import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { OperationPayment, RegisteredToken } from '../operations.ts';
import type { NativeFundingIntent } from '../payouts/native-funding-types.ts';

export interface FundingRecoveryGrant {
  paymentId: string;
  scope: string;
  freezeFingerprint: string;
  expiresAt: string;
  createdAt: string;
  actor: string;
}

export interface GlobalRecoveryGrant {
  id: string;
  freezeFingerprint: string;
  reviewFingerprint: string;
  note: string;
  actor: string;
  createdAt: string;
}

export const TESTING_CAP_USD_CENTS = 30_000;
export type TestingCostKind =
  'gift' | 'chain_fee' | 'offramp_fee' | 'browser_fee' | 'provider_fee' | 'buyback';
export type TestingCostState = 'reserved' | 'unresolved' | 'settled' | 'released';
export interface TestingCostReservation {
  operationId: string;
  kind: TestingCostKind;
  /** A conservative final USD ceiling, including all charges represented by this operation. */
  maxUsdCents: number;
}
export type TestingCostEvidenceKind =
  | 'twitch_receipt'
  | 'kick_receipt'
  | 'solana_transaction_fee'
  | 'solana_buyback'
  | 'coinbase_invoice_fee'
  | 'browserbase_invoice_item'
  | 'provider_invoice_item'
  | 'operator_attested_twitch_receipt'
  | 'operator_attested_kick_receipt'
  | 'operator_attested_twitch_purchase'
  | 'operator_attested_kick_purchase'
  | 'operator_attested_coinbase_fee';
export interface TestingCostProof {
  attemptId: string;
  actualUsdCents: number;
  evidenceId: string;
  evidenceKind: TestingCostEvidenceKind;
}
export interface TestingNoSpendProof {
  attemptId: string;
  evidenceId: string;
  evidenceKind: 'provider_final_no_charge' | 'finalized_chain_no_fee';
}
export interface TestingCostOperation extends TestingCostReservation {
  state: TestingCostState;
  attemptId?: string;
  actualUsdCents?: number;
  evidenceId?: string;
  evidenceKind?: TestingCostEvidenceKind | TestingNoSpendProof['evidenceKind'];
  releaseReason?: 'cancelled_before_execution' | 'verified_final_no_spend';
  createdAt: string;
  updatedAt: string;
}
/** Widen creator-backed rows transactionally; original values and immutability triggers survive. */
function migrateCreatorCostCeilings(db: DatabaseSync) {
  const tables = ['worker_testing_budget_costs', 'worker_creator_funding_authorizations'];
  const migrations = tables.flatMap((name) => {
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(name)?.sql;
    return typeof sql === 'string' && /max_cents\s*<=\s*30000/.test(sql) ? [{ name, sql }] : [];
  });
  if (!migrations.length) return;
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?)")
    .all(...tables);
  // Drop/recreate both sets together so no temporarily dangling cross-table trigger is validated.
  for (const trigger of triggers)
    db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
  for (const { name, sql } of migrations) {
    const temporary = `${name}_ceiling_v2`;
    const create = sql
      .replace(name, temporary)
      .replace(/max_cents\s*<=\s*30000/g, 'max_cents<=500000');
    db.exec(create);
    const columns = db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((row) => `"${String(row.name).replaceAll('"', '""')}"`)
      .join(',');
    db.exec(`INSERT INTO ${temporary}(rowid,${columns}) SELECT rowid,${columns} FROM ${name}`);
    db.exec(`DROP TABLE ${name}`);
    db.exec(`ALTER TABLE ${temporary} RENAME TO ${name}`);
  }
  for (const trigger of triggers) db.exec(String(trigger.sql));
}

export class TestingBudgetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const KINDS: readonly TestingCostKind[] = [
  'gift',
  'chain_fee',
  'offramp_fee',
  'browser_fee',
  'provider_fee',
  'buyback',
];
const EVIDENCE: Record<TestingCostKind, readonly TestingCostEvidenceKind[]> = {
  gift: [
    'twitch_receipt',
    'kick_receipt',
    'operator_attested_twitch_receipt',
    'operator_attested_kick_receipt',
    'operator_attested_twitch_purchase',
    'operator_attested_kick_purchase',
  ],
  chain_fee: ['solana_transaction_fee'],
  offramp_fee: ['coinbase_invoice_fee', 'operator_attested_coinbase_fee'],
  browser_fee: ['browserbase_invoice_item'],
  provider_fee: ['provider_invoice_item'],
  buyback: ['solana_buyback'],
};
function evidenceFamily(kind: string): string {
  return (
    (
      {
        operator_attested_twitch_receipt: 'twitch_receipt',
        operator_attested_kick_receipt: 'kick_receipt',
        operator_attested_twitch_purchase: 'twitch_receipt',
        operator_attested_kick_purchase: 'kick_receipt',
        operator_attested_coinbase_fee: 'coinbase_invoice_fee',
      } as Record<string, string>
    )[kind] ?? kind
  );
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,180}$/.test(value))
    throw new TestingBudgetError(
      400,
      'Use a non-secret operation, attempt, actor or evidence identifier.',
    );
  return value;
}
function cents(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000_000_000
  )
    throw new TestingBudgetError(
      400,
      'Amounts must be positive integer USD cents within the supported range.',
    );
  return value;
}

/** Single database-wide testing ceiling. Trusted adapters verify external evidence;
 * this component never treats browser labels or user-submitted amounts as proof. */
export class TestingBudget {
  /** Transaction composition requires the same connection, not merely the same file. */
  usesDatabase(db: DatabaseSync): boolean {
    return this.db === db;
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    let ownsTransaction = true;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (!(error instanceof Error) || !/within a transaction/.test(error.message)) throw error;
      ownsTransaction = false;
      db.exec('SAVEPOINT creator_budget_schema');
    }
    try {
      migrateCreatorCostCeilings(db);
      db.exec(`
      CREATE TABLE IF NOT EXISTS worker_testing_budget_config (
        id INTEGER PRIMARY KEY CHECK(id=1), cap_cents INTEGER NOT NULL CHECK(cap_cents=30000),
        frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1)), freeze_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO worker_testing_budget_config(id,cap_cents) VALUES(1,30000);
      CREATE TABLE IF NOT EXISTS worker_testing_budget_costs (
        operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        max_cents INTEGER NOT NULL CHECK(max_cents>0 AND max_cents<=500000),
        state TEXT NOT NULL CHECK(state IN ('reserved','unresolved','settled','released')),
        attempt_id TEXT UNIQUE, actual_cents INTEGER, evidence_kind TEXT, evidence_id TEXT,
        release_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(evidence_kind,evidence_id),
        CHECK((state='settled' AND actual_cents>0 AND attempt_id IS NOT NULL AND evidence_id IS NOT NULL)
          OR (state!='settled' AND actual_cents IS NULL))
      );
      CREATE TABLE IF NOT EXISTS worker_testing_budget_events (
        id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, event TEXT NOT NULL,
        actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_cap_immutable
        BEFORE UPDATE ON worker_testing_budget_config WHEN NEW.cap_cents!=OLD.cap_cents OR NEW.id!=OLD.id
        BEGIN SELECT RAISE(ABORT,'Testing cap is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_config_no_delete
        BEFORE DELETE ON worker_testing_budget_config BEGIN SELECT RAISE(ABORT,'Testing cap is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_freeze_immutable
        BEFORE UPDATE ON worker_testing_budget_config WHEN OLD.frozen=1 AND NEW.frozen!=1
        BEGIN SELECT RAISE(ABORT,'Testing freeze is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_identity_immutable
        BEFORE UPDATE ON worker_testing_budget_costs
        WHEN NEW.operation_id!=OLD.operation_id OR NEW.kind!=OLD.kind OR NEW.max_cents!=OLD.max_cents
          OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id)
          OR OLD.state IN ('settled','released')
        BEGIN SELECT RAISE(ABORT,'Testing cost identity and terminal proof are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_costs_no_delete
        BEFORE DELETE ON worker_testing_budget_costs BEGIN SELECT RAISE(ABORT,'Testing costs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_events_no_update
        BEFORE UPDATE ON worker_testing_budget_events BEGIN SELECT RAISE(ABORT,'Testing events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_events_no_delete
        BEFORE DELETE ON worker_testing_budget_events BEGIN SELECT RAISE(ABORT,'Testing events are immutable'); END;
      CREATE TABLE IF NOT EXISTS worker_funding_recovery_grants (
        payment_id TEXT PRIMARY KEY, scope TEXT NOT NULL, freeze_fingerprint TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
        token_id TEXT NOT NULL, creator_address TEXT NOT NULL, budget_cents INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS worker_funding_recovery_no_update
        BEFORE UPDATE ON worker_funding_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Funding recovery grants are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_funding_recovery_no_delete
        BEFORE DELETE ON worker_funding_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Funding recovery grants are immutable'); END;
      CREATE TABLE IF NOT EXISTS worker_global_recovery_grants (
        id TEXT PRIMARY KEY, freeze_fingerprint TEXT NOT NULL UNIQUE,
        review_fingerprint TEXT NOT NULL, note TEXT NOT NULL,
        actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS worker_global_recovery_no_update
        BEFORE UPDATE ON worker_global_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Global recovery grants are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_global_recovery_no_delete
        BEFORE DELETE ON worker_global_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Global recovery grants are immutable'); END;
      CREATE TABLE IF NOT EXISTS worker_creator_funding_authorizations (
        operation_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, token_id TEXT NOT NULL,
        budget_cents INTEGER NOT NULL CHECK(budget_cents>0),
        kind TEXT NOT NULL CHECK(kind IN ('gift','chain_fee','offramp_fee')),
        max_cents INTEGER NOT NULL CHECK(max_cents>0 AND max_cents<=500000),
        source_payload TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(payment_id,kind),
        CHECK(operation_id=CASE kind WHEN 'gift' THEN 'gift:' || payment_id
          WHEN 'chain_fee' THEN 'gas:funding:' || payment_id
          WHEN 'offramp_fee' THEN 'offramp:' || payment_id END)
      );
      CREATE TRIGGER IF NOT EXISTS worker_large_cost_requires_creator
        BEFORE INSERT ON worker_testing_budget_costs
        WHEN NEW.max_cents>30000 AND NOT EXISTS(
          SELECT 1 FROM worker_creator_funding_authorizations
          WHERE operation_id=NEW.operation_id AND kind=NEW.kind AND max_cents=NEW.max_cents)
        BEGIN SELECT RAISE(ABORT,'Large costs require exact creator funding authorization'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_cost_ceiling
        BEFORE INSERT ON worker_creator_funding_authorizations
        WHEN NEW.max_cents>CASE NEW.kind WHEN 'gift' THEN 500000 ELSE 30000 END
        BEGIN SELECT RAISE(ABORT,'Creator cost exceeds its configured boundary'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_reclassification
        BEFORE INSERT ON worker_creator_funding_authorizations
        WHEN EXISTS(SELECT 1 FROM worker_testing_budget_costs WHERE operation_id=NEW.operation_id)
        BEGIN SELECT RAISE(ABORT,'Existing testing costs cannot be reclassified'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_update
        BEFORE UPDATE ON worker_creator_funding_authorizations
        BEGIN SELECT RAISE(ABORT,'Creator funding authorizations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_delete
        BEFORE DELETE ON worker_creator_funding_authorizations
        BEGIN SELECT RAISE(ABORT,'Creator funding authorizations are immutable'); END;
    `);
      if (
        Number(
          db.prepare('SELECT cap_cents FROM worker_testing_budget_config WHERE id=1').get()
            ?.cap_cents,
        ) !== TESTING_CAP_USD_CENTS
      )
        throw new TestingBudgetError(
          503,
          'The persistent testing cap does not match the authorized limit.',
        );
      db.exec(ownsTransaction ? 'COMMIT' : 'RELEASE creator_budget_schema');
    } catch (error) {
      db.exec(
        ownsTransaction
          ? 'ROLLBACK'
          : 'ROLLBACK TO creator_budget_schema; RELEASE creator_budget_schema',
      );
      throw error;
    }
  }
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private write<T>(work: () => T, standalone = false): T {
    if (standalone) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
      } catch {
        throw new TestingBudgetError(
          409,
          'Execution authorization requires an available standalone transaction; commit any outer transaction before continuing.',
        );
      }
      try {
        const result = work();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    const savepoint = `testing_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      // Acquire SQLite's writer lock before inspecting aggregate balances. This also
      // composes with a caller transaction; never hold it across an external request.
      this.db
        .prepare('UPDATE worker_testing_budget_config SET revision=revision+1 WHERE id=1')
        .run();
      const result = work();
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }
  private decode(row: Record<string, unknown>): TestingCostOperation {
    return {
      operationId: String(row.operation_id),
      kind: row.kind as TestingCostKind,
      maxUsdCents: Number(row.max_cents),
      state: row.state as TestingCostState,
      ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
      ...(row.actual_cents === null ? {} : { actualUsdCents: Number(row.actual_cents) }),
      ...(row.evidence_id === null
        ? {}
        : {
            evidenceId: String(row.evidence_id),
            evidenceKind: row.evidence_kind as TestingCostOperation['evidenceKind'],
          }),
      ...(row.release_reason === null
        ? {}
        : { releaseReason: row.release_reason as TestingCostOperation['releaseReason'] }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  get(operationId: string): TestingCostOperation | undefined {
    const row = this.db
      .prepare('SELECT * FROM worker_testing_budget_costs WHERE operation_id=?')
      .get(identifier(operationId));
    return row ? this.decode(row) : undefined;
  }
  list(): TestingCostOperation[] {
    return this.db
      .prepare('SELECT * FROM worker_testing_budget_costs ORDER BY rowid')
      .all()
      .map((row) => this.decode(row));
  }
  private required(operationId: string) {
    const value = this.get(operationId);
    if (!value) throw new TestingBudgetError(404, 'Testing cost operation does not exist.');
    return value;
  }
  /** Binds approval to immutable confirmed overruns and the latest explicit incident. */
  fundingRecoveryChallenge() {
    const status = this.snapshot();
    if (status.overCapUsdCents)
      throw new TestingBudgetError(409, 'Funding recovery cannot bypass the total testing cap.');
    if (!status.frozen || status.freezeReason !== 'confirmed_cost_exceeded_reservation')
      throw new TestingBudgetError(
        409,
        'Funding recovery requires a confirmed reservation overrun freeze.',
      );
    return this.recoveryIncident();
  }
  /** Raw incident state avoids letting a prior global acknowledgement hide a new incident. */
  private recoveryIncident() {
    const config = this.db
      .prepare('SELECT frozen,freeze_reason FROM worker_testing_budget_config WHERE id=1')
      .get()!;
    if (!config.frozen || config.freeze_reason !== 'confirmed_cost_exceeded_reservation')
      throw new TestingBudgetError(
        409,
        'Recovery requires a confirmed reservation overrun freeze.',
      );
    const overruns = this.db
      .prepare(
        `SELECT operation_id,max_cents,actual_cents,evidence_kind,evidence_id
      FROM worker_testing_budget_costs WHERE state='settled' AND actual_cents>max_cents
      ORDER BY operation_id`,
      )
      .all()
      .map((row) => ({
        operationId: String(row.operation_id),
        maxUsdCents: Number(row.max_cents),
        actualUsdCents: Number(row.actual_cents),
        evidenceKind: String(row.evidence_kind),
        evidenceId: String(row.evidence_id),
      }));
    if (!overruns.length)
      throw new TestingBudgetError(
        409,
        'Funding recovery requires immutable confirmed overrun evidence.',
      );
    const incident = this.db
      .prepare(
        "SELECT id,payload FROM worker_testing_budget_events WHERE event='testing_frozen' ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (incident) {
      let reason: unknown;
      try {
        reason = JSON.parse(String(incident.payload))?.reason;
      } catch {
        /* Invalid incident is not recoverable. */
      }
      if (reason !== 'confirmed_cost_exceeded_reservation')
        throw new TestingBudgetError(
          409,
          'Funding recovery cannot bypass an unresolved policy freeze incident.',
        );
    }
    const freezeFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          freezeReason: config.freeze_reason,
          overruns,
          incidentId: incident?.id ?? null,
        }),
      )
      .digest('hex');
    return { freezeFingerprint, freezeReason: String(config.freeze_reason), overruns };
  }
  private decodeGlobalRecovery(row: Record<string, unknown>): GlobalRecoveryGrant {
    return {
      id: String(row.id),
      freezeFingerprint: String(row.freeze_fingerprint),
      reviewFingerprint: String(row.review_fingerprint),
      note: String(row.note),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    };
  }
  globalRecoveryChallenge(contextFingerprint?: string) {
    const budget = this.snapshot();
    if (budget.overCapUsdCents)
      throw new TestingBudgetError(409, 'Global recovery cannot bypass the total testing cap.');
    const { freezeFingerprint, overruns } = this.recoveryIncident();
    const costs = this.list();
    for (const overrun of overruns) {
      const operation = costs.find((cost) => cost.operationId === overrun.operationId)!;
      if (
        !operation.attemptId ||
        !operation.evidenceId ||
        !operation.evidenceKind ||
        !EVIDENCE[operation.kind]?.includes(operation.evidenceKind as TestingCostEvidenceKind)
      )
        throw new TestingBudgetError(
          409,
          'Global recovery requires complete immutable overrun evidence.',
        );
    }
    const reviewFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          freezeFingerprint,
          contextFingerprint: contextFingerprint ?? null,
          costs,
          creatorAuthorizations: this.db
            .prepare('SELECT * FROM worker_creator_funding_authorizations ORDER BY operation_id')
            .all(),
          fundingRecoveries: this.db
            .prepare('SELECT * FROM worker_funding_recovery_grants ORDER BY payment_id')
            .all(),
          capUsdCents: budget.capUsdCents,
          allocatedUsdCents: budget.allocatedUsdCents,
          creatorFunding: budget.creatorFunding,
        }),
      )
      .digest('hex');
    return {
      freezeFingerprint,
      reviewFingerprint,
      overruns,
      budget,
      unresolvedOperations: costs.filter((cost) => cost.state === 'unresolved'),
    };
  }
  approveGlobalRecovery(
    input: Pick<GlobalRecoveryGrant, 'freezeFingerprint' | 'reviewFingerprint' | 'note'>,
    actor: string,
    contextFingerprint?: string | (() => string),
  ): GlobalRecoveryGrant {
    identifier(actor);
    if (
      !input ||
      typeof input.freezeFingerprint !== 'string' ||
      typeof input.reviewFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.freezeFingerprint) ||
      !/^[a-f0-9]{64}$/.test(input.reviewFingerprint)
    )
      throw new TestingBudgetError(
        400,
        'Recovery freeze and review fingerprints must be SHA256 digests.',
      );
    if (
      typeof input.note !== 'string' ||
      input.note.trim().length < 10 ||
      input.note.trim().length > 1000
    )
      throw new TestingBudgetError(
        400,
        'Recovery note must contain between 10 and 1000 characters.',
      );
    const note = input.note.trim();
    return this.write(() => {
      const challenge = this.globalRecoveryChallenge(
        typeof contextFingerprint === 'function' ? contextFingerprint() : contextFingerprint,
      );
      if (challenge.freezeFingerprint !== input.freezeFingerprint)
        throw new TestingBudgetError(409, 'The global recovery freeze fingerprint is stale.');
      const old = this.db
        .prepare('SELECT * FROM worker_global_recovery_grants WHERE freeze_fingerprint=?')
        .get(input.freezeFingerprint);
      if (old) {
        const grant = this.decodeGlobalRecovery(old);
        if (
          grant.reviewFingerprint !== input.reviewFingerprint ||
          grant.note !== note ||
          grant.actor !== actor
        )
          throw new TestingBudgetError(
            409,
            'The original global recovery grant is immutable; conflicting approval rejected.',
          );
        return grant;
      }
      if (challenge.reviewFingerprint !== input.reviewFingerprint)
        throw new TestingBudgetError(
          409,
          'The global recovery review is stale; review current costs and reservations again.',
        );
      const grant: GlobalRecoveryGrant = {
        id: randomUUID(),
        freezeFingerprint: input.freezeFingerprint,
        reviewFingerprint: input.reviewFingerprint,
        note,
        actor,
        createdAt: this.timestamp(),
      };
      this.db
        .prepare(
          `INSERT INTO worker_global_recovery_grants
        (id,freeze_fingerprint,review_fingerprint,note,actor,created_at) VALUES(?,?,?,?,?,?)`,
        )
        .run(
          grant.id,
          grant.freezeFingerprint,
          grant.reviewFingerprint,
          grant.note,
          grant.actor,
          grant.createdAt,
        );
      this.db
        .prepare(
          'INSERT INTO worker_testing_budget_events(operation_id,event,actor,payload,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          'testing-budget',
          'global_recovery_approved',
          actor,
          JSON.stringify(grant),
          grant.createdAt,
        );
      return grant;
    }, true);
  }
  private recoveryPayment(paymentId: string, untouched = false) {
    for (const table of ['ops_payments', 'ops_tokens', 'ops_journal'])
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        throw new TestingBudgetError(
          409,
          'A real reserved creator payment is required for recovery.',
        );
    const row = this.db
      .prepare(
        `SELECT p.token_id,p.status,p.payload,
      t.creator_address,t.payload AS token_payload FROM ops_payments p
      JOIN ops_tokens t ON t.id=p.token_id WHERE p.id=?`,
      )
      .get(paymentId);
    if (!row)
      throw new TestingBudgetError(
        409,
        'A real reserved creator payment is required for recovery.',
      );
    let payment: OperationPayment, token: RegisteredToken;
    try {
      payment = JSON.parse(String(row.payload));
      token = JSON.parse(String(row.token_payload));
    } catch {
      throw new TestingBudgetError(409, 'The recovery payment identity is invalid.');
    }
    if (
      !payment ||
      !token ||
      payment.id !== paymentId ||
      payment.tokenId !== row.token_id ||
      token.id !== row.token_id ||
      token.creatorAddress !== row.creator_address ||
      !token.creatorAddress ||
      ('kind' in token && token.kind === 'platform') ||
      token.recipientPlatform !== 'twitch' ||
      !token.recipientVerified ||
      !token.dedicatedCreatorVerified ||
      payment.status !== row.status ||
      !(untouched ? ['reserved'] : ['reserved', 'funding_pending']).includes(payment.status) ||
      payment.funding ||
      payment.completion ||
      payment.failedFunding ||
      (untouched && payment.nativeFundingIntent)
    )
      throw new TestingBudgetError(
        409,
        'Recovery requires an untouched reserved community creator payment with matching identity.',
      );
    cents(payment.budgetCents);
    const reserved = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ops_journal WHERE payment_id=? AND token_id=? AND account='reserved'",
      )
      .get(paymentId, payment.tokenId);
    if (Number(reserved?.amount) < payment.budgetCents)
      throw new TestingBudgetError(409, 'The recovery creator payment budget is not reserved.');
    return { payment, token };
  }
  private decodeRecovery(row: Record<string, unknown>): FundingRecoveryGrant {
    return {
      paymentId: String(row.payment_id),
      scope: String(row.scope),
      freezeFingerprint: String(row.freeze_fingerprint),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      actor: String(row.actor),
    };
  }
  approveFundingRecovery(
    input: Pick<FundingRecoveryGrant, 'paymentId' | 'scope' | 'freezeFingerprint' | 'expiresAt'>,
    actor: string,
  ): FundingRecoveryGrant {
    identifier(input.paymentId);
    identifier(actor);
    if (!/^[a-f0-9]{64}$/.test(input.scope) || !/^[a-f0-9]{64}$/.test(input.freezeFingerprint))
      throw new TestingBudgetError(
        400,
        'Recovery scope and freeze fingerprint must be SHA256 digests.',
      );
    return this.write(() => {
      const old = this.db
        .prepare('SELECT * FROM worker_funding_recovery_grants WHERE payment_id=?')
        .get(input.paymentId);
      if (old) {
        const grant = this.decodeRecovery(old);
        if (
          grant.scope !== input.scope ||
          grant.freezeFingerprint !== input.freezeFingerprint ||
          grant.expiresAt !== input.expiresAt ||
          grant.actor !== actor
        )
          throw new TestingBudgetError(409, 'The original funding recovery grant is immutable.');
        return this.assertFundingRecovery(input.paymentId, input.scope);
      }
      const expiry = Date.parse(input.expiresAt);
      if (
        typeof input.expiresAt !== 'string' ||
        !Number.isFinite(expiry) ||
        new Date(expiry).toISOString() !== input.expiresAt ||
        expiry <= this.now() ||
        expiry > this.now() + 900_000
      )
        throw new TestingBudgetError(
          400,
          'Recovery expiry must be a strict UTC timestamp within the next 15 minutes.',
        );
      const challenge = this.fundingRecoveryChallenge();
      if (challenge.freezeFingerprint !== input.freezeFingerprint)
        throw new TestingBudgetError(409, 'The recovery freeze fingerprint is stale.');
      const { payment, token } = this.recoveryPayment(input.paymentId, true);
      const createdAt = this.timestamp();
      this.db
        .prepare(
          `INSERT INTO worker_funding_recovery_grants
        (payment_id,scope,freeze_fingerprint,expires_at,created_at,actor,token_id,creator_address,budget_cents)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.paymentId,
          input.scope,
          input.freezeFingerprint,
          input.expiresAt,
          createdAt,
          actor,
          payment.tokenId,
          token.creatorAddress,
          payment.budgetCents,
        );
      const grant = { ...input, createdAt, actor };
      this.db
        .prepare(
          'INSERT INTO worker_testing_budget_events(operation_id,event,actor,payload,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          `recovery:${input.paymentId}`,
          'funding_recovery_approved',
          actor,
          JSON.stringify(grant),
          createdAt,
        );
      return grant;
    });
  }
  assertFundingRecovery(paymentId: string, scope?: string): FundingRecoveryGrant {
    identifier(paymentId);
    const row = this.db
      .prepare('SELECT * FROM worker_funding_recovery_grants WHERE payment_id=?')
      .get(paymentId);
    if (!row)
      throw new TestingBudgetError(409, 'An explicit funding recovery approval is required.');
    const grant = this.decodeRecovery(row);
    if (scope !== undefined && scope !== grant.scope)
      throw new TestingBudgetError(
        409,
        'The funding recovery scope does not match the approved payment and policy.',
      );
    if (Date.parse(grant.expiresAt) <= this.now())
      throw new TestingBudgetError(409, 'The funding recovery approval has expired.');
    if (this.fundingRecoveryChallenge().freezeFingerprint !== grant.freezeFingerprint)
      throw new TestingBudgetError(
        409,
        'A new freeze incident invalidated this funding recovery fingerprint.',
      );
    const { payment, token } = this.recoveryPayment(paymentId);
    if (
      payment.tokenId !== row.token_id ||
      token.creatorAddress !== row.creator_address ||
      payment.budgetCents !== row.budget_cents
    )
      throw new TestingBudgetError(
        409,
        'The funding recovery payment identity no longer matches its approval.',
      );
    return grant;
  }
  listFundingRecoveries(): (FundingRecoveryGrant & { active: boolean })[] {
    return this.db
      .prepare('SELECT * FROM worker_funding_recovery_grants ORDER BY rowid')
      .all()
      .map((row) => {
        const grant = this.decodeRecovery(row);
        let active = false;
        try {
          this.assertFundingRecovery(grant.paymentId);
          active = true;
        } catch {
          /* Invalid grants remain visible for audit. */
        }
        return { ...grant, active };
      });
  }
  private recoveryCosts(paymentId: string, inputs: { operationId: string }[], begin: boolean) {
    this.assertFundingRecovery(paymentId);
    const { costs } = this.creatorPayment(paymentId);
    const expected = begin ? costs.filter((cost) => cost.kind !== 'gift') : costs;
    if (
      inputs.length !== expected.length ||
      new Set(inputs.map((cost) => cost.operationId)).size !== expected.length ||
      inputs.some((input) => !expected.some((cost) => cost.operationId === input.operationId))
    )
      throw new TestingBudgetError(
        409,
        'Funding recovery permits only the exact approved native cost group.',
      );
    for (const input of inputs) {
      const cost = expected.find((cost) => cost.operationId === input.operationId)!;
      if (!begin && !isDeepStrictEqual(cost, input))
        throw new TestingBudgetError(409, 'Recovery costs must match the exact approved ceilings.');
      if (!this.creatorCost(cost, true))
        throw new TestingBudgetError(409, 'Recovery cannot execute historical testing costs.');
    }
  }
  private creatorPayment(paymentId: string) {
    for (const table of ['ops_payments', 'ops_tokens', 'ops_native_funding_intents'])
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        throw new TestingBudgetError(409, 'A real creator payment and locked source are required.');
    const row = this.db
      .prepare(
        `SELECT p.token_id,p.status,p.payload,
      t.creator_address,t.payload AS token_payload,i.token_id AS source_token_id,
      i.payload AS source_payload FROM ops_payments p
      JOIN ops_tokens t ON t.id=p.token_id
      JOIN ops_native_funding_intents i ON i.payment_id=p.id WHERE p.id=?`,
      )
      .get(paymentId);
    if (!row)
      throw new TestingBudgetError(
        409,
        'A real creator payment and locked source intent are required.',
      );
    let payment: OperationPayment, token: RegisteredToken, intent: NativeFundingIntent;
    try {
      payment = JSON.parse(String(row.payload));
      token = JSON.parse(String(row.token_payload));
      intent = JSON.parse(String(row.source_payload));
    } catch {
      throw new TestingBudgetError(409, 'The creator payment or source intent is invalid.');
    }
    if (
      !payment ||
      !token ||
      !intent ||
      payment.id !== paymentId ||
      payment.tokenId !== row.token_id ||
      payment.status !== row.status ||
      token.id !== row.token_id ||
      ('kind' in token && token.kind === 'platform') ||
      token.creatorAddress !== row.creator_address ||
      token.recipientPlatform !== 'twitch' ||
      !token.recipientVerified ||
      !token.dedicatedCreatorVerified ||
      intent.version !== 1 ||
      intent.paymentId !== paymentId ||
      intent.tokenId !== row.token_id ||
      intent.tokenId !== row.source_token_id ||
      intent.creatorAddress !== token.creatorAddress ||
      !isDeepStrictEqual(payment.nativeFundingIntent, intent)
    )
      throw new TestingBudgetError(
        409,
        'The creator payment must match its immutable source intent.',
      );
    const budgetCents = cents(payment.budgetCents);
    const costs: TestingCostReservation[] = [
      {
        operationId: `gift:${paymentId}`,
        kind: 'gift',
        maxUsdCents: cents(intent.giftMaxUsdCents),
      },
      {
        operationId: `gas:funding:${paymentId}`,
        kind: 'chain_fee',
        maxUsdCents: cents(intent.gasMaxUsdCents),
      },
      {
        operationId: `offramp:${paymentId}`,
        kind: 'offramp_fee',
        maxUsdCents: cents(intent.conversionMaxUsdCents),
      },
    ];
    if (
      costs.some(
        (cost) => cost.maxUsdCents > (cost.kind === 'gift' ? 500000 : TESTING_CAP_USD_CENTS),
      ) ||
      costs.reduce((sum, cost) => sum + cost.maxUsdCents, 0) > budgetCents ||
      !Number.isSafeInteger(intent.reservedSourceCostBasisCents) ||
      intent.reservedSourceCostBasisCents <= 0 ||
      intent.reservedSourceCostBasisCents > budgetCents
    )
      throw new TestingBudgetError(
        409,
        'Creator cost ceilings exceed the earned payment authorization.',
      );
    return { payment, intent, costs, sourcePayload: String(row.source_payload) };
  }
  /** Authorize only the gift and funding costs of an already locked earned allocation.
   * Historical testing costs can never acquire this scope retroactively. */
  authorizeCreatorPayment(paymentId: string, actor: string, recoveryPaymentId?: string) {
    identifier(paymentId);
    identifier(actor);
    return this.write(() => {
      if (recoveryPaymentId !== undefined) {
        if (recoveryPaymentId !== paymentId)
          throw new TestingBudgetError(409, 'Recovery must match the authorized creator payment.');
        this.enabled(recoveryPaymentId);
      }
      const { payment, intent, costs, sourcePayload } = this.creatorPayment(paymentId);
      const existing = this.db
        .prepare('SELECT * FROM worker_creator_funding_authorizations WHERE payment_id=?')
        .all(paymentId);
      if (existing.length) {
        if (existing.length !== costs.length)
          throw new TestingBudgetError(409, 'The original creator authorization is incomplete.');
        for (const cost of costs) this.creatorCost(cost);
        return { paymentId, tokenId: payment.tokenId, budgetCents: payment.budgetCents, costs };
      }
      this.enabled(recoveryPaymentId);
      if (
        !['reserved', 'funding_pending'].includes(payment.status) ||
        payment.funding ||
        payment.failedFunding ||
        payment.completion
      )
        throw new TestingBudgetError(
          409,
          'Only an untouched locked creator payment can be authorized.',
        );
      const reserved = this.db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM ops_journal WHERE payment_id=? AND token_id=? AND account='reserved'",
        )
        .get(paymentId, payment.tokenId);
      if (Number(reserved?.amount) < payment.budgetCents)
        throw new TestingBudgetError(409, 'The earned creator payment budget is not reserved.');
      if (costs.some((cost) => this.get(cost.operationId)))
        throw new TestingBudgetError(
          409,
          'Existing historical testing costs cannot be reclassified.',
        );
      const insert = this.db.prepare(`INSERT INTO worker_creator_funding_authorizations
        (operation_id,payment_id,token_id,budget_cents,kind,max_cents,source_payload,actor,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      const at = this.timestamp();
      for (const cost of costs)
        insert.run(
          cost.operationId,
          paymentId,
          intent.tokenId,
          payment.budgetCents,
          cost.kind,
          cost.maxUsdCents,
          sourcePayload,
          actor,
          at,
        );
      this.db
        .prepare(
          'INSERT INTO worker_testing_budget_events(operation_id,event,actor,payload,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          `creator:${paymentId}`,
          'creator_payment_authorized',
          actor,
          JSON.stringify({
            paymentId,
            tokenId: intent.tokenId,
            budgetCents: payment.budgetCents,
            costs,
          }),
          at,
        );
      return { paymentId, tokenId: payment.tokenId, budgetCents: payment.budgetCents, costs };
    });
  }
  private creatorCost(input: TestingCostReservation, active = false) {
    const row = this.db
      .prepare('SELECT * FROM worker_creator_funding_authorizations WHERE operation_id=?')
      .get(input.operationId);
    if (!row) return undefined;
    const { payment, intent, costs } = this.creatorPayment(String(row.payment_id));
    const expected = costs.find((cost) => cost.operationId === input.operationId);
    if (
      !expected ||
      row.token_id !== payment.tokenId ||
      row.budget_cents !== payment.budgetCents ||
      row.kind !== input.kind ||
      row.max_cents !== input.maxUsdCents ||
      !isDeepStrictEqual(expected, input) ||
      !isDeepStrictEqual(JSON.parse(String(row.source_payload)), intent)
    )
      throw new TestingBudgetError(
        409,
        'The creator cost must match its exact authorized kind and ceiling.',
      );
    if (active && (['completed', 'cancelled'].includes(payment.status) || payment.failedFunding))
      throw new TestingBudgetError(409, 'The creator payment no longer authorizes new execution.');
    return row;
  }
  snapshot() {
    const config = this.db.prepare('SELECT * FROM worker_testing_budget_config WHERE id=1').get()!;
    const rows = this.db
      .prepare(
        `SELECT c.kind,CASE WHEN a.operation_id IS NULL THEN 'testing' ELSE 'creator' END AS scope,
      COALESCE(SUM(CASE WHEN state='settled' THEN actual_cents ELSE 0 END),0) AS committed,
      COALESCE(SUM(CASE WHEN state='reserved' THEN c.max_cents ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN state='unresolved' THEN c.max_cents ELSE 0 END),0) AS unresolved
      FROM worker_testing_budget_costs c LEFT JOIN worker_creator_funding_authorizations a
        ON a.operation_id=c.operation_id GROUP BY c.kind,scope`,
      )
      .all();
    const summarize = (scope: string) => {
      const byKind = Object.fromEntries(
        KINDS.map((kind) => [
          kind,
          { committedUsdCents: 0, reservedUsdCents: 0, unresolvedUsdCents: 0 },
        ]),
      ) as Record<
        TestingCostKind,
        { committedUsdCents: number; reservedUsdCents: number; unresolvedUsdCents: number }
      >;
      let committedUsdCents = 0,
        reservedUsdCents = 0,
        unresolvedUsdCents = 0;
      for (const row of rows.filter((row) => row.scope === scope)) {
        const value = {
          committedUsdCents: Number(row.committed),
          reservedUsdCents: Number(row.reserved),
          unresolvedUsdCents: Number(row.unresolved),
        };
        byKind[row.kind as TestingCostKind] = value;
        committedUsdCents += value.committedUsdCents;
        reservedUsdCents += value.reservedUsdCents;
        unresolvedUsdCents += value.unresolvedUsdCents;
      }
      const allocatedUsdCents = committedUsdCents + reservedUsdCents + unresolvedUsdCents;
      return { committedUsdCents, reservedUsdCents, unresolvedUsdCents, allocatedUsdCents, byKind };
    };
    const testing = summarize('testing');
    const authorized = this.db
      .prepare(
        `SELECT COALESCE(SUM(max_cents),0) AS amount,
      COUNT(DISTINCT payment_id) AS payments FROM worker_creator_funding_authorizations`,
      )
      .get()!;
    let globalRecovery: GlobalRecoveryGrant | null = null;
    if (config.frozen && testing.allocatedUsdCents <= TESTING_CAP_USD_CENTS) {
      try {
        const { freezeFingerprint } = this.recoveryIncident();
        const grant = this.db
          .prepare('SELECT * FROM worker_global_recovery_grants WHERE freeze_fingerprint=?')
          .get(freezeFingerprint);
        if (grant) globalRecovery = this.decodeGlobalRecovery(grant);
      } catch (error) {
        if (!(error instanceof TestingBudgetError)) throw error;
        // Unsupported or incomplete incidents remain blocked, including after prior approval.
      }
    }
    return {
      capUsdCents: TESTING_CAP_USD_CENTS,
      ...testing,
      remainingUsdCents: Math.max(0, TESTING_CAP_USD_CENTS - testing.allocatedUsdCents),
      overCapUsdCents: Math.max(0, testing.allocatedUsdCents - TESTING_CAP_USD_CENTS),
      frozen: Boolean(config.frozen) && !globalRecovery,
      historicalFrozen: Boolean(config.frozen),
      globalRecovery,
      freezeReason: config.freeze_reason === null ? null : String(config.freeze_reason),
      creatorFunding: {
        authorizedUsdCents: Number(authorized.amount),
        paymentCount: Number(authorized.payments),
        ...summarize('creator'),
      },
    };
  }
  private enabled(recoveryPaymentId?: string) {
    const status = this.snapshot();
    if (status.frozen && recoveryPaymentId !== undefined)
      this.assertFundingRecovery(recoveryPaymentId);
    else if (status.frozen)
      throw new TestingBudgetError(
        409,
        'The testing budget is frozen after a confirmed cost overrun.',
      );
    if (status.overCapUsdCents)
      throw new TestingBudgetError(409, 'The total testing cap has been exceeded.');
    return status;
  }
  private event(value: TestingCostOperation, event: string, actor: string) {
    this.db
      .prepare(
        'INSERT INTO worker_testing_budget_events(operation_id,event,actor,payload,created_at) VALUES(?,?,?,?,?)',
      )
      .run(value.operationId, event, actor, JSON.stringify(value), this.timestamp());
    return value;
  }
  reserve(input: TestingCostReservation, actor: string) {
    return this.reserveMany([input], actor)[0];
  }
  reserveMany(
    inputs: TestingCostReservation[],
    actor: string,
    recoveryPaymentId?: string,
  ): TestingCostOperation[] {
    identifier(actor);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64)
      throw new TestingBudgetError(400, 'Reserve between one and 64 cost operations at a time.');
    const clean = inputs.map((input) => {
      if (!input || !KINDS.includes(input.kind))
        throw new TestingBudgetError(
          400,
          'Unsupported testing expense kind; funding principal is not a cost.',
        );
      return {
        operationId: identifier(input.operationId),
        kind: input.kind,
        maxUsdCents: cents(input.maxUsdCents),
      };
    });
    return this.write(() => {
      if (recoveryPaymentId !== undefined && this.snapshot().frozen)
        this.recoveryCosts(recoveryPaymentId, clean, false);
      return clean.map((input) => {
        const old = this.get(input.operationId);
        const creator = this.creatorCost(input, !old);
        if (old) {
          if (old.kind !== input.kind || old.maxUsdCents !== input.maxUsdCents)
            throw new TestingBudgetError(
              409,
              'This operation already has a different reservation.',
            );
          return old;
        }
        const enabled = this.enabled(recoveryPaymentId);
        if (!creator && input.maxUsdCents > enabled.remainingUsdCents)
          throw new TestingBudgetError(
            409,
            'This reservation would exceed the total $300 testing cap.',
          );
        const at = this.timestamp();
        this.db
          .prepare(
            "INSERT INTO worker_testing_budget_costs(operation_id,kind,max_cents,state,created_at,updated_at) VALUES(?,?,?,'reserved',?,?)",
          )
          .run(input.operationId, input.kind, input.maxUsdCents, at, at);
        return this.event(this.required(input.operationId), 'reserved', actor);
      });
    });
  }
  begin(
    operationId: string,
    attemptId: string,
    actor: string,
  ): { execute: boolean; operation: TestingCostOperation } {
    const result = this.beginMany([{ operationId, attemptId }], actor);
    return { execute: result.execute, operation: result.operations[0] };
  }
  beginMany(
    inputs: { operationId: string; attemptId: string }[],
    actor: string,
    recoveryPaymentId?: string,
  ): { execute: boolean; operations: TestingCostOperation[] } {
    identifier(actor);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64)
      throw new TestingBudgetError(400, 'Begin between one and 64 related cost operations.');
    const clean = inputs.map((input) => ({
      operationId: identifier(input.operationId),
      attemptId: identifier(input.attemptId),
    }));
    if (
      new Set(clean.map((x) => x.operationId)).size !== clean.length ||
      new Set(clean.map((x) => x.attemptId)).size !== clean.length
    )
      throw new TestingBudgetError(
        400,
        'Each related cost requires a unique operation and namespaced attempt.',
      );
    return this.write(() => {
      if (recoveryPaymentId !== undefined && this.snapshot().frozen)
        this.recoveryCosts(recoveryPaymentId, clean, true);
      const operations = clean.map((input) => this.required(input.operationId));
      for (let i = 0; i < operations.length; i++)
        if (operations[i].attemptId && operations[i].attemptId !== clean[i].attemptId)
          throw new TestingBudgetError(
            409,
            'Reconcile the original attempt; a replacement cannot execute.',
          );
      if (operations.every((operation) => operation.attemptId))
        return { execute: false, operations };
      if (operations.some((operation) => operation.attemptId))
        throw new TestingBudgetError(
          409,
          'Reconcile the original related attempts before changing the execution group.',
        );
      const closed = operations.find((operation) => operation.state !== 'reserved');
      if (closed) throw new TestingBudgetError(409, `This testing operation is ${closed.state}.`);
      for (const operation of operations)
        this.creatorCost(
          {
            operationId: operation.operationId,
            kind: operation.kind,
            maxUsdCents: operation.maxUsdCents,
          },
          true,
        );
      this.enabled(recoveryPaymentId);
      const begun = clean.map(({ operationId, attemptId }) => {
        if (
          this.db
            .prepare('SELECT 1 FROM worker_testing_budget_costs WHERE attempt_id=?')
            .get(attemptId)
        )
          throw new TestingBudgetError(
            409,
            'This attempt already belongs to another testing operation.',
          );
        this.db
          .prepare(
            "UPDATE worker_testing_budget_costs SET state='unresolved',attempt_id=?,updated_at=? WHERE operation_id=?",
          )
          .run(attemptId, this.timestamp(), operationId);
        return this.event(this.required(operationId), 'execution_authorized', actor);
      });
      return { execute: true, operations: begun };
    }, true);
  }
  private evidenceAvailable(kind: string, id: string) {
    if (
      this.db
        .prepare('SELECT evidence_kind FROM worker_testing_budget_costs WHERE evidence_id=?')
        .all(id)
        .some((row) => evidenceFamily(String(row.evidence_kind)) === evidenceFamily(kind))
    )
      throw new TestingBudgetError(409, 'This cost evidence already belongs to another operation.');
  }
  /** Reconciliation only: a trusted adapter has verified, or an authenticated
   * operator has attested, a cost already incurred. Never grants execution.
   * Missing prior reservations cannot hide real expenses or bypass an overrun freeze. */
  reconcileObservedCost(
    input: TestingCostProof & { operationId: string; kind: TestingCostKind },
    actor: string,
  ): TestingCostOperation {
    identifier(actor);
    identifier(input.operationId);
    identifier(input.attemptId);
    identifier(input.evidenceId);
    cents(input.actualUsdCents);
    if (!KINDS.includes(input.kind) || !EVIDENCE[input.kind].includes(input.evidenceKind))
      throw new TestingBudgetError(400, 'Observed evidence must match its expense kind.');
    return this.write(() => {
      const old = this.get(input.operationId);
      const creator = this.db
        .prepare(
          'SELECT kind,max_cents FROM worker_creator_funding_authorizations WHERE operation_id=?',
        )
        .get(input.operationId);
      if (creator)
        this.creatorCost({
          operationId: input.operationId,
          kind: input.kind,
          maxUsdCents: Number(creator.max_cents),
        });
      if (old && old.kind !== input.kind)
        throw new TestingBudgetError(409, 'The observed expense has a different reserved kind.');
      if (old?.state === 'released')
        throw new TestingBudgetError(
          409,
          'A released expense needs explicit contradiction reconciliation.',
        );
      if (old?.attemptId && old.attemptId !== input.attemptId)
        throw new TestingBudgetError(409, 'The observed cost must match the original attempt.');
      if (!old || old.state === 'reserved') {
        this.evidenceAvailable(input.evidenceKind, input.evidenceId);
        if (
          this.db
            .prepare(
              'SELECT operation_id FROM worker_testing_budget_costs WHERE attempt_id=? AND operation_id!=?',
            )
            .get(input.attemptId, input.operationId)
        )
          throw new TestingBudgetError(
            409,
            'The observed attempt already belongs to another expense.',
          );
        if (!old) {
          const at = this.timestamp();
          this.db
            .prepare(
              `INSERT INTO worker_testing_budget_costs(operation_id,kind,max_cents,state,attempt_id,created_at,updated_at)
            VALUES(?,?,?,'unresolved',?,?,?)`,
            )
            .run(
              input.operationId,
              input.kind,
              creator
                ? Number(creator.max_cents)
                : Math.min(input.actualUsdCents, TESTING_CAP_USD_CENTS),
              input.attemptId,
              at,
              at,
            );
        } else
          this.db
            .prepare(
              "UPDATE worker_testing_budget_costs SET state='unresolved',attempt_id=?,updated_at=? WHERE operation_id=?",
            )
            .run(input.attemptId, this.timestamp(), input.operationId);
        this.event(this.required(input.operationId), 'observed_without_execution_grant', actor);
      }
      const result = this.settle(input.operationId, input, actor);
      if (this.snapshot().overCapUsdCents > 0 && old?.state !== 'settled')
        // The incident remains unacknowledged even if later reconciliation lowers allocations.
        // Exact receipt retries do not create a second incident.
        this.freeze('observed_cost_exceeded_total_cap', actor);
      return result;
    });
  }
  /** Stop future spending after a verified policy breach without inventing an expense. */
  freeze(reason: string, actor: string) {
    identifier(reason);
    identifier(actor);
    return this.write(() => {
      this.db
        .prepare(
          'UPDATE worker_testing_budget_config SET frozen=1,freeze_reason=COALESCE(freeze_reason,?) WHERE id=1',
        )
        .run(reason);
      this.db
        .prepare(
          'INSERT INTO worker_testing_budget_events(operation_id,event,actor,payload,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          'testing-budget',
          'testing_frozen',
          actor,
          JSON.stringify({ reason }),
          this.timestamp(),
        );
      return this.snapshot();
    });
  }
  settle(operationId: string, proof: TestingCostProof, actor: string): TestingCostOperation {
    identifier(actor);
    identifier(proof.attemptId);
    identifier(proof.evidenceId);
    cents(proof.actualUsdCents);
    return this.write(() => {
      const old = this.required(operationId);
      if (!EVIDENCE[old.kind].includes(proof.evidenceKind))
        throw new TestingBudgetError(
          400,
          'The verified cost evidence does not match this expense kind.',
        );
      if (old.attemptId !== proof.attemptId)
        throw new TestingBudgetError(
          409,
          'Reconcile the original attempt before recording a cost.',
        );
      if (old.state === 'settled') {
        if (
          old.actualUsdCents !== proof.actualUsdCents ||
          old.evidenceId !== proof.evidenceId ||
          evidenceFamily(old.evidenceKind ?? '') !== evidenceFamily(proof.evidenceKind)
        )
          throw new TestingBudgetError(
            409,
            'A different final cost or receipt is already recorded.',
          );
        return old;
      }
      if (old.state !== 'unresolved')
        throw new TestingBudgetError(409, `This testing operation is ${old.state}.`);
      this.evidenceAvailable(proof.evidenceKind, proof.evidenceId);
      this.db
        .prepare(
          "UPDATE worker_testing_budget_costs SET state='settled',actual_cents=?,evidence_kind=?,evidence_id=?,updated_at=? WHERE operation_id=?",
        )
        .run(
          proof.actualUsdCents,
          proof.evidenceKind,
          proof.evidenceId,
          this.timestamp(),
          operationId,
        );
      if (proof.actualUsdCents > old.maxUsdCents)
        this.db
          .prepare(
            'UPDATE worker_testing_budget_config SET frozen=1,freeze_reason=COALESCE(freeze_reason,?) WHERE id=1',
          )
          .run('confirmed_cost_exceeded_reservation');
      return this.event(this.required(operationId), 'cost_confirmed', actor);
    });
  }
  cancelBeforeExecution(operationId: string, actor: string): TestingCostOperation {
    identifier(actor);
    return this.write(() => {
      const old = this.required(operationId);
      if (old.state === 'released' && old.releaseReason === 'cancelled_before_execution')
        return old;
      if (old.state !== 'reserved' || old.attemptId)
        throw new TestingBudgetError(
          409,
          `This testing operation is ${old.state}; only an unsubmitted reservation can be cancelled.`,
        );
      this.db
        .prepare(
          "UPDATE worker_testing_budget_costs SET state='released',release_reason='cancelled_before_execution',updated_at=? WHERE operation_id=?",
        )
        .run(this.timestamp(), operationId);
      return this.event(this.required(operationId), 'cancelled_before_execution', actor);
    });
  }
  releaseNoSpend(
    operationId: string,
    proof: TestingNoSpendProof,
    actor: string,
  ): TestingCostOperation {
    identifier(actor);
    identifier(proof.attemptId);
    identifier(proof.evidenceId);
    if (!['provider_final_no_charge', 'finalized_chain_no_fee'].includes(proof.evidenceKind))
      throw new TestingBudgetError(
        400,
        'A definitive verified no-spend proof is required; timeouts and decline labels are insufficient.',
      );
    return this.write(() => {
      const old = this.required(operationId);
      if (proof.evidenceKind === 'finalized_chain_no_fee' && old.kind !== 'chain_fee')
        throw new TestingBudgetError(400, 'A definitive proof must match the expense kind.');
      if (old.attemptId !== proof.attemptId)
        throw new TestingBudgetError(409, 'Reconcile the original attempt before releasing funds.');
      if (
        old.state === 'released' &&
        old.evidenceId === proof.evidenceId &&
        old.evidenceKind === proof.evidenceKind
      )
        return old;
      if (old.state !== 'unresolved')
        throw new TestingBudgetError(409, `This testing operation is ${old.state}.`);
      this.evidenceAvailable(proof.evidenceKind, proof.evidenceId);
      this.db
        .prepare(
          "UPDATE worker_testing_budget_costs SET state='released',evidence_kind=?,evidence_id=?,release_reason='verified_final_no_spend',updated_at=? WHERE operation_id=?",
        )
        .run(proof.evidenceKind, proof.evidenceId, this.timestamp(), operationId);
      return this.event(this.required(operationId), 'verified_final_no_spend', actor);
    });
  }
}
