import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';
import {
  projectAutonomousCatalog,
  publicAutonomousLedger,
  publicAutonomousDonations,
} from '../server/public/autonomous-catalog.ts';
import type { PipelineJob } from '../server/agents/pipeline.ts';
function fixture() {
  const db = new DatabaseSync(':memory:');
  const operations = createOperations(db, { streamerBps: 8000 });
  const token = operations.registerToken(
    {
      name: 'Community',
      symbol: 'COM',
      mint: bs58.encode(Buffer.alloc(32, 1)),
      creatorAddress: bs58.encode(Buffer.alloc(32, 2)),
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'alice',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    'test',
  );
  operations.recordClaim(
    {
      tokenId: token.id,
      signature: bs58.encode(Buffer.alloc(64, 3)),
      amountLamports: '1000000000',
      grossUsdCents: 10000,
      networkFeeCents: 2,
      valuationAt: '2026-09-18T12:00:00Z',
      slot: 1,
      confirmation: 'finalized',
    },
    'test',
  );
  const catalog = publicCatalog(
    operations,
    { allConfirmedMetadata: () => [] } as Parameters<typeof publicCatalog>[1],
    [],
  );
  const job: PipelineJob = {
    id: 'fee-1',
    tokenId: token.id,
    chain: 'solana',
    asset: 'SOL',
    amountBaseUnits: '800000000',
    decimals: 9,
    claimReference: 'claim-1',
    recipient: { platform: 'twitch', providerId: 'twitch:1', username: 'alice' },
    phase: 'completed',
    allocationVersion: 'native-streamer-v1',
    netUsdCents: 7500,
    spentUsdCents: 7400,
    streamerBudgetUsdCents: 7500,
    platformReserveUsdCents: 0,
    residualUsdCents: 100,
    receiptReference: 'receipt-1',
    createdAt: '2026-09-18T12:00:00Z',
    completedAt: '2026-09-18T12:03:00Z',
    cardAccountId: 'PRIVATE-CARD',
    giftReference: 'PRIVATE-BROWSER',
    conversionReference: 'PRIVATE-ORDER',
  };
  return { db, catalog, job };
}
test('actual completed spending replaces stale operation budgets without treating residual as card credit', () => {
  const { db, catalog, job } = fixture();
  try {
    assert.equal(catalog.tokens[0].availableUsdCents, 8000);
    const result = projectAutonomousCatalog(catalog, [job]);
    assert.equal(result.tokens[0].donatedUsdCents, 7400);
    assert.equal(result.tokens[0].convertedUsdCents, 7500);
    assert.equal(result.tokens[0].availableUsdCents, 0);
    assert.equal(result.tokens[0].reservedUsdCents, 0);
    assert.equal(result.tokens[0].pendingUsdCents, 0);
    assert.equal(result.tokens[0].cardResidualUsdCents, 0);
    assert.equal(result.stats.totalClaimedUsdCents, 10000);
    assert.equal(result.stats.claimNetworkFeesUsdCents, 2);
    assert.equal(result.streamers[0].donatedUsdCents, 7400);
    assert.equal(result.stats.completedPaymentCount, 1);
    assert.equal(result.tokens[0].address, catalog.tokens[0].address);
    assert.equal(result.tokens[0].created, catalog.tokens[0].created);
    assert.equal(catalog.tokens[0].availableUsdCents, 8000);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
    const ledger = publicAutonomousLedger([job]);
    assert.equal(ledger.residualUsdCents, 100);
    assert.equal(ledger.heldUsdCents, 100);
    assert.equal(ledger.availableUsdCents, 0);
    assert.equal(ledger.platformReserveUsdCents, 0);
    assert.equal(result.stats.platformReserveUsdCents, 0);
    assert.equal(result.stats.buybackReserveUsdCents, 0);
    assert.equal(result.stats.heldUsdCents, 100);
  } finally {
    db.close();
  }
});
test('converted and gifting lots have separate available and reserved budgets', () => {
  const { db, catalog, job } = fixture();
  try {
    const converted = {
      ...job,
      id: 'converted',
      phase: 'converted' as const,
      netUsdCents: 5100,
      streamerBudgetUsdCents: 5100,
      platformReserveUsdCents: 0,
      spentUsdCents: undefined,
      residualUsdCents: undefined,
      completedAt: undefined,
    };
    const gifting = {
      ...converted,
      id: 'gifting',
      phase: 'gifting' as const,
      netUsdCents: 6200,
      streamerBudgetUsdCents: 6200,
      platformReserveUsdCents: 0,
    };
    const result = projectAutonomousCatalog(catalog, [converted, gifting]);
    assert.equal(result.stats.convertedUsdCents, 11300);
    assert.equal(result.stats.streamerAvailableUsdCents, 5100);
    assert.equal(result.stats.streamerReservedUsdCents, 6200);
    assert.equal(result.stats.streamerPendingUsdCents, 11300);
    assert.equal(result.stats.totalDonatedUsdCents, 0);
    assert.equal(result.stats.platformReserveUsdCents, 0);
    assert.equal(result.stats.heldUsdCents, 11300);
  } finally {
    db.close();
  }
});
test('unmatched EVM jobs count globally without fabricating catalog tokens', () => {
  const { db, catalog, job } = fixture();
  try {
    const external = {
      ...job,
      id: 'evm-job',
      tokenId: 'unregistered-evm-token',
      chain: 'bnb' as const,
      asset: 'BNB' as const,
      decimals: 18,
      receiptReference: 'receipt-evm',
    };
    const result = projectAutonomousCatalog(catalog, [external]);
    assert.equal(result.tokens.length, 1);
    assert.equal(result.tokens[0].donatedUsdCents, 0);
    assert.equal(result.stats.totalDonatedUsdCents, 7400);
    assert.equal(publicAutonomousLedger([external]).byChain.bnb.spentUsdCents, 7400);
    const rows = publicAutonomousDonations([external]);
    assert.equal(rows[0].chain, 'bnb');
    assert.equal(rows[0].receiptReference, 'receipt-evm');
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-/);
  } finally {
    db.close();
  }
});
test('duplicate and invalid financial evidence cannot inflate public totals', () => {
  const { db, job } = fixture();
  try {
    assert.equal(publicAutonomousLedger([job, job]).spentUsdCents, 7400);
    assert.throws(() =>
      publicAutonomousLedger([job, { ...job, spentUsdCents: 7300, residualUsdCents: 200 }]),
    );
    assert.throws(() => publicAutonomousLedger([{ ...job, spentUsdCents: 7600 }]));
    assert.throws(() =>
      publicAutonomousLedger([{ ...job, netUsdCents: Number.MAX_SAFE_INTEGER + 1 }]),
    );
  } finally {
    db.close();
  }
});

test('missing or inconsistent persisted allocation cannot become a public gift budget', () => {
  const { db, job } = fixture();
  try {
    assert.throws(() =>
      publicAutonomousLedger([
        { ...job, streamerBudgetUsdCents: undefined, platformReserveUsdCents: undefined },
      ]),
    );
    assert.throws(() =>
      publicAutonomousLedger([
        { ...job, streamerBudgetUsdCents: 6000, platformReserveUsdCents: 1500 },
      ]),
    );
    const historical = {
      ...job,
      streamerBudgetUsdCents: 7500,
      platformReserveUsdCents: 0,
      spentUsdCents: 7400,
      residualUsdCents: 100,
    };
    assert.equal(publicAutonomousLedger([historical]).streamerBudgetUsdCents, 7500);
  } finally {
    db.close();
  }
});

test('unfinished allocations without the native version remain held while historical completions retain actual spending', () => {
  const { db, job } = fixture();
  try {
    const old = {
      ...job,
      allocationVersion: undefined,
      streamerBudgetUsdCents: 6000,
      platformReserveUsdCents: 1500,
      spentUsdCents: 5900,
      residualUsdCents: 100,
    };
    assert.equal(publicAutonomousLedger([old]).spentUsdCents, 5900);
    const held = publicAutonomousLedger([{ ...old, phase: 'converted' }]);
    assert.equal(held.availableUsdCents, 0);
    assert.equal(held.reservedUsdCents, 0);
    assert.equal(held.heldLegacyUsdCents, 6000);
    assert.equal(held.heldUsdCents, 7500);
  } finally {
    db.close();
  }
});
