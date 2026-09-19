/** Isolated product components with synthetic images; no external providers or wallet actions. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import bs58 from 'bs58';

let server: ViteDevServer, browser: Browser, origin: string;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>';
const tokens = Array.from({ length: 257 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Community ${i}`,
  symbol: `C${i}`,
  image: `/__images/token-${i}.svg`,
  color: '#85ed18',
  launchpad: 'pump',
  streamerId: 'twitch:123',
  mcap: null,
  volume: null,
  change: null,
  created: i,
  address: bs58.encode(
    Uint8Array.from({ length: 32 }, (_, b) => (b === 30 ? i >> 8 : b === 31 ? i & 255 : 0)),
  ),
  description: '',
  donatedUsdCents: 100,
}));
const catalog = (ready: boolean) => ({
  tokens: tokens.map((token, i) => ({
    ...token,
    ...(ready ? { mcap: (i + 1) * 100, volume: i + 1, change: i % 10 } : {}),
    marketDataStatus: ready ? 'fresh' : 'warming',
    marketDataUpdatedAt: ready ? '2026-09-16T12:00:00.000Z' : null,
  })),
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
    tokenCount: 257,
    streamerCount: 1,
  },
  marketData: { refreshing: !ready, retryAfterMs: ready ? 0 : 1000 },
});
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-image-browser-vite',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'token-images-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__image_explore', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__image_explore',
                `<!doctype html><div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {ExplorePage} from '/src/pages/Discover.tsx';import * as data from '/src/data.ts';import {PublicServices} from '/src/auth.tsx';import '/src/styles.css';import '/src/pog-interface.css';
        window.refreshFixture=()=>data.refreshCatalog({force:true});window.catalogFixture=()=>data.tokens;
        createRoot(document.getElementById('root')).render(React.createElement(PublicServices,null,React.createElement(MemoryRouter,null,React.createElement(ExplorePage))));
        </script>`,
              ),
            );
          });
          vite.middlewares.use('/__chart_loading', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__chart_loading',
                `<!doctype html><div id="root"></div><script type="module">
              import React from 'react';import {createRoot} from 'react-dom/client';import {TokenPriceChart} from '/src/TokenPriceChart.tsx';
              createRoot(document.getElementById('root')).render(React.createElement(TokenPriceChart,{tokenId:'token-fixture',symbol:'TEST'}));
            </script>`,
              ),
            );
          });
          vite.middlewares.use('/__image_fixture', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__image_fixture',
                `<!doctype html><div id="root"></div><script type="module">
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import {TokenArt,Avatar} from '/src/components.tsx'; import {tokenImageSource} from '/src/TokenImage.tsx';window.normalizeImage=tokenImageSource; import '/src/styles.css';
          const root=createRoot(document.getElementById('root'));
          window.imageFixture=(source)=>root.render(React.createElement('div',null,
            React.createElement(TokenArt,{token:{image:source,name:'Fixture'},large:true}),
            React.createElement(Avatar,{streamer:{image:source,name:'Streamer'},large:true})));
          window.imageFixture('/__images/slow.svg');
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

test('actual token art and avatar show pending fallback, recover changed URLs and keep loaded DOM on refresh', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const requests: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/__images/')) {
      requests.push(url.pathname);
      if (url.pathname.endsWith('slow.svg')) await held;
      return route.fulfill({
        status: url.pathname.endsWith('broken.svg') ? 404 : 200,
        contentType: 'image/svg+xml',
        body: url.pathname.endsWith('broken.svg') ? 'missing' : svg,
      });
    }
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API');
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(origin + '/__image_fixture', { waitUntil: 'domcontentloaded' });
    const art = page.locator('.token-art');
    await art.waitFor();
    assert.equal(await art.getAttribute('data-image-state'), 'loading');
    assert.equal(await art.getAttribute('loading'), 'eager');
    assert.equal(await art.getAttribute('fetchpriority'), 'high');
    assert.match(await art.evaluate((e) => getComputedStyle(e).backgroundImage), /mark\.svg/);
    release();
    await page.waitForFunction(
      () => document.querySelector('.token-art')?.getAttribute('data-image-state') === 'loaded',
    );
    await art.evaluate((e) => ((window as any).savedArtwork = e));
    const before = requests.length;
    await page.evaluate(() => (window as any).imageFixture('/__images/slow.svg'));
    assert.equal(await art.evaluate((e) => e === (window as any).savedArtwork), true);
    assert.equal(requests.length, before, 'unchanged refresh must not request images again');
    await page.evaluate(() => (window as any).imageFixture('/__images/broken.svg'));
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.token-art,.avatar')).every(
        (e) =>
          e.getAttribute('data-image-state') === 'fallback' &&
          (e as HTMLImageElement).naturalWidth > 0,
      ),
    );
    assert.equal(await art.getAttribute('src'), '/assets/brand/mark.svg');
    assert.equal(await art.getAttribute('alt'), 'Fixture artwork unavailable');
    await page.evaluate(() => (window as any).imageFixture('/__images/recovered.svg'));
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.token-art,.avatar')).every(
        (e) => e.getAttribute('data-image-state') === 'loaded',
      ),
    );
    assert.equal(await art.getAttribute('src'), '/__images/recovered.svg');
    await page.evaluate(() => (window as any).imageFixture('javascript:alert(1)'));
    assert.equal(await art.getAttribute('src'), '/assets/brand/mark.svg');
  } finally {
    release();
    await context.close();
  }
});

// Backend held-provider behavior is separately exercised by the actual HTTP market test.
// This fixture checks browser paint/fetch scheduling and subsequent full-catalog updates.
test('warming metadata starts bounded image loads before market readiness; refresh preserves images and all257 values', async () => {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
  });
  const imageRequests = new Map<string, number>();
  let marketReady = false;
  let writes = 0;
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== 'GET') {
      writes++;
      return route.abort();
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/config')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          privyAppId: null,
          launchesEnabled: false,
          chain: 'solana:mainnet',
          providers: { twitch: false, kick: false },
        }),
      });
    if (url.pathname === '/api/catalog')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(catalog(marketReady)),
      });
    if (url.pathname.startsWith('/__images/')) {
      imageRequests.set(url.pathname, (imageRequests.get(url.pathname) ?? 0) + 1);
      return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    }
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API ' + url.pathname);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(origin + '/__image_explore', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('#all-tokens .token-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 24);
    assert.equal(await cards.locator('.token-art-link>img[loading=eager]').count(), 4);
    assert.equal(await cards.locator('.token-art-link>img[loading=lazy]').count(), 20);
    assert.match(
      (await cards
        .first()
        .locator('.token-card-figures>span')
        .first()
        .getAttribute('aria-label')) ?? '',
      /Market data is loading/,
    );
    assert.equal(marketReady, false);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.token-art-link>img')).some(
        (e) => (e as HTMLImageElement).naturalWidth > 0,
      ),
    );
    assert.ok(
      imageRequests.size > 0 && imageRequests.size <= 28,
      '24 grid art plus four separate spotlight art maximum',
    );
    assert.ok((await cards.locator('.token-card-figures strong').allTextContents()).includes('—'));
    await page.evaluate(() => {
      (window as any).savedImages = new Map(
        Array.from(document.querySelectorAll('.token-art-link')).map((e) => [
          e.getAttribute('href'),
          e.querySelector('img'),
        ]),
      );
    });
    // Unchanged metadata must retain loaded artwork even across bursts.
    await page.evaluate(() =>
      Promise.all(Array.from({ length: 12 }, () => (window as any).refreshFixture())),
    );
    assert.equal(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('.token-art-link')).every(
          (e) => (window as any).savedImages.get(e.getAttribute('href')) === e.querySelector('img'),
        ),
      ),
      true,
    );
    marketReady = true;
    // Real PublicServices poller follows the server's 1s warming retry hint.
    await page.waitForFunction(() =>
      (window as any).catalogFixture().every((t: any) => t.marketDataStatus === 'fresh'),
    );
    const actual = await page.evaluate(() =>
      (window as any)
        .catalogFixture()
        .map((t: any) => ({ id: t.id, mcap: t.mcap, volume: t.volume, change: t.change })),
    );
    assert.equal(actual.length, 257);
    assert.deepEqual(
      actual,
      tokens.map((t, i) => ({ id: t.id, mcap: (i + 1) * 100, volume: i + 1, change: i % 10 })),
    );
    assert.equal(await cards.count(), 24);
    assert.equal(writes, 0);
    assert.ok(
      [...imageRequests.values()].every((n) => n === 1),
      'cached unchanged images must not refetch during catalog polling',
    );
  } finally {
    await context.close();
  }
});

test('source normalization allows derivatives and validated IPFS paths without unsafe protocols or credentials', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.origin);
      return route.abort();
    }
    if (url.pathname.startsWith('/__images/'))
      return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    return route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(origin + '/__image_fixture');
    const cid = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const inputs = [
      '/api/token-images/' + 'a'.repeat(64),
      'https://gateway.pinata.cloud/ipfs/' + cid,
      `ipfs://${cid}/folder/art%20work.png`,
      `ipfs://ipfs/${cid}/art.png`,
      `ipfs://${cid}/../private`,
      `ipfs://${cid}/%2e%2e/private`,
      `ipfs://${cid}/a%2fb`,
      `ipfs://${cid}/broken%`,
      'ipfs://not-a-cid/image.png',
      'https://username:password@example.test/image.png',
      'javascript:alert(1)',
      'data:image/svg+xml,not-supported',
      '//example.test/image.png',
      '/\\example.test/image.png',
      'http://example.test/image.png',
      '',
    ];
    const outputs = await page.evaluate(
      (values) => values.map((s) => (window as any).normalizeImage(s)),
      inputs,
    );
    assert.deepEqual(outputs.slice(0, 4), [
      inputs[0],
      inputs[1],
      `https://gateway.pinata.cloud/ipfs/${cid}/folder/art%20work.png`,
      `https://gateway.pinata.cloud/ipfs/${cid}/art.png`,
    ]);
    assert.ok(outputs.slice(4).every((s: string) => s === '/assets/brand/mark.svg'));
    assert.deepEqual(external, [], 'normalizing sources must not perform gateway fetches');
  } finally {
    await context.close();
  }
});

test('an empty new-token chart retries after15s then returns to normal polling once indexed', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let calls = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/tokens/token-fixture/chart') {
      calls++;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          tokenId: 'token-fixture',
          mint: 'mint-fixture',
          range: '24h',
          currency: 'USD',
          provider: 'GeckoTerminal',
          status: calls === 1 ? 'empty' : 'ready',
          updatedAt: '2026-09-16T12:00:00Z',
          poolAddress: 'pool-fixture',
          sourceUrl: 'https://www.geckoterminal.com/solana/pools/pool-fixture',
          candles:
            calls === 1
              ? []
              : [{ time: 1789559940, open: 1, high: 2, low: 1, close: 2, volume: 10 }],
        }),
      });
    }
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected chart fixture API');
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.clock.install();
    await page.goto(origin + '/__chart_loading');
    await page.getByText('No indexed price history yet', { exact: true }).waitFor();
    assert.equal(calls, 1);
    await page.clock.fastForward(16_000);
    await page.locator('.tpc-price-row strong').filter({ hasText: '$2' }).waitFor();
    assert.equal(calls, 2);
    await page.clock.fastForward(30_000);
    assert.equal(calls, 2, 'ready charts should retain the normal60s poll cadence');
    const refreshed = page.waitForResponse((r) =>
      r.url().includes('/api/tokens/token-fixture/chart'),
    );
    await page.clock.fastForward(31_000);
    await refreshed;
    assert.equal(calls, 3);
  } finally {
    await context.close();
  }
});
