import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { TestingBudget } from '../server/workers/testing-budget.ts';

const actor = 'test-runner';
const request = (
  operationId: string,
  maxUsdCents: number,
  kind: 'gift' | 'chain_fee' | 'offramp_fee' | 'browser_fee' | 'provider_fee' = 'gift',
) => ({ operationId, kind, maxUsdCents });
function fixture() {
  const db = new DatabaseSync(':memory:');
  return { db, budget: new TestingBudget(db), close: () => db.close() };
}

test('observed costs reconcile without authorizing execution, including an already exhausted or frozen cap', () => {
  const t = fixture();
  try {
    t.budget.reserve(request('other', 30000), actor);
    const input = {
      operationId: 'observed-gas',
      kind: 'chain_fee' as const,
      attemptId: 'attemptgas:signature',
      actualUsdCents: 2,
      evidenceKind: 'solana_transaction_fee' as const,
      evidenceId: 'signature',
    };
    const result = t.budget.reconcileObservedCost(input, actor);
    assert.equal('execute' in result, false);
    assert.equal(result.state, 'settled');
    assert.equal(t.budget.snapshot().committedUsdCents, 2);
    assert.equal(t.budget.snapshot().frozen, true);
    t.budget.reconcileObservedCost(input, actor);
    assert.equal(t.budget.snapshot().committedUsdCents, 2);
    assert.equal(t.budget.begin(input.operationId, input.attemptId, actor).execute, false);
    assert.throws(
      () => t.budget.reconcileObservedCost({ ...input, operationId: 'different' }, actor),
      /evidence|attempt/i,
    );
  } finally {
    t.close();
  }
});

test('observed operator receipts settle a never-begun hold, book overruns and cannot duplicate verified evidence', () => {
  const t = fixture();
  try {
    t.budget.reserve(request('gift', 5000), actor);
    const input = {
      operationId: 'gift',
      kind: 'gift' as const,
      attemptId: 'manualgift:receipt',
      actualUsdCents: 5100,
      evidenceKind: 'operator_attested_twitch_receipt' as const,
      evidenceId: 'receipt',
    };
    t.budget.reconcileObservedCost(input, actor);
    assert.equal(t.budget.snapshot().committedUsdCents, 5100);
    assert.equal(t.budget.snapshot().frozen, true);
    assert.equal(t.budget.get('gift')?.evidenceKind, 'operator_attested_twitch_receipt');
    assert.equal(t.budget.begin('gift', input.attemptId, actor).execute, false);
    assert.throws(
      () =>
        t.budget.reconcileObservedCost(
          {
            ...input,
            operationId: 'another',
            attemptId: 'other-attempt',
            evidenceKind: 'twitch_receipt',
          },
          actor,
        ),
      /evidence/i,
    );
    assert.throws(
      () => t.budget.reconcileObservedCost({ ...input, actualUsdCents: 5101 }, actor),
      /different/i,
    );
  } finally {
    t.close();
  }
});

test('one durable cap includes reserved, unresolved, and confirmed gift and fee costs', () => {
  const t = fixture();
  try {
    t.budget.reserveMany(
      [
        request('gift', 29000),
        request('gas', 100, 'chain_fee'),
        request('offramp', 300, 'offramp_fee'),
        request('browser', 600, 'browser_fee'),
      ],
      actor,
    );
    assert.equal(t.budget.snapshot().remainingUsdCents, 0);
    assert.equal(t.budget.begin('gift', 'checkout-1', actor).execute, true);
    assert.equal(t.budget.begin('gas', 'solana-fee-1', actor).execute, true);
    t.budget.settle(
      'gas',
      {
        attemptId: 'solana-fee-1',
        actualUsdCents: 50,
        evidenceId: 'signature-1',
        evidenceKind: 'solana_transaction_fee',
      },
      actor,
    );
    const totals = t.budget.snapshot();
    assert.equal(totals.committedUsdCents, 50);
    assert.equal(totals.unresolvedUsdCents, 29000);
    assert.equal(totals.reservedUsdCents, 900);
    assert.equal(totals.remainingUsdCents, 50);
    assert.throws(() => t.budget.reserve(request('extra', 51), actor), /cap/);
  } finally {
    t.close();
  }
});

test('funding principal is not an expense kind; reserve the gift once before a card top-up', () => {
  const t = fixture();
  try {
    t.budget.reserveMany(
      [
        request('gift', 10000),
        request('topup-fee', 200, 'offramp_fee'),
        request('topup-gas', 10, 'chain_fee'),
      ],
      actor,
    );
    assert.equal(t.budget.snapshot().allocatedUsdCents, 10210);
    assert.throws(
      () =>
        t.budget.reserve(
          { ...request('card-principal', 10000), kind: 'card_funding' } as never,
          actor,
        ),
      /kind/,
    );
    assert.equal(t.budget.snapshot().allocatedUsdCents, 10210);
  } finally {
    t.close();
  }
});

test('failed reservation batches are atomic and money fields reject noninteger or unsafe values', () => {
  const t = fixture();
  try {
    assert.throws(
      () => t.budget.reserveMany([request('a', 20000), request('b', 10001)], actor),
      /cap/,
    );
    assert.equal(t.budget.list().length, 0);
    for (const cents of [-1, 0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => t.budget.reserve(request('bad', cents), actor), /integer/);
    t.budget.reserve(request('exact', 30000), actor);
    assert.equal(t.budget.snapshot().remainingUsdCents, 0);
  } finally {
    t.close();
  }
});

test('begin is durable and exactly one caller may execute; restarting only reconciles the same operation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pog-testing-budget-'));
  const path = join(dir, 'state.sqlite');
  let db = new DatabaseSync(path);
  try {
    let budget = new TestingBudget(db);
    budget.reserve(request('gift', 15000), actor);
    assert.equal(budget.begin('gift', 'checkout-1', actor).execute, true);
    db.close();
    db = new DatabaseSync(path);
    budget = new TestingBudget(db);
    assert.equal(budget.reserve(request('gift', 15000), actor).state, 'unresolved');
    assert.equal(budget.begin('gift', 'checkout-1', actor).execute, false);
    assert.throws(() => budget.begin('gift', 'replacement-checkout', actor), /original/);
    assert.throws(() => budget.reserve(request('gift', 15001), actor), /different/);
    assert.equal(budget.snapshot().unresolvedUsdCents, 15000);
    assert.throws(() => budget.cancelBeforeExecution('gift', actor), /unresolved/);
    assert.throws(
      () =>
        budget.releaseNoSpend(
          'gift',
          { attemptId: 'checkout-1', evidenceId: 'timeout', evidenceKind: 'timeout' } as never,
          actor,
        ),
      /definitive/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('related expense starts commit together and cannot authorize inside an outer transaction', () => {
  const t = fixture();
  try {
    t.budget.reserveMany(
      [request('gas', 10, 'chain_fee'), request('offramp', 100, 'offramp_fee')],
      actor,
    );
    t.db.exec('BEGIN');
    assert.throws(() => t.budget.begin('gas', 'topup:gas', actor), /standalone/);
    t.db.exec('ROLLBACK');
    assert.equal(t.budget.get('gas')?.state, 'reserved');
    const starts = [
      { operationId: 'gas', attemptId: 'topup:gas' },
      { operationId: 'offramp', attemptId: 'topup:offramp' },
    ];
    assert.equal(t.budget.beginMany(starts, actor).execute, true);
    assert.equal(t.budget.beginMany(starts, actor).execute, false);
    t.budget.reserve(request('another-fee', 50, 'provider_fee'), actor);
    assert.throws(
      () =>
        t.budget.beginMany(
          [starts[0], { operationId: 'another-fee', attemptId: 'another' }],
          actor,
        ),
      /original/,
    );
    assert.equal(t.budget.get('another-fee')?.state, 'reserved');
  } finally {
    if (t.db.isTransaction) t.db.exec('ROLLBACK');
    t.close();
  }
});

test('only known unsubmitted cancellation or verified final no-charge releases a reservation', () => {
  const t = fixture();
  try {
    t.budget.reserve(request('unsubmitted', 10000), actor);
    t.budget.cancelBeforeExecution('unsubmitted', actor);
    assert.equal(t.budget.cancelBeforeExecution('unsubmitted', actor).state, 'released');
    assert.throws(() => t.budget.begin('unsubmitted', 'new-attempt', actor), /released/);
    t.budget.reserve(request('unknown', 20000), actor);
    t.budget.begin('unknown', 'purchase-1', actor);
    const proof = {
      attemptId: 'purchase-1',
      evidenceId: 'provider-final-1',
      evidenceKind: 'provider_final_no_charge' as const,
    };
    t.budget.releaseNoSpend('unknown', proof, actor);
    assert.equal(t.budget.releaseNoSpend('unknown', proof, actor).state, 'released');
    assert.equal(t.budget.snapshot().remainingUsdCents, 30000);
    assert.equal(t.budget.begin('unknown', 'purchase-1', actor).execute, false);
  } finally {
    t.close();
  }
});

test('settlements are idempotent, globally deduplicate cost evidence, and cannot silently change a receipt', () => {
  const t = fixture();
  try {
    for (const id of ['one', 'two']) {
      t.budget.reserve(request(id, 6000), actor);
      t.budget.begin(id, `checkout-${id}`, actor);
    }
    const proof = {
      attemptId: 'checkout-one',
      actualUsdCents: 5500,
      evidenceId: 'receipt-1',
      evidenceKind: 'twitch_receipt' as const,
    };
    t.budget.settle('one', proof, actor);
    t.budget.settle('one', proof, actor);
    assert.equal(t.budget.snapshot().committedUsdCents, 5500);
    assert.throws(
      () => t.budget.settle('one', { ...proof, actualUsdCents: 5000 }, actor),
      /different/,
    );
    assert.throws(
      () => t.budget.settle('two', { ...proof, attemptId: 'checkout-two' }, actor),
      /evidence/,
    );
    assert.throws(
      () =>
        t.budget.releaseNoSpend(
          'one',
          {
            attemptId: 'checkout-one',
            evidenceId: 'refund',
            evidenceKind: 'provider_final_no_charge',
          },
          actor,
        ),
      /settled/,
    );
    assert.equal(t.budget.snapshot().unresolvedUsdCents, 6000);
  } finally {
    t.close();
  }
});

test('confirmed overrun is recorded, freezes future execution, and retains other unresolved costs', () => {
  const t = fixture();
  try {
    t.budget.reserveMany(
      [
        request('gift', 25000),
        request('browser', 4000, 'browser_fee'),
        request('gas', 1000, 'chain_fee'),
      ],
      actor,
    );
    t.budget.begin('gift', 'checkout-1', actor);
    t.budget.begin('browser', 'session-1', actor);
    t.budget.settle(
      'gift',
      {
        attemptId: 'checkout-1',
        actualUsdCents: 31000,
        evidenceId: 'receipt-overrun',
        evidenceKind: 'kick_receipt',
      },
      actor,
    );
    const totals = t.budget.snapshot();
    assert.equal(totals.committedUsdCents, 31000);
    assert.equal(totals.overCapUsdCents, 6000);
    assert.equal(totals.frozen, true);
    assert.equal(totals.remainingUsdCents, 0);
    assert.throws(() => t.budget.reserve(request('more', 1), actor), /frozen/);
    assert.throws(() => t.budget.begin('gas', 'gas-new', actor), /frozen/);
    assert.equal(t.budget.begin('browser', 'session-1', actor).execute, false);
    t.budget.settle(
      'browser',
      {
        attemptId: 'session-1',
        actualUsdCents: 3000,
        evidenceId: 'usage-1',
        evidenceKind: 'browserbase_invoice_item',
      },
      actor,
    );
    assert.equal(t.budget.snapshot().committedUsdCents, 34000);
    assert.equal(t.budget.snapshot().frozen, true);
  } finally {
    t.close();
  }
});

test('cap and audit history cannot be reset through SQL updates or deletes', () => {
  const t = fixture();
  try {
    t.budget.reserve(request('gift', 100), actor);
    assert.throws(
      () => t.db.exec('UPDATE worker_testing_budget_config SET cap_cents=40000'),
      /immutable/,
    );
    assert.throws(() => t.db.exec('DELETE FROM worker_testing_budget_config'), /immutable/);
    assert.throws(() => t.db.exec('DELETE FROM worker_testing_budget_events'), /immutable/);
    assert.equal(t.budget.snapshot().capUsdCents, 30000);
  } finally {
    t.close();
  }
});

test('competing reservations on independent SQLite handles cannot exceed the total cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pog-testing-budget-race-'));
  const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  new TestingBudget(db);
  db.close();
  const barrier = new SharedArrayBuffer(8);
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    require('tsx/cjs');
    const { TestingBudget } = require(workerData.module);
    const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=5000');
    const budget = new TestingBudget(db); const gate = new Int32Array(workerData.barrier);
    Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
    Atomics.wait(gate, 1, 0);
    try { budget.reserve({operationId:workerData.id,kind:'gift',maxUsdCents:20000}, 'race'); parentPort.postMessage('reserved'); }
    catch(error) { parentPort.postMessage(error.message.includes('cap') ? 'capped' : 'other-error'); }
    finally {db.close();}`;
  const workers = [1, 2].map(
    (id) =>
      new Worker(source, {
        eval: true,
        workerData: {
          module: new URL('../server/workers/testing-budget.ts', import.meta.url).pathname,
          path,
          id: `operation-${id}`,
          barrier,
        },
      }),
  );
  const results = workers.map(
    (worker) =>
      new Promise<string>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      }),
  );
  try {
    const gate = new Int32Array(barrier);
    const readyBy = Date.now() + 5000;
    while (Atomics.load(gate, 0) < 2) {
      if (Date.now() > readyBy) throw Error('Workers did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1, 2);
    assert.deepEqual((await Promise.all(results)).sort(), ['capped', 'reserved']);
    const check = new DatabaseSync(path);
    try {
      assert.equal(new TestingBudget(check).snapshot().allocatedUsdCents, 20000);
    } finally {
      check.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});
