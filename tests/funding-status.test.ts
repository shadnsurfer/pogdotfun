import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { fundingWaitMessage } from '../src/funding-status.ts';
import type { Streamer, Token } from '../src/data.ts';

const now = Date.parse('2026-09-16T12:01:00.000Z');
const observation = {
  name: 'SPEED',
  platform: 'twitch' as const,
  liveStatus: 'offline' as const,
  liveCheckedAt: '2026-09-16T12:00:00.000Z',
  nextLiveCheckAt: '2026-09-16T12:05:00.000Z',
};

test('fresh offline stream observation explains the next gift and preserves allocation', () => {
  const message = fundingWaitMessage({ pendingUsdCents: 49109 }, observation, now);
  assert.equal(message?.summary, 'Next gift paused: SPEED is offline.');
  assert.match(message!.detail, /Gifts wait for a verified live stream/);
  assert.match(message!.detail, /Funds remain allocated to their original tokens/);
  assert.match(message!.detail, /all other payment checks still apply/);
});

test('no waiting funds, unavailable amounts, and unsupported recipients have no offline funding claim', () => {
  for (const pendingUsdCents of [undefined, 0, -1, NaN, Infinity, 0.5])
    assert.equal(fundingWaitMessage({ pendingUsdCents }, observation, now), null);
  for (const liveStatus of ['live', 'unknown', undefined] as const)
    assert.equal(
      fundingWaitMessage({ pendingUsdCents: 100 }, { ...observation, liveStatus }, now),
      null,
    );
  assert.equal(
    fundingWaitMessage({ pendingUsdCents: 100 }, { ...observation, platform: 'kick' }, now)
      ?.summary,
    'Next gift paused: SPEED is offline.',
  );
});

test('missing, stale, invalid, and future stream checks never produce an offline funding reason', () => {
  for (const changed of [
    { liveCheckedAt: undefined },
    { liveCheckedAt: null },
    { liveCheckedAt: 'invalid' },
    { liveCheckedAt: '2026-09-16T12:02:00.000Z' },
    { nextLiveCheckAt: undefined },
    { nextLiveCheckAt: null },
    { nextLiveCheckAt: 'invalid' },
    { nextLiveCheckAt: '2026-09-16T12:00:30.000Z' },
    { nextLiveCheckAt: '2026-09-16T12:01:00.000Z' },
  ])
    assert.equal(
      fundingWaitMessage({ pendingUsdCents: 100 }, { ...observation, ...changed }, now),
      null,
    );
  assert.equal(fundingWaitMessage({ pendingUsdCents: 100 }, observation, NaN), null);
});

let vite: ViteDevServer;
let data: typeof import('../src/data.ts');
let components: typeof import('../src/components.tsx');
let details: typeof import('../src/pages/Details.tsx');
let router: Pick<typeof import('react-router-dom'), 'MemoryRouter' | 'Routes' | 'Route'>;
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
        name: 'funding-status-test-router',
        resolveId(id) {
          if (id === 'virtual:funding-status-router') return '\0funding-status-router';
        },
        load(id) {
          if (id === '\0funding-status-router')
            return 'export { MemoryRouter, Routes, Route } from "react-router-dom";';
        },
      },
    ],
  });
  data = (await vite.ssrLoadModule('/src/data.ts')) as typeof data;
  components = (await vite.ssrLoadModule('/src/components.tsx')) as typeof components;
  details = (await vite.ssrLoadModule('/src/pages/Details.tsx')) as typeof details;
  router = (await vite.ssrLoadModule('virtual:funding-status-router')) as typeof router;
});
after(async () => {
  await vite?.close();
});

function render(Page: ComponentType, path: string, route: string) {
  return renderToStaticMarkup(
    createElement(
      router.MemoryRouter,
      { initialEntries: [route] },
      createElement(
        router.Routes,
        {},
        createElement(router.Route, { path, element: createElement(Page) }),
      ),
    ),
  );
}

test('public card and detail pages explain fresh offline waits without replacing sent and pending totals', () => {
  const streamer: Streamer = {
    ...observation,
    liveCheckedAt: new Date(Date.now() - 1000).toISOString(),
    nextLiveCheckAt: new Date(Date.now() + 60_000).toISOString(),
    id: 'twitch:funding-fixture',
    handle: 'funding_fixture',
    color: '#9146ff',
    image: '',
    category: '',
    bio: '',
    donatedUsdCents: 4751,
    pendingUsdCents: 49109,
  };
  const token: Token = {
    id: 'funding-fixture',
    name: 'Funding fixture',
    symbol: 'SPEED',
    streamerId: streamer.id,
    image: '',
    color: '#9146ff',
    launchpad: 'pump',
    mcap: null,
    volume: null,
    change: null,
    created: 1,
    address: 'fixture',
    description: '',
    donatedUsdCents: 4751,
    pendingUsdCents: 49109,
  };
  const oldTokens = [...data.tokens];
  const oldStreamers = [...data.streamers];
  data.tokens.splice(0, data.tokens.length, token);
  data.streamers.splice(0, data.streamers.length, streamer);
  try {
    const card = () =>
      renderToStaticMarkup(
        createElement(router.MemoryRouter, {}, createElement(components.TokenCard, { token })),
      );
    const pages = () => [
      card(),
      render(details.TokenPage, '/token/:id', `/token/${token.id}`),
      render(details.StreamerPage, '/streamer/:id', `/streamer/${streamer.id}`),
    ];
    for (const html of pages()) {
      assert.match(html, /Next gift paused: SPEED is offline\./);
      assert.match(html, /\$47\.51/);
      assert.match(html, /\$491\.09/);
    }
    assert.match(card(), /<strong>\$47\.51<\/strong><small>Gifts sent<\/small>/);
    assert.match(card(), /<strong>\$491\.09<\/strong><small>Awaiting gift<\/small>/);
    for (const liveStatus of ['live', 'unknown'] as const) {
      streamer.liveStatus = liveStatus;
      for (const html of pages()) assert.doesNotMatch(html, /Next gift paused/);
    }
    streamer.liveStatus = 'offline';
    streamer.nextLiveCheckAt = new Date(Date.now() - 1000).toISOString();
    for (const html of pages()) assert.doesNotMatch(html, /Next gift paused/);
    streamer.nextLiveCheckAt = new Date(Date.now() + 60_000).toISOString();
    token.pendingUsdCents = 0;
    streamer.pendingUsdCents = 0;
    for (const html of pages()) assert.doesNotMatch(html, /Next gift paused/);
  } finally {
    data.tokens.splice(0, data.tokens.length, ...oldTokens);
    data.streamers.splice(0, data.streamers.length, ...oldStreamers);
  }
});
