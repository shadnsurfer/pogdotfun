import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  AutonomousPipeline,
  type FeeLot,
  type PipelineAdapters,
} from '../server/agents/pipeline.ts';
import { createNativeFeeRouter } from '../server/agents/fee-router.ts';
const lot: FeeLot = {
  id: 'lot',
  tokenId: 'token',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '10003',
  decimals: 9,
  claimReference: 'claim',
  recipient: { platform: 'twitch', providerId: 'twitch:42', username: 'streamer' },
};
function setup() {
  const db = new DatabaseSync(':memory:');
  const pipeline = new AutonomousPipeline(db, {} as PipelineAdapters, {
    enabled: false,
    minimumGiftUsdCents: 1,
    maximumGiftUsdCents: 50000,
  });
  const router = createNativeFeeRouter(db, pipeline);
  return { db, pipeline, router };
}
test('native allocation conserves exact base units on every supported chain, including large integers and dust', () => {
  for (const [chain, asset, decimals] of [
    ['solana', 'SOL', 9],
    ['bnb', 'BNB', 18],
    ['robinhood', 'ETH', 18],
  ] as const) {
    for (const amount of [
      '1',
      '4',
      '5',
      '10003',
      '999999999999999999999999999999999999999999999999999999999999999999999999999999',
    ]) {
      const f = setup();
      try {
        f.router.recordClaim({ ...lot, chain, asset, decimals, amountBaseUnits: amount });
        const split = f.router.splits()[0];
        const reserve = BigInt(amount) / 5n;
        assert.equal(split.version, 'native-streamer-v1');
        assert.equal(split.streamer.id, 'lot:streamer');
        assert.equal(BigInt(split.streamer.amountBaseUnits), BigInt(amount) - reserve);
        assert.equal(BigInt(split.buyback?.amountBaseUnits ?? '0'), reserve);
        assert.equal(f.router.buybackLots().length, reserve === 0n ? 0 : 1);
        assert.equal(f.pipeline.list()[0].amountBaseUnits, split.streamer.amountBaseUnits);
        assert.equal(f.pipeline.list()[0].allocationVersion, 'native-streamer-v1');
      } finally {
        f.db.close();
      }
    }
  }
});
test('redelivery is stable across router recreation and conflicting original identity is rejected', () => {
  const f = setup();
  try {
    f.router.recordClaim(lot);
    const saved = f.router.splits();
    const next = createNativeFeeRouter(f.db, f.pipeline);
    next.recordClaim({
      ...lot,
      recipient: { username: 'streamer', providerId: 'twitch:42', platform: 'twitch' },
    });
    assert.deepEqual(next.splits(), saved);
    assert.equal(f.pipeline.list().length, 1);
    for (const patch of [
      { amountBaseUnits: '10004' },
      { id: 'new-id' },
      { claimReference: 'another' },
      { recipient: { ...lot.recipient, providerId: 'twitch:43' } },
    ])
      assert.throws(() => next.recordClaim({ ...lot, ...patch }));
    assert.equal(next.splits().length, 1);
    next.acknowledgeBuyback('lot:buyback');
    next.acknowledgeBuyback('lot:buyback');
    next.recordClaim(lot);
    assert.deepEqual(next.buybackLots(), []);
    assert.deepEqual(next.splits(), saved, 'acknowledging outbox never changes split evidence');
    assert.throws(() => next.acknowledgeBuyback('unknown'));
  } finally {
    f.db.close();
  }
});
test('split and outbox roll back even if downstream streamer insertion fails after writing', () => {
  const f = setup();
  try {
    const fail = createNativeFeeRouter(f.db, {
      recordClaim(value) {
        f.pipeline.recordClaim(value);
        throw Error('insertion failure');
      },
    });
    assert.throws(() => fail.recordClaim(lot), /insertion failure/);
    assert.deepEqual(f.pipeline.list(), []);
    assert.deepEqual(f.router.splits(), []);
    assert.deepEqual(f.router.buybackLots(), []);
    f.router.recordClaim(lot);
    assert.equal(f.pipeline.list().length, 1);
    assert.equal(f.router.buybackLots()[0].id, 'lot:buyback');
  } finally {
    f.db.close();
  }
});
test('invalid input never creates a split and original split records reject updates and deletion', () => {
  const f = setup();
  try {
    for (const amount of ['0', '-1', '1.5', '01'])
      assert.throws(() => f.router.recordClaim({ ...lot, amountBaseUnits: amount }));
    assert.deepEqual(f.router.splits(), []);
    f.router.recordClaim(lot);
    assert.throws(() => f.db.exec("UPDATE agent_native_fee_splits SET payload='{}'"), /immutable/);
    assert.throws(() => f.db.exec('DELETE FROM agent_native_fee_splits'), /immutable/);
    assert.equal(
      f.router.buybackLots().length,
      1,
      'buyback persists even with disabled Coinbase pipeline',
    );
  } finally {
    f.db.close();
  }
});

test('streamer submission only receives its native share and cannot consume the durable buyback branch', async () => {
  const db = new DatabaseSync(':memory:');
  const seen: FeeLot[] = [];
  const pipeline = new AutonomousPipeline(
    db,
    {
      deposit: async (value: FeeLot) => {
        seen.push(value);
        throw Error('submission timeout');
      },
      reconcileDeposit: async () => null,
    } as unknown as PipelineAdapters,
    { enabled: true, minimumGiftUsdCents: 1, maximumGiftUsdCents: 50000 },
  );
  const router = createNativeFeeRouter(db, pipeline);
  try {
    router.recordClaim(lot);
    await pipeline.runOnce();
    await pipeline.runOnce();
    router.recordClaim(lot);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].amountBaseUnits, '8003');
    assert.equal(seen[0].id, 'lot:streamer');
    assert.equal(router.buybackLots()[0].amountBaseUnits, '2000');
    assert.equal(pipeline.list()[0].phase, 'depositing');
  } finally {
    db.close();
  }
});

test('pre-migration chain evidence blocks a new split and rolls back its buyback outbox', () => {
  const f = setup();
  try {
    f.pipeline.recordClaim(lot);
    const legacy = { ...f.pipeline.list()[0] };
    delete legacy.allocationVersion;
    f.db.prepare('UPDATE agent_fee_jobs SET payload=?').run(JSON.stringify(legacy));
    assert.throws(() => f.router.recordClaim(lot));
    assert.deepEqual(f.router.splits(), []);
    assert.deepEqual(f.router.buybackLots(), []);
    assert.equal(f.pipeline.list()[0].id, lot.id);
    assert.throws(() => f.pipeline.recordClaim(lot), /allocation version/);
  } finally {
    f.db.close();
  }
});

test('split and pending acknowledgement survive closing and reopening the database', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'pog-native-router-'));
  const path = join(directory, 'router.sqlite');
  let db = new DatabaseSync(path);
  const policy = { enabled: false, minimumGiftUsdCents: 1, maximumGiftUsdCents: 50000 };
  try {
    let pipeline = new AutonomousPipeline(db, {} as PipelineAdapters, policy);
    let router = createNativeFeeRouter(db, pipeline);
    router.recordClaim(lot);
    const original = router.splits();
    db.close();
    db = new DatabaseSync(path);
    pipeline = new AutonomousPipeline(db, {} as PipelineAdapters, policy);
    router = createNativeFeeRouter(db, pipeline);
    router.recordClaim(lot);
    assert.deepEqual(router.splits(), original);
    assert.equal(pipeline.list().length, 1);
    assert.equal(router.buybackLots().length, 1);
    router.acknowledgeBuyback('lot:buyback');
    db.close();
    db = new DatabaseSync(path);
    router = createNativeFeeRouter(db, new AutonomousPipeline(db, {} as PipelineAdapters, policy));
    assert.deepEqual(router.buybackLots(), []);
    assert.deepEqual(router.splits(), original);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
