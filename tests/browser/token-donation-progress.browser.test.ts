/** Public UI with synthetic APIs: this does not execute claims, funding, or gifts. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Locator } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer, browser: Browser, origin: string;
const at = '2026-09-16T20:00:00Z';
const speedId = 'da3a070a-f323-47a9-bbd4-228438ae90be';
const broccoliId = '68ee5f0a-ce96-4e7f-8017-9e18e3ad858c';

function catalog(delivered = false, missingMetrics = false) {
  const common = {
    image: '',
    color: '#9876ff',
    launchpad: 'pump',
    mcap: 12000,
    volume: 300,
    change: 1,
    created: Date.parse(at),
    description: '',
    claimCount: 1,
    donatedUsdCents: 0,
    completedPaymentCount: 0,
  };
  const tokens = [
    {
      ...common,
      id: broccoliId,
      name: 'broccoli head',
      symbol: 'BROC',
      address: 'H5vAZvMNACATqhXXCfsNPp2ghhLHuniFmTFLfJiwX6JK',
      streamerId: 'twitch:844609866',
      claimedUsdCents: 5511,
      streamerAllocatedUsdCents: 4409,
      pendingUsdCents: 4409,
      payoutStatus: 'awaiting_threshold',
    },
    {
      ...common,
      id: speedId,
      name: 'ISHOWSPEED',
      symbol: 'SPEED',
      address: '8bFvxaMqvf3kxNtuZwgiD4Sw8iqj6SWGonn3wvRwLMgY',
      streamerId: 'twitch:220476955',
      claimedUsdCents: 19044,
      streamerAllocatedUsdCents: 15237,
      pendingUsdCents: delivered ? 5237 : 15237,
      donatedUsdCents: delivered ? 10000 : 0,
      completedPaymentCount: delivered ? 1 : 0,
      payoutStatus: 'accumulating',
    },
    {
      ...common,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'New launch',
      symbol: 'NEW',
      address: 'So11111111111111111111111111111111111111112',
      streamerId: 'twitch:220476955',
      claimCount: 0,
      claimedUsdCents: 0,
      streamerAllocatedUsdCents: 0,
      pendingUsdCents: 0,
      payoutStatus: 'awaiting_fees',
    },
  ];
  if (missingMetrics) {
    delete (tokens[0] as Partial<(typeof tokens)[number]>).streamerAllocatedUsdCents;
    delete (tokens[0] as Partial<(typeof tokens)[number]>).pendingUsdCents;
    delete (tokens[0] as Partial<(typeof tokens)[number]>).donatedUsdCents;
  }
  return {
    tokens,
    streamers: [
      {
        id: 'twitch:220476955',
        name: 'IShowSpeed',
        handle: 'ishowspeed',
        platform: 'twitch',
        tokenCount: 2,
      },
      {
        id: 'twitch:844609866',
        name: 'ThreadGuy',
        handle: 'threadguy',
        platform: 'twitch',
        tokenCount: 1,
      },
    ],
    activity: [],
    stats: {
      totalDonatedUsdCents: delivered ? 10000 : 0,
      totalClaimedUsdCents: 24555,
      streamerAllocatedUsdCents: 19646,
      buybackAllocatedUsdCents: 4909,
      streamerPendingUsdCents: delivered ? 9646 : 19646,
      tokenCount: 3,
      streamerCount: 2,
    },
  };
}

before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-token-progress-browser',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'token-progress-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__progress', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__progress',
                `<!doctype html><div id="root"></div><script type="module">
            import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router-dom';
            import {DonationsPage} from '/src/pages/Transparency.tsx'; import {HomePage} from '/src/pages/Discover.tsx';
            import * as data from '/src/data.ts'; import '/src/styles.css'; import '/src/pog-interface.css';
            window.refreshFixture=()=>data.refreshCatalog({force:true});
            const home=new URLSearchParams(location.search).has('home');
            createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:[home?'/':'/donations']},React.createElement(home?HomePage:DonationsPage)));
            data.refreshCatalog();
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

async function fixture(options: { home?: boolean; width?: number; missingMetrics?: boolean } = {}) {
  let failed = false,
    delivered = false,
    writes = 0;
  const context = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    viewport: { width: options.width ?? 1440, height: 900 },
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== 'GET') {
      writes++;
      return route.abort();
    }
    if (url.origin !== origin) return route.abort();
    const reply = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/catalog')
      return reply(
        failed ? { error: 'Fixture unavailable' } : catalog(delivered, options.missingMetrics),
        failed ? 503 : 200,
      );
    if (url.pathname === '/api/donations')
      return reply({
        donations: delivered
          ? [
              {
                id: 'confirmed-fixture-gift',
                tokenId: speedId,
                tokenName: 'ISHOWSPEED',
                tokenSymbol: 'SPEED',
                recipientPlatform: 'twitch',
                recipientUsername: 'ishowspeed',
                spentUsdCents: 10000,
                completedAt: at,
                kind: 'gifted_subs',
                giftUnits: 20,
                fundingTransactionUrl: 'https://solscan.io/tx/synthetic-funding',
                confirmationUrl: 'https://example.org/synthetic-gift-receipt',
              },
            ]
          : [],
        receipts: [],
      });
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API: ' + url.pathname);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.clock.install();
  await page.goto(origin + '/__progress' + (options.home ? '?home' : ''));
  const progress = page.getByRole('region', { name: 'Token donation progress', exact: true });
  await progress.getByRole('article').first().waitFor();
  return {
    page,
    progress,
    context,
    fail: () => {
      failed = true;
    },
    complete: () => {
      delivered = true;
    },
    writes: () => writes,
  };
}

async function metricText(card: Locator, label: string) {
  return card
    .locator('dl > div')
    .filter({ has: card.page().getByText(label, { exact: true }) })
    .locator('dd')
    .innerText();
}

for (const home of [false, true])
  for (const width of [1440, 320]) {
    test(`${home ? 'home' : 'Donations'} at ${width}px shows new token support without claiming gifts were delivered`, async () => {
      const f = await fixture({ home, width });
      try {
        assert.equal(await f.progress.getByRole('article').count(), 2);
        const speed = f.progress.getByRole('article', {
          name: 'ISHOWSPEED donation progress',
          exact: true,
        });
        assert.equal(await metricText(speed, 'Allocated to streamer'), '$152.37');
        assert.equal(await metricText(speed, 'Awaiting gift'), '$152.37');
        assert.equal(await metricText(speed, 'Delivered gifts'), '$0.00');
        assert.equal(
          await speed.getByRole('link', { name: /Visit @ishowspeed/ }).getAttribute('href'),
          'https://www.twitch.tv/ishowspeed',
        );
        assert.equal(
          await speed.getByRole('link', { name: /ISHOWSPEED/ }).getAttribute('href'),
          '/token/' + speedId,
        );
        assert.equal(
          await f.progress.getByRole('article').first().getAttribute('aria-label'),
          'ISHOWSPEED donation progress',
        );
        const broccoli = f.progress.getByRole('article', {
          name: 'broccoli head donation progress',
          exact: true,
        });
        assert.equal(await metricText(broccoli, 'Awaiting gift'), '$44.09');
        assert.match(await broccoli.innerText(), /Below payout threshold/);
        assert.equal(await f.progress.getByText('Gift sent to', { exact: true }).count(), 0);
        if (!home) assert.equal(await f.page.locator('.tv-confirmed-receipt').count(), 0);
        await f.page.screenshot({
          path: `/tmp/pog-token-progress-${home ? 'home' : 'donations'}-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        });
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(f.writes(), 0);
      } finally {
        await f.context.close();
      }
    });
  }

test('progress refreshes after delivery and confirmed gifts appear automatically with their receipts', async () => {
  const f = await fixture();
  try {
    await f.page.getByText('No creator-fee gift receipts to show yet.', { exact: true }).waitFor();
    f.complete();
    await f.page.evaluate(() => (window as any).refreshFixture());
    const speed = f.progress.getByRole('article', {
      name: 'ISHOWSPEED donation progress',
      exact: true,
    });
    assert.equal(await metricText(speed, 'Awaiting gift'), '$52.37');
    assert.equal(await metricText(speed, 'Delivered gifts'), '$100.00');
    await f.page.clock.runFor(15001);
    const gift = f.page.getByRole('article', { name: 'Donation to @ishowspeed', exact: true });
    await gift.waitFor();
    assert.equal(
      await gift.getByRole('link', { name: 'Gift confirmation' }).getAttribute('href'),
      'https://example.org/synthetic-gift-receipt',
    );
    assert.match(await gift.innerText(), /20 units/);
    assert.equal(f.writes(), 0);
  } finally {
    await f.context.close();
  }
});

test('failed refresh preserves known token values and clearly labels them stale', async () => {
  const f = await fixture();
  try {
    f.fail();
    await f.page.evaluate(() => (window as any).refreshFixture());
    await f.progress
      .getByRole('status')
      .filter({ hasText: /last confirmed token donation progress/ })
      .waitFor();
    assert.equal(await f.progress.getByRole('article').count(), 2);
    assert.equal(
      await metricText(
        f.progress.getByRole('article', { name: 'ISHOWSPEED donation progress', exact: true }),
        'Awaiting gift',
      ),
      '$152.37',
    );
  } finally {
    await f.context.close();
  }
});

test('missing financial metrics stay unavailable rather than displaying invented zeroes', async () => {
  const f = await fixture({ missingMetrics: true });
  try {
    const broccoli = f.progress.getByRole('article', {
      name: 'broccoli head donation progress',
      exact: true,
    });
    for (const label of ['Allocated to streamer', 'Awaiting gift', 'Delivered gifts'])
      assert.equal(await metricText(broccoli, label), '—');
  } finally {
    await f.context.close();
  }
});
