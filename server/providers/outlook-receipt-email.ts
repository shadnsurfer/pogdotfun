import { createHash } from 'node:crypto';
import {
  normalizeTwitchReceiptTrust,
  receiptEmailAddress,
  selectTwitchReceiptInvoice,
  TwitchReceiptEmailError,
  validateTwitchReceiptMatch,
  verifyTwitchReceiptMime,
  type ReceiptMimeDependencies,
  type TwitchReceiptInvoice,
  type TwitchReceiptMatch,
  type TwitchReceiptTrustConfig,
} from './twitch-receipt-email.ts';

export interface OutlookReceiptEmailConfig extends TwitchReceiptTrustConfig {
  /** Exact Graph /me mailbox, independently checked for each scan. */
  mailboxAddress: string;
  /** Worker-owned OAuth provider; the receipt reader never refreshes credentials itself. */
  getAccessToken: () => Promise<string>;
}
export interface OutlookReceiptEmailDependencies extends ReceiptMimeDependencies {
  fetch?: typeof fetch;
}

const origin = 'https://graph.microsoft.com';
const messagePath = '/v1.0/me/messages';
const maxBytes = 1_000_000;
const windowMs = 24 * 60 * 60 * 1000;
type ObjectValue = Record<string, unknown>;
function unavailable(): never {
  throw new TwitchReceiptEmailError(
    503,
    'Receipt email evidence is unavailable or could not be verified.',
  );
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as ObjectValue;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 50 || !Number.isFinite(Date.parse(value)))
    unavailable();
  return Date.parse(value);
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Receipt verification timed out.'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Read-only Graph transport. Receipt authority comes exclusively from verified raw MIME. */
export class OutlookReceiptEmailReader {
  private readonly config: OutlookReceiptEmailConfig;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    config: OutlookReceiptEmailConfig,
    private readonly dependencies: OutlookReceiptEmailDependencies = {},
  ) {
    if (
      !config ||
      !receiptEmailAddress(config.mailboxAddress) ||
      typeof config.getAccessToken !== 'function'
    )
      unavailable();
    this.config = {
      ...normalizeTwitchReceiptTrust(config),
      mailboxAddress: receiptEmailAddress(config.mailboxAddress)!,
      getAccessToken: config.getAccessToken,
    };
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }
  private async bytes(
    url: URL,
    token: string,
    mime: boolean,
    signal: AbortSignal,
  ): Promise<Buffer> {
    // Only URLs constructed locally or checked by nextPage ever reach this method.
    if (url.origin !== origin || url.username || url.password || url.hash) unavailable();
    const response = await bounded(
      this.fetcher(url.href, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'IdType="ImmutableId"',
          Accept: mime ? 'message/rfc822' : 'application/json',
          'User-Agent': 'pog-receipt-reader/1.0',
        },
      }),
      signal,
    );
    if (
      response.status !== 200 ||
      response.redirected ||
      !response.body ||
      Number(response.headers.get('content-length') ?? 0) > maxBytes
    )
      unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await bounded(reader.read(), signal);
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) unavailable();
        chunks.push(part.value);
      }
    } finally {
      // A stalled provider cannot extend the overall deadline through cancellation.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }
  private async json(url: URL, token: string, signal: AbortSignal) {
    return object(JSON.parse((await this.bytes(url, token, false, signal)).toString('utf8')));
  }
  private nextPage(value: unknown, initial: URL): URL {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
      unavailable();
    const next = new URL(value);
    if (
      next.origin !== origin ||
      next.pathname !== messagePath ||
      next.username ||
      next.password ||
      next.hash ||
      next.port
    )
      unavailable();
    // Preserve the bounded query; accept Graph's opaque pagination values without editing them.
    for (const [key, value] of initial.searchParams) {
      if (next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value)
        unavailable();
    }
    for (const key of next.searchParams.keys()) {
      if (!initial.searchParams.has(key) && !['$skip', '$skiptoken'].includes(key)) unavailable();
      if (next.searchParams.getAll(key).length !== 1) unavailable();
    }
    return next;
  }
  private async account(signal: AbortSignal): Promise<{ token: string; mailboxId: string }> {
    const token = await bounded(this.config.getAccessToken(), signal);
    if (
      typeof token !== 'string' ||
      !token ||
      token.length > 32_768 ||
      /[\s\u0000-\u001f\u007f]/.test(token)
    )
      unavailable();
    // Reusing exactly this token prevents a refresh changing /me midway through a scan.
    const identity = await this.json(
      new URL('/v1.0/me?$select=id,mail,userPrincipalName', origin),
      token,
      signal,
    );
    const mailbox =
      identity.mail == null || identity.mail === '' ? identity.userPrincipalName : identity.mail;
    if (
      typeof identity.id !== 'string' ||
      !identity.id ||
      identity.id.length > 256 ||
      /[\s\u0000-\u001f\u007f]/.test(identity.id) ||
      receiptEmailAddress(mailbox) !== this.config.mailboxAddress
    )
      unavailable();

    return { token, mailboxId: identity.id as string };
  }
  /** Refresh authorization and verify live mailbox/body-read access before any purchase. */
  async checkConnection(): Promise<void> {
    try {
      const signal = AbortSignal.timeout(30_000);
      const { token } = await this.account(signal);
      const response = await this.json(
        new URL(`${messagePath}?$top=1&$select=id,body`, origin),
        token,
        signal,
      );
      if (!Array.isArray(response.value) || response.value.length > 1) unavailable();
      for (const value of response.value) {
        const item = object(value),
          body = object(item.body);
        if (typeof item.id !== 'string' || !item.id || typeof body.content !== 'string')
          unavailable();
      }
      // Body content is used only to exercise Mail.Read, never stored, parsed or returned.
    } catch (error) {
      if (error instanceof TwitchReceiptEmailError) throw error;
      unavailable();
    }
  }
  async findMatchingInvoice(input: TwitchReceiptMatch): Promise<TwitchReceiptInvoice | null> {
    try {
      const expected = validateTwitchReceiptMatch(input, this.now());
      const signal = AbortSignal.timeout(30_000);
      const { token, mailboxId } = await this.account(signal);

      const submitted = timestamp(expected.submittedAt);
      const upper = Math.min(submitted + windowMs, this.now() + 5000);
      const initial = new URL(messagePath, origin);
      initial.searchParams.set('$select', 'id,from,receivedDateTime,isDraft');
      initial.searchParams.set('$top', '100');
      initial.searchParams.set(
        '$filter',
        `receivedDateTime ge ${new Date(submitted - 5000).toISOString()} and receivedDateTime le ${new Date(upper).toISOString()}`,
      );
      initial.searchParams.set('$orderby', 'receivedDateTime asc');
      let url = initial;
      const seenPages = new Set<string>();
      const seenIds = new Set<string>();
      const matches: TwitchReceiptInvoice[] = [];
      for (let page = 0; page < 10; page++) {
        if (seenPages.has(url.href)) unavailable();
        seenPages.add(url.href);
        const response = await this.json(url, token, signal);
        if (!Array.isArray(response.value) || response.value.length > 100) unavailable();
        for (const value of response.value) {
          const item = object(value);
          if (
            typeof item.id !== 'string' ||
            !/^[A-Za-z0-9_+/=-]{1,2048}$/.test(item.id) ||
            seenIds.has(item.id)
          )
            unavailable();
          seenIds.add(item.id);
          if (typeof item.isDraft !== 'boolean') unavailable();
          // /me/messages includes drafts, which need not have a sender or received date.
          if (item.isDraft) continue;
          const received = timestamp(item.receivedDateTime);
          const from = receiptEmailAddress(object(object(item.from).emailAddress).address);
          if (
            received < submitted - 5000 ||
            received > upper ||
            !this.config.trustedSenders.some((sender) => sender.address === from)
          )
            continue;
          const raw = await this.bytes(
            new URL(`${messagePath}/${encodeURIComponent(item.id)}/$value`, origin),
            token,
            true,
            signal,
          );
          // Raw Graph IDs are long/case-sensitive opaque values. Hashing retains stable
          // mailbox-scoped identity within the journal's 128-character safe ID contract.
          const emailId = `outlook_${createHash('sha256')
            .update(JSON.stringify([mailboxId, item.id]))
            .digest('hex')}`;
          const match = await bounded(
            verifyTwitchReceiptMime(
              { raw, emailId, from, receivedAt: item.receivedDateTime, expected },
              this.config,
              { ...this.dependencies, now: this.now },
              signal,
            ),
            signal,
          );
          if (match) matches.push(match);
        }
        if (!Object.hasOwn(response, '@odata.nextLink')) return selectTwitchReceiptInvoice(matches);
        if (!response.value.length) unavailable();
        url = this.nextPage(response['@odata.nextLink'], initial);
      }
      unavailable();
    } catch (error) {
      if (error instanceof TwitchReceiptEmailError) throw error;
      unavailable();
    }
  }
}
