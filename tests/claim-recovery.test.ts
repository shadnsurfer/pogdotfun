import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimRecovery, type ClaimExpiryEvidence } from '../server/workers/claim-recovery.ts';
import { TestingBudget } from '../server/workers/testing-budget.ts';
import {
  SqliteTransactionJournal,
  TransactionDispatcher,
} from '../server/workers/transaction-journal.ts';

const now = Date.now();
const at = new Date(now).toISOString();
const quote = { centsPerSol: '15000', observedAt: at, source: 'test-quote' };
const context = { policy: 'fixed', enabled: true };
function fixture(path = ':memory:', reserveHolds = true, ids = ['one', 'two']) {
  const db = new DatabaseSync(path);
  const budget = new TestingBudget(db);
  const journal = new SqliteTransactionJournal(db);
  db.exec(`CREATE TABLE service_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,token_id TEXT NOT NULL,payment_id TEXT UNIQUE,invoice_id TEXT,stage TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE UNIQUE INDEX service_active_token_job ON service_jobs(kind,token_id) WHERE stage <> 'done'`);
  for (const id of ids) {
    const job = { id, type: 'claim', tokenId: `token:${id}`, stage: 'review', quote };
    db.prepare('INSERT INTO service_jobs(id,kind,token_id,stage,payload) VALUES(?,?,?,?,?)').run(
      id,
      'claim',
      job.tokenId,
      'review',
      JSON.stringify(job),
    );
    journal.insert({
      id: `claim:${id}`,
      kind: 'claim',
      tokenId: job.tokenId,
      mint: `mint:${id}`,
      creator: `creator:${id}`,
      signature: `signature:${id}`,
      signedTransactionBase64: 'original-signed-bytes',
      blockhash: 'original-blockhash',
      lastValidBlockHeight: 100,
      createdAt: at,
      networkFeeLamports: '5000',
    });
    journal.update(`claim:${id}`, 'expired_review');
    if (reserveHolds) {
      budget.reserve({ operationId: `gas:claim:${id}`, kind: 'chain_fee', maxUsdCents: 2 }, 'test');
      budget.begin(`gas:claim:${id}`, `attemptgas:signature:${id}`, 'test');
    }
  }
  const recovery = new ClaimRecovery(db, () => now);
  return { db, budget, journal, recovery };
}
function evidence(ids = ['one', 'two']): ClaimExpiryEvidence[] {
  return ids.map((id) => ({
    signature: `signature:${id}`,
    lastValidBlockHeight: 100,
    checkedAt: at,
    sources: ['primary', 'secondary'].map((source) => ({
      source,
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      finalizedBlockHeight: 101,
      status: null,
      transaction: null,
    })),
  }));
}
function input(recovery: ClaimRecovery) {
  return {
    reviewFingerprint: recovery.preview(context).reviewFingerprint,
    note: 'Reviewed expiry and retained uncertain historical gas.',
    acknowledge: true as const,
    evidence: evidence(),
    quote,
  };
}
test('approval preserves signed bytes and all gas holds, links exactly one successor and appends immutable evidence', () => {
  const f = fixture();
  try {
    const holds = JSON.stringify(f.budget.list());
    const originals = f.db.prepare('SELECT payload FROM worker_transactions ORDER BY id').all();
    const preview = f.recovery.preview(context);
    assert.equal(preview.candidates.length, 2);
    assert.equal(preview.preservedGasHoldUsdCents, 4);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM service_jobs WHERE stage='planned'").get()!.n,
      0,
    );
    const approval = f.recovery.approve(input(f.recovery), 'operator', () => context);
    assert.equal(approval.successors.length, 2);
    assert.deepEqual(approval.quote, quote);
    assert.equal(JSON.stringify(f.budget.list()), holds);
    assert.deepEqual(
      f.db.prepare('SELECT payload FROM worker_transactions ORDER BY id').all(),
      originals,
    );
    for (const item of approval.successors) {
      assert.equal(f.journal.get(`claim:${item.originalJobId}`)?.state, 'retired_expired');
      const job = JSON.parse(
        String(
          f.db.prepare('SELECT payload FROM service_jobs WHERE id=?').get(item.successorJobId)!
            .payload,
        ),
      );
      assert.equal(job.stage, 'planned');
      assert.deepEqual(job.quote, quote);
      assert.equal(job.recovery.originalJobId, item.originalJobId);
    }
    assert.throws(
      () => f.db.exec("UPDATE worker_claim_recoveries SET note='tampered'"),
      /immutable/,
    );
    assert.throws(() => f.db.exec('DELETE FROM worker_claim_recoveries'), /immutable/);
  } finally {
    f.db.close();
  }
});
test('claims denied before gas reservation can be retired without inventing or releasing expenses', () => {
  const f = fixture(':memory:', false);
  try {
    assert.equal(f.recovery.preview(context).preservedGasHoldUsdCents, 0);
    f.recovery.approve(input(f.recovery), 'operator', () => context);
    assert.deepEqual(f.budget.list(), []);
    assert.equal(f.budget.snapshot().remainingUsdCents, 30000);
  } finally {
    f.db.close();
  }
});
test('recovery approves at most 50 held claims and leaves the remaining batch recoverable without changing gas holds', () => {
  const ids = Array.from({ length: 53 }, (_, index) => `job-${String(index).padStart(3, '0')}`);
  const f = fixture(':memory:', true, ids);
  try {
    const holds = JSON.stringify(f.budget.list());
    const signedPayloads = f.db
      .prepare('SELECT payload FROM worker_transactions ORDER BY id')
      .all();
    const first = f.recovery.preview(context);
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.jobId),
      ids.slice(0, 50),
    );
    assert.equal(first.preservedGasHoldUsdCents, 100);
    const request = {
      reviewFingerprint: first.reviewFingerprint,
      note: 'Reviewed this bounded batch and retained all original gas holds.',
      acknowledge: true as const,
      evidence: evidence(ids.slice(0, 50)),
      quote,
    };
    const approved = f.recovery.approve(request, 'operator', () => context);
    assert.equal(approved.successors.length, 50);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM service_jobs WHERE stage='retired'").get()!.n,
      50,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM service_jobs WHERE stage='planned'").get()!.n,
      50,
    );
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM worker_transactions WHERE state='expired_review'")
        .get()!.n,
      3,
    );
    assert.equal(JSON.stringify(f.budget.list()), holds);

    const next = f.recovery.preview(context);
    assert.deepEqual(
      next.candidates.map((candidate) => candidate.jobId),
      ids.slice(50),
    );
    assert.equal(next.preservedGasHoldUsdCents, 6);
    assert.notEqual(next.reviewFingerprint, first.reviewFingerprint);
    const remainder = f.recovery.approve(
      { ...request, reviewFingerprint: next.reviewFingerprint, evidence: evidence(ids.slice(50)) },
      'operator',
      () => context,
    );
    assert.equal(remainder.successors.length, 3);
    assert.equal(f.recovery.preview(context).candidates.length, 0);
    assert.deepEqual(
      f.recovery.approve(request, 'operator', () => context),
      approved,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM service_jobs WHERE stage='planned'").get()!.n,
      53,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM worker_claim_recoveries').get()!.n, 2);
    assert.equal(JSON.stringify(f.budget.list()), holds);
    assert.equal(f.budget.snapshot().unresolvedUsdCents, 106);
    assert.deepEqual(
      f.db.prepare('SELECT payload FROM worker_transactions ORDER BY id').all(),
      signedPayloads,
    );
  } finally {
    f.db.close();
  }
});
test('exact approval retries survive restart and subsequent work without creating successors again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-recovery-'));
  const path = join(dir, 'db.sqlite');
  const f = fixture(path);
  const request = input(f.recovery);
  const grant = f.recovery.approve(request, 'operator', () => context);
  f.db.close();
  const db = new DatabaseSync(path);
  try {
    const recovery = new ClaimRecovery(db, () => now + 120_000);
    assert.deepEqual(
      recovery.approve(request, 'operator', () => {
        throw new Error('scope changed');
      }),
      grant,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_jobs').get()!.n, 4);
    assert.throws(
      () =>
        recovery.approve(
          { ...request, note: 'Another meaningful note' },
          'operator',
          () => context,
        ),
      /conflict|immutable/,
    );
    assert.throws(
      () => recovery.approve(request, 'another-operator', () => context),
      /conflict|immutable/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('stale scope and changed original evidence reject without partially retiring any job', () => {
  const f = fixture();
  try {
    const request = input(f.recovery);
    assert.throws(
      () => f.recovery.approve(request, 'operator', () => ({ ...context, policy: 'changed' })),
      /stale/,
    );
    f.budget.settle(
      'gas:claim:one',
      {
        attemptId: 'attemptgas:signature:one',
        actualUsdCents: 1,
        evidenceId: 'signature:one',
        evidenceKind: 'solana_transaction_fee',
      },
      'test',
    );
    assert.throws(() => f.recovery.approve(request, 'operator', () => context), /stale/);
    assert.equal(f.journal.get('claim:two')?.state, 'expired_review');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM worker_claim_recoveries').get()!.n, 0);
  } finally {
    f.db.close();
  }
});
test('missing acknowledgement, missing evidence, stale quote, and uncertain or insufficient RPC evidence are rejected', () => {
  const f = fixture();
  try {
    const request = input(f.recovery);
    const mutations = [
      { ...request, acknowledge: false },
      { ...request, evidence: request.evidence.slice(1) },
      { ...request, quote: { ...quote, observedAt: new Date(now - 60_001).toISOString() } },
      { ...request, evidence: request.evidence.map((e) => ({ ...e, sources: [e.sources[0]] })) },
      {
        ...request,
        evidence: request.evidence.map((e) => ({
          ...e,
          sources: e.sources.map((s) => ({ ...s, finalizedBlockHeight: 100 })),
        })),
      },
      {
        ...request,
        evidence: request.evidence.map((e) => ({
          ...e,
          sources: e.sources.map((s) => ({ ...s, status: { confirmationStatus: 'confirmed' } })),
        })),
      },
    ];
    for (const bad of mutations)
      assert.throws(() => f.recovery.approve(bad as typeof request, 'operator', () => context));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM worker_claim_recoveries').get()!.n, 0);
    assert.equal(f.journal.get('claim:one')?.state, 'expired_review');
  } finally {
    f.db.close();
  }
});
test('retired transactions never reconcile or rebroadcast automatically, but verified late proof can settle them', async () => {
  const f = fixture();
  try {
    f.recovery.approve(input(f.recovery), 'operator', () => context);
    let calls = 0;
    const dispatcher = new TransactionDispatcher(f.journal, {
      async broadcast() {
        calls++;
        throw new Error('not allowed');
      },
      async reconcile() {
        calls++;
        throw new Error('unavailable');
      },
    });
    assert.equal(
      (
        await dispatcher.execute('claim:one', async () => {
          throw new Error('not allowed');
        })
      ).state,
      'retired_expired',
    );
    assert.equal((await dispatcher.reconcile('claim:one')).state, 'retired_expired');
    assert.equal(calls, 0);
    assert.throws(() => f.journal.update('claim:one', 'unknown'), /retired/);
    f.journal.update('claim:one', 'confirmed');
    assert.equal(f.journal.get('claim:one')?.state, 'confirmed');
  } finally {
    f.db.close();
  }
});
test('approval locks context reads against competing writers and rolls back all rows on failed successor insert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-recovery-lock-'));
  const path = join(dir, 'db.sqlite');
  const f = fixture(path);
  const other = new DatabaseSync(path);
  other.exec('PRAGMA busy_timeout=0');
  try {
    const request = input(f.recovery);
    f.db.exec(
      "CREATE TRIGGER fail_successor BEFORE INSERT ON service_jobs WHEN NEW.stage='planned' BEGIN SELECT RAISE(ABORT,'test insert failure'); END",
    );
    assert.throws(
      () =>
        f.recovery.approve(request, 'operator', () => {
          assert.throws(
            () => other.prepare("UPDATE service_jobs SET stage='done' WHERE id='one'").run(),
            /locked/,
          );
          return context;
        }),
      /test insert failure/,
    );
    assert.equal(f.journal.get('claim:one')?.state, 'expired_review');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM service_jobs').get()!.n, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM worker_claim_recoveries').get()!.n, 0);
  } finally {
    other.close();
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
