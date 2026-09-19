import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  AutonomousPipeline,
  type FeeLot,
  type PipelineAdapters,
} from '../server/agents/pipeline.ts';
const lot: FeeLot = {
  id: 'lot',
  tokenId: 'token',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '1000000000',
  decimals: 9,
  claimReference: 'claim',
  recipient: { platform: 'twitch', providerId: 'twitch:42', username: 'streamer' },
};
function fixture(netUsdCents = 10003, spend = 9999, credit = 10003) {
  const db = new DatabaseSync(':memory:');
  let gifts = 0;
  const adapters: PipelineAdapters = {
    deposit: async () => ({ reference: 'deposit' }),
    reconcileDeposit: async (job) => ({ reference: 'deposit', jobId: job.id }),
    convert: async () => ({ reference: 'order' }),
    reconcileConversion: async (job) => ({ reference: 'order', jobId: job.id, netUsdCents }),
    live: async () => true,
    cardReady: async () => ({
      cardAccountId: 'card',
      availableCreditCents: credit,
      observedAt: Date.now(),
    }),
    gift: async () => {
      gifts++;
      return { reference: 'purchase' };
    },
    reconcileGift: async (job) => ({
      jobId: job.id,
      cardAccountId: 'card',
      chargeStatus: 'POSTED',
      purchaseReference: 'purchase',
      reference: 'receipt',
      chargeReference: 'charge',
      spentUsdCents: spend,
      recipientProviderId: 'twitch:42',
      currency: 'USD',
    }),
  };
  const worker = new AutonomousPipeline(db, adapters, {
    enabled: true,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: 50000,
  });
  worker.recordClaim(lot);
  return {
    db,
    adapters,
    worker,
    gifts: () => gifts,
    advance: async (count: number) => {
      for (let i = 0; i < count; i++) await worker.runOnce();
    },
  };
}
test('already native-split streamer proceeds are reserved without a second USD split', async () => {
  const f = fixture();
  try {
    await f.advance(5);
    const reserved = f.worker.list()[0];
    assert.equal(reserved.netUsdCents, 10003);
    assert.equal(reserved.platformReserveUsdCents, 0);
    assert.equal(reserved.streamerBudgetUsdCents, 10003);
    assert.equal(reserved.phase, 'gifting');
    assert.equal(
      f.db.prepare('SELECT cents FROM agent_card_reservations WHERE job_id=?').get(lot.id)!.cents,
      10003,
    );
    await f.advance(1);
    const completed = f.worker.list()[0];
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.spentUsdCents, 9999);
    assert.equal(completed.residualUsdCents, 4);
    assert.equal(
      completed.spentUsdCents! + completed.residualUsdCents! + completed.platformReserveUsdCents!,
      completed.netUsdCents,
    );
    assert.equal(f.gifts(), 1);
  } finally {
    f.db.close();
  }
});
test('gift minimum and maximum apply to all verified streamer conversion proceeds', async () => {
  const below = fixture(4999, 4999, 4999);
  const eligible = fixture(50000, 50000, 50000);
  try {
    await below.advance(6);
    assert.equal(below.gifts(), 0);
    assert.equal(below.worker.list()[0].phase, 'converted');
    await eligible.advance(6);
    assert.equal(eligible.gifts(), 1);
    assert.equal(eligible.worker.list()[0].phase, 'completed');
    assert.equal(eligible.worker.list()[0].platformReserveUsdCents, 0);
  } finally {
    below.db.close();
    eligible.db.close();
  }
});
test('receipt cannot overspend verified streamer proceeds', async () => {
  const f = fixture(10003, 10004, 20000);
  try {
    await f.advance(8);
    assert.equal(f.gifts(), 1);
    assert.equal(f.worker.list()[0].phase, 'gifting');
    assert.equal(f.worker.list()[0].platformReserveUsdCents, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_receipts').get()!.n, 0);
  } finally {
    f.db.close();
  }
});
test('every verified streamer cent remains available, including large safe values', async () => {
  for (const net of [1, 4, 5, 10003, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(net);
    try {
      await f.advance(4);
      const value = f.worker.list()[0];
      const reserve = 0;
      assert.equal(value.platformReserveUsdCents, reserve);
      assert.equal(value.streamerBudgetUsdCents, net - reserve);
    } finally {
      f.db.close();
    }
  }
});

test('legacy persisted jobs stay held in every unfinished phase before adapters run', async () => {
  for (const phase of [
    'claimed',
    'depositing',
    'deposited',
    'converting',
    'converted',
    'gifting',
  ]) {
    const f = fixture();
    try {
      const job = {
        ...f.worker.list()[0],
        phase,
        netUsdCents: 10003,
        streamerBudgetUsdCents: 8003,
        platformReserveUsdCents: 2000,
      };
      delete job.allocationVersion;
      f.db.prepare('UPDATE agent_fee_jobs SET phase=?,payload=?').run(phase, JSON.stringify(job));
      let calls = 0;
      for (const key of Object.keys(f.adapters))
        (f.adapters as any)[key] = async () => {
          calls++;
          throw Error('legacy replay');
        };
      await f.advance(3);
      assert.equal(calls, 0);
      assert.equal(f.worker.list()[0].phase, phase);
      assert.match(f.worker.list()[0].issue!, /allocation version/i);
    } finally {
      f.db.close();
    }
  }
});
test('policy rejects a second USD allocation split', () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        new AutonomousPipeline(f.db, f.adapters, {
          enabled: true,
          minimumGiftUsdCents: 1,
          maximumGiftUsdCents: 100,
          streamerBps: 8000,
        }),
    );
  } finally {
    f.db.close();
  }
});
