/** Real UI, isolated Chromium and synthetic APIs. No on-chain verification or financial execution. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
let server: ViteDevServer, browser: Browser, origin: string;
const mint = 'So11111111111111111111111111111111111111112',
  creator = '11111111111111111111111111111111';
const platform = {
  id: 'platform-pog',
  name: 'Pog',
  symbol: 'POG',
  address: mint,
  creatorAddress: creator,
  chain: 'solana',
  launchpad: 'pump',
  verifiedAt: '2026-09-16T12:00:00Z',
  feeCollectionRegistered: false,
  buybackBps: null,
  claimedUsdCents: 1200,
  claimCount: 2,
  claimGasUsdCents: 5,
  buybackAllocatedUsdCents: 240,
  platformReserveUsdCents: 960,
  lastClaimAt: null,
  buybackSpentUsdCents: 200,
  buybackCount: 1,
  burnCount: 1,
  burnedTokenBaseUnits: '1234567',
  burnedTokenDecimals: 6,
  lastExecutionAt: null,
  mcap: 12340,
  volume: 400,
  change: 1.4,
  priceUsd: 0.00001234,
  marketDataStatus: 'fresh',
  marketDataUpdatedAt: '2026-09-16T12:00:00Z',
};
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-platform-browser',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'platform-fixture',
        configureServer(vite) {
          vite.middlewares.use('/__platform', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__platform',
                `<!doctype html><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {AdminTreasury} from '/src/pages/AdminTreasury.tsx';import {DonationsPage} from '/src/pages/Transparency.tsx';import * as data from '/src/data.ts';import '/src/styles.css';import '/src/pages/admin.css';import '/src/pog-interface.css';
 const request=async(path,method='GET',body,signal)=>{const r=await fetch('/api/admin/'+path,{method,body:body?JSON.stringify(body):undefined,headers:body?{'content-type':'application/json'}:undefined,signal});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;};
 window.refreshFixture=()=>data.refreshCatalog({force:true});window.tokenCount=()=>data.tokens.length;
 const admin=new URLSearchParams(location.search).has('admin');createRoot(document.getElementById('root')).render(admin?React.createElement('div',{className:'page ops-page'},React.createElement(AdminTreasury,{request})):React.createElement(MemoryRouter,{initialEntries:['/donations?view=treasury']},React.createElement(DonationsPage)));if(!admin)data.refreshCatalog();
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

test('admin tracks only two public addresses, distinguishes readiness, and stale forced submit cannot POST', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  let tracked = false,
    fail = false;
  const posts: unknown[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/admin/treasury')
      return route.fulfill({
        status: fail ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          fail
            ? { error: 'Fixture treasury unavailable' }
            : {
                enabled: false,
                automatic: false,
                configured: false,
                transactionsEnabled: false,
                platform: {
                  identity: tracked
                    ? {
                        id: 'tracked-identity',
                        mint,
                        creatorAddress: creator,
                        verifiedAt: '2026-09-16T12:00:00Z',
                        registered: false,
                      }
                    : null,
                  feeCollectionRegistered: false,
                  missingSetup: tracked
                    ? ['platform_fee_policy', 'fee_collection_registration']
                    : [
                        'platform_identity',
                        'mainnet_rpc',
                        'platform_fee_policy',
                        'fee_collection_registration',
                      ],
                  signerReady: null,
                },
              },
        ),
      });
    if (
      url.pathname === '/api/admin/treasury/platform/track' &&
      route.request().method() === 'POST'
    ) {
      posts.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 100));
      tracked = true;
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          identity: {
            id: 'tracked-identity',
            mint,
            creatorAddress: creator,
            verifiedAt: '2026-09-16T12:00:00Z',
            registered: false,
          },
        }),
      });
    }
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected operation ' + url.pathname);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(origin + '/__platform?admin');
    await page.getByText('Treasury source: current', { exact: false }).waitFor();
    assert.match(
      await page.locator('body').innerText(),
      /Tracking does not enable fee claims or buybacks/,
    );
    assert.equal(await page.getByText('Not checked', { exact: true }).count(), 1);
    await page.getByLabel('Official token mint', { exact: true }).fill('invalid-mint');
    await page.getByLabel('Actual Pump creator fee wallet', { exact: true }).fill(creator);
    await page.getByRole('button', { name: 'Verify & track token' }).click();
    await page.getByRole('alert').filter({ hasText: 'two public Solana addresses' }).waitFor();
    assert.equal(posts.length, 0);
    await page.getByLabel('Official token mint', { exact: true }).fill(mint);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: '/tmp/pog-platform-admin-tracking-390.png',
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    fail = true;
    await page.getByRole('button', { name: 'Refresh treasury status' }).click();
    await page.getByRole('alert').first().waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Verify & track token' }).isDisabled(),
      true,
    );
    await page
      .locator('form')
      .evaluate((e) => e.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(posts.length, 0);
    fail = false;
    await page.getByRole('button', { name: 'Refresh treasury status' }).click();
    await page.waitForFunction(
      () => !(document.querySelector('fieldset') as HTMLFieldSetElement).disabled,
    );
    await page.locator('form').evaluate((e) => {
      e.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      e.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.getByRole('heading', { name: /Verified identity/ }).waitFor();
    assert.deepEqual(posts, [{ mint, creatorAddress: creator }]);
    assert.equal(await page.locator('form').count(), 0);
    assert.equal(
      await page.getByRole('link', { name: new RegExp(mint) }).getAttribute('href'),
      'https://solscan.io/token/' + mint,
    );
    await page.screenshot({
      path: '/tmp/pog-platform-admin-verified-390.png',
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(await page.getByText('Not registered', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Not checked', { exact: true }).count(), 1);
  } finally {
    await context.close();
  }
});

for (const width of [1440, 320])
  test(`public treasury at ${width}px separates official creator fees and precise token price from aggregate reserves`, async () => {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
      viewport: { width, height: 900 },
    });
    let tracked = false;
    let writes = 0;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') {
        writes++;
        return route.abort();
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/catalog')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            platformToken: tracked
              ? { ...platform, feeCollectionRegistered: width === 1440 }
              : null,
            tokens: [],
            streamers: [],
            activity: [],
            stats: {
              totalDonatedUsdCents: 0,
              totalClaimedUsdCents: 6000,
              streamerAllocatedUsdCents: 4000,
              buybackAllocatedUsdCents: 2000,
              streamerPendingUsdCents: 1000,
              tokenCount: 0,
              streamerCount: 0,
              buybackReserveUsdCents: 1800,
            },
          }),
        });
      if (url.pathname === '/api/tokens/platform-pog/chart')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            tokenId: 'platform-pog',
            mint,
            range: url.searchParams.get('range'),
            currency: 'USD',
            provider: 'GeckoTerminal',
            status: 'empty',
            updatedAt: null,
            poolAddress: null,
            sourceUrl: null,
            candles: [],
          }),
        });
      if (url.pathname === '/api/donations')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ donations: [], receipts: [] }),
        });
      if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API ' + url.pathname);
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(origin + '/__platform');
      await page.getByText(/The official token is not tracked yet/).waitFor();
      assert.equal(await page.getByText('$0.00001234', { exact: true }).count(), 0);
      tracked = true;
      await page.evaluate(() => (window as any).refreshFixture());
      await page.getByRole('heading', { name: 'Pog · $POG' }).waitFor();
      assert.equal(
        await page
          .getByRole('group', { name: 'Official token market data' })
          .getByText('$0.00001234', { exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .locator('.platform-treasury .tv-treasury-metrics>div')
          .filter({ hasText: 'Fees claimed' })
          .locator('strong')
          .innerText(),
        '$12',
      );
      assert.equal(
        await page
          .locator('.tv-treasury-metrics>div')
          .filter({ hasText: 'All creator fees claimed' })
          .locator('strong')
          .innerText(),
        '$60',
      );
      assert.match(await page.locator('.platform-treasury').innerText(), /all funding sources/);
      assert.match(await page.locator('.platform-treasury').innerText(), /1.234567/);
      assert.equal(await page.evaluate(() => (window as any).tokenCount()), 0);
      assert.match(
        await page.locator('.platform-treasury').innerText(),
        width === 1440
          ? /Creator fee collection is registered/
          : /Creator fee collection is not connected yet/,
      );
      assert.equal(writes, 0);
      await page.screenshot({
        path: `/tmp/pog-platform-treasury-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await context.close();
    }
  });

test('tracking timeout stays uncertain and never repeats the POST automatically', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let posts = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/admin/treasury')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: false,
          automatic: false,
          configured: false,
          transactionsEnabled: false,
          platform: {
            identity: null,
            feeCollectionRegistered: false,
            missingSetup: ['platform_identity'],
            signerReady: null,
          },
        }),
      });
    if (url.pathname === '/api/admin/treasury/platform/track') {
      posts++;
      await held;
      await route
        .fulfill({ status: 504, contentType: 'application/json', body: '{"error":"timeout"}' })
        .catch(() => {});
      return;
    }
    if (url.pathname.startsWith('/api/')) throw new Error('Unexpected API');
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.clock.install();
    await page.goto(origin + '/__platform?admin');
    await page.getByText('Treasury source: current', { exact: false }).waitFor();
    await page.getByLabel('Official token mint', { exact: true }).fill(mint);
    await page.getByLabel('Actual Pump creator fee wallet', { exact: true }).fill(creator);
    const sent = page.waitForRequest('**/api/admin/treasury/platform/track');
    await page.getByRole('button', { name: 'Verify & track token' }).click();
    await sent;
    await page.clock.runFor(20_001);
    await page
      .getByRole('alert')
      .filter({ hasText: 'Tracking verification timed out' })
      .first()
      .waitFor();
    assert.equal(posts, 1);
    await page.clock.runFor(30_000);
    assert.equal(posts, 1, 'polling must only read status, never retry tracking');
    assert.equal(await page.getByRole('heading', { name: /Verified identity/ }).count(), 0);
  } finally {
    release();
    await context.close();
  }
});
