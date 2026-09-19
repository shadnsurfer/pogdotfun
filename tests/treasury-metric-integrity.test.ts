import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import bs58 from 'bs58';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';

for (const variant of ['different mints', 'different decimals'] as const) {
  test(`historical burns with ${variant} never produce a fabricated combined token amount`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      const ops = createOperations(db, { streamerBps: 8000 });
      const key = (value: number, bytes = 32) => bs58.encode(Buffer.alloc(bytes, value));
      const token = ops.registerToken(
        {
          name: 'Community',
          symbol: 'COMM',
          mint: key(1),
          creatorAddress: key(2),
          chain: 'solana',
          launchpad: 'pump',
          recipientPlatform: 'twitch',
          recipientUsername: 'streamer',
          recipientVerified: true,
          dedicatedCreatorVerified: true,
        },
        'test',
      );
      ops.recordClaim(
        {
          tokenId: token.id,
          signature: key(1, 64),
          amountLamports: '1000000000',
          grossUsdCents: 10000,
          networkFeeCents: 1,
          valuationAt: '2026-09-16T12:00:00.000Z',
          slot: 1,
          confirmation: 'finalized',
        },
        'test',
      );
      for (let i = 0; i < 2; i++) {
        const buy = {
          id: `buy-${i}`,
          kind: 'Buyback' as const,
          tokenId: token.id,
          mint: key(variant === 'different mints' ? 3 + i : 3),
          signature: key(2 + i, 64),
          consumedLamports: '10000000',
          networkFeeLamports: '5000',
          amountUsdCents: 99,
          networkFeeUsdCents: 1,
          tokenBaseUnits: '1000000',
          tokenDecimals: variant === 'different decimals' ? 6 + i : 6,
          slot: 2 + i,
        };
        ops.recordTreasuryReceipt(buy, 'test');
        ops.recordTreasuryReceipt(
          {
            ...buy,
            id: `burn-${i}`,
            kind: 'Burn',
            signature: key(4 + i, 64),
            consumedLamports: '5000',
            amountUsdCents: null,
            parentBuyId: buy.id,
          },
          'test',
        );
      }
      const catalog = publicCatalog(ops, { allConfirmedMetadata: () => [] }, []);
      assert.equal(catalog.stats.burnedTokenBaseUnits, null);
      assert.equal(catalog.stats.burnedTokenDecimals, null);
      assert.equal(catalog.stats.burnCount, 2);
      assert.equal(catalog.stats.buybackSpentUsdCents, 198);
      assert.equal(catalog.stats.buybackNetworkFeesUsdCents, 4);
      assert.equal(catalog.activity.filter((event) => event.kind === 'Burn').length, 2);
      assert.ok(
        catalog.activity
          .filter((event) => event.kind === 'Burn')
          .every((event) => event.tokenBaseUnits === '1000000'),
      );
    } finally {
      db.close();
    }
  });
}
