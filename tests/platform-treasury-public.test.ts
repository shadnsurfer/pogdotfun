import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';
import { projectNativeBuybacks } from '../server/public/native-buybacks.ts';
import type { BuybackJob, BuybackTarget } from '../server/agents/buyback.ts';
import type { NativeFeeSplit } from '../server/agents/fee-router.ts';

const target: BuybackTarget = {
  chainId: 4663,
  tokenAddress: `0x${'1'.repeat(40)}`,
  devWallet: `0x${'2'.repeat(40)}`,
  tokenCodeHash: `0x${'3'.repeat(64)}`,
  tokenDecimals: 18,
};
const time = '2026-09-18T12:00:00Z';
function fixture() {
  const db = new DatabaseSync(':memory:');
  const ops = createOperations(db, { streamerBps: 8000 });
  const lot = {
    id: 'claim',
    tokenId: 'source',
    chain: 'bnb' as const,
    asset: 'BNB' as const,
    decimals: 18,
    amountBaseUnits: '10000000000000000003',
    claimReference: 'claim-hash',
    recipient: { platform: 'twitch' as const, providerId: 'recipient', username: 'alice' },
  };
  const split: NativeFeeSplit = {
    version: 'native-streamer-v1',
    original: lot,
    streamer: { ...lot, id: 'claim:streamer', amountBaseUnits: '8000000000000000003' },
    buyback: { ...lot, id: 'claim:buyback', amountBaseUnits: '2000000000000000000' },
    createdAt: time,
  };
  const job: BuybackJob = {
    ...split.buyback!,
    phase: 'completed',
    createdAt: time,
    target,
    targetVerifiedAt: time,
    sourceSpentBaseUnits: '1900000000000000000',
    residualSourceBaseUnits: '100000000000000000',
    receivedEthWei: '500000000000000000',
    ethSpentWei: '490000000000000000',
    targetGasSpentWei: '1000000000000000',
    swapGasWei: '500000000000000',
    burnGasWei: '500000000000000',
    residualEthWei: '9000000000000000',
    purchasedTokenBaseUnits: '12345678901234567890123',
    burnedTokenBaseUnits: '12345678901234567890123',
    residualTokenBaseUnits: '0',
    sourceTransferReference: 'source-proof',
    transferReference: 'bridge-proof',
    buyReference: 'buy-proof',
    burnReference: 'burn-proof',
    completedAt: time,
  };
  return {
    db,
    ops,
    split,
    job,
    catalog: publicCatalog(ops, { allConfirmedMetadata: () => [] }, []),
  };
}
test('legacy Solana platform registrations can never identify official POG', () => {
  const { db, ops } = fixture();
  try {
    const snapshot = ops.snapshot();
    snapshot.platformTokens = [
      {
        id: 'platform-pog',
        name: 'Pog',
        symbol: 'POG',
        mint: 'So11111111111111111111111111111111111111112',
        creatorAddress: '11111111111111111111111111111111',
      } as never,
    ];
    assert.equal(
      publicCatalog({ snapshot: () => snapshot }, { allConfirmedMetadata: () => [] }, [])
        .platformToken,
      null,
    );
  } finally {
    db.close();
  }
});
test('configured target and bridge funds are not verified token identity or completed buybacks', () => {
  const { db, catalog, split, job } = fixture();
  try {
    const result = projectNativeBuybacks(catalog, {
      target,
      jobs: [{ ...job, phase: 'funded', targetVerifiedAt: undefined }],
      splits: [split],
    });
    assert.equal(result.platformToken, null);
    assert.equal(result.officialPlatformIntent.status, 'configured');
    assert.equal(result.nativeBuybackLedger.ethSpentWei, '0');
    assert.equal(result.nativeBuybackLedger.burnedTokenBaseUnits, '0');
    assert.equal(result.nativeBuybackLedger.sources[0].pendingBuybackBaseUnits, '0');
    assert.equal(
      result.nativeBuybackLedger.sources[0].residualSourceBaseUnits,
      '100000000000000000',
    );
  } finally {
    db.close();
  }
});
test('verified native ledgers preserve exact per-asset amounts and expose only confirmed buy/burn proof', () => {
  const { db, catalog, split, job } = fixture();
  try {
    const result = projectNativeBuybacks(catalog, {
      target,
      jobs: [{ ...job, privateSigningKey: 'PRIVATE' } as BuybackJob],
      splits: [split],
    });
    assert.equal(result.platformToken?.chain, 'robinhood');
    assert.equal(result.platformToken?.chainId, 4663);
    assert.equal(result.platformToken?.address, target.tokenAddress);
    assert.equal(result.nativeBuybackLedger.sources[0].claimedBaseUnits, '10000000000000000003');
    assert.equal(result.nativeBuybackLedger.sources[0].streamerBaseUnits, '8000000000000000003');
    assert.equal(result.nativeBuybackLedger.sources[0].pendingBuybackBaseUnits, '0');
    assert.equal(result.nativeBuybackLedger.ethSpentWei, job.ethSpentWei);
    assert.equal(result.nativeBuybackLedger.burnedTokenBaseUnits, job.burnedTokenBaseUnits);
    assert.equal(result.nativeBuybackLedger.receipts[0].burnReference, 'burn-proof');
    assert.doesNotMatch(JSON.stringify(result.nativeBuybackLedger), /PRIVATE|UsdCents|solscan/);
    assert.equal(result.tokens, catalog.tokens);
  } finally {
    db.close();
  }
});
test('unbound, duplicate, inconsistent, or wrong-chain buyback evidence cannot inflate totals', () => {
  const { db, catalog, split, job } = fixture();
  try {
    for (const context of [
      { target, jobs: [job], splits: [] },
      { target, jobs: [job, job], splits: [split] },
      { target, jobs: [{ ...job, amountBaseUnits: '1' }], splits: [split] },
      {
        target,
        jobs: [{ ...job, burnedTokenBaseUnits: '99999999999999999999999' }],
        splits: [split],
      },
      { target: { ...target, chainId: 1 }, jobs: [job], splits: [split] },
      {
        target,
        jobs: [job],
        splits: [{ ...split, streamer: { ...split.streamer, amountBaseUnits: '1' } }],
      },
    ])
      assert.throws(() => projectNativeBuybacks(catalog, context as never));
  } finally {
    db.close();
  }
});

test('removing runtime target configuration does not hide confirmed historical native receipts', () => {
  const { db, catalog, split, job } = fixture();
  try {
    const result = projectNativeBuybacks(catalog, { jobs: [job], splits: [split] });
    assert.equal(result.officialPlatformIntent.status, 'unconfigured');
    assert.equal(result.platformToken?.address, target.tokenAddress);
    assert.equal(result.nativeBuybackLedger.sources[0].sourceSpentBaseUnits, '1900000000000000000');
  } finally {
    db.close();
  }
});
