import assert from 'node:assert/strict';
import test from 'node:test';
import { UnclaimedFeeCache } from '../server/public/unclaimed-fees.ts';

const token = { id: 'xqc', address: 'mint', donatedUsdCents: 0, claimedUsdCents: 0 };
const now = Date.parse('2026-09-16T21:38:16Z');
const observation = (at = now) => ({
  tokenId: 'xqc',
  mint: 'mint',
  amountLamports: '7759187457',
  grossUsdCents: 76249,
  quote: { observedAt: new Date(at).toISOString() },
});

test('unclaimed fees load without blocking the catalog or altering claimed and sent balances', async () => {
  let reads = 0;
  const cache = new UnclaimedFeeCache(
    async () => {
      reads++;
      return observation();
    },
    () => now,
  );
  const first = cache.snapshot([token])[0];
  assert.equal(first.feeAccrual.status, 'loading');
  assert.equal(first.feeAccrual.unclaimedUsdCents, null);
  cache.snapshot([token]);
  await cache.idle();
  const loaded = cache.snapshot([token])[0];
  assert.equal(reads, 1);
  assert.equal(loaded.feeAccrual.unclaimedUsdCents, 76249);
  assert.equal(loaded.feeAccrual.unclaimedLamports, '7759187457');
  assert.equal(loaded.feeAccrual.status, 'fresh');
  assert.equal(loaded.claimedUsdCents, 0);
  assert.equal(loaded.donatedUsdCents, 0);
  await cache.close();
});

test('stale observations survive read failures briefly, expire to unknown, and refresh after collection', async () => {
  let clock = now,
    fail = false,
    cents = 76249;
  const cache = new UnclaimedFeeCache(
    async () => {
      if (fail) throw Error('RPC unavailable');
      return {
        ...observation(clock),
        grossUsdCents: cents,
        amountLamports: cents ? '7759187457' : '0',
      };
    },
    () => clock,
  );
  cache.snapshot([token]);
  await cache.idle();
  clock += 61_000;
  fail = true;
  assert.equal(cache.snapshot([token])[0].feeAccrual.status, 'stale');
  await cache.idle();
  assert.equal(cache.snapshot([token])[0].feeAccrual.unclaimedUsdCents, 76249);
  clock += 600_000;
  assert.equal(cache.snapshot([token])[0].feeAccrual.unclaimedUsdCents, null);
  await cache.idle();
  clock += 61_000;
  fail = false;
  cents = 0;
  cache.snapshot([token]);
  await cache.idle();
  assert.equal(cache.snapshot([token])[0].feeAccrual.unclaimedUsdCents, 0);
  await cache.close();
});

test('invalid amounts, stale quotes and wrong token identities never become public fee estimates', async () => {
  for (const invalid of [
    { grossUsdCents: -1 },
    { grossUsdCents: Number.MAX_SAFE_INTEGER + 1 },
    { amountLamports: '-1' },
    { tokenId: 'other' },
    { mint: 'other' },
    { quote: { observedAt: new Date(now - 600_000).toISOString() } },
  ]) {
    const cache = new UnclaimedFeeCache(
      async () => ({ ...observation(), ...invalid }),
      () => now,
    );
    cache.snapshot([token]);
    await cache.idle();
    assert.equal(cache.snapshot([token])[0].feeAccrual.unclaimedUsdCents, null);
    assert.equal(cache.snapshot([token])[0].feeAccrual.status, 'unavailable');
    await cache.close();
  }
});

test('repeated catalog requests coalesce reads and limit chain concurrency to two', async () => {
  let active = 0,
    maximum = 0,
    reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rows = Array.from({ length: 38 }, (_, i) => ({ id: `token-${i}`, address: `mint-${i}` }));
  const cache = new UnclaimedFeeCache(
    async (id) => {
      active++;
      reads++;
      maximum = Math.max(maximum, active);
      await held;
      active--;
      return { ...observation(), tokenId: id, mint: rows.find((row) => row.id === id)!.address };
    },
    () => now,
  );
  for (let i = 0; i < 10; i++) cache.snapshot(rows);
  await Promise.resolve();
  assert.equal(reads, 2);
  release();
  await cache.idle();
  assert.equal(reads, rows.length);
  assert.equal(maximum, 2);
  await cache.close();
});
