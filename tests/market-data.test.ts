import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { DexScreenerMarketData } from '../server/public/market-data.ts';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const mint = () => Keypair.generate().publicKey.toBase58();
const token = (address = mint()) => ({
  address,
  mcap: null as number | null,
  volume: null as number | null,
  change: null as number | null,
  name: 'Registered name',
  donatedUsdCents: 123,
});
function pair(address: string, overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    pairAddress: mint(),
    baseToken: { address, name: 'Untrusted name', symbol: 'SAME' },
    quoteToken: { address: SOL, symbol: 'SOL' },
    marketCap: 1000,
    fdv: 9000,
    volume: { h24: 500 },
    priceChange: { h24: -10 },
    liquidity: { usd: 100 },
    ...overrides,
  };
}
const metrics = (value: { mcap: number | null; volume: number | null; change: number | null }) => ({
  mcap: value.mcap,
  volume: value.volume,
  change: value.change,
});
test('display price accepts documented positive decimal strings without changing ledger values', async () => {
  const input = token();
  const adapter = new DexScreenerMarketData({
    fetch: async () =>
      Response.json([pair(input.address, { priceUsd: '0.0000425', donatedUsdCents: 99999 })]),
  });
  try {
    const [result] = await adapter.enrich([input]);
    assert.equal(result.priceUsd, 0.0000425);
    assert.equal(result.donatedUsdCents, 123);
    assert.equal(result.marketDataStatus, 'fresh');
  } finally {
    await adapter.close();
  }
});
test('malformed, nonpositive and unsafe display prices cannot become a zero or fabricated quote', async () => {
  for (const priceUsd of [
    '',
    ' ',
    '0x10',
    '1e4',
    'Infinity',
    '-1',
    '0',
    0,
    -1,
    1e30,
    null,
    {},
    [],
    '0.' + '0'.repeat(80) + '1',
  ]) {
    const input = token();
    const adapter = new DexScreenerMarketData({
      fetch: async () =>
        Response.json([
          pair(input.address, { priceUsd, marketCap: null, volume: {}, priceChange: {} }),
        ]),
    });
    try {
      const [result] = await adapter.enrich([input]);
      assert.equal(result.priceUsd, null);
      assert.equal(result.marketDataUpdatedAt, null);
    } finally {
      await adapter.close();
    }
  }
});
test('price-only market responses are fresh and still match exact mint and quote identity', async () => {
  const input = token();
  const adapter = new DexScreenerMarketData({
    fetch: async () =>
      Response.json([
        pair(input.address, { priceUsd: '0.002', marketCap: null, volume: {}, priceChange: {} }),
        pair(input.address, {
          priceUsd: '100000',
          quoteToken: { address: mint(), symbol: 'SOL' },
          liquidity: { usd: 1e6 },
        }),
      ]),
  });
  try {
    const [result] = await adapter.enrich([input]);
    assert.equal(result.priceUsd, 0.002);
    assert.equal(result.marketDataStatus, 'fresh');
    assert.equal(result.mcap, null);
  } finally {
    await adapter.close();
  }
});
test('matches exact base mint and chooses the deepest canonical SOL or USDC pool without mutating token identity', async () => {
  const input = token();
  const rows = [
    pair(input.address, { liquidity: { usd: 10 }, marketCap: 10 }),
    pair(input.address, {
      liquidity: { usd: 200 },
      quoteToken: { address: USDC, symbol: 'FAKE' },
      marketCap: 2500,
      volume: { h24: 800 },
      priceChange: { h24: 12.5 },
      name: 'Injected',
      donatedUsdCents: 999,
    }),
  ];
  const adapter = new DexScreenerMarketData({
    fetch: async (url, init) => {
      assert.equal(String(url), `https://api.dexscreener.com/tokens/v1/solana/${input.address}`);
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return Response.json(rows);
    },
    now: () => 1_000,
  });
  const [result] = await adapter.enrich([input]);
  assert.deepEqual(metrics(result), { mcap: 2500, volume: 800, change: 12.5 });
  assert.equal(result.name, input.name);
  assert.equal(result.donatedUsdCents, 123);
  assert.equal(input.mcap, null);
  assert.equal(result.marketDataUpdatedAt, '1970-01-01T00:00:01.000Z');
});
test('wrong chain, different base mint and symbol-spoofed quote cannot attach data to a registered token', async () => {
  const input = token();
  const rows = [
    pair(input.address, { chainId: 'ethereum' }),
    pair(mint()),
    pair(input.address, { quoteToken: { address: mint(), symbol: 'SOL' } }),
    pair(SOL, { quoteToken: { address: input.address, symbol: 'SAME' } }),
  ];
  const adapter = new DexScreenerMarketData({ fetch: async () => Response.json(rows) });
  const [result] = await adapter.enrich([input]);
  assert.deepEqual(metrics(result), { mcap: null, volume: null, change: null });
  assert.equal(result.marketDataUpdatedAt, null);
});
test('provider fields are numbers only, unsafe values become null and FDV never substitutes market cap', async () => {
  for (const values of [
    { marketCap: '1000', volume: { h24: -1 }, priceChange: { h24: -101 } },
    { marketCap: 1e30, volume: { h24: '500' }, priceChange: { h24: 1e30 } },
    { marketCap: null, volume: {}, priceChange: null },
  ]) {
    const input = token();
    const adapter = new DexScreenerMarketData({
      fetch: async () => Response.json([pair(input.address, values)]),
    });
    assert.deepEqual(metrics((await adapter.enrich([input]))[0]), {
      mcap: null,
      volume: null,
      change: null,
    });
  }
});
test('unlisted mint returned by provider never poisons a future registered mint cache', async () => {
  const a = token(),
    b = token();
  let calls = 0;
  const adapter = new DexScreenerMarketData({
    fetch: async () => {
      calls++;
      return Response.json(calls === 1 ? [pair(b.address)] : []);
    },
  });
  assert.equal((await adapter.enrich([a]))[0].mcap, null);
  assert.equal((await adapter.enrich([b]))[0].mcap, null);
  assert.equal(calls, 2);
});
test('empty and malformed catalogs make no provider calls', async () => {
  const adapter = new DexScreenerMarketData({
    fetch: async () => {
      throw Error('must not request');
    },
  });
  assert.deepEqual(await adapter.enrich([]), []);
  const rows = await adapter.enrich([
    token('../evil?url=https://evil.invalid'),
    token('not a mint'),
  ]);
  assert.ok(rows.every((row) => row.mcap === null));
});
test('refreshes after15 seconds and retains validated stale prices only up to120 seconds during failures', async () => {
  const input = token();
  let now = 0,
    calls = 0;
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async () => {
      calls++;
      return calls === 1
        ? Response.json([pair(input.address)])
        : new Response('Unavailable', { status: 503 });
    },
  });
  assert.equal((await adapter.enrich([input]))[0].mcap, 1000);
  now = 14_999;
  assert.equal((await adapter.enrich([input]))[0].mcap, 1000);
  assert.equal(calls, 1);
  now = 15_000;
  const stale = (await adapter.enrich([input]))[0];
  assert.equal(stale.mcap, 1000);
  assert.equal(stale.marketDataStatus, 'stale');
  assert.equal(stale.marketDataUpdatedAt, '1970-01-01T00:00:00.000Z');
  now = 44_999;
  assert.equal((await adapter.enrich([input]))[0].mcap, 1000);
  assert.equal(calls, 2);
  now = 45_000;
  await adapter.enrich([input]);
  assert.equal(calls, 3);
  now = 104_999;
  assert.equal((await adapter.enrich([input]))[0].mcap, 1000);
  assert.equal(calls, 3);
  now = 105_000;
  await adapter.enrich([input]);
  assert.equal(calls, 4);
  now = 120_000;
  const expired = adapter.snapshot([input]);
  assert.equal(expired.tokens[0].mcap, null);
  assert.equal(expired.tokens[0].marketDataUpdatedAt, null);
  assert.equal(expired.tokens[0].marketDataStatus, 'unavailable');
  assert.equal(calls, 4, 'failure backoff remains active after stale data expires');
  await adapter.close();
});
test('overlapping concurrent callers share requests for the same mint', async () => {
  const a = token(),
    b = token(),
    c = token();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const requested: string[][] = [];
  const adapter = new DexScreenerMarketData({
    fetch: async (url) => {
      const addresses = String(url).split('/').at(-1)!.split(',');
      requested.push(addresses);
      await gate;
      return Response.json(addresses.map((address) => pair(address)));
    },
  });
  const one = adapter.enrich([a, b]);
  const two = adapter.enrich([b, c]);
  release();
  const results = await Promise.all([one, two]);
  assert.ok(results.flat().every((row) => row.mcap === 1000));
  assert.equal(requested.flat().filter((address) => address === b.address).length, 1);
});
test('batches at most 30 mints and bounds concurrent upstream work', async () => {
  const rows = Array.from({ length: 91 }, () => token());
  const sizes: number[] = [];
  let active = 0,
    peak = 0;
  const adapter = new DexScreenerMarketData({
    fetch: async (url) => {
      active++;
      peak = Math.max(peak, active);
      const addresses = String(url).split('/').at(-1)!.split(',');
      sizes.push(addresses.length);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return Response.json(addresses.map((address) => pair(address)));
    },
  });
  const result = await adapter.enrich(rows);
  assert.equal(result.length, 91);
  assert.ok(result.every((row) => row.mcap === 1000));
  assert.deepEqual(sizes, [30, 30, 30, 1]);
  assert.ok(peak <= 3);
});
test('request timeout fails open to unavailable market data even if provider never resolves', async () => {
  const input = token();
  let signal: AbortSignal | null | undefined;
  const adapter = new DexScreenerMarketData({
    timeoutMs: 10,
    fetch: async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  assert.equal((await adapter.enrich([input]))[0].mcap, null);
  assert.equal(signal?.aborted, true);
});
test('cache eviction is bounded and provider supplied URLs are never followed', async () => {
  const a = token(),
    b = token(),
    c = token();
  let calls = 0;
  const adapter = new DexScreenerMarketData({
    maximumCacheEntries: 2,
    fetch: async (url) => {
      calls++;
      assert.equal(new URL(String(url)).origin, 'https://api.dexscreener.com');
      return Response.json([]);
    },
  });
  await adapter.enrich([a, b]);
  await adapter.enrich([c]);
  await adapter.enrich([a]);
  assert.equal(calls, 3);
});

test('honors a provider rate-limit cooldown for new mints as well as repeated reads', async () => {
  let now = 0,
    calls = 0;
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async () => {
      calls++;
      return new Response('Limited', { status: 429, headers: { 'retry-after': '120' } });
    },
  });
  await adapter.enrich([token()]);
  now = 90_000;
  await adapter.enrich([token()]);
  assert.equal(calls, 1);
  now = 120_000;
  await adapter.enrich([token()]);
  assert.equal(calls, 2);
});
test('never exceeds 120 provider requests in a rolling minute', async () => {
  let calls = 0,
    now = 0;
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async () => {
      calls++;
      return Response.json([]);
    },
  });
  for (let i = 0; i < 125; i++) await adapter.enrich([token()]);
  assert.equal(calls, 120);
  now = 60_000;
  await adapter.enrich([token()]);
  assert.equal(calls, 121);
});
test('rejects non-array payloads, invalid JSON, oversized bodies and unsafe liquidity', async () => {
  const input = token();
  const responses = [
    () => Response.json({ pairs: [pair(input.address)] }),
    () => new Response('{'),
    () => new Response('x'.repeat(2_000_001)),
    () => Response.json([pair(input.address, { liquidity: { usd: '999999' } })]),
  ];
  for (const response of responses) {
    const adapter = new DexScreenerMarketData({ fetch: async () => response() });
    assert.deepEqual(metrics((await adapter.enrich([input]))[0]), {
      mcap: null,
      volume: null,
      change: null,
    });
  }
});
test('unavailable incoming metric values are erased when no pair is indexed', async () => {
  const input = { ...token(), mcap: 999999, volume: 999999, change: 999999 };
  const adapter = new DexScreenerMarketData({ fetch: async () => Response.json([]) });
  assert.deepEqual(metrics((await adapter.enrich([input]))[0]), {
    mcap: null,
    volume: null,
    change: null,
  });
});
test('bonding curve pair with unreported liquidity remains eligible until a measured pool exists', async () => {
  const input = token();
  const adapter = new DexScreenerMarketData({
    fetch: async () => Response.json([pair(input.address, { liquidity: null })]),
  });
  assert.equal((await adapter.enrich([input]))[0].mcap, 1000);
});

test('honors HTTP-date Retry-After across multiple cache lifetimes', async () => {
  let now = 0,
    calls = 0;
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async () => {
      calls++;
      return new Response('Limited', {
        status: 429,
        headers: { 'retry-after': new Date(600_000).toUTCString() },
      });
    },
  });
  await adapter.enrich([token()]);
  now = 180_000;
  await adapter.enrich([token()]);
  assert.equal(calls, 1);
  now = 600_000;
  await adapter.enrich([token()]);
  assert.equal(calls, 2);
});

test('snapshot returns identities synchronously, coalesces refreshes and retries unindexed mints after10 seconds', async () => {
  const a = token(),
    b = token();
  let now = 0,
    calls = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async (url) => {
      calls++;
      await held;
      const mints = String(url).split('/').at(-1)!.split(',');
      return Response.json(calls === 1 ? [] : mints.map((mint) => pair(mint)));
    },
  });
  const first = adapter.snapshot([a]);
  assert.equal(first.tokens[0].name, a.name);
  assert.equal(first.tokens[0].donatedUsdCents, 123);
  assert.equal(first.tokens[0].marketDataStatus, 'warming');
  assert.equal(first.marketData.refreshing, true);
  assert.equal(first.marketData.retryAfterMs, 1000);
  adapter.snapshot([a]);
  release();
  await adapter.enrich([a]);
  assert.equal(calls, 1);
  assert.equal(adapter.snapshot([a]).tokens[0].marketDataStatus, 'unavailable');
  now = 9_999;
  await adapter.enrich([a]);
  assert.equal(calls, 1);
  now = 10_000;
  await adapter.enrich([a, b]);
  assert.equal(calls, 2);
  assert.ok(adapter.snapshot([a, b]).tokens.every((t) => t.marketDataStatus === 'fresh'));
  await adapter.close();
});

test('bounded admission rotates across130 tokens instead of repeatedly refreshing the first cache window', async () => {
  const inputs = Array.from({ length: 130 }, () => token());
  const seen = new Set<string>();
  const adapter = new DexScreenerMarketData({
    maximumCacheEntries: 30,
    fetch: async (url) => {
      for (const mint of String(url).split('/').at(-1)!.split(',')) seen.add(mint);
      return Response.json([]);
    },
  });
  for (let i = 0; i < 5; i++) {
    const result = await adapter.enrich(inputs);
    assert.deepEqual(
      result.map((t) => t.address),
      inputs.map((t) => t.address),
    );
  }
  assert.equal(seen.size, 130);
  await adapter.close();
});

test(
  'queued batches receive a full deadline only after a provider slot is available',
  { timeout: 2000 },
  async () => {
    const inputs = Array.from({ length: 91 }, () => token());
    let calls = 0;
    const adapter = new DexScreenerMarketData({
      timeoutMs: 200,
      fetch: async (url) => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 120));
        return Response.json(
          String(url)
            .split('/')
            .at(-1)!
            .split(',')
            .map((mint) => pair(mint)),
        );
      },
    });
    const results = await adapter.enrich(inputs);
    assert.equal(calls, 4);
    assert.ok(results.every((t) => t.mcap === 1000));
    await adapter.close();
  },
);

test('timed out uncooperative requests release all slots and their late data cannot enter the cache', async () => {
  const old = Array.from({ length: 90 }, () => token());
  const releases: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const adapter = new DexScreenerMarketData({
    timeoutMs: 10,
    fetch: async (url, init) => {
      calls++;
      const mints = String(url).split('/').at(-1)!.split(',');
      if (calls <= 3) {
        signals.push(init!.signal!);
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return Response.json(mints.map((mint) => pair(mint)));
    },
  });
  assert.ok((await adapter.enrich(old)).every((t) => t.mcap === null));
  assert.ok(signals.every((signal) => signal.aborted));
  const next = token();
  assert.equal((await adapter.enrich([next]))[0].mcap, 1000);
  releases.forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(adapter.snapshot(old).tokens.every((t) => t.mcap === null));
  assert.equal(calls, 4);
  await adapter.close();
});

test(
  'close aborts active and queued work promptly and cannot be reversed by late provider success',
  { timeout: 2000 },
  async () => {
    const inputs = Array.from({ length: 130 }, () => token());
    let calls = 0;
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const adapter = new DexScreenerMarketData({
      fetch: async (url, init) => {
        calls++;
        signals.push(init!.signal!);
        await new Promise<void>((resolve) => releases.push(resolve));
        return Response.json(
          String(url)
            .split('/')
            .at(-1)!
            .split(',')
            .map((mint) => pair(mint)),
        );
      },
    });
    adapter.snapshot(inputs);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    await adapter.close();
    assert.ok(signals.every((signal) => signal.aborted));
    releases.forEach((release) => release());
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = adapter.snapshot(inputs);
    assert.equal(calls, 3, 'neither queued nor later snapshots start new requests');
    assert.equal(stopped.marketData.refreshing, false);
    assert.ok(stopped.tokens.every((t) => t.mcap === null && t.marketDataStatus === 'unavailable'));
  },
);

test(
  'close cancels a provider body still streaming before it can publish partial metrics',
  { timeout: 2000 },
  async () => {
    const input = token();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let cancelled = false;
    const adapter = new DexScreenerMarketData({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('['));
              bodyStarted();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    adapter.snapshot([input]);
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.close();
    assert.equal(cancelled, true);
    assert.equal(adapter.snapshot([input]).tokens[0].mcap, null);
  },
);

test('concurrent429 responses cannot shorten an existing longer provider cooldown', async () => {
  const inputs = Array.from({ length: 31 }, () => token());
  const releases: Array<(response: Response) => void> = [];
  let now = 0,
    calls = 0;
  const adapter = new DexScreenerMarketData({
    now: () => now,
    fetch: async () => {
      calls++;
      if (calls <= 2) return new Promise<Response>((resolve) => releases.push(resolve));
      return Response.json([]);
    },
  });
  const pending = adapter.enrich(inputs);
  await new Promise((resolve) => setImmediate(resolve));
  releases[0](new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await new Promise((resolve) => setImmediate(resolve));
  releases[1](new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await pending;
  now = 70_000;
  await adapter.enrich(inputs);
  assert.equal(calls, 2);
  now = 120_000;
  await adapter.enrich(inputs);
  assert.equal(calls, 4);
  await adapter.close();
});
