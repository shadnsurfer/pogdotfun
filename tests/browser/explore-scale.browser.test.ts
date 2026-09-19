/** Isolated real ExplorePage + refreshCatalog. All catalog data is synthetic API data. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Token } from '../../src/data';
import bs58 from 'bs58';
const tokenId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

let server: ViteDevServer, browser: Browser, origin: string;
const fixtureTokens = (count: number): Token[] =>
  Array.from({ length: count }, (_, i) => ({
    id: tokenId(i),
    name: i < 2 ? 'Shared Community' : `Community ${String(i).padStart(3, '0')}`,
    symbol: i < 2 ? 'SAME' : `C${i}`,
    image: '/assets/brand/mark.svg',
    color: '#85ed18',
    launchpad: i % 3 === 0 ? 'pons' : 'pump',
    streamerId: 'twitch:123',
    mcap: null,
    volume: null,
    change: null,
    created: Date.UTC(2026, 8, 1) + i * 1000,
    address: bs58.encode(
      Uint8Array.from({ length: 32 }, (_, byte) =>
        byte === 30 ? i >> 8 : byte === 31 ? i & 255 : 0,
      ),
    ),
    description: '',
    donatedUsdCents: i * 100,
    pendingUsdCents: 0,
  }));
const catalog = (tokens: Token[]) => ({
  tokens,
  streamers: [
    {
      id: 'twitch:123',
      name: 'Fixture Streamer',
      handle: 'fixturestreamer',
      platform: 'twitch',
      color: '#9146ff',
      image: '/assets/brand/mark.svg',
      category: '',
      bio: '',
    },
  ],
  activity: [],
  stats: {
    totalDonatedUsdCents: 0,
    totalClaimedUsdCents: 0,
    streamerAllocatedUsdCents: 0,
    buybackAllocatedUsdCents: 0,
    streamerPendingUsdCents: 0,
    tokenCount: tokens.length,
    streamerCount: 1,
  },
});
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-explore-scale-vite',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'explore-scale-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__explore_scale', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__explore_scale',
                `<!doctype html><div id="root"></div><script type="module">
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router-dom';
      import {ExplorePage} from '/src/pages/Discover.tsx'; import {refreshCatalog} from '/src/data.ts'; import '/src/styles.css'; import '/src/pog-interface.css';
      window.refreshFixture=(options)=>refreshCatalog(options);
      createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(ExplorePage))); refreshCatalog();
      </script>`,
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_EXECUTABLE ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update'],
  });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
async function fixture(count: number) {
  const state = { tokens: fixtureTokens(count), calls: 0, fail: false, delay: 0, onRead: () => {} };
  const errors: string[] = [];
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/catalog') {
      state.calls++;
      const body = JSON.stringify(catalog(state.tokens));
      state.onRead();
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
      return route.fulfill({
        status: state.fail ? 503 : 200,
        contentType: 'application/json',
        body,
      });
    }
    if (url.pathname.startsWith('/api/')) {
      errors.push(`Unexpected API ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/__explore_scale');
  await page.locator('#all-tokens .token-card').first().waitFor();
  return { page, state, errors, close: () => context.close() };
}
const visibleIds = async (page: Page) => {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page
    .locator('#all-tokens .token-card-title')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')!.split('/').pop()!));
};
async function refresh(page: Page, count = 1) {
  await page.evaluate(
    (n) => Promise.all(Array.from({ length: n }, () => (window as any).refreshFixture())),
    count,
  );
}

for (const count of [14, 15, 20, 21, 24, 25, 29, 107, 257])
  test(`${count} tokens render immediately without duplicates or a display limit`, async () => {
    const f = await fixture(count);
    try {
      assert.equal((await visibleIds(f.page)).length, count);
      assert.equal(
        await f.page.locator('.results-count').innerText(),
        `Showing ${count} of ${count}`,
      );
      const ids = await visibleIds(f.page);
      assert.equal(await f.page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
      assert.equal(ids.length, count);
      assert.equal(new Set(ids).size, count);
      assert.deepEqual([...ids].sort(), f.state.tokens.map((t) => t.id).sort());
      assert.equal(
        await f.page
          .locator('#all-tokens .token-card-figures strong')
          .filter({ hasText: /^—$/ })
          .count(),
        count,
      );
      assert.equal(
        await f.page.getByRole('heading', { name: 'Shared Community', exact: true }).count(),
        2,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  });

test('name, symbol and exact address search disambiguate identical token names, reset filters and sort every result', async () => {
  const f = await fixture(257);
  try {
    const search = f.page.getByRole('textbox', { name: 'Search tokens', exact: true });
    assert.equal((await visibleIds(f.page)).length, 257);
    await search.fill('sHaReD cOmMuNiTy');
    assert.deepEqual((await visibleIds(f.page)).sort(), [tokenId(0), tokenId(1)]);
    await search.fill('SAME');
    assert.equal((await visibleIds(f.page)).length, 2);
    await search.fill(f.state.tokens[256].address);
    assert.deepEqual(await visibleIds(f.page), [tokenId(256)]);
    await f.page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await f.page.waitForFunction(
      () => document.querySelectorAll('#all-tokens .token-card').length === 257,
    );
    assert.equal(
      (await visibleIds(f.page)).length,
      257,
      'Clearing search restores the entire catalog',
    );
    await f.page.getByRole('button', { name: 'Pump.fun', exact: true }).click();
    const pumps = f.state.tokens.filter((t) => t.launchpad === 'pump');
    assert.deepEqual((await visibleIds(f.page)).sort(), pumps.map((t) => t.id).sort());
    await f.page.getByRole('combobox').selectOption('newest');
    assert.deepEqual(
      await visibleIds(f.page),
      [...pumps].reverse().map((t) => t.id),
    );
    await f.page.getByRole('combobox').selectOption('donations');
    assert.deepEqual(
      await visibleIds(f.page),
      [...pumps].reverse().map((t) => t.id),
    );
    await search.fill('does-not-exist');
    await f.page.getByRole('heading', { name: 'No tokens found', exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    await f.page.waitForFunction(
      () => document.querySelectorAll('#all-tokens .token-card').length === 257,
    );
    assert.equal((await visibleIds(f.page)).length, 257);
    assert.equal(await search.inputValue(), '');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('burst refresh uses one request, publishes every new token, and failed refresh retains labeled last confirmed inventory', async () => {
  const f = await fixture(14);
  try {
    f.state.tokens = fixtureTokens(107);
    f.state.delay = 100;
    const before = f.state.calls;
    await refresh(f.page, 25);
    assert.equal(f.state.calls - before, 1);
    assert.equal((await visibleIds(f.page)).length, 107);
    f.state.tokens = fixtureTokens(129);
    await refresh(f.page);
    assert.equal(
      (await visibleIds(f.page)).length,
      129,
      'Refresh displays every newly added token',
    );
    f.state.fail = true;
    await refresh(f.page, 25);
    await f.page
      .getByText('Live refresh unavailable. Showing the last confirmed catalog and totals.', {
        exact: true,
      })
      .waitFor();
    assert.equal((await visibleIds(f.page)).length, 129);
    f.state.fail = false;
    f.state.tokens = fixtureTokens(15);
    await f.page.getByRole('button', { name: 'Try again', exact: true }).click();
    await f.page.waitForFunction(
      () => document.querySelectorAll('#all-tokens .token-card').length === 15,
    );
    assert.equal(
      await f.page
        .getByText('Live refresh unavailable. Showing the last confirmed catalog and totals.', {
          exact: true,
        })
        .count(),
      0,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('unavailable market metrics use a stable ordering across reversed catalog responses', async () => {
  const f = await fixture(21);
  try {
    for (const sort of ['mcap', 'volume']) {
      await f.page.getByRole('combobox').selectOption(sort);
      const before = await visibleIds(f.page);
      f.state.tokens.reverse();
      await refresh(f.page);
      assert.deepEqual(
        await visibleIds(f.page),
        before,
        `${sort}: unavailable metrics must not reshuffle identical data when API order changes`,
      );
    }
  } finally {
    await f.close();
  }
});

test('forced refresh during an older in-flight catalog fetch queues one newer snapshot without losing a newly launched token', async () => {
  const f = await fixture(14);
  try {
    f.state.delay = 100;
    let started!: () => void;
    const olderRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.state.onRead = started;
    const before = f.state.calls;
    await f.page.evaluate(() => {
      (window as any).olderRead = (window as any).refreshFixture();
    });
    await olderRead;
    f.state.tokens = fixtureTokens(15);
    await f.page.evaluate(() =>
      Promise.all(
        Array.from({ length: 20 }, () => (window as any).refreshFixture({ force: true })),
      ),
    );
    assert.equal(f.state.calls - before, 2, 'Force callers share one follow-up read');
    assert.equal((await visibleIds(f.page)).length, 15);
    assert.ok((await visibleIds(f.page)).includes(tokenId(14)));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('mobile 390px directory shows all 257 cards with the final token reachable', async () => {
  const f = await fixture(257);
  try {
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.equal((await visibleIds(f.page)).length, 257);
    const last = f.page.locator('#all-tokens .token-card').last();
    await last.scrollIntoViewIfNeeded();
    assert.equal(await last.isVisible(), true);
    const bounds = await last.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Mobile page must not overflow horizontally',
    );
    await f.page.screenshot({ path: '/tmp/pog-explore-257-mobile.png' });
    await f.page.setViewportSize({ width: 1440, height: 1000 });
    await f.page.evaluate(() => scrollTo(0, 0));
    await f.page.screenshot({ path: '/tmp/pog-explore-257-desktop.png' });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
