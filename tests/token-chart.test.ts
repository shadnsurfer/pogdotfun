import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { GeckoTerminalTokenChart } from '../server/public/token-chart.ts';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const key = () => Keypair.generate().publicKey.toBase58();
const NOW = Date.parse('2026-09-16T12:00:00Z');
function pool(mint: string, address = key(), quote = SOL, liquidity = '100') {
  return {
    id: `solana_${address}`,
    type: 'pool',
    attributes: { address, reserve_in_usd: liquidity },
    relationships: {
      base_token: { data: { type: 'token', id: `solana_${mint}` } },
      quote_token: { data: { type: 'token', id: `solana_${quote}` } },
    },
  };
}
function pools(rows: ReturnType<typeof pool>[]) {
  return {
    data: rows,
    included: [
      ...new Set(
        rows.flatMap((row) => [
          row.relationships.base_token.data.id,
          row.relationships.quote_token.data.id,
        ]),
      ),
    ].map((id) => ({ id, type: 'token', attributes: { address: id.slice(7) } })),
  };
}
function candles(mint: string, rows: number[][], quote = SOL) {
  return {
    data: { id: 'request-id', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } },
    meta: { base: { address: mint }, quote: { address: quote } },
  };
}
const candle = (time = NOW / 1000 - 300) => [time, 1, 3, 0.5, 2, 10];

test('chooses deepest verified base-mint pool, requests USD mint OHLCV, sorts and deduplicates', async () => {
  const mint = key(),
    shallow = pool(mint),
    deep = pool(mint, key(), USDC, '200');
  const urls: string[] = [];
  const adapter = new GeckoTerminalTokenChart({
    now: () => NOW,
    fetch: async (url, init) => {
      urls.push(String(url));
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return urls.length === 1
        ? Response.json(pools([shallow, deep]))
        : Response.json(candles(mint, [candle(), candle(NOW / 1000 - 600), candle()], USDC));
    },
  });
  const result = await adapter.get('registered-id', mint, '24h');
  assert.equal(result.status, 'ready');
  assert.equal(result.poolAddress, deep.attributes.address);
  assert.equal(result.tokenId, 'registered-id');
  assert.equal(result.mint, mint);
  assert.equal(result.provider, 'GeckoTerminal');
  assert.equal(result.currency, 'USD');
  assert.deepEqual(
    result.candles.map((c) => c.time),
    [NOW / 1000 - 600, NOW / 1000 - 300],
  );
  const u = new URL(urls[1]);
  assert.ok(u.pathname.endsWith(`/${deep.attributes.address}/ohlcv/minute`));
  assert.equal(u.searchParams.get('token'), mint);
  assert.equal(u.searchParams.get('currency'), 'usd');
  assert.equal(u.searchParams.get('aggregate'), '5');
  assert.equal(u.searchParams.get('limit'), '289');
  assert.equal(u.searchParams.get('include_empty_intervals'), 'false');
  assert.equal(
    result.sourceUrl,
    `https://www.geckoterminal.com/solana/pools/${deep.attributes.address}`,
  );
});
test('equal depth tie is deterministic; swapped quote identities cannot masquerade as the requested base', async () => {
  const mint = key();
  const candidates = [pool(mint), pool(mint)];
  const selected = candidates.map((p) => p.attributes.address).sort()[0];
  for (const rows of [candidates, [...candidates].reverse()]) {
    let count = 0;
    const a = new GeckoTerminalTokenChart({
      now: () => NOW,
      fetch: async () =>
        Response.json(
          ++count === 1
            ? pools([...rows, pool(SOL, key(), mint, '99999')])
            : candles(mint, [candle()]),
        ),
    });
    assert.equal((await a.get('id', mint, '24h')).poolAddress, selected);
  }
});
test('wrong network, mint, pool address or metadata identity never produces ready data', async () => {
  const mint = key();
  for (const alter of [
    (p: ReturnType<typeof pool>) => {
      p.id = `eth_${p.attributes.address}`;
    },
    (p: ReturnType<typeof pool>) => {
      p.attributes.address = key();
    },
    (p: ReturnType<typeof pool>) => {
      p.relationships.base_token.data.id = `solana_${key()}`;
    },
  ]) {
    const p = pool(mint);
    alter(p);
    let calls = 0;
    const a = new GeckoTerminalTokenChart({
      now: () => NOW,
      fetch: async () => {
        calls++;
        return Response.json(pools([p]));
      },
    });
    assert.notEqual((await a.get('id', mint, '24h')).status, 'ready');
    assert.equal(calls, 1);
  }
  for (const data of [candles(key(), [candle()]), candles(mint, [candle()], key())]) {
    let count = 0;
    const a = new GeckoTerminalTokenChart({
      now: () => NOW,
      fetch: async () => Response.json(++count === 1 ? pools([pool(mint)]) : data),
    });
    assert.equal((await a.get('id', mint, '24h')).status, 'unavailable');
  }
});
test('full ranges use documented intervals and exclude old candles without fabricating missing periods', async () => {
  const mint = key();
  let calls = 0;
  const urls: string[] = [];
  const a = new GeckoTerminalTokenChart({
    now: () => NOW,
    fetch: async (url) => {
      urls.push(String(url));
      calls++;
      return Response.json(
        calls === 1
          ? pools([pool(mint)])
          : candles(mint, [candle(NOW / 1000 - 86400 * 31), candle(NOW / 1000 - 300)]),
      );
    },
  });
  for (const [range, timeframe, aggregate, limit] of [
    ['24h', 'minute', '5', '289'],
    ['7d', 'hour', '1', '169'],
    ['30d', 'hour', '4', '181'],
  ] as const) {
    const result = await a.get('id', mint, range);
    assert.equal(result.candles.length, 1);
    const u = new URL(urls.at(-1)!);
    assert.ok(u.pathname.endsWith(`/ohlcv/${timeframe}`));
    assert.equal(u.searchParams.get('aggregate'), aggregate);
    assert.equal(u.searchParams.get('limit'), limit);
  }
  assert.equal(calls, 4, 'three chart ranges share pool discovery');
});
test('empty discovery/history is distinct from malformed or unavailable data', async () => {
  const mint = key();
  const empty = new GeckoTerminalTokenChart({ fetch: async () => Response.json({ data: [] }) });
  assert.equal((await empty.get('id', mint, '24h')).status, 'empty');
  for (const response of [
    new Response('down', { status: 503 }),
    Response.json({ wrong: 'schema' }),
  ]) {
    const a = new GeckoTerminalTokenChart({ fetch: async () => response });
    const r = await a.get('id', mint, '24h');
    assert.equal(r.status, 'unavailable');
    assert.equal(r.updatedAt, null);
    assert.deepEqual(r.candles, []);
  }
  let count = 0;
  const a = new GeckoTerminalTokenChart({
    now: () => NOW,
    fetch: async () => Response.json(++count === 1 ? pools([pool(mint)]) : candles(mint, [])),
  });
  assert.equal((await a.get('id', mint, '24h')).status, 'empty');
});
test('malformed prices, bounds, seconds, volume, conflicting duplicates and excessive rows fail closed', async () => {
  const mint = key();
  for (const rows of [
    [['not-time', 1, 2, 1, 2, 1]],
    [candle(NOW)],
    [candle(NOW / 1000 + 60)],
    [[NOW / 1000, 1, 0.5, 0.1, 2, 1]],
    [[NOW / 1000, 0, 1, 0, 1, 1]],
    [[NOW / 1000, 1, 2, 0.5, 1, -1]],
    [candle(), [...candle().slice(0, 5), 11]],
    Array.from({ length: 1001 }, () => candle()),
  ]) {
    let count = 0;
    const a = new GeckoTerminalTokenChart({
      now: () => NOW,
      fetch: async () =>
        Response.json(++count === 1 ? pools([pool(mint)]) : candles(mint, rows as number[][])),
    });
    assert.equal((await a.get('id', mint, '24h')).status, 'unavailable');
  }
});

test('cached charts expire without stale fallback; pool discovery lasts five minutes and ranges stay isolated', async () => {
  const mint = key();
  let now = NOW,
    chartCalls = 0,
    poolCalls = 0,
    offline = false;
  const adapter = new GeckoTerminalTokenChart({
    now: () => now,
    fetch: async (url) => {
      if (String(url).includes('/tokens/')) {
        poolCalls++;
        return Response.json(pools([pool(mint)]));
      }
      chartCalls++;
      return offline
        ? new Response('down', { status: 503 })
        : Response.json(candles(mint, [candle(Math.floor(now / 1000) - 300)]));
    },
  });
  const initial = await adapter.get('id', mint, '24h');
  assert.equal(initial.status, 'ready');
  initial.candles[0].close = 999;
  now += 89_999;
  const cached = await adapter.get('other-registered-id', mint, '24h');
  assert.equal(cached.tokenId, 'other-registered-id');
  assert.equal(cached.candles[0].close, 2);
  assert.equal(chartCalls, 1);
  await adapter.get('id', mint, '7d');
  assert.equal(chartCalls, 2);
  assert.equal(poolCalls, 1);
  now += 1;
  offline = true;
  const gone = await adapter.get('id', mint, '24h');
  assert.equal(gone.status, 'unavailable');
  assert.equal(gone.updatedAt, null);
  assert.deepEqual(gone.candles, []);
  assert.equal(chartCalls, 3);
  assert.equal(poolCalls, 1);
  now = NOW + 300_001;
  await adapter.get('id', mint, '30d');
  assert.equal(poolCalls, 2);
});
test('concurrent same-range callers coalesce chart and discovery; different ranges share only discovery', async () => {
  const mint = key();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let poolCalls = 0,
    chartCalls = 0;
  const adapter = new GeckoTerminalTokenChart({
    now: () => NOW,
    fetch: async (url) => {
      if (String(url).includes('/tokens/')) {
        poolCalls++;
        await gate;
        return Response.json(pools([pool(mint)]));
      }
      chartCalls++;
      return Response.json(candles(mint, [candle()]));
    },
  });
  const jobs = [
    adapter.get('a', mint, '24h'),
    adapter.get('b', mint, '24h'),
    adapter.get('c', mint, '7d'),
  ];
  release();
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.status === 'ready'));
  assert.equal(poolCalls, 1);
  assert.equal(chartCalls, 2);
  assert.deepEqual(
    results.map((r) => r.tokenId),
    ['a', 'b', 'c'],
  );
});
test('rolling quota admits at most 25 reads per minute and honors provider cooldown', async () => {
  let now = NOW,
    calls = 0;
  const adapter = new GeckoTerminalTokenChart({
    now: () => now,
    fetch: async () => {
      calls++;
      return Response.json({ data: [] });
    },
  });
  for (let i = 0; i < 40; i++) await adapter.get(`id-${i}`, key(), '24h');
  assert.equal(calls, 25);
  now += 60000;
  await adapter.get('next-minute', key(), '24h');
  assert.equal(calls, 26);
  let throttledCalls = 0;
  const limited = new GeckoTerminalTokenChart({
    now: () => now,
    fetch: async () => {
      throttledCalls++;
      return new Response('slow', { status: 429, headers: { 'retry-after': '120' } });
    },
  });
  assert.equal((await limited.get('a', key(), '24h')).status, 'unavailable');
  now += 60001;
  await limited.get('b', key(), '24h');
  assert.equal(throttledCalls, 1);
  now += 60000;
  await limited.get('c', key(), '24h');
  assert.equal(throttledCalls, 2);
});
test('timeouts and ignored aborts cannot create unbounded upstream work', async () => {
  let calls = 0;
  const adapter = new GeckoTerminalTokenChart({
    timeoutMs: 10,
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  const first = await Promise.all(
    Array.from({ length: 12 }, (_, i) => adapter.get(`id-${i}`, key(), '24h')),
  );
  assert.ok(first.every((r) => r.status === 'unavailable'));
  assert.equal(calls, 3);
  await adapter.get('after-timeout', key(), '24h');
  assert.equal(
    calls,
    3,
    'hung fetches retain their concurrency slots instead of allowing more dangling reads',
  );
});
test('streaming and declared oversized bodies, redirects and malformed JSON never become charts', async () => {
  for (const make of [
    () => new Response('small', { headers: { 'content-length': '1000001' } }),
    () => new Response(' '.repeat(1000001)),
    () => new Response('{broken'),
    () => Response.redirect('https://untrusted.example', 302),
  ]) {
    const a = new GeckoTerminalTokenChart({ fetch: async () => make() });
    assert.equal((await a.get('id', key(), '24h')).status, 'unavailable');
  }
  const hanging = new GeckoTerminalTokenChart({
    timeoutMs: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
      ),
  });
  assert.equal((await hanging.get('id', key(), '24h')).status, 'unavailable');
});
test('bounded cache eviction and invalid caller inputs cause no uncontrolled provider requests', async () => {
  let calls = 0;
  const a = new GeckoTerminalTokenChart({
    maximumCacheEntries: 1,
    fetch: async () => {
      calls++;
      return Response.json({ data: [] });
    },
  });
  const one = key(),
    two = key();
  await a.get('a', one, '24h');
  await a.get('b', two, '24h');
  await a.get('a', one, '24h');
  assert.equal(calls, 3);
  await a.get('id', '../not-a-mint', '24h');
  await a.get('id', one, 'bad' as '24h');
  assert.equal(calls, 3);
  assert.throws(() => new GeckoTerminalTokenChart({ maximumCacheEntries: 0 }));
  assert.throws(() => new GeckoTerminalTokenChart({ timeoutMs: 6001 }));
});

test('abort-aware fetch releases timed-out concurrency slots and later reads recover', async () => {
  let calls = 0;
  const adapter = new GeckoTerminalTokenChart({
    timeoutMs: 10,
    fetch: async (_url, init) => {
      calls++;
      if (calls > 3) return Response.json({ data: [] });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, i) => adapter.get(`timed-out-${i}`, key(), '24h')),
  );
  assert.ok(results.every((r) => r.status === 'unavailable'));
  // The shared discovery deadline can finish just after the caller's overall deadline.
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await adapter.get('recovered', key(), '24h')).status, 'empty');
  assert.equal(calls, 4);
});

test('a newly indexed pool becomes discoverable after15 seconds without repeatedly fetching empty discovery', async () => {
  const mint = key(),
    known = pool(mint);
  let now = NOW,
    indexed = false,
    poolCalls = 0,
    chartCalls = 0;
  const adapter = new GeckoTerminalTokenChart({
    now: () => now,
    fetch: async (url) => {
      if (String(url).includes('/tokens/')) {
        poolCalls++;
        return Response.json(pools(indexed ? [known] : []));
      }
      chartCalls++;
      return Response.json(candles(mint, [candle()]));
    },
  });
  assert.equal((await adapter.get('id', mint, '24h')).status, 'empty');
  indexed = true;
  now += 14_999;
  assert.equal((await adapter.get('id', mint, '24h')).status, 'empty');
  assert.equal((await adapter.get('id', mint, '7d')).status, 'empty');
  assert.equal(poolCalls, 1);
  now += 1;
  assert.equal((await adapter.get('id', mint, '24h')).status, 'ready');
  assert.equal(poolCalls, 2);
  assert.equal(chartCalls, 1);
  now += 89_999;
  assert.equal((await adapter.get('id', mint, '24h')).status, 'ready');
  assert.equal(chartCalls, 1, 'ready charts retain the existing90-second cache');
});

test('empty history retries after15 seconds using the existing pool while failures retain90-second backoff', async () => {
  const mint = key(),
    known = pool(mint);
  let now = NOW,
    poolCalls = 0,
    chartCalls = 0;
  const adapter = new GeckoTerminalTokenChart({
    now: () => now,
    fetch: async (url) => {
      if (String(url).includes('/tokens/')) {
        poolCalls++;
        return Response.json(pools([known]));
      }
      chartCalls++;
      return chartCalls === 1
        ? Response.json(candles(mint, []))
        : new Response('offline', { status: 503 });
    },
  });
  assert.equal((await adapter.get('id', mint, '24h')).status, 'empty');
  now += 14_999;
  await adapter.get('id', mint, '24h');
  assert.equal(chartCalls, 1);
  now += 1;
  assert.equal((await adapter.get('id', mint, '24h')).status, 'unavailable');
  assert.equal(chartCalls, 2);
  assert.equal(poolCalls, 1);
  now += 89_999;
  await adapter.get('id', mint, '24h');
  assert.equal(chartCalls, 2);
  now += 1;
  await adapter.get('id', mint, '24h');
  assert.equal(chartCalls, 3);
  assert.equal(poolCalls, 1, 'known pool retains the existingfive-minute cache');
});
