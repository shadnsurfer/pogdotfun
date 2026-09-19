import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const ops = createOperations(db, { streamerBps: 8000 });
  const token = ops.registerToken(
    {
      name: 'Community',
      symbol: 'COMM',
      mint: '1'.repeat(32),
      creatorAddress: '1'.repeat(31) + '2',
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'streamer',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    'test',
  );
  const proof = {
    tokenId: token.id,
    signature: '1'.repeat(64),
    networkFeeLamports: '5000',
    networkFeeCents: 2,
    slot: 123,
    confirmation: 'finalized_failure',
    valuationAt: '2026-09-16T12:00:00.000Z',
  };
  const catalog = () => publicCatalog(ops, { allConfirmedMetadata: () => [] }, []);
  return { db, ops, token, proof, catalog };
}

test('failed claim gas survives retry and restart without creating revenue, claim activity, or recipient funds', () => {
  const f = fixture();
  try {
    const record = f.ops.recordFailedClaimCost(f.proof, 'test');
    assert.deepEqual(f.ops.recordFailedClaimCost(f.proof, 'test'), record);
    const restarted = createOperations(f.db, { streamerBps: 8000 });
    assert.equal(restarted.snapshot().failedClaimCosts.length, 1);
    assert.equal(restarted.snapshot().totals.claimNetworkFeeCents, 2);
    const catalog = f.catalog();
    assert.equal(catalog.stats.claimNetworkFeesUsdCents, 2);
    assert.equal(catalog.stats.totalRecordedCostsUsdCents, 2);
    assert.equal(catalog.stats.claimCount, 0);
    assert.equal(catalog.stats.totalClaimedUsdCents, 0);
    assert.equal(catalog.stats.streamerAllocatedUsdCents, 0);
    assert.equal(catalog.stats.buybackAllocatedUsdCents, 0);
    assert.equal(catalog.stats.heldUsdCents, 0);
    assert.equal(catalog.tokens[0].claimNetworkFeesUsdCents, 2);
    assert.deepEqual(catalog.activity, []);
    assert.equal(restarted.treasurySource(f.token.id).buybackLamports, '0');
    assert.throws(() => f.db.prepare("UPDATE ops_claim_costs SET payload='{}'").run(), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM ops_claim_costs').run(), /immutable/);
  } finally {
    f.db.close();
  }
});

test('failed claim evidence rejects conflicting retries and successful claims with the same signature', () => {
  const f = fixture();
  try {
    f.ops.recordFailedClaimCost(f.proof, 'test');
    assert.throws(
      () => f.ops.recordFailedClaimCost({ ...f.proof, networkFeeCents: 3 }, 'test'),
      /conflict/i,
    );
    const success = {
      ...f.proof,
      confirmation: 'finalized',
      amountLamports: '1000000000',
      grossUsdCents: 10000,
    };
    assert.throws(() => f.ops.recordClaim(success, 'test'), /failed/i);
    f.ops.recordClaim({ ...success, signature: '1'.repeat(63) + '2' }, 'test');
    assert.throws(
      () => f.ops.recordFailedClaimCost({ ...f.proof, signature: '1'.repeat(63) + '2' }, 'test'),
      /successful|claim.*already/i,
    );
    assert.equal(f.catalog().stats.claimNetworkFeesUsdCents, 4);
    assert.equal(f.catalog().stats.claimCount, 1);
    assert.equal(f.catalog().stats.totalClaimedUsdCents, 10000);
    assert.equal(f.catalog().stats.heldUsdCents, 10000);
  } finally {
    f.db.close();
  }
});

test('failed claim costs require finalized failure evidence and a registered fee token', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.ops.recordFailedClaimCost({ ...f.proof, confirmation: 'finalized' }, 'test'),
      /finalized.*fail/i,
    );
    assert.throws(
      () => f.ops.recordFailedClaimCost({ ...f.proof, tokenId: 'missing' }, 'test'),
      /not found/i,
    );
    assert.throws(
      () => f.ops.recordFailedClaimCost({ ...f.proof, networkFeeCents: -1 }, 'test'),
      /cents/i,
    );
    assert.equal(f.catalog().stats.totalRecordedCostsUsdCents, 0);
  } finally {
    f.db.close();
  }
});
