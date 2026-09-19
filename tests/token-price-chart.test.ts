import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTokenPrice,
  parseTokenChart,
  tokenChartFallbackUrl,
  tokenChartQuote,
} from '../src/token-price-chart-data.ts';

const candle = {
  time: 1700000000,
  open: 0.000001,
  high: 0.000003,
  low: 0.000001,
  close: 0.000002,
  volume: 123.45,
};
const payload = () => ({
  tokenId: 'token-a',
  mint: 'mint-a',
  range: '24h',
  currency: 'USD',
  provider: 'GeckoTerminal',
  status: 'ready',
  updatedAt: '2026-09-16T12:00:00Z',
  poolAddress: 'pool-a',
  sourceUrl: 'https://www.geckoterminal.com/solana/pools/pool-a',
  candles: [{ ...candle }],
});

test('current market price remains usable independently of missing historical candles', () => {
  const quote = {
    priceUsd: 0.0000061234,
    marketDataStatus: 'fresh' as const,
    marketDataUpdatedAt: '2026-09-16T12:00:00Z',
  };
  assert.deepEqual(tokenChartQuote(quote), {
    price: 0.0000061234,
    updatedAt: '2026-09-16T12:00:00Z',
    stale: false,
  });
  assert.equal(tokenChartQuote({ ...quote, marketDataStatus: 'stale' })?.stale, true);
  for (const patch of [
    { priceUsd: null },
    { priceUsd: 0 },
    { priceUsd: -1 },
    { priceUsd: NaN },
    { priceUsd: Infinity },
    { marketDataStatus: 'warming' as const },
    { marketDataStatus: 'unavailable' as const },
    { marketDataUpdatedAt: 'invalid' },
    { marketDataUpdatedAt: null },
  ]) {
    assert.equal(tokenChartQuote({ ...quote, ...patch }), null);
  }
  assert.equal(tokenChartQuote({}), null);
});

test('fallback chart is pinned to a Solana mint and explicitly shows USD price', () => {
  const mint = '8bFvxaMqvf3kxNtuZwgiD4Sw8iqj6SWGonn3wvRwLMgY';
  const url = new URL(tokenChartFallbackUrl(mint)!);
  assert.equal(url.origin, 'https://dexscreener.com');
  assert.equal(url.pathname, `/solana/${mint}`);
  assert.equal(url.searchParams.get('embed'), '1');
  assert.equal(url.searchParams.get('chartType'), 'price');
  assert.equal(url.searchParams.get('info'), '1', 'the provider needs pair info to initialize');
  assert.equal(url.searchParams.get('loadChartSettings'), '0');
  assert.equal(url.searchParams.get('chartDefaultOnMobile'), '1');
  for (const value of [
    undefined,
    '',
    '../other',
    'https://evil.test',
    `${mint}?chartType=marketCap`,
  ])
    assert.equal(tokenChartFallbackUrl(value), null);
});

test('micro prices retain meaningful decimal precision and never become a fake zero', () => {
  assert.equal(formatTokenPrice(0.00000123456), '$0.00000123456');
  assert.equal(formatTokenPrice(0.00000000123456), '$0.00000000123456');
  assert.equal(formatTokenPrice(1.23456e-18), '$1.23456e-18');
  assert.equal(formatTokenPrice(12.34), '$12.34');
  assert.equal(formatTokenPrice(null), '—');
  assert.equal(formatTokenPrice(Number.NaN), '—');
  assert.equal(formatTokenPrice(-1), '—');
});

test('chart data is pinned to the requested token and time range', () => {
  assert.equal(parseTokenChart(payload(), 'token-a', '24h').candles.length, 1);
  assert.throws(() => parseTokenChart(payload(), 'token-b', '24h'));
  assert.throws(() => parseTokenChart(payload(), 'token-a', '7d'));
  assert.throws(() => parseTokenChart({ ...payload(), currency: 'SOL' }, 'token-a', '24h'));
});

test('malformed OHLC, duplicate time and invalid price or volume cannot reach the chart', () => {
  for (const patch of [
    { close: 4 },
    { low: 2 },
    { high: 0 },
    { open: NaN },
    { close: -1 },
    { volume: -1 },
    { time: 1.5 },
    { time: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() =>
      parseTokenChart({ ...payload(), candles: [{ ...candle, ...patch }] }, 'token-a', '24h'),
    );
  }
  assert.throws(() =>
    parseTokenChart({ ...payload(), candles: [candle, candle] }, 'token-a', '24h'),
  );
  assert.throws(() =>
    parseTokenChart(
      { ...payload(), candles: [candle, { ...candle, time: candle.time - 1 }] },
      'token-a',
      '24h',
    ),
  );
  assert.throws(() =>
    parseTokenChart({ ...payload(), candles: Array(2001).fill(candle) }, 'token-a', '24h'),
  );
});

test('empty and unavailable responses cannot carry a misleading curve; source links are constrained', () => {
  for (const status of ['empty', 'unavailable']) {
    assert.throws(() => parseTokenChart({ ...payload(), status }, 'token-a', '24h'));
    assert.equal(
      parseTokenChart(
        { ...payload(), status, candles: [], poolAddress: null, sourceUrl: null, updatedAt: null },
        'token-a',
        '24h',
      ).candles.length,
      0,
    );
  }
  assert.throws(() => parseTokenChart({ ...payload(), candles: [] }, 'token-a', '24h'));
  for (const sourceUrl of [
    'javascript:alert(1)',
    'https://evil.test',
    'https://user:pass@www.geckoterminal.com/',
  ]) {
    assert.throws(() => parseTokenChart({ ...payload(), sourceUrl }, 'token-a', '24h'));
  }
});
