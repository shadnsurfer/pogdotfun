import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';
import { projectNativeBuybacks } from '../server/public/native-buybacks.ts';
import type { BuybackJob, BuybackTarget } from '../server/agents/buyback.ts';
import type { NativeFeeSplit } from '../server/agents/fee-router.ts';
import { publicAddresses } from '../server/treasury/public-addresses.ts';

const target: BuybackTarget = {
  chain: 'solana',
  mintAddress: bs58.encode(new Uint8Array(32).fill(11)),
  devWallet: publicAddresses.buybackWallet,
  tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
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
    receivedSolLamports: '500000000000000000',
    solSpentLamports: '490000000000000000',
    targetFeesSpentLamports: '1000000000000000',
    swapFeeLamports: '500000000000000',
    burnFeeLamports: '500000000000000',
    residualSolLamports: '9000000000000000',
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
    assert.equal(result.nativeBuybackLedger.solSpentLamports, '0');
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
    assert.equal(result.platformToken?.chain, 'solana');
    assert.equal(result.platformToken?.address, target.mintAddress);
    assert.equal(result.nativeBuybackLedger.sources[0].claimedBaseUnits, '10000000000000000003');
    assert.equal(result.nativeBuybackLedger.sources[0].streamerBaseUnits, '8000000000000000003');
    assert.equal(result.nativeBuybackLedger.sources[0].pendingBuybackBaseUnits, '0');
    assert.equal(result.nativeBuybackLedger.solSpentLamports, job.solSpentLamports);
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
      { target: { ...target, chain: 'robinhood' }, jobs: [job], splits: [split] },
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
    assert.equal(result.platformToken?.address, target.mintAddress);
    assert.equal(result.nativeBuybackLedger.sources[0].sourceSpentBaseUnits, '1900000000000000000');
  } finally {
    db.close();
  }
});
