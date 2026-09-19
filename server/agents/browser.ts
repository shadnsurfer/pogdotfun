import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AutomaticConnector,
  AutomaticDelivery,
  AutomaticDriver,
} from '../acceptance/automatic.ts';
import type { AcceptanceGiftQuote } from '../acceptance/gift-types.ts';
import {
  BrowserbaseProvider,
  type BrowserbaseConfig,
  type BrowserSession,
  type BrowserSessionProvider,
} from '../providers/browserbase.ts';
import { BrowserbaseCdpConnector, type OwnedBrowserLease } from '../providers/browserbase-cdp.ts';
import { TwitchCheckoutDriver, type TwitchGiftIntent } from '../providers/twitch-checkout.ts';
import { KickCheckoutDriver, type KickSelectorContract } from '../providers/kick-checkout.ts';
import type { PipelineJob } from './pipeline.ts';

type Platform = 'twitch' | 'kick';
export interface BrowserGiftAccount {
  accountId: string;
  contextId: string;
  cardAccountId: string;
  cardLast4: string;
  giftUnits: number;
  maxSpendUsdCents: number;
}
/** Attestation from an authenticated, independent receipt AND issuer reader. */
export interface BrowserGiftEvidence {
  jobId: string;
  cardAccountId: string;
  purchaseReference: string;
  reference: string;
  chargeReference: string;
  spentUsdCents: number;
  currency: 'USD';
  recipientProviderId: string;
  recipientUsername: string;
  platform: Platform;
  giftUnits: number;
  cardLast4: string;
  chargeStatus: 'POSTED';
  postedAt: string;
  receiptDigest: string;
  chargeDigest: string;
}
export interface BrowserEvidenceRequest {
  job: PipelineJob;
  cardAccountId: string;
  purchaseReference: string;
  intent: TwitchGiftIntent;
  quote: AcceptanceGiftQuote;
  submittedAt: string;
  delivery?: AutomaticDelivery;
}
export interface AgentBrowserOptions {
  browserbase?: BrowserbaseConfig;
  accounts: Partial<Record<Platform, BrowserGiftAccount>>;
  liveGate: {
    requireLive(recipient: PipelineJob['recipient']): Promise<unknown>;
    assertFreshLive(recipient: PipelineJob['recipient']): void;
  };
  /** Omit until authenticated receipt + posted issuer evidence is implemented. */
  readEvidence?: (request: BrowserEvidenceRequest) => Promise<BrowserGiftEvidence | null>;
  provider?: Pick<
    BrowserSessionProvider,
    'createSession' | 'findSessions' | 'getSession' | 'releaseSession'
  >;
  connectorFactory?: (
    ownsLease: (lease: Readonly<OwnedBrowserLease>) => boolean,
  ) => AutomaticConnector;
  drivers?: Partial<Record<Platform, AutomaticDriver>>;
  kickContract?: KickSelectorContract;
}
interface Attempt {
  job: PipelineJob;
  jobDigest: string;
  reference: string;
  attemptId: string;
  leaseId: string;
  account: BrowserGiftAccount;
  phase: 'provisioning' | 'prepared' | 'submitting' | 'observed' | 'settled';
  session?: BrowserSession;
  intent: TwitchGiftIntent;
  quote?: AcceptanceGiftQuote;
  submittedAt?: string;
  delivery?: AutomaticDelivery;
  evidence?: BrowserGiftEvidence;
}
export class AgentBrowserError extends Error {
  constructor() {
    super('Browser gift held. Reconcile the original operation before continuing.');
    this.name = 'AgentBrowserError';
  }
}
function fail(): never {
  throw new AgentBrowserError();
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const cents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function stableUuid(value: string) {
  const h = createHash('sha256').update(`pog-browser-v1:${value}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function jobDigest(job: PipelineJob) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        job.id,
        job.tokenId,
        job.chain,
        job.asset,
        job.amountBaseUnits,
        job.decimals,
        job.claimReference,
        job.depositReference,
        job.conversionReference,
        job.recipient.platform,
        job.recipient.providerId,
        job.recipient.username,
        job.netUsdCents,
        job.streamerBudgetUsdCents,
        job.platformReserveUsdCents,
        job.cardAccountId,
      ]),
    )
    .digest('hex');
}
/** Durable worker-only coordinator. No endpoint accepts browser or purchase evidence. */
export class AgentBrowserRunner {
  private readonly provider?: AgentBrowserOptions['provider'];
  private readonly connector?: AutomaticConnector;
  private readonly drivers: Record<Platform, AutomaticDriver>;
  private readonly options: AgentBrowserOptions;
  constructor(
    private readonly db: DatabaseSync,
    options: AgentBrowserOptions,
  ) {
    this.options = { ...options, accounts: structuredClone(options.accounts) };
    db.exec(`CREATE TABLE IF NOT EXISTS agent_browser_attempts(job_id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_browser_context_locks(context_id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, lease_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_browser_evidence(receipt TEXT PRIMARY KEY, charge TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE);`);
    this.provider =
      options.provider ??
      (options.browserbase ? new BrowserbaseProvider(options.browserbase) : undefined);
    this.connector =
      options.connectorFactory?.((lease) => this.ownsLease(lease)) ??
      (options.browserbase
        ? new BrowserbaseCdpConnector(options.browserbase, {
            ownsLease: (lease) => this.ownsLease(lease),
          })
        : undefined);
    this.drivers = {
      twitch: options.drivers?.twitch ?? new TwitchCheckoutDriver(),
      kick: options.drivers?.kick ?? new KickCheckoutDriver(options.kickContract),
    };
  }
  private get(jobId: string): Attempt | undefined {
    const row = this.db
      .prepare('SELECT payload FROM agent_browser_attempts WHERE job_id=?')
      .get(jobId);
    return row ? (JSON.parse(String(row.payload)) as Attempt) : undefined;
  }
  private save(old: Attempt, next: Attempt) {
    if (
      this.db
        .prepare('UPDATE agent_browser_attempts SET phase=?,payload=? WHERE job_id=? AND payload=?')
        .run(next.phase, JSON.stringify(next), old.job.id, JSON.stringify(old)).changes !== 1
    )
      fail();
  }
  private assertJob(job: PipelineJob, stored?: Attempt) {
    if (
      !job ||
      typeof job.id !== 'string' ||
      job.id.length < 1 ||
      job.id.length > 256 ||
      !cents(job.netUsdCents) ||
      !cents(job.streamerBudgetUsdCents) ||
      !Number.isSafeInteger(job.platformReserveUsdCents) ||
      job.platformReserveUsdCents! < 0 ||
      job.streamerBudgetUsdCents! + job.platformReserveUsdCents! !== job.netUsdCents ||
      !['twitch', 'kick'].includes(job.recipient?.platform) ||
      !new RegExp(`^${job.recipient.platform}:[1-9]\\d{0,29}$`).test(job.recipient.providerId) ||
      !/^[a-z0-9_]{3,25}$/.test(job.recipient.username) ||
      (stored && stored.jobDigest !== jobDigest(job))
    )
      fail();
  }
  private account(job: PipelineJob) {
    const account = this.options.accounts[job.recipient.platform];
    if (
      !account ||
      !/^[a-z0-9_]{3,25}$/.test(account.accountId) ||
      !identifier(account.contextId) ||
      !identifier(account.cardAccountId) ||
      account.cardAccountId !== job.cardAccountId ||
      !/^\d{4}$/.test(account.cardLast4) ||
      !Number.isSafeInteger(account.giftUnits) ||
      account.giftUnits < 1 ||
      account.giftUnits > 100 ||
      !cents(account.maxSpendUsdCents)
    )
      fail();
    return account;
  }
  private ready(job: PipelineJob) {
    if (
      !this.provider ||
      !this.connector ||
      !this.options.browserbase ||
      !this.options.readEvidence ||
      (job.recipient.platform === 'kick' &&
        !this.options.drivers?.kick &&
        !(this.drivers.kick as KickCheckoutDriver).configured())
    )
      fail();
  }
  private ownsLease(lease: Readonly<OwnedBrowserLease>) {
    const row = this.db
      .prepare('SELECT payload FROM agent_browser_attempts WHERE reference=?')
      .get(lease.paymentId);
    if (!row) return false;
    const a = JSON.parse(String(row.payload)) as Attempt;
    const lock = this.db
      .prepare('SELECT reference,lease_id FROM agent_browser_context_locks WHERE context_id=?')
      .get(a.account.contextId);
    return !!(
      lock &&
      lock.reference === a.reference &&
      lock.lease_id === a.leaseId &&
      a.phase !== 'settled' &&
      a.session &&
      a.session.status === 'RUNNING' &&
      Date.parse(a.session.expiresAt) > Date.now() &&
      lease.sessionId === a.session.id &&
      lease.contextId === a.account.contextId &&
      lease.leaseId === a.leaseId &&
      lease.browserAttemptId === a.attemptId &&
      (lease.providerAttemptId ?? lease.browserAttemptId) === a.attemptId
    );
  }
  private session(session: BrowserSession, a: Attempt) {
    if (
      !identifier(session.id) ||
      (a.session && session.id !== a.session.id) ||
      session.projectId !== this.options.browserbase?.projectId ||
      session.contextId !== a.account.contextId ||
      session.attemptId !== a.attemptId ||
      !['RUNNING', 'PENDING', 'COMPLETED', 'ERROR', 'TIMED_OUT'].includes(session.status) ||
      !Number.isFinite(Date.parse(session.expiresAt))
    )
      fail();
  }
  private validateQuote(quote: AcceptanceGiftQuote, a: Attempt) {
    const age = Date.now() - Date.parse(quote.observedAt);
    if (
      quote.accountId !== a.account.accountId ||
      quote.recipientPlatform !== a.job.recipient.platform ||
      quote.recipientUsername !== a.job.recipient.username ||
      quote.recipientProviderId !== a.job.recipient.providerId ||
      quote.kind !== 'gift_sub' ||
      quote.giftUnits !== a.account.giftUnits ||
      quote.nativeCurrency !== 'USD' ||
      !cents(quote.totalUsdCents) ||
      quote.nativeTotalMinorUnits !== quote.totalUsdCents ||
      quote.totalUsdCents > a.intent.maxSpendUsdCents ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 30000
    )
      fail();
  }
  async submit(job: PipelineJob): Promise<{ reference: string }> {
    this.assertJob(job);
    const old = this.get(job.id);
    if (old) {
      this.assertJob(job, old);
      return { reference: old.reference };
    }
    this.ready(job);
    const account = this.account(job);
    const attemptId = stableUuid(job.id);
    let a: Attempt = {
      job: structuredClone(job),
      jobDigest: jobDigest(job),
      reference: attemptId,
      attemptId,
      leaseId: randomUUID(),
      account: structuredClone(account),
      phase: 'provisioning',
      intent: {
        production: true,
        accountId: account.accountId,
        username: job.recipient.username,
        providerId: job.recipient.providerId,
        giftUnits: account.giftUnits,
        maxSpendUsdCents: Math.min(account.maxSpendUsdCents, job.streamerBudgetUsdCents!),
        maxNativeMinorUnits: Math.min(account.maxSpendUsdCents, job.streamerBudgetUsdCents!),
        cardLast4: account.cardLast4,
      },
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO agent_browser_context_locks VALUES(?,?,?)')
        .run(account.contextId, a.reference, a.leaseId);
      this.db
        .prepare('INSERT INTO agent_browser_attempts VALUES(?,?,?,?)')
        .run(job.id, a.reference, a.phase, JSON.stringify(a));
      this.db.exec('COMMIT');
    } catch {
      this.db.exec('ROLLBACK');
      fail();
    }
    try {
      // The provisioning intent and context lock are durable before any provider request.
      // A failed create is reconciled by attemptId; it is never blindly repeated.
      const session = await this.provider!.createSession(account.contextId, attemptId);
      this.session(session, a);
      if (session.status !== 'RUNNING' || Date.parse(session.expiresAt) <= Date.now()) fail();
      const bound = { ...a, session };
      this.save(a, bound);
      a = bound;
      const lease: OwnedBrowserLease = {
        paymentId: a.reference,
        browserAttemptId: a.attemptId,
        providerAttemptId: a.attemptId,
        sessionId: session.id,
        contextId: account.contextId,
        leaseId: a.leaseId,
      };
      await this.connector!.withOwnedPage(lease, async (scope) => {
        const owned = { ...scope, diagnosticIdentity: a.reference };
        const driver = this.drivers[job.recipient.platform];
        const quote = await driver.prepare(owned, a.intent);
        scope.assertOwned();
        this.validateQuote(quote, a);
        const prepared: Attempt = { ...a, phase: 'prepared', quote };
        this.save(a, prepared);
        a = prepared;
        await this.options.liveGate.requireLive(job.recipient);
        scope.assertOwned();
        const delivery = await driver.submit(owned, a.intent, quote, () => {
          scope.assertOwned();
          this.options.liveGate.assertFreshLive(job.recipient);
          this.validateQuote(quote, a);
          const current = this.get(job.id);
          if (
            !current ||
            current.phase !== 'prepared' ||
            JSON.stringify(current) !== JSON.stringify(a)
          )
            fail();
          const submitting: Attempt = {
            ...current,
            phase: 'submitting',
            submittedAt: new Date().toISOString(),
          };
          this.save(current, submitting);
          a = submitting;
        });
        scope.assertOwned();
        if (
          a.phase !== 'submitting' ||
          !/^[a-f0-9]{64}$/.test(delivery.evidenceDigest) ||
          !Number.isFinite(Date.parse(delivery.completedAt))
        )
          fail();
        const observed: Attempt = { ...a, phase: 'observed', delivery };
        this.save(a, observed);
        a = observed;
      });
      return { reference: a.reference };
    } catch {
      fail();
    }
  }
  private validateEvidence(e: BrowserGiftEvidence, a: Attempt) {
    if (
      !a.quote ||
      a.quote.nativeCurrency !== 'USD' ||
      !a.submittedAt ||
      e.jobId !== a.job.id ||
      e.cardAccountId !== a.account.cardAccountId ||
      e.purchaseReference !== a.reference ||
      !identifier(e.reference) ||
      !identifier(e.chargeReference) ||
      e.currency !== 'USD' ||
      e.spentUsdCents !== a.quote.totalUsdCents ||
      e.recipientProviderId !== a.job.recipient.providerId ||
      e.recipientUsername !== a.job.recipient.username ||
      e.platform !== a.job.recipient.platform ||
      e.giftUnits !== a.account.giftUnits ||
      e.cardLast4 !== a.account.cardLast4 ||
      e.chargeStatus !== 'POSTED' ||
      !/^[a-f0-9]{64}$/.test(e.receiptDigest) ||
      !/^[a-f0-9]{64}$/.test(e.chargeDigest) ||
      !Number.isFinite(Date.parse(e.postedAt)) ||
      Date.parse(e.postedAt) < Date.parse(a.submittedAt) ||
      Date.parse(e.postedAt) > Date.now()
    )
      fail();
  }
  async reconcile(job: PipelineJob): Promise<BrowserGiftEvidence | null> {
    let a = this.get(job.id);
    this.assertJob(job, a);
    if (!a) return null;
    if (a.phase === 'settled') return a.evidence ?? null;
    if (!this.options.readEvidence || !this.provider) return null;
    if (!a.session) {
      const found = await this.provider.findSessions(a.attemptId);
      if (found.length !== 1) return null;
      this.session(found[0], a);
      const bound = { ...a, session: found[0] };
      this.save(a, bound);
      a = bound;
    }
    if (!a.quote || !a.submittedAt || !['submitting', 'observed'].includes(a.phase)) return null;
    const observedEvidence = await this.options.readEvidence(
      structuredClone({
        job: a.job,
        cardAccountId: a.account.cardAccountId,
        purchaseReference: a.reference,
        intent: a.intent,
        quote: a.quote,
        submittedAt: a.submittedAt,
        ...(a.delivery ? { delivery: a.delivery } : {}),
      }),
    );
    if (!observedEvidence) return null;
    const evidence = structuredClone(observedEvidence);
    this.validateEvidence(evidence, a);
    if (this.connector?.hasActiveConnection(a.session!.id)) return null;
    let session = await this.provider.getSession(a.session!.id);
    this.session(session, a);
    if (['RUNNING', 'PENDING'].includes(session.status)) {
      session = await this.provider.releaseSession(session.id);
      this.session(session, a);
      if (['RUNNING', 'PENDING'].includes(session.status)) return null;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(job.id);
      if (!current || current.phase === 'settled' || JSON.stringify(current) !== JSON.stringify(a))
        fail();
      this.db
        .prepare('INSERT INTO agent_browser_evidence VALUES(?,?,?)')
        .run(evidence.reference, evidence.chargeReference, job.id);
      this.save(a, { ...a, phase: 'settled', session, evidence });
      if (
        this.db
          .prepare(
            'DELETE FROM agent_browser_context_locks WHERE context_id=? AND reference=? AND lease_id=?',
          )
          .run(a.account.contextId, a.reference, a.leaseId).changes !== 1
      )
        fail();
      this.db.exec('COMMIT');
    } catch {
      this.db.exec('ROLLBACK');
      fail();
    }
    return evidence;
  }
}
