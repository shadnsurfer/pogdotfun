import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import * as catalog from '../src/data.ts';
import { publicAddresses } from '../server/treasury/public-addresses.ts';
const platform = () => ({
  id: 'platform-pog',
  name: 'Pog',
  symbol: 'POG',
  chain: 'solana',
  address: bs58.encode(new Uint8Array(32).fill(11)),
  devWallet: publicAddresses.devWallet,
  tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenDecimals: 9,
  verifiedAt: '2026-09-18T12:00:00Z',
  solSpentLamports: '12345678901234567890',
  targetFeesSpentLamports: '1000000',
  burnedTokenBaseUnits: '9999999999999999999999',
  buybackCount: 1,
  burnCount: 1,
  lastExecutionAt: '2026-09-18T12:00:00Z',
});
const payload = (platformToken: unknown) => ({
  platformToken,
  tokens: [],
  streamers: [],
  activity: [],
  stats: {
    totalDonatedUsdCents: 1200,
    totalClaimedUsdCents: 6000,
    streamerAllocatedUsdCents: 4000,
    buybackAllocatedUsdCents: 0,
    streamerPendingUsdCents: 2800,
    tokenCount: 0,
    streamerCount: 0,
  },
});
test('verified Solana identity and native amounts remain exact and separate from community token prices', async () => {
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(payload(platform()));
    await catalog.refreshCatalog();
    assert.deepEqual(catalog.platformToken, platform());
    assert.equal(catalog.tokens.length, 0);
    assert.equal(catalog.treasury.claimed, 60);
  } finally {
    globalThis.fetch = fetch;
  }
});
test('invalid official native amounts or identity retain the previous catalog snapshot', async () => {
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(payload(platform()));
    await catalog.refreshCatalog();
    const saved = catalog.platformToken,
      treasury = catalog.treasury;
    for (const change of [
      { chain: 'robinhood' },
      { address: `0x${'1'.repeat(40)}` },
      { devWallet: 'invalid' },
      { devWallet: bs58.encode(new Uint8Array(32).fill(12)) },
      { tokenProgramId: '0x00' },
      { solSpentLamports: 123 },
      { solSpentLamports: '1e6' },
      { burnedTokenBaseUnits: '-1' },
      { tokenDecimals: 19 },
      { burnCount: 1.5 },
      { verifiedAt: 'bad' },
    ]) {
      globalThis.fetch = async () => Response.json(payload({ ...platform(), ...change }));
      await catalog.refreshCatalog();
      assert.equal(catalog.platformToken, saved, JSON.stringify(change));
      assert.equal(catalog.treasury, treasury);
    }
  } finally {
    globalThis.fetch = fetch;
  }
});
test('no verified target remains null and unknown sensitive fields never enter client token state', async () => {
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(payload(null));
    await catalog.refreshCatalog();
    assert.equal(catalog.platformToken, null);
    globalThis.fetch = async () => Response.json(payload({ ...platform(), secret: 'PRIVATE' }));
    await catalog.refreshCatalog();
    assert.doesNotMatch(JSON.stringify(catalog.platformToken), /PRIVATE/);
  } finally {
    globalThis.fetch = fetch;
  }
});
