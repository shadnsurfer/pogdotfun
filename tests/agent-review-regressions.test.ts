import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutonomousPipeline,
  type FeeLot,
  type PipelineAdapters,
  type PipelineJob,
} from '../server/agents/pipeline.ts';
import { autonomousRuntime, type WorkerIntegrations } from '../server/agents/runtime.ts';
import type { StreamerLiveGate } from '../server/workers/streamer-live.ts';

const policy = {
  enabled: true,
  streamerBps: 10000,
  minimumGiftUsdCents: 5000,
  maximumGiftUsdCents: 50000,
};
const lot = (index: number): FeeLot => ({
  id: `lot-${index}`,
  tokenId: 'token',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '1000000000',
  decimals: 9,
  claimReference: `claim-${index}`,
  recipient: { platform: 'twitch', providerId: 'twitch:42', username: 'streamer' },
});
function adapters(): PipelineAdapters {
  return {
    deposit: async () => {
      throw new Error('Unexpected deposit');
    },
    reconcileDeposit: async () => null,
    convert: async () => {
      throw new Error('Unexpected conversion');
    },
    reconcileConversion: async () => null,
    live: async () => true,
    cardReady: async () => ({
      cardAccountId: 'card',
      availableCreditCents: 50000,
      observedAt: Date.now(),
    }),
    gift: async () => ({ reference: 'purchase' }),
    reconcileGift: async () => null,
  };
}
function seed(
  worker: AutonomousPipeline,
  db: DatabaseSync,
  index: number,
  phase: PipelineJob['phase'],
  netUsdCents?: number,
) {
  const value = lot(index);
  worker.recordClaim(value);
  db.prepare('UPDATE agent_fee_jobs SET phase=?,payload=? WHERE id=?').run(
    phase,
    JSON.stringify({
      ...value,
      allocationVersion: 'native-streamer-v1',
      phase,
      ...(netUsdCents === undefined
        ? {}
        : { netUsdCents, streamerBudgetUsdCents: netUsdCents, platformReserveUsdCents: 0 }),
    }),
    value.id,
  );
}

test('bounded queue rotation persists across database reopen and cannot starve a later eligible gift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pog-fair-queue-'));
  const path = join(directory, 'queue.db');
  let db = new DatabaseSync(path);
  let gifts = 0;
  const api = adapters();
  api.gift = async () => {
    gifts++;
    return { reference: 'purchase' };
  };
  try {
    let worker = new AutonomousPipeline(db, api, policy);
    for (let index = 0; index < 100; index++) seed(worker, db, index, 'converted', 4999);
    seed(worker, db, 100, 'converted', 6000);
    await worker.runOnce();
    assert.equal(gifts, 0, 'one run visits at most 100 jobs');
    db.close();
    db = new DatabaseSync(path);
    worker = new AutonomousPipeline(db, api, policy);
    await worker.runOnce();
    assert.equal(gifts, 1, 'restart continues past the 100 permanent holds');
    assert.equal(worker.list().find((job) => job.id === 'lot-100')?.phase, 'gifting');
    for (let i = 0; i < 4; i++) await new AutonomousPipeline(db, api, policy).runOnce();
    assert.equal(gifts, 1, 'rotation reconciles the same uncertain gift without resubmitting');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('queue batches wrap fairly, stay bounded, and retain compare-and-swap submission safety', async () => {
  const db = new DatabaseSync(':memory:');
  const seen: string[] = [];
  const api = adapters();
  api.reconcileDeposit = async (job) => {
    seen.push(job.id);
    return null;
  };
  try {
    const worker = new AutonomousPipeline(db, api, policy);
    for (let i = 0; i < 205; i++) seed(worker, db, i, 'depositing');
    for (let i = 0; i < 3; i++) {
      const count = seen.length;
      await new AutonomousPipeline(db, api, policy).runOnce();
      assert.equal(seen.length - count, 100);
      assert.equal(new Set(seen.slice(count)).size, 100);
    }
    assert.equal(new Set(seen).size, 205, 'every unfinished job is eventually reconciled');
    assert.deepEqual(seen.slice(200, 205), ['lot-200', 'lot-201', 'lot-202', 'lot-203', 'lot-204']);
  } finally {
    db.close();
  }
});

const env = {
  POG_COINBASE_KEY_NAME: 'fixture',
  POG_COINBASE_PRIVATE_KEY: 'fixture',
  BROWSERBASE_API_KEY: 'fixture',
  BROWSERBASE_PROJECT_ID: 'project',
  POG_COINBASE_ACCOUNT_ID: 'coinbase',
  POG_COINBASE_SOL_ADDRESS: 'address',
  POG_TWITCH_ACCOUNT_ID: 'buyer',
  POG_TWITCH_CONTEXT_ID: 'context',
  POG_CARD_ACCOUNT_ID: 'card',
  POG_CARD_LAST4: '1234',
};
const gate = { requireLive: async () => ({}), assertFreshLive() {} } as unknown as StreamerLiveGate;
const integrations: WorkerIntegrations = {
  cardEvidence: { readBalance: async () => null, readCharge: async () => null },
  readGiftEvidence: async () => null,
};

test('malformed JavaScript worker bindings cannot compose any funding or browser rails', () => {
  for (const input of [
    undefined,
    null,
    {},
    [],
    { readGiftEvidence: async () => null },
    { ...integrations, readGiftEvidence: undefined },
    { ...integrations, readGiftEvidence: 'configured' },
    { ...integrations, cardEvidence: {} },
    { ...integrations, cardEvidence: { readBalance: async () => null } },
    { ...integrations, cardEvidence: { readBalance: 'configured', readCharge: async () => null } },
    { ...integrations, cardEvidence: { readBalance: async () => null, readCharge: false } },
  ]) {
    const db = new DatabaseSync(':memory:');
    let providerCalls = 0;
    try {
      const runtime = autonomousRuntime(
        db,
        env,
        () => {
          providerCalls++;
          throw Error('No provider access');
        },
        gate,
        input as unknown as WorkerIntegrations,
      );
      assert.equal(runtime, undefined);
      assert.equal(providerCalls, 0);
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()!.count,
        0,
        'reject incomplete bindings before constructing persistent provider rails',
      );
    } finally {
      db.close();
    }
  }
});

test('complete evidence readers remain compatible with a trusted injected live gate', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const runtime = autonomousRuntime(
      db,
      env,
      () => {
        throw Error('No provider access');
      },
      gate,
      integrations,
    );
    assert.ok(runtime);
    assert.equal(runtime.feeRouteReady({ chain: 'solana', recipient: lot(0).recipient }), true);
  } finally {
    db.close();
  }
});
test('concurrent rotating workers preserve one deposit submission per fee job', async () => {
  const db = new DatabaseSync(':memory:');
  const calls: string[] = [];
  const api = adapters();
  api.deposit = async (job) => {
    calls.push(job.id);
    return { reference: `deposit-${job.id}` };
  };
  try {
    const first = new AutonomousPipeline(db, api, policy);
    const second = new AutonomousPipeline(db, api, policy);
    for (let i = 0; i < 150; i++) first.recordClaim(lot(i));
    await Promise.all([first.runOnce(), second.runOnce()]);
    assert.equal(calls.length, 150);
    assert.equal(new Set(calls).size, 150);
    await Promise.all([first.runOnce(), second.runOnce()]);
    assert.equal(calls.length, 150, 'later rotations only reconcile submitted deposits');
  } finally {
    db.close();
  }
});
