import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { Token } from '../src/data.ts';

let vite: ViteDevServer;
let progress: typeof import('../src/TokenDonationProgress.tsx');
let data: typeof import('../src/data.ts');
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

before(async () => {
  vite = await createServer({
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'progress-test-router',
        resolveId(id) {
          if (id === 'virtual:progress-test-router') return '\0progress-test-router';
        },
        load(id) {
          if (id === '\0progress-test-router')
            return 'export { MemoryRouter } from "react-router-dom";';
        },
      },
    ],
  });
  progress = (await vite.ssrLoadModule('/src/TokenDonationProgress.tsx')) as typeof progress;
  data = (await vite.ssrLoadModule('/src/data.ts')) as typeof data;
  ({ MemoryRouter } = await vite.ssrLoadModule('virtual:progress-test-router'));
  data.streamers.push({
    id: 'twitch:fixture',
    platform: 'twitch',
    handle: 'recipient_fixture',
    name: 'Recipient Fixture',
    image: '',
    color: '#fff',
    category: 'Fixture',
    bio: 'Synthetic test recipient',
  });
});
after(async () => {
  await vite?.close();
});
beforeEach(() => {
  data?.tokens.splice(0);
});

function token(id: string, metrics: Partial<Token> = {}): Token {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    image: '',
    color: '#fff',
    launchpad: 'pump',
    streamerId: 'twitch:fixture',
    mcap: null,
    volume: null,
    change: null,
    created: 1,
    address: id,
    description: 'Synthetic token',
    ...metrics,
  };
}
function render(limit?: number) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, {}, createElement(progress.TokenDonationProgress, { limit })),
  );
}

test('an unclaimed-only token appears with an estimate while claimed allocations and gifts stay zero', () => {
  data.tokens.push(
    token('xqc', {
      claimedUsdCents: 0,
      streamerAllocatedUsdCents: 0,
      pendingUsdCents: 0,
      donatedUsdCents: 0,
      feeAccrual: {
        unclaimedUsdCents: 76249,
        unclaimedLamports: '7759187457',
        observedAt: '2026-09-16T21:38:16Z',
        status: 'fresh',
      },
    }),
  );
  const html = render();
  assert.match(html, /xqc donation progress/);
  assert.match(html, /Unclaimed fees/);
  assert.match(html, /\$762\.49/);
  assert.match(html, /Delivered gifts<\/dt><dd>\$0\.00/);
  assert.match(html, /Allocated to streamer<\/dt><dd>\$0\.00/);
});

test('recorded allocations show exact cents separately from zero delivered gifts and link identities', () => {
  data.tokens.push(
    token('speed', {
      claimedUsdCents: 19046,
      streamerAllocatedUsdCents: 15237,
      pendingUsdCents: 15237,
      donatedUsdCents: 0,
      payoutStatus: 'accumulating',
      claimCount: 2,
    }),
  );
  const html = render();
  assert.match(html, /Token donation progress/);
  assert.match(html, /Allocated to streamer<\/dt><dd>\$152\.37<\/dd>/);
  assert.match(html, /Awaiting gift<\/dt><dd>\$152\.37<\/dd>/);
  assert.match(html, /Delivered gifts<\/dt><dd>\$0\.00<\/dd>/);
  assert.match(html, /Accumulating funds/);
  assert.match(html, /href="\/token\/speed"/);
  assert.match(html, /href="https:\/\/www\.twitch\.tv\/recipient_fixture"/);
  assert.match(html, />Supporting<\/span>/);
  assert.doesNotMatch(html, /Gift sent to|Payments completed/);
});

test('an activity count can reveal a token while unknown amounts remain unknown', () => {
  data.tokens.push(token('unknown', { claimCount: 1 }));
  const html = render();
  assert.match(html, /unknown donation progress/);
  for (const label of ['Allocated to streamer', 'Awaiting gift', 'Delivered gifts']) {
    assert.ok(html.includes(`${label}</dt><dd>—</dd>`));
  }
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /Status unavailable/);
});

test('only positive valid recorded activity qualifies, including completed gift history', () => {
  for (const metrics of [
    {},
    { pendingUsdCents: 0, donatedUsdCents: 0, claimCount: 0 },
    { claimedUsdCents: NaN },
    { pendingUsdCents: -1 },
    { donatedUsdCents: Infinity },
  ]) {
    assert.equal(progress.hasRecordedDonationActivity(token('inactive', metrics)), false);
  }
  for (const metrics of [
    { claimedUsdCents: 1 },
    { streamerAllocatedUsdCents: 1 },
    { pendingUsdCents: 1 },
    { donatedUsdCents: 1 },
    { completedPaymentCount: 1 },
    { pendingPaymentCount: 1 },
  ]) {
    assert.equal(progress.hasRecordedDonationActivity(token('active', metrics)), true);
  }
});

test('rows prioritize pending funds then allocations, apply limit afterwards, and omit zero activity', () => {
  data.tokens.push(
    token('zero-only', { pendingUsdCents: 0, donatedUsdCents: 0 }),
    token('second', { pendingUsdCents: 100, streamerAllocatedUsdCents: 300 }),
    token('third', { pendingUsdCents: 100, streamerAllocatedUsdCents: 200 }),
    token('first', { pendingUsdCents: 101, streamerAllocatedUsdCents: 101 }),
  );
  const html = render(2);
  assert.ok(html.indexOf('first donation progress') < html.indexOf('second donation progress'));
  assert.match(html, /second donation progress/);
  assert.doesNotMatch(html, /zero-only donation progress|third donation progress/);
});

test('homepage and Donations progress preserve sent fees alongside the next pending payment', () => {
  data.tokens.push(
    token('speed', {
      donatedUsdCents: 4751,
      completedPaymentCount: 1,
      pendingUsdCents: 30052,
      pendingPaymentCount: 1,
      payoutStatus: 'in_progress',
    }),
  );
  const html = render();
  assert.match(html, /Sent from creator fees: \$47\.51/);
  assert.match(html, /Next payout: Gift in progress/);
  assert.match(html, /Awaiting gift<\/dt><dd>\$300\.52<\/dd>/);
  assert.match(html, /Delivered gifts<\/dt><dd>\$47\.51<\/dd>/);
});
