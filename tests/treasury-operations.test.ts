import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOperations } from '../server/operations.ts';

const actor = 'treasury-test';
const mint = '11111111111111111111111111111111';
const creator = '11111111111111111111111111111112';
const proof = (tokenId: string) => ({
  tokenId,
  signature: '1'.repeat(64),
  amountLamports: '1000000000',
  grossUsdCents: 10000,
  networkFeeCents: 1,
  valuationAt: new Date().toISOString(),
  slot: 123,
  confirmation: 'finalized',
});

test('central transfers preserve principal, source attribution and the other 80 percent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ops = createOperations(db, { streamerBps: 8000 });
    const token = ops.registerPlatformToken(
      {
        name: 'Pog',
        symbol: 'POG',
        mint,
        creatorAddress: creator,
        buybackBps: 2000,
        dedicatedCreatorVerified: true,
      },
      actor,
    );
    ops.recordClaim(proof(token.id), actor);
    const wallet = '11111111111111111111111111111114';
    const transfer = {
      id: 'central:transfer',
      kind: 'Transfer' as const,
      tokenId: token.id,
      mint,
      signature: '1'.repeat(63) + '2',
      consumedLamports: '10000',
      networkFeeLamports: '10000',
      amountUsdCents: null,
      networkFeeUsdCents: 1,
      tokenBaseUnits: '0',
      tokenDecimals: 6,
      slot: 124,
      executionWallet: wallet,
      transferFrom: creator,
      transferredLamports: '200000000',
    };
    assert.deepEqual(ops.treasuryCustody(token.id, wallet), {
      atCreatorLamports: '200000000',
      atTreasuryLamports: '0',
    });
    ops.recordTreasuryReceipt(transfer, actor);
    ops.recordTreasuryReceipt(transfer, actor);
    assert.deepEqual(ops.treasuryCustody(token.id, wallet), {
      atCreatorLamports: '0',
      atTreasuryLamports: '199990000',
    });
    assert.equal(ops.treasurySnapshot().buybackCount, 0);
    assert.equal(ops.treasurySnapshot().transfers.length, 1);
    assert.equal(ops.treasurySnapshot().platformReserveUsdCents, 8000);
    assert.equal(ops.treasuryCustody(token.id, creator).atTreasuryLamports, '0');
    assert.throws(
      () =>
        ops.recordTreasuryReceipt(
          { ...transfer, id: 'twice', signature: '1'.repeat(63) + '3' },
          actor,
        ),
      /custody|transfer|source/i,
    );
    assert.throws(
      () =>
        ops.recordTreasuryReceipt(
          {
            ...transfer,
            id: 'foreign',
            signature: '1'.repeat(63) + '4',
            kind: 'Buyback',
            executionWallet: '11111111111111111111111111111115',
            transferredLamports: undefined,
            transferFrom: undefined,
            tokenBaseUnits: '100',
            amountUsdCents: 1,
          },
          actor,
        ),
      /custody|funded/i,
    );
    assert.equal(db.prepare('SELECT SUM(amount_cents) total FROM ops_journal').get()!.total, 0);
  } finally {
    db.close();
  }
});

test('platform fees require an explicit immutable policy without a fictitious streamer', () => {
  const db = new DatabaseSync(':memory:');
  const ops = createOperations(db, { streamerBps: 8000 });
  assert.throws(
    () =>
      ops.registerPlatformToken(
        { name: 'Pog', symbol: 'POG', mint, creatorAddress: creator },
        actor,
      ),
    /policy/i,
  );
  const platform = ops.registerPlatformToken(
    {
      name: 'Pog',
      symbol: 'POG',
      mint,
      creatorAddress: creator,
      buybackBps: 7500,
      dedicatedCreatorVerified: true,
    },
    actor,
  );
  const claim = ops.recordClaim(proof(platform.id), actor);
  assert.equal(claim.streamerCents, 0);
  assert.equal(claim.buybackCents, 7500);
  assert.equal(claim.platformReserveCents, 2500);
  assert.equal(ops.snapshot().tokens.length, 0);
  assert.equal(ops.feeTokens().length, 1);
  assert.equal(ops.treasurySource(platform.id).buybackLamports, '750000000');
  assert.throws(
    () =>
      ops.registerPlatformToken(
        {
          name: 'Pog',
          symbol: 'POG',
          mint,
          creatorAddress: creator,
          buybackBps: 10000,
          dedicatedCreatorVerified: true,
        },
        actor,
      ),
    /immutable|conflict/i,
  );
  assert.throws(
    () => ops.reservePayment({ tokenId: platform.id, idempotencyKey: 'no-platform-gift' }, actor),
    /not found/i,
  );
  db.close();
});

test('treasury receipts debit only buyback SOL, conserve journal, and count burn only with separate proof', () => {
  const db = new DatabaseSync(':memory:');
  const ops = createOperations(db, { streamerBps: 8000 });
  const token = ops.registerToken(
    {
      name: 'Community',
      symbol: 'COMM',
      mint,
      creatorAddress: creator,
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'streamer',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    actor,
  );
  ops.recordClaim(proof(token.id), actor);
  const buy = {
    id: 'job:buy',
    kind: 'Buyback' as const,
    tokenId: token.id,
    mint: '11111111111111111111111111111113',
    signature: '1'.repeat(63) + '2',
    consumedLamports: '100000000',
    networkFeeLamports: '5000',
    amountUsdCents: 999,
    networkFeeUsdCents: 1,
    tokenBaseUnits: '5000000',
    tokenDecimals: 6,
    slot: 124,
  };
  ops.recordTreasuryReceipt(buy, actor);
  ops.recordTreasuryReceipt(buy, actor);
  assert.equal(ops.snapshot().treasury.buybackCount, 1);
  assert.equal(ops.snapshot().treasury.burnCount, 0);
  assert.equal(ops.snapshot().treasury.burnedTokenBaseUnits, '0');
  assert.equal(ops.treasurySource(token.id).buybackLamports, '100000000');
  assert.equal(ops.snapshot().tokens[0].assetBalances.streamerAvailableLamports, '800000000');
  assert.equal(ops.snapshot().treasury.buybackReserveUsdCents, 1000);
  ops.recordTreasuryReceipt(
    {
      ...buy,
      id: 'job:burn',
      kind: 'Burn',
      signature: '1'.repeat(63) + '3',
      consumedLamports: '5000',
      networkFeeLamports: '5000',
      amountUsdCents: null,
      networkFeeUsdCents: 1,
      parentBuyId: buy.id,
    },
    actor,
  );
  assert.equal(ops.snapshot().treasury.burnedTokenBaseUnits, '5000000');
  assert.equal(ops.snapshot().treasury.burnCount, 1);
  assert.equal(db.prepare('SELECT SUM(amount_cents) total FROM ops_journal').get()!.total, 0);
  assert.throws(
    () =>
      ops.recordTreasuryReceipt({ ...buy, id: 'overdraw', signature: '1'.repeat(63) + '4' }, actor),
    /reserve/i,
  );
  assert.throws(
    () =>
      ops.recordTreasuryReceipt(
        {
          ...buy,
          id: 'duplicate-burn',
          kind: 'Burn',
          signature: '1'.repeat(63) + '5',
          consumedLamports: '5000',
          networkFeeLamports: '5000',
          amountUsdCents: null,
          networkFeeUsdCents: 1,
          parentBuyId: buy.id,
        },
        actor,
      ),
    /burn/i,
  );
  db.close();
});
