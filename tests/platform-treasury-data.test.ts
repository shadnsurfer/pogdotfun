import assert from 'node:assert/strict';
import test from 'node:test';
import * as catalog from '../src/data.ts';
const platform = () => ({
  id: 'platform-pog',
  name: 'Pog',
  symbol: 'POG',
  chain: 'robinhood',
  chainId: 4663,
  address: `0x${'1'.repeat(40)}`,
  devWallet: `0x${'2'.repeat(40)}`,
  tokenCodeHash: `0x${'3'.repeat(64)}`,
  tokenDecimals: 18,
  verifiedAt: '2026-09-18T12:00:00Z',
  ethSpentWei: '12345678901234567890',
  targetGasSpentWei: '1000000000000000',
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
test('verified EVM identity and native amounts remain exact and separate from community token prices', async () => {
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
      { chain: 'solana' },
      { chainId: 1 },
      { address: 'So11111111111111111111111111111111111111112' },
      { devWallet: 'invalid' },
      { tokenCodeHash: '0x00' },
      { ethSpentWei: 123 },
      { ethSpentWei: '1e6' },
      { burnedTokenBaseUnits: '-1' },
      { tokenDecimals: 37 },
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
