import type { DatabaseSync } from 'node:sqlite';

export interface FeeLot {
  id: string;
  tokenId: string;
  chain: 'solana' | 'bnb' | 'robinhood';
  asset: 'SOL' | 'BNB' | 'ETH';
  amountBaseUnits: string;
  decimals: number;
  claimReference: string;
  recipient: { platform: 'twitch' | 'kick'; providerId: string; username: string };
}
export function canonicalFeeLot(lot: FeeLot): FeeLot {
  const asset = { solana: 'SOL', bnb: 'BNB', robinhood: 'ETH' }[lot.chain];
  if (
    !lot.id ||
    !lot.tokenId ||
    !lot.claimReference ||
    asset !== lot.asset ||
    !/^[1-9]\d{0,77}$/.test(lot.amountBaseUnits) ||
    lot.decimals !== (lot.chain === 'solana' ? 9 : 18) ||
    !['twitch', 'kick'].includes(lot.recipient.platform) ||
    !new RegExp(`^${lot.recipient.platform}:[1-9]\\d*$`).test(lot.recipient.providerId) ||
    !/^[a-zA-Z0-9_]{3,25}$/.test(lot.recipient.username)
  )
    throw new Error('Invalid finalized fee lot.');
  return {
    id: lot.id,
    tokenId: lot.tokenId,
    chain: lot.chain,
    asset: lot.asset,
    amountBaseUnits: lot.amountBaseUnits,
    decimals: lot.decimals,
    claimReference: lot.claimReference,
    recipient: {
      platform: lot.recipient.platform,
      providerId: lot.recipient.providerId,
      username: lot.recipient.username,
    },
  };
}

export const NATIVE_STREAMER_VERSION = 'native-streamer-v1' as const;
export interface PipelineJob extends FeeLot {
  allocationVersion?: typeof NATIVE_STREAMER_VERSION;
  createdAt?: string;
  completedAt?: string;
  phase:
    'claimed' | 'depositing' | 'deposited' | 'converting' | 'converted' | 'gifting' | 'completed';
  depositReference?: string;
  conversionReference?: string;
  giftReference?: string;
  netUsdCents?: number;
  streamerBudgetUsdCents?: number;
  platformReserveUsdCents?: number;
  cardAccountId?: string;
  spentUsdCents?: number;
  residualUsdCents?: number;
  receiptReference?: string;
  issue?: string;
}
export interface PipelineAdapters {
  /** Implementations persist transaction bytes/identity BEFORE sending. Stable lot.id is the idempotency key. */
  deposit(lot: FeeLot): Promise<{ reference: string }>;
  /** Must recover by lot.id even when submission timed out before returning a reference. */
  reconcileDeposit(job: PipelineJob): Promise<{ reference: string; jobId: string } | null>;
  convert(job: PipelineJob): Promise<{ reference: string }>;
  reconcileConversion(
    job: PipelineJob,
  ): Promise<{ reference: string; jobId: string; netUsdCents: number } | null>;
  live(lot: FeeLot): Promise<boolean>;
  /** Independent issuer evidence. Coinbase exchange cash is not card capacity. */
  cardReady(
    job: PipelineJob,
  ): Promise<{ cardAccountId: string; availableCreditCents: number; observedAt: number } | null>;
  gift(job: PipelineJob): Promise<{ reference: string }>;
  reconcileGift(job: PipelineJob): Promise<{
    reference: string;
    chargeReference: string;
    spentUsdCents: number;
    recipientProviderId: string;
    currency: 'USD';
    jobId: string;
    cardAccountId: string;
    chargeStatus: 'POSTED';
    purchaseReference: string;
  } | null>;
}
export interface PipelinePolicy {
  enabled: boolean;
  minimumGiftUsdCents: number;
  maximumGiftUsdCents: number;
  /** Compatibility only: native routing already allocated these proceeds; only 10000 is accepted. */
  streamerBps?: number;
}
const validCents = (n: number) => Number.isSafeInteger(n) && n > 0;
function validAllocation(job: PipelineJob) {
  return (
    validCents(job.netUsdCents!) &&
    Number.isSafeInteger(job.streamerBudgetUsdCents) &&
    job.streamerBudgetUsdCents! >= 0 &&
    Number.isSafeInteger(job.platformReserveUsdCents) &&
    job.platformReserveUsdCents === 0 &&
    BigInt(job.streamerBudgetUsdCents!) + BigInt(job.platformReserveUsdCents!) ===
      BigInt(job.netUsdCents!)
  );
}

/** Worker-only state machine. There is no HTTP mutation surface or human approval bypass.
 * A compare-and-swap commits the uncertain phase before each external side effect.
 * Restarts reconcile the same identity; they never authorize a second purchase.
 */
export class AutonomousPipeline {
  private running?: Promise<void>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly adapters: PipelineAdapters,
    private readonly policy: PipelinePolicy,
  ) {
    if (
      !validCents(policy.minimumGiftUsdCents) ||
      !validCents(policy.maximumGiftUsdCents) ||
      policy.maximumGiftUsdCents < policy.minimumGiftUsdCents ||
      (policy.streamerBps !== undefined && policy.streamerBps !== 10000)
    )
      throw new Error('Invalid autonomous spending limits.');
    db.exec(`CREATE TABLE IF NOT EXISTS agent_fee_jobs(id TEXT PRIMARY KEY, claim_identity TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_pipeline_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_rowid INTEGER NOT NULL);
      INSERT OR IGNORE INTO agent_pipeline_cursor(singleton,last_rowid) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS agent_funding_evidence(reference TEXT NOT NULL, kind TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(reference,kind), UNIQUE(job_id,kind));
      CREATE TABLE IF NOT EXISTS agent_card_reservations(job_id TEXT PRIMARY KEY, card_account TEXT NOT NULL, cents INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS agent_receipts(receipt TEXT PRIMARY KEY, charge TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS agent_events(sequence INTEGER PRIMARY KEY, job_id TEXT NOT NULL, phase TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS agent_events_no_update BEFORE UPDATE ON agent_events BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
      CREATE TRIGGER IF NOT EXISTS agent_events_no_delete BEFORE DELETE ON agent_events BEGIN SELECT RAISE(ABORT,'immutable audit'); END;`);
  }
  /** Trusted intake of already allocated streamer lots only; services must enter through the native router. */
  recordClaim(lot: FeeLot) {
    lot = canonicalFeeLot(lot);
    const old = this.db.prepare('SELECT payload FROM agent_fee_jobs WHERE id=?').get(lot.id);
    if (old) {
      const saved = JSON.parse(String(old.payload)) as PipelineJob;
      if (saved.allocationVersion !== NATIVE_STREAMER_VERSION)
        throw new Error('Unsupported saved allocation version.');
      for (const key of Object.keys(lot) as (keyof FeeLot)[])
        if (JSON.stringify(saved[key]) !== JSON.stringify(lot[key]))
          throw new Error('Conflicting fee identity.');
      return;
    }
    this.db.prepare('INSERT INTO agent_fee_jobs VALUES(?,?,?,0,?)').run(
      lot.id,
      `${lot.chain}:${lot.claimReference}:${lot.tokenId}`,
      'claimed',
      JSON.stringify({
        ...lot,
        allocationVersion: NATIVE_STREAMER_VERSION,
        phase: 'claimed',
        createdAt: new Date().toISOString(),
      }),
    );
  }
  private creditEvidence(jobId: string, kind: string, reference: string) {
    const old = this.db
      .prepare('SELECT job_id FROM agent_funding_evidence WHERE reference=? AND kind=?')
      .get(reference, kind);
    if (old?.job_id === jobId) return;
    this.db.prepare('INSERT INTO agent_funding_evidence VALUES(?,?,?)').run(reference, kind, jobId);
  }
  list(): PipelineJob[] {
    return this.db
      .prepare('SELECT payload FROM agent_fee_jobs ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  private save(job: PipelineJob, expectedRevision: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved =
        this.db
          .prepare(
            'UPDATE agent_fee_jobs SET phase=?,revision=revision+1,payload=? WHERE id=? AND revision=?',
          )
          .run(job.phase, JSON.stringify(job), job.id, expectedRevision).changes === 1;
      if (saved)
        this.db
          .prepare('INSERT INTO agent_events(job_id,phase,recorded_at) VALUES(?,?,?)')
          .run(job.id, job.phase, new Date().toISOString());
      this.db.exec('COMMIT');
      return saved;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  runOnce(): Promise<void> {
    if (!this.policy.enabled) return Promise.resolve();
    return (this.running ??= this.run().finally(() => {
      this.running = undefined;
    }));
  }
  private nextBatch() {
    // Reserve a bounded slice before asynchronous work. Persisted rotation means
    // held jobs and a crashed worker cannot monopolize the head of the queue.
    // This is scheduling only; per-job CAS still grants all spending authority.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cursor = this.db
        .prepare('SELECT last_rowid FROM agent_pipeline_cursor WHERE singleton=1')
        .get()!.last_rowid;
      const rows = this.db
        .prepare(
          "SELECT rowid AS queue_rowid,payload,revision FROM agent_fee_jobs WHERE phase!='completed' AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(cursor);
      if (rows.length < 100) {
        rows.push(
          ...this.db
            .prepare(
              "SELECT rowid AS queue_rowid,payload,revision FROM agent_fee_jobs WHERE phase!='completed' AND rowid<=? ORDER BY rowid LIMIT ?",
            )
            .all(cursor, 100 - rows.length),
        );
      }
      this.db
        .prepare('UPDATE agent_pipeline_cursor SET last_rowid=? WHERE singleton=1')
        .run(rows.at(-1)?.queue_rowid ?? 0);
      this.db.exec('COMMIT');
      return rows;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private async run() {
    const rows = this.nextBatch();
    for (const row of rows) {
      let job = JSON.parse(String(row.payload)) as PipelineJob;
      let revision = Number(row.revision);
      const transition = (phase: PipelineJob['phase']) => {
        const next = { ...job, phase };
        delete next.issue;
        if (!this.save(next, revision)) return false;
        job = next;
        revision++;
        return true;
      };
      if (job.allocationVersion !== NATIVE_STREAMER_VERSION) {
        if (!job.issue?.includes('allocation version'))
          this.save(
            {
              ...job,
              issue: 'Unsupported allocation version; historical financial operation remains held.',
            },
            revision,
          );
        continue;
      }
      try {
        switch (job.phase) {
          case 'claimed': {
            if (!transition('depositing')) break;
            const result = await this.adapters.deposit(job);
            if (!result.reference) throw new Error();
            job.depositReference = result.reference;
            this.save(job, revision);
            break;
          }
          case 'depositing': {
            const proof = await this.adapters.reconcileDeposit(job);
            if (proof) {
              if (proof.jobId !== job.id || !proof.reference) throw new Error();
              this.creditEvidence(job.id, 'deposit', proof.reference);
              job.depositReference = proof.reference;
              transition('deposited');
            }
            break;
          }
          case 'deposited': {
            if (!transition('converting')) break;
            const result = await this.adapters.convert(job);
            if (!result.reference) throw new Error();
            job.conversionReference = result.reference;
            this.save(job, revision);
            break;
          }
          case 'converting': {
            const result = await this.adapters.reconcileConversion(job);
            if (result && validCents(result.netUsdCents)) {
              if (result.jobId !== job.id || !result.reference) throw new Error();
              this.creditEvidence(job.id, 'conversion', result.reference);
              job.conversionReference = result.reference;
              job.netUsdCents = result.netUsdCents;
              job.platformReserveUsdCents = 0;
              job.streamerBudgetUsdCents = result.netUsdCents;
              transition('converted');
            }
            break;
          }
          case 'converted': {
            if (
              !validAllocation(job) ||
              !job.streamerBudgetUsdCents ||
              job.streamerBudgetUsdCents < this.policy.minimumGiftUsdCents ||
              job.streamerBudgetUsdCents > this.policy.maximumGiftUsdCents
            )
              break;
            if (!(await this.adapters.live(job))) break;
            const card = await this.adapters.cardReady(job);
            if (
              !card ||
              !card.cardAccountId ||
              !validCents(card.availableCreditCents) ||
              !Number.isFinite(card.observedAt) ||
              Date.now() - card.observedAt > 60000 ||
              card.observedAt > Date.now()
            )
              break;
            this.db.exec('BEGIN IMMEDIATE');
            try {
              const current = this.db
                .prepare('SELECT revision FROM agent_fee_jobs WHERE id=?')
                .get(job.id);
              const held = this.db
                .prepare(
                  'SELECT COALESCE(SUM(cents),0) AS cents, MAX(completed_at) AS completed FROM agent_card_reservations WHERE card_account=? AND (completed_at IS NULL OR completed_at>=?)',
                )
                .get(card.cardAccountId, card.observedAt)!;
              if (
                current?.revision !== revision ||
                Number(held.cents) + job.streamerBudgetUsdCents > card.availableCreditCents
              ) {
                this.db.exec('ROLLBACK');
                break;
              }
              this.db
                .prepare('INSERT INTO agent_card_reservations VALUES(?,?,?,NULL)')
                .run(job.id, card.cardAccountId, job.streamerBudgetUsdCents);
              job = { ...job, phase: 'gifting', cardAccountId: card.cardAccountId };
              delete job.issue;
              this.db
                .prepare(
                  'UPDATE agent_fee_jobs SET phase=?,revision=revision+1,payload=? WHERE id=?',
                )
                .run(job.phase, JSON.stringify(job), job.id);
              this.db
                .prepare('INSERT INTO agent_events(job_id,phase,recorded_at) VALUES(?,?,?)')
                .run(job.id, job.phase, new Date().toISOString());
              this.db.exec('COMMIT');
              revision++;
            } catch (error) {
              this.db.exec('ROLLBACK');
              throw error;
            }
            // The browser adapter must recheck liveness and the exact quote immediately at final submit.
            const result = await this.adapters.gift(job);
            if (!result.reference) throw new Error();
            job.giftReference = result.reference;
            this.save(job, revision);
            break;
          }
          case 'gifting': {
            if (!validAllocation(job)) throw new Error('Invalid saved allocation.');
            const receipt = await this.adapters.reconcileGift(job);
            if (!receipt) break;
            if (
              !receipt.reference ||
              !receipt.chargeReference ||
              receipt.currency !== 'USD' ||
              receipt.recipientProviderId !== job.recipient.providerId ||
              !validCents(receipt.spentUsdCents) ||
              receipt.spentUsdCents > job.streamerBudgetUsdCents! ||
              receipt.jobId !== job.id ||
              receipt.cardAccountId !== job.cardAccountId ||
              receipt.chargeStatus !== 'POSTED' ||
              !receipt.purchaseReference ||
              (job.giftReference && receipt.purchaseReference !== job.giftReference)
            )
              throw new Error();
            this.db.exec('BEGIN IMMEDIATE');
            try {
              const current = this.db
                .prepare('SELECT revision FROM agent_fee_jobs WHERE id=?')
                .get(job.id);
              if (current?.revision !== revision) {
                this.db.exec('ROLLBACK');
                break;
              }
              this.db
                .prepare('INSERT INTO agent_receipts VALUES(?,?,?)')
                .run(receipt.reference, receipt.chargeReference, job.id);
              this.db
                .prepare('UPDATE agent_card_reservations SET cents=?,completed_at=? WHERE job_id=?')
                .run(receipt.spentUsdCents, Date.now(), job.id);
              job = {
                ...job,
                phase: 'completed',
                completedAt: new Date().toISOString(),
                receiptReference: receipt.reference,
                spentUsdCents: receipt.spentUsdCents,
                residualUsdCents: job.streamerBudgetUsdCents! - receipt.spentUsdCents,
              };
              this.db
                .prepare(
                  'UPDATE agent_fee_jobs SET phase=?,revision=revision+1,payload=? WHERE id=?',
                )
                .run(job.phase, JSON.stringify(job), job.id);
              this.db
                .prepare('INSERT INTO agent_events(job_id,phase,recorded_at) VALUES(?,?,?)')
                .run(job.id, job.phase, new Date().toISOString());
              this.db.exec('COMMIT');
            } catch (error) {
              this.db.exec('ROLLBACK');
              throw error;
            }
            break;
          }
        }
      } catch {
        // Do not expose remote errors or release reservations on uncertain outcomes.
        this.save(
          { ...job, issue: 'Provider evidence pending; the original operation remains reserved.' },
          revision,
        );
      }
    }
  }
}
