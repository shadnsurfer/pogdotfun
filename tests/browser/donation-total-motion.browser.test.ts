/** Real homepage and catalog refresh; synthetic read-only API, with normal motion enabled. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer, browser: Browser, origin: string;

before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-donation-total-motion-browser',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'donation-total-motion-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__donation_total', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__donation_total',
                `<!doctype html><div id="root"></div><script type="module">
                  import React from 'react'; import {createRoot} from 'react-dom/client';
                  import {MemoryRouter} from 'react-router-dom';
                  import {HomePage} from '/src/pages/Discover.tsx';
                  import * as data from '/src/data.ts';
                  import '/src/styles.css'; import '/src/pog-interface.css';
                  window.refreshDonationTotal=()=>data.refreshCatalog({force:true});
                  createRoot(document.getElementById('root')).render(
                    React.createElement(MemoryRouter,{},React.createElement(HomePage)));
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

// Text content contains every reel digit; inspect the glyph inside each clipping window instead.
// Keep this raw script free of transpiler helpers when it is evaluated in the page.
const visibleAmount = `() => {
  const amount = document.querySelector('.preview-stats .rolling-amount');
  if (!amount) return null;
  let value = '';
  for (const character of amount.children) {
    if (!character.classList.contains('rolling-digit')) {
      value += character.textContent;
      continue;
    }
    const clip = character.getBoundingClientRect();
    let digit = '?';
    for (const candidate of character.querySelectorAll(':scope > span > span')) {
      const box = candidate.getBoundingClientRect();
      if (Math.abs(box.top - clip.top) < 0.5 && Math.abs(box.bottom - clip.bottom) < 0.5) {
        digit = candidate.textContent;
        break;
      }
    }
    value += digit;
  }
  return value;
}`;

async function expectAmount(page: Page, expected: string) {
  await page.getByRole('img', { name: expected, exact: true }).waitFor();
  try {
    await page.waitForFunction(`(${visibleAmount})() === ${JSON.stringify(expected)}`, undefined, {
      timeout: 4000,
    });
  } catch {
    assert.equal(await page.evaluate(`(${visibleAmount})()`), expected, 'visible donation digits');
  }
  assert.equal(await page.evaluate(`(${visibleAmount})()`), expected);
}

test('homepage donation digits update from zero and between equal-width amounts with normal motion', async () => {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: 'no-preference',
    viewport: { width: 1440, height: 1000 },
  });
  let donatedUsdCents = 0;
  const errors: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.origin !== origin) return route.abort();
    if (url.pathname === '/api/catalog')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          tokens: [],
          streamers: [],
          activity: [],
          stats: {
            totalDonatedUsdCents: 0,
            totalClaimedUsdCents: 100000,
            streamerAllocatedUsdCents: 80000,
            buybackAllocatedUsdCents: 20000,
            streamerPendingUsdCents: 80000,
            heldUsdCents: 100000,
            tokenCount: 0,
            streamerCount: 0,
          },
          donationSummary: {
            totalGiftSpendingUsdCents: donatedUsdCents,
            creatorFeeGiftSpendingUsdCents: 0,
            manualGiftSpendingUsdCents: donatedUsdCents,
            completedGiftCount: donatedUsdCents ? 1 : 0,
            manualGiftCount: donatedUsdCents ? 1 : 0,
          },
        }),
      });
    if (url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.goto(origin + '/__donation_total', { waitUntil: 'domcontentloaded' });
    await page.locator('.preview-stats').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.preview-motion-toggle').isEnabled(), true);
    await expectAmount(page, '$0.00');
    assert.equal(await page.locator('.preview-stats .rolling-digit').count(), 3);

    donatedUsdCents = 2381;
    await page.evaluate(() => (window as any).refreshDonationTotal());
    await expectAmount(page, '$23.81');
    assert.match(
      (await page.locator('.preview-stats').getAttribute('aria-label')) ?? '',
      /\$23\.81 in confirmed gifts/,
    );

    donatedUsdCents = 4602;
    await page.evaluate(() => (window as any).refreshDonationTotal());
    await expectAmount(page, '$46.02');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
