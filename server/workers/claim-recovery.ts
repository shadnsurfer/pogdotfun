import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { valueLamportsInUsdCents, type SolUsdQuote } from '../providers/contracts.ts';

export interface ClaimExpiryEvidence {
  signature: string;
  lastValidBlockHeight: number;
  checkedAt: string;
  sources: {
    source: string;
    genesisHash: string;
    finalizedBlockHeight: number;
    status: null;
    transaction: null;
  }[];
}
export interface ClaimRecoveryRequest {
  reviewFingerprint: string;
  note: string;
  acknowledge: true;
}
export interface ClaimRecoveryApproval {
  id: string;
  reviewFingerprint: string;
  note: string;
  actor: string;
  createdAt: string;
  quote: SolUsdQuote;
  successors: {
    originalJobId: string;
    successorJobId: string;
    signature: string;
    tokenId: string;
  }[];
}
export class ClaimRecoveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = Record<string, unknown>;

/** Retirement acknowledges uncertainty. It never releases a cost hold or signs a transaction. */
export class ClaimRecovery {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec('SAVEPOINT claim_recovery_schema');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_claim_recoveries (
          id TEXT PRIMARY KEY, review_fingerprint TEXT NOT NULL UNIQUE,
          actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
          payload TEXT NOT NULL, evidence TEXT NOT NULL, originals TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS worker_claim_recoveries_no_update
          BEFORE UPDATE ON worker_claim_recoveries BEGIN SELECT RAISE(ABORT,'Claim recovery audit is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS worker_claim_recoveries_no_delete
          BEFORE DELETE ON worker_claim_recoveries BEGIN SELECT RAISE(ABORT,'Claim recovery audit is immutable'); END;
        DROP INDEX IF EXISTS service_active_token_job;
        CREATE UNIQUE INDEX service_active_token_job ON service_jobs(kind,token_id)
          WHERE stage NOT IN ('done','retired');
      `);
      db.exec('RELEASE claim_recovery_schema');
    } catch (error) {
      db.exec('ROLLBACK TO claim_recovery_schema; RELEASE claim_recovery_schema');
      throw error;
    }
  }
  private originals(): Row[] {
    return this.db
      .prepare(
        `SELECT j.id AS job_id,j.token_id,j.payload AS job_payload,
      t.id AS transaction_id,t.kind,t.creator,t.signature,t.payload AS transaction_payload,
      t.state,t.detail,t.updated_at,
      c.operation_id AS gas_operation_id,c.kind AS gas_kind,c.max_cents,c.state AS gas_state,
      c.attempt_id,c.actual_cents,c.evidence_kind,c.evidence_id,c.release_reason,
      c.created_at AS gas_created_at,c.updated_at AS gas_updated_at
      FROM service_jobs j JOIN worker_transactions t ON t.id='claim:' || j.id
      LEFT JOIN worker_testing_budget_costs c ON c.operation_id='gas:claim:' || j.id
      WHERE j.kind='claim' AND j.stage='review' AND t.kind='claim' AND t.state='expired_review'
      AND (c.operation_id IS NULL OR (c.kind='chain_fee' AND c.state IN ('reserved','unresolved')))
      ORDER BY j.id LIMIT 50`,
      )
      .all();
  }
  preview(context: unknown) {
    const originals = this.originals();
    const candidates = originals.map((row) => {
      const transaction = JSON.parse(String(row.transaction_payload));
      const job = JSON.parse(String(row.job_payload));
      if (
        job.id !== row.job_id ||
        job.tokenId !== row.token_id ||
        job.type !== 'claim' ||
        job.stage !== 'review' ||
        transaction.id !== row.transaction_id ||
        transaction.kind !== 'claim' ||
        transaction.tokenId !== row.token_id ||
        transaction.signature !== row.signature ||
        transaction.creator !== row.creator ||
        !Number.isSafeInteger(transaction.lastValidBlockHeight) ||
        transaction.lastValidBlockHeight < 1 ||
        (row.attempt_id !== null && row.attempt_id !== `attemptgas:${row.signature}`)
      )
        throw new ClaimRecoveryError(
          409,
          'The original claim identity or gas hold is inconsistent.',
        );
      return {
        jobId: String(row.job_id),
        tokenId: String(row.token_id),
        signature: String(row.signature),
        lastValidBlockHeight: Number(transaction.lastValidBlockHeight),
        gasHoldUsdCents: row.max_cents === null ? 0 : Number(row.max_cents),
      };
    });
    return {
      reviewFingerprint: createHash('sha256')
        .update(JSON.stringify({ context, originals }))
        .digest('hex'),
      candidates,
      preservedGasHoldUsdCents: candidates.reduce((sum, item) => sum + item.gasHoldUsdCents, 0),
    };
  }
  private validateRequest(input: ClaimRecoveryRequest, actor: string) {
    if (
      !input ||
      input.acknowledge !== true ||
      typeof input.reviewFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.reviewFingerprint) ||
      typeof input.note !== 'string' ||
      input.note.trim().length < 10 ||
      input.note.trim().length > 1000 ||
      typeof actor !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,180}$/.test(actor)
    )
      throw new ClaimRecoveryError(
        400,
        'Explicit acknowledgement, valid review, operator and 10–1000 character note are required.',
      );
  }
  /** Safe before RPC inspection: a replay returns the original audit and creates no new work. */
  replay(input: ClaimRecoveryRequest, actor: string): ClaimRecoveryApproval | null {
    this.validateRequest(input, actor);
    const row = this.db
      .prepare('SELECT payload FROM worker_claim_recoveries WHERE review_fingerprint=?')
      .get(input.reviewFingerprint);
    if (!row) return null;
    const approval = JSON.parse(String(row.payload)) as ClaimRecoveryApproval;
    if (approval.actor !== actor || approval.note !== input.note.trim())
      throw new ClaimRecoveryError(
        409,
        'The original claim recovery is immutable; conflicting approval rejected.',
      );
    return approval;
  }
  approve(
    input: ClaimRecoveryRequest & { evidence: ClaimExpiryEvidence[]; quote: SolUsdQuote },
    actor: string,
    currentContext: () => unknown,
  ): ClaimRecoveryApproval {
    this.validateRequest(input, actor);
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch {
      throw new ClaimRecoveryError(
        409,
        'Claim recovery requires an available standalone transaction.',
      );
    }
    try {
      const prior = this.replay(input, actor);
      if (prior) {
        this.db.exec('COMMIT');
        return prior;
      }
      const preview = this.preview(currentContext());
      if (preview.reviewFingerprint !== input.reviewFingerprint)
        throw new ClaimRecoveryError(
          409,
          'The claim recovery review is stale. Review current originals and policy again.',
        );
      if (!preview.candidates.length)
        throw new ClaimRecoveryError(409, 'No expired held claims are eligible for recovery.');
      try {
        valueLamportsInUsdCents(0n, input.quote, this.now());
      } catch {
        throw new ClaimRecoveryError(409, 'A fresh identified SOL/USD quote is required.');
      }
      if (
        !Array.isArray(input.evidence) ||
        input.evidence.length !== preview.candidates.length ||
        new Set(input.evidence.map((e) => e?.signature)).size !== preview.candidates.length
      )
        throw new ClaimRecoveryError(
          409,
          'Fresh expiry evidence is required for every original claim.',
        );
      for (const candidate of preview.candidates) {
        const evidence = input.evidence.find((e) => e.signature === candidate.signature);
        const checked = Date.parse(evidence?.checkedAt ?? '');
        if (
          !evidence ||
          evidence.lastValidBlockHeight !== candidate.lastValidBlockHeight ||
          !Number.isFinite(checked) ||
          checked > this.now() + 5000 ||
          this.now() - checked > 60_000 ||
          !Array.isArray(evidence.sources) ||
          evidence.sources.length !== 2 ||
          new Set(evidence.sources.map((source) => source?.source)).size !== 2 ||
          new Set(evidence.sources.map((source) => source?.genesisHash)).size !== 1 ||
          evidence.sources.some(
            (source) =>
              !source ||
              !source.source ||
              !source.genesisHash ||
              !Number.isSafeInteger(source.finalizedBlockHeight) ||
              source.finalizedBlockHeight <= candidate.lastValidBlockHeight ||
              source.status !== null ||
              source.transaction !== null,
          )
        )
          throw new ClaimRecoveryError(
            409,
            'Both independent RPC observations must show expiry without status or receipt.',
          );
      }
      const originals = this.originals();
      const approval: ClaimRecoveryApproval = {
        id: randomUUID(),
        reviewFingerprint: input.reviewFingerprint,
        note: input.note.trim(),
        actor,
        createdAt: new Date(this.now()).toISOString(),
        quote: input.quote,
        successors: preview.candidates.map((candidate) => ({
          originalJobId: candidate.jobId,
          successorJobId: randomUUID(),
          signature: candidate.signature,
          tokenId: candidate.tokenId,
        })),
      };
      this.db
        .prepare(
          `INSERT INTO worker_claim_recoveries
        (id,review_fingerprint,actor,note,created_at,payload,evidence,originals) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          approval.id,
          approval.reviewFingerprint,
          actor,
          approval.note,
          approval.createdAt,
          JSON.stringify(approval),
          JSON.stringify(input.evidence),
          JSON.stringify(originals),
        );
      for (const successor of approval.successors) {
        const original = originals.find((row) => row.job_id === successor.originalJobId)!;
        const originalJob = JSON.parse(String(original.job_payload));
        const recovery = {
          approvalId: approval.id,
          originalJobId: successor.originalJobId,
          originalSignature: successor.signature,
          successorJobId: successor.successorJobId,
        };
        const retired = {
          ...originalJob,
          stage: 'retired',
          detail:
            'Expired claim retired by explicit operator approval; original gas uncertainty remains reserved.',
          recovery,
        };
        const changed = this.db
          .prepare(
            "UPDATE service_jobs SET stage='retired',payload=? WHERE id=? AND stage='review'",
          )
          .run(JSON.stringify(retired), successor.originalJobId);
        const transaction = this.db
          .prepare(
            "UPDATE worker_transactions SET state='retired_expired',detail=?,updated_at=? WHERE id=? AND state='expired_review'",
          )
          .run(
            `Retired by claim recovery ${approval.id}; original payload and gas hold preserved.`,
            approval.createdAt,
            `claim:${successor.originalJobId}`,
          );
        if (changed.changes !== 1 || transaction.changes !== 1)
          throw new ClaimRecoveryError(409, 'Original claim state changed before retirement.');
        const job = {
          id: successor.successorJobId,
          type: 'claim',
          tokenId: successor.tokenId,
          stage: 'planned',
          quote: input.quote,
          recovery,
        };
        this.db
          .prepare(
            "INSERT INTO service_jobs(id,kind,token_id,stage,payload) VALUES(?,'claim',?,'planned',?)",
          )
          .run(job.id, job.tokenId, JSON.stringify(job));
      }
      this.db.exec('COMMIT');
      return approval;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
