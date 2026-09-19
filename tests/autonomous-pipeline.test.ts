import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  AutonomousPipeline,
  type FeeLot,
  type PipelineAdapters,
} from '../server/agents/pipeline.ts';
const lot: FeeLot = {
  id: 'solana:claim:0',
  tokenId: 'token1',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '1000000000',
  decimals: 9,
  claimReference: 'claim',
  recipient: { platform: 'twitch', providerId: 'twitch:1', username: 'alice' },
};
function adapters(): PipelineAdapters {
  return {
    deposit: async () => ({ reference: 'deposit' }),
    reconcileDeposit: async (j) => ({ reference: 'deposit:' + j.id, jobId: j.id }),
    convert: async () => ({ reference: 'order' }),
    reconcileConversion: async (j) => ({
      reference: 'order:' + j.id,
      jobId: j.id,
      netUsdCents: 10000,
    }),
    live: async () => true,
    cardReady: async () => ({
      cardAccountId: 'card',
      availableCreditCents: 100000,
      observedAt: Date.now(),
    }),
    gift: async () => ({ reference: 'purchase' }),
    reconcileGift: async (j) => ({
      jobId: j.id,
      cardAccountId: 'card',
      chargeStatus: 'POSTED',
      purchaseReference: 'purchase',
      reference: 'receipt',
      chargeReference: 'charge',
      spentUsdCents: 9990,
      recipientProviderId: 'twitch:1',
      currency: 'USD',
    }),
  };
}
test('confirmed fees flow to deposit, conversion and verified gift without human actions', async () => {
  const db = new DatabaseSync(':memory:');
  const worker = new AutonomousPipeline(db, adapters(), {
    enabled: true,
    streamerBps: 10000,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 20000,
  });
  worker.recordClaim(lot);
  worker.recordClaim(lot);
  for (let i = 0; i < 8; i++) await worker.runOnce();
  assert.equal(worker.list().length, 1);
  assert.equal(worker.list()[0].phase, 'completed');
  assert.equal(worker.list()[0].residualUsdCents, 10);
  db.close();
});
test('uncertain side effects never replay after restart and mismatched receipts cannot complete', async () => {
  const db = new DatabaseSync(':memory:');
  const api = adapters();
  let submits = 0;
  api.deposit = async () => {
    submits++;
    throw new Error('timeout');
  };
  api.reconcileDeposit = async () => null;
  const config = {
    enabled: true,
    streamerBps: 10000,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 20000,
  };
  const first = new AutonomousPipeline(db, api, config);
  first.recordClaim(lot);
  await first.runOnce();
  const next = new AutonomousPipeline(db, api, config);
  await next.runOnce();
  await next.runOnce();
  assert.equal(submits, 1);
  assert.equal(next.list()[0].phase, 'depositing');
  assert.throws(() => next.recordClaim({ ...lot, amountBaseUnits: '2000000000' }));
  db.close();
});
test('offline streamers and unverified card capacity hold funds', async () => {
  const db = new DatabaseSync(':memory:');
  const api = adapters();
  let gifts = 0;
  api.live = async () => false;
  api.gift = async () => {
    gifts++;
    return { reference: 'bad' };
  };
  const worker = new AutonomousPipeline(db, api, {
    enabled: true,
    streamerBps: 10000,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 20000,
  });
  worker.recordClaim(lot);
  for (let i = 0; i < 8; i++) await worker.runOnce();
  assert.equal(gifts, 0);
  assert.equal(worker.list()[0].phase, 'converted');
  db.close();
});
test('one settled card charge cannot complete different fee lots', async () => {
  const db = new DatabaseSync(':memory:');
  const worker = new AutonomousPipeline(db, adapters(), {
    enabled: true,
    streamerBps: 10000,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 20000,
  });
  worker.recordClaim(lot);
  worker.recordClaim({ ...lot, id: 'solana:claim2:0', claimReference: 'claim2' });
  for (let i = 0; i < 10; i++) await worker.runOnce();
  assert.equal(worker.list().filter((j) => j.phase === 'completed').length, 1);
  db.close();
});

test('one conversion order cannot fund two independent fee lots', async () => {
  const db = new DatabaseSync(':memory:');
  const api = adapters();
  let gifts = 0;
  api.reconcileConversion = async (j) => ({
    reference: 'shared-order',
    jobId: j.id,
    netUsdCents: 10000,
  });
  api.gift = async () => {
    gifts++;
    return { reference: 'purchase' };
  };
  const worker = new AutonomousPipeline(db, api, {
    enabled: true,
    streamerBps: 10000,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 20000,
  });
  worker.recordClaim(lot);
  worker.recordClaim({ ...lot, id: 'other-lot', claimReference: 'other-claim' });
  for (let i = 0; i < 8; i++) await worker.runOnce();
  assert.equal(gifts, 1);
  assert.equal(worker.list().filter((j) => j.phase === 'converting').length, 1);
  db.close();
});

test('workers atomically reserve shared card capacity before submitting different gifts', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pog-pipeline-'));
  const firstDb = new DatabaseSync(join(dir, 'jobs.sqlite'));
  const secondDb = new DatabaseSync(join(dir, 'jobs.sqlite'));
  try {
    const api = adapters();
    let gifts = 0;
    api.cardReady = async () => ({
      cardAccountId: 'shared-card',
      availableCreditCents: 10000,
      observedAt: Date.now(),
    });
    api.gift = async () => {
      gifts++;
      return { reference: 'purchase' };
    };
    api.reconcileGift = async () => null;
    const policy = {
      enabled: true,
      streamerBps: 10000,
      minimumGiftUsdCents: 5000,
      maximumGiftUsdCents: 20000,
    };
    const first = new AutonomousPipeline(firstDb, api, policy),
      second = new AutonomousPipeline(secondDb, api, policy);
    first.recordClaim(lot);
    first.recordClaim({ ...lot, id: 'second-lot', claimReference: 'second-claim' });
    for (let i = 0; i < 4; i++) await first.runOnce();
    await Promise.all([first.runOnce(), second.runOnce()]);
    assert.equal(gifts, 1);
    assert.equal(first.list().filter((j) => j.phase === 'gifting').length, 1);
    assert.equal(first.list().filter((j) => j.phase === 'converted').length, 1);
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong job, card, purchase or pending issuer charge cannot settle a gift', async () => {
  for (const patch of [
    { jobId: 'wrong-job' },
    { cardAccountId: 'wrong-card' },
    { purchaseReference: 'old-purchase' },
    { chargeStatus: 'PENDING' as 'POSTED' },
  ]) {
    const db = new DatabaseSync(':memory:');
    const api = adapters();
    const valid = api.reconcileGift;
    api.reconcileGift = async (j) => ({ ...(await valid(j))!, ...patch });
    const worker = new AutonomousPipeline(db, api, {
      enabled: true,
      streamerBps: 10000,
      minimumGiftUsdCents: 5000,
      maximumGiftUsdCents: 20000,
    });
    worker.recordClaim(lot);
    for (let i = 0; i < 7; i++) await worker.runOnce();
    assert.equal(worker.list()[0].phase, 'gifting');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_receipts').get()!.n, 0);
    db.close();
  }
});
