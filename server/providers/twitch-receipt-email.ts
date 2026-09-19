import { createHash } from 'node:crypto';
import { lookup, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { dkimVerify, type DKIMResult } from 'mailauth';
import { simpleParser } from 'mailparser';

export interface TwitchReceiptTrustConfig {
  /** Exact mailbox registered to the operating donor, derived from genuine receipts. */
  donorReceiptAddress: string;
  trustedSenders: Array<{
    address: string;
    signingDomains: string[];
    role: 'original' | 'forwarder';
  }>;
}
export interface TwitchReceiptEmailConfig extends TwitchReceiptTrustConfig {
  apiKey: string;
  receivingAddress: string;
  /** Exact observed Resend/CloudFront storage hosts, never a wildcard. */
  rawEmailHosts: string[];
}
export interface TwitchReceiptMatch {
  username: string;
  giftUnits: number;
  nativeCurrency: 'USD' | 'HKD';
  nativeTotalMinorUnits: number;
  submittedAt: string;
}
export interface TwitchReceiptInvoice {
  nativeReceiptId: string;
  emailId: string;
  receivedAt: string;
  evidenceDigest: string;
}
export interface ReceiptMimeDependencies {
  resolveTxt?: (name: string) => Promise<string[][]>;
  verifyDkim?: typeof dkimVerify;
  now?: () => number;
}
interface Dependencies extends ReceiptMimeDependencies {
  fetch?: typeof fetch;
  resolveHost?: (name: string) => Promise<string[]>;
}
interface SignatureResult extends DKIMResult {
  algo?: string;
  signatureTimeValid?: boolean;
  canonBodyLengthLimited?: boolean;
  signingHeaders?: { keys?: string | string[] };
}
type ObjectValue = Record<string, unknown>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const addressPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const maxBytes = 1_000_000;
const windowMs = 24 * 60 * 60 * 1000;

export class TwitchReceiptEmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
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
export function receiptEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n\u0000]/.test(value)) return null;
  const match = /^(?:[^<>]*<)?([^<>]+)>?$/.exec(value.trim());
  const result = match?.[1].trim().toLowerCase();
  return result && addressPattern.test(result) ? result : null;
}
function time(value: unknown): number {
  if (typeof value !== 'string' || value.length > 50 || !Number.isFinite(Date.parse(value)))
    unavailable();
  return Date.parse(value);
}
function publicAddress(value: string): boolean {
  // Only public IPv4 is used for raw-storage lookup. IPv6-only/private answers fail closed.
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
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
function pinnedDownload(url: URL, ip: string, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Connect to the already checked public IP while retaining TLS hostname
    // verification. A second DNS lookup cannot rebind this request to localhost.
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        family: 4,
        signal,
        lookup: (_hostname, _options, callback) => callback(null, ip, 4),
        headers: { 'User-Agent': 'pog-receipt-reader/1.0' },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          Number(response.headers['content-length'] ?? 0) > maxBytes
        ) {
          response.destroy();
          reject(new Error('Receipt download rejected.'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error('Receipt download exceeded limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks, size)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
function cents(value: string): number | null {
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}$/.test(value)) return null;
  const units = Number(value.replace(/[,.]/g, ''));
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}
function matchingInvoice(text: string, expected: TwitchReceiptMatch): string | null {
  if (!text || text.length > maxBytes || /\u0000/.test(text)) return null;
  const normalized = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');
  const invoices = [...normalized.matchAll(/\bInvoice\s*#\s*([A-Z]{2}-\d{1,30})\b/gi)];
  if (invoices.length !== 1) return null;
  const gifts = [
    ...normalized.matchAll(
      /\bCommunity Gift for (\d+) user(?:\(s\)|s)? to (?:Channel )?Subscription \(([a-zA-Z0-9_]{3,25})\) \(x\s*(\d+)\)/gi,
    ),
  ];
  if (
    gifts.length !== 1 ||
    Number(gifts[0][1]) !== expected.giftUnits ||
    Number(gifts[0][3]) !== expected.giftUnits ||
    gifts[0][2].toLowerCase() !== expected.username.toLowerCase()
  )
    return null;
  const money =
    /(?:\b(HKD|USD|CAD|EUR|GBP)\s*|(?<symbol>HK\$|US\$|\$)\s*)(\d[\d,]*\.\d{2})(?:\s*\b(HKD|USD|CAD|EUR|GBP)\b)?/g;
  const total =
    /\b(?:Total(?: Paid| Amount)?|Amount Paid|Payment Total)\s*:?\s*((?:HK\$|US\$|\$|HKD|USD|CAD|EUR|GBP)\s*\d[\d,]*\.\d{2}(?:\s*\b(?:HKD|USD|CAD|EUR|GBP)\b)?)/gi;
  const totals = [...normalized.matchAll(total)];
  if (totals.length > 1) return null;
  const amounts = [...(totals.length ? totals[0][1] : normalized).matchAll(money)];
  if (!amounts.length) return null;
  for (const value of amounts) {
    const explicit = [
      value[1],
      value[4],
      value.groups?.symbol === 'HK$' ? 'HKD' : value.groups?.symbol === 'US$' ? 'USD' : undefined,
    ].filter(Boolean);
    if (
      explicit.some((currency) => currency !== expected.nativeCurrency) ||
      cents(value[3]) !== expected.nativeTotalMinorUnits
    )
      return null;
  }
  // An unqualified "$" has no independent currency meaning. The caller's saved
  // browser quote supplies that binding; this adapter never returns a currency.
  return invoices[0][1].toUpperCase();
}

/** Shared trust contract for receipt transports; mailbox connectivity is not proof. */
export function normalizeTwitchReceiptTrust(
  config: TwitchReceiptTrustConfig,
): TwitchReceiptTrustConfig {
  if (
    !config ||
    !receiptEmailAddress(config.donorReceiptAddress) ||
    !Array.isArray(config.trustedSenders) ||
    !config.trustedSenders.length
  )
    unavailable();
  for (const sender of config.trustedSenders) {
    if (
      !sender ||
      !receiptEmailAddress(sender.address) ||
      !['original', 'forwarder'].includes(sender.role) ||
      !Array.isArray(sender.signingDomains) ||
      !sender.signingDomains.length ||
      sender.signingDomains.some(
        (domain) =>
          typeof domain !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain),
      )
    )
      unavailable();
  }
  return {
    donorReceiptAddress: receiptEmailAddress(config.donorReceiptAddress)!,
    trustedSenders: config.trustedSenders.map((sender) => ({
      address: receiptEmailAddress(sender.address)!,
      signingDomains: [...sender.signingDomains],
      role: sender.role,
    })),
  };
}
export function validateTwitchReceiptMatch(
  input: TwitchReceiptMatch,
  now: number,
): TwitchReceiptMatch {
  const expected = structuredClone(input);
  if (
    !expected ||
    !/^[a-zA-Z0-9_]{3,25}$/.test(expected.username) ||
    !['USD', 'HKD'].includes(expected.nativeCurrency) ||
    !Number.isSafeInteger(expected.giftUnits) ||
    expected.giftUnits < 1 ||
    expected.giftUnits > 10000 ||
    !Number.isSafeInteger(expected.nativeTotalMinorUnits) ||
    expected.nativeTotalMinorUnits <= 0 ||
    time(expected.submittedAt) > now + 5000
  )
    unavailable();
  return expected;
}
export function selectTwitchReceiptInvoice(
  matches: TwitchReceiptInvoice[],
): TwitchReceiptInvoice | null {
  if (new Set(matches.map((match) => match.nativeReceiptId)).size > 1)
    throw new TwitchReceiptEmailError(
      409,
      'Receipt email evidence is ambiguous; reconcile the original purchase.',
    );
  return (
    matches.sort(
      (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.emailId.localeCompare(b.emailId),
    )[0] ?? null
  );
}
/** Verifies original raw MIME, full signed body/headers, pinned sender/donor and exact invoice facts. */
export async function verifyTwitchReceiptMime(
  input: {
    raw: Buffer;
    emailId: string;
    from: unknown;
    receivedAt: unknown;
    expected: TwitchReceiptMatch;
  },
  config: TwitchReceiptTrustConfig,
  dependencies: ReceiptMimeDependencies,
  signal: AbortSignal,
): Promise<TwitchReceiptInvoice | null> {
  const { raw, emailId, expected } = input;
  const now = dependencies.now ?? Date.now;
  if (raw.length > maxBytes) unavailable();
  const from = receiptEmailAddress(input.from);
  const trusted = config.trustedSenders.find((sender) => sender.address === from);
  if (!trusted) return null;
  const received = time(input.receivedAt),
    submitted = time(expected.submittedAt);
  if (received < submitted - 5000 || received > submitted + windowMs || received > now() + 5000)
    return null;
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0 || headerEnd > 32_768) return null;
  const signatures =
    raw
      .subarray(0, headerEnd)
      .toString('utf8')
      .match(/^DKIM-Signature:/gim) ?? [];
  if (!signatures.length || signatures.length > 8) return null;
  let lookups = 0;
  const verified = await bounded(
    (dependencies.verifyDkim ?? dkimVerify)(raw, {
      curTime: now(),
      minBitLength: 2048,
      resolver: async (domain, type) => {
        signal.throwIfAborted();
        if (type !== 'TXT' || ++lookups > 8 || domain.length > 253) unavailable();
        return bounded((dependencies.resolveTxt ?? resolveTxt)(domain), signal);
      },
    }),
    signal,
  );
  const headerNames = verified.headers?.parsed.map((header) => header.key) ?? [];
  const protectedHeaders = [
    'from',
    'to',
    'date',
    'subject',
    'content-type',
    ...['mime-version', 'content-transfer-encoding'].filter((key) => headerNames.includes(key)),
  ];
  if (protectedHeaders.some((key) => headerNames.filter((name) => name === key).length !== 1))
    return null;
  const approved = verified.results.some((result: SignatureResult) => {
    const rawKeys = result.signingHeaders?.keys;
    const keys = (typeof rawKeys === 'string' ? rawKeys.split(':') : (rawKeys ?? [])).map((key) =>
      key.trim().toLowerCase(),
    );
    const senderDomain = from!.split('@')[1];
    return (
      result.status.result === 'pass' &&
      result.signatureTimeValid === true &&
      result.canonBodyLengthLimited === false &&
      ['rsa-sha256', 'ed25519-sha256'].includes(result.algo ?? '') &&
      trusted.signingDomains.includes(result.signingDomain) &&
      (senderDomain === result.signingDomain ||
        senderDomain.endsWith(`.${result.signingDomain}`)) &&
      protectedHeaders.every((key) => keys.includes(key))
    );
  });
  if (
    !approved ||
    verified.headerFrom.length !== 1 ||
    receiptEmailAddress(verified.headerFrom[0]) !== from
  )
    return null;
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: maxBytes,
  });
  if (
    ['from', 'to', 'date', 'subject'].some(
      (key) => parsed.headerLines.filter((line) => line.key === key).length !== 1,
    ) ||
    parsed.from?.value.length !== 1 ||
    receiptEmailAddress(parsed.from.value[0].address) !== from ||
    !parsed.date
  )
    return null;
  const authored = parsed.date.getTime();
  const signedTo = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap(
    (entry) => entry.value,
  );
  if (
    trusted.role === 'original' &&
    !signedTo.some((entry) => receiptEmailAddress(entry.address) === config.donorReceiptAddress)
  )
    return null;
  if (!Number.isFinite(authored) || authored < submitted - 5000 || authored > received + 5000)
    return null;
  const nativeReceiptId = matchingInvoice(parsed.text ?? '', expected);
  if (!nativeReceiptId) return null;
  return {
    nativeReceiptId,
    emailId,
    receivedAt: new Date(received).toISOString(),
    evidenceDigest: createHash('sha256').update(raw).digest('hex'),
  };
}

/** Read-only corroborating invoice evidence. No purchase, email send, or ledger writes. */
export class TwitchReceiptEmailReader {
  private readonly config: TwitchReceiptEmailConfig;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    config: TwitchReceiptEmailConfig,
    private readonly dependencies: Dependencies = {},
  ) {
    if (
      !config ||
      typeof config.apiKey !== 'string' ||
      !config.apiKey ||
      /[\s\u0000]/.test(config.apiKey) ||
      !receiptEmailAddress(config.receivingAddress) ||
      !receiptEmailAddress(config.donorReceiptAddress) ||
      !Array.isArray(config.trustedSenders) ||
      !config.trustedSenders.length ||
      !Array.isArray(config.rawEmailHosts) ||
      !config.rawEmailHosts.length
    )
      unavailable();
    const trust = normalizeTwitchReceiptTrust(config);
    if (
      config.rawEmailHosts.some(
        (host) => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cloudfront\.net|resend\.com)$/.test(host),
      )
    )
      unavailable();
    this.config = { ...structuredClone(config), ...trust };
    this.config.receivingAddress = receiptEmailAddress(config.receivingAddress)!;
    this.config.donorReceiptAddress = receiptEmailAddress(config.donorReceiptAddress)!;
    this.config.trustedSenders.forEach((sender) => {
      sender.address = receiptEmailAddress(sender.address)!;
    });
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }
  private async bytes(url: URL, authenticated: boolean, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetcher(url.href, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        'User-Agent': 'pog-receipt-reader/1.0',
        ...(authenticated
          ? { Authorization: `Bearer ${this.config.apiKey}`, Accept: 'application/json' }
          : {}),
      },
    });
    if (
      !response.ok ||
      response.redirected ||
      !response.body ||
      Number(response.headers.get('content-length') ?? 0) > maxBytes
    )
      unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maxBytes) unavailable();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
  }
  private async api(path: string, signal: AbortSignal): Promise<ObjectValue> {
    return object(
      JSON.parse(
        (await this.bytes(new URL(path, 'https://api.resend.com'), true, signal)).toString('utf8'),
      ),
    );
  }
  private async candidate(
    id: string,
    expected: TwitchReceiptMatch,
    signal: AbortSignal,
  ): Promise<TwitchReceiptInvoice | null> {
    const email = await this.api(`/emails/receiving/${id}`, signal);
    if (email.id !== id || email.object !== 'email') unavailable();
    const recipients = [
      ...(Array.isArray(email.to) ? email.to : []),
      ...(Array.isArray(email.received_for) ? email.received_for : []),
    ];
    if (!recipients.some((value) => receiptEmailAddress(value) === this.config.receivingAddress))
      return null;
    const from = receiptEmailAddress(email.from);
    const trusted = this.config.trustedSenders.find((sender) => sender.address === from);
    if (!trusted || !email.raw) return null;
    const received = time(email.created_at),
      submitted = time(expected.submittedAt);
    if (
      received < submitted - 5000 ||
      received > submitted + windowMs ||
      received > this.now() + 5000
    )
      return null;
    const source = object(email.raw);
    if (
      typeof source.download_url !== 'string' ||
      source.download_url.length > 8192 ||
      time(source.expires_at) <= this.now()
    )
      unavailable();
    const url = new URL(source.download_url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !this.config.rawEmailHosts.includes(url.hostname)
    )
      unavailable();
    const addresses = await bounded(
      this.dependencies.resolveHost
        ? this.dependencies.resolveHost(url.hostname)
        : lookup(url.hostname, { all: true, family: 4 }).then((entries) =>
            entries.map((entry) => entry.address),
          ),
      signal,
    );
    if (!addresses.length || addresses.some((value) => !publicAddress(value))) unavailable();
    const raw = this.dependencies.fetch
      ? await this.bytes(url, false, signal)
      : await pinnedDownload(url, addresses[0], signal);
    return verifyTwitchReceiptMime(
      { raw, emailId: id, from: email.from, receivedAt: email.created_at, expected },
      this.config,
      { ...this.dependencies, now: this.now },
      signal,
    );
  }
  /** Verify live receiving-read authorization before opening or submitting a checkout. */
  async checkConnection(): Promise<void> {
    try {
      const signal = AbortSignal.timeout(30_000);
      const response = await bounded(this.api('/emails/receiving?limit=1', signal), signal);
      if (
        response.object !== 'list' ||
        typeof response.has_more !== 'boolean' ||
        !Array.isArray(response.data) ||
        response.data.length > 1
      )
        unavailable();
    } catch (error) {
      if (error instanceof TwitchReceiptEmailError) throw error;
      unavailable();
    }
  }
  async findMatchingInvoice(input: TwitchReceiptMatch): Promise<TwitchReceiptInvoice | null> {
    try {
      const expected = validateTwitchReceiptMatch(input, this.now());
      const signal = AbortSignal.timeout(30_000);
      const seen = new Set<string>(),
        matches: TwitchReceiptInvoice[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await this.api(
          `/emails/receiving?limit=100${cursor ? `&after=${cursor}` : ''}`,
          signal,
        );
        if (
          result.object !== 'list' ||
          typeof result.has_more !== 'boolean' ||
          !Array.isArray(result.data) ||
          result.data.length > 100
        )
          unavailable();
        for (const value of result.data) {
          const item = object(value);
          if (typeof item.id !== 'string' || !uuid.test(item.id) || seen.has(item.id))
            unavailable();
          seen.add(item.id);
          cursor = item.id;
          const received = time(item.created_at);
          if (
            received < time(expected.submittedAt) - 5000 ||
            received > time(expected.submittedAt) + windowMs ||
            received > this.now() + 5000 ||
            !this.config.trustedSenders.some(
              (sender) => sender.address === receiptEmailAddress(item.from),
            )
          )
            continue;
          const match = await this.candidate(item.id, expected, signal);
          if (match) matches.push(match);
        }
        if (!result.has_more) {
          return selectTwitchReceiptInvoice(matches);
        }
        if (!result.data.length) unavailable();
      }
      unavailable();
    } catch (error) {
      if (error instanceof TwitchReceiptEmailError) throw error;
      unavailable();
    }
  }
}
