import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { DonationSummary } from '../src/data.ts';

let vite: ViteDevServer;
let page: typeof import('../src/pages/Discover.tsx');
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
        name: 'home-donation-test-router',
        resolveId(id) {
          if (id === 'virtual:home-donation-router') return '\0home-donation-router';
        },
        load(id) {
          if (id === '\0home-donation-router')
            return 'export { MemoryRouter } from "react-router-dom";';
        },
      },
    ],
  });
  page = (await vite.ssrLoadModule('/src/pages/Discover.tsx')) as typeof page;
  data = (await vite.ssrLoadModule('/src/data.ts')) as typeof data;
  ({ MemoryRouter } = await vite.ssrLoadModule('virtual:home-donation-router'));
});

after(async () => {
  await vite?.close();
});

async function homeWithEmptyRecentFeed(
  creatorGiftSpendingUsdCents: number,
  donationSummary?: DonationSummary,
) {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        tokens: [],
        streamers: [],
        activity: [],
        stats: {
          totalDonatedUsdCents: creatorGiftSpendingUsdCents,
          totalClaimedUsdCents: creatorGiftSpendingUsdCents,
          streamerAllocatedUsdCents: creatorGiftSpendingUsdCents,
          buybackAllocatedUsdCents: 0,
          streamerPendingUsdCents: 0,
          tokenCount: 0,
          streamerCount: 0,
        },
        donationSummary,
      });
    await data.refreshCatalog();
    assert.equal(data.totalDonations, creatorGiftSpendingUsdCents / 100);
    assert.equal(data.donationSummary?.completedGiftCount, donationSummary?.completedGiftCount);
    assert.equal(data.payments.length, 0);
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, {}, createElement(page.HomePage)),
    );
    return html.slice(html.indexOf('<section class="home-recent">'));
  } finally {
    globalThis.fetch = previous;
  }
}

function assertConfirmedHistory(html: string) {
  assert.match(html, /Confirmed gifts are available/);
  assert.match(html, /href="\/donations"[^>]*>View confirmed gifts<\/a>/);
  assert.doesNotMatch(html, /Completed donations will appear here/);
}

test('an empty recent activity window links to lifetime creator gifts from older catalogs', async () => {
  assertConfirmedHistory(await homeWithEmptyRecentFeed(4751));
});

test('receipt-verified manual gifts are discoverable when the recent creator-fee feed is empty', async () => {
  assertConfirmedHistory(
    await homeWithEmptyRecentFeed(0, {
      totalGiftSpendingUsdCents: 11883,
      creatorFeeGiftSpendingUsdCents: 0,
      manualGiftSpendingUsdCents: 11883,
      completedGiftCount: 3,
      manualGiftCount: 3,
    }),
  );
});

test('a completed gift count keeps history discoverable without a positive displayed total', async () => {
  assertConfirmedHistory(
    await homeWithEmptyRecentFeed(0, {
      totalGiftSpendingUsdCents: 0,
      creatorFeeGiftSpendingUsdCents: 0,
      manualGiftSpendingUsdCents: 0,
      completedGiftCount: 1,
      manualGiftCount: 0,
    }),
  );
});

test('a catalog with no confirmed gifts retains the first-donation prompt', async () => {
  const html = await homeWithEmptyRecentFeed(0, {
    totalGiftSpendingUsdCents: 0,
    creatorFeeGiftSpendingUsdCents: 0,
    manualGiftSpendingUsdCents: 0,
    completedGiftCount: 0,
    manualGiftCount: 0,
  });
  assert.match(html, /Completed donations will appear here with their receipts\./);
  assert.doesNotMatch(html, /Confirmed gifts are available|View confirmed gifts/);
});
