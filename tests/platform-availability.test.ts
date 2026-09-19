import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { Session } from '../src/auth.tsx';

let vite: ViteDevServer;
let launch: typeof import('../src/pages/Launch.tsx');
let discover: typeof import('../src/pages/Discover.tsx');
let transparency: typeof import('../src/pages/Transparency.tsx');
let details: typeof import('../src/pages/Details.tsx');
let auth: typeof import('../src/auth.tsx');
let app: typeof import('../src/App.tsx');
let router: Pick<typeof import('react-router-dom'), 'MemoryRouter' | 'Routes' | 'Route'>;
const session: Session = {
  // This fixture has profile lookups configured for both supported platforms.
  config: {
    privyAppId: null,
    launchesEnabled: true,
    chain: 'solana:mainnet',
    providers: { twitch: true, kick: true },
  },
  ready: true,
  authenticated: true,
  userId: 'fixture-user',
  generation: 0,
  wallets: [],
  login() {},
  connectWallet() {},
  async logout() {},
  async request() {
    throw new Error('No network requests are allowed in this render test.');
  },
  async sign() {
    throw new Error('No signing is allowed in this render test.');
  },
  error: '',
};

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
        name: 'platform-test-router',
        resolveId(id) {
          if (id === 'virtual:platform-test-router') return '\0platform-test-router';
        },
        load(id) {
          if (id === '\0platform-test-router')
            return 'export { MemoryRouter, Routes, Route } from "react-router-dom";';
        },
      },
    ],
  });
  launch = (await vite.ssrLoadModule('/src/pages/Launch.tsx')) as typeof launch;
  discover = (await vite.ssrLoadModule('/src/pages/Discover.tsx')) as typeof discover;
  transparency = (await vite.ssrLoadModule('/src/pages/Transparency.tsx')) as typeof transparency;
  details = (await vite.ssrLoadModule('/src/pages/Details.tsx')) as typeof details;
  auth = (await vite.ssrLoadModule('/src/auth.tsx')) as typeof auth;
  app = (await vite.ssrLoadModule('/src/App.tsx')) as typeof app;
  router = (await vite.ssrLoadModule('virtual:platform-test-router')) as typeof router;
  const data = (await vite.ssrLoadModule('/src/data.ts')) as typeof import('../src/data.ts');
  // Isolated in-memory history, never loaded into the running site.
  data.streamers.push(
    ...(['kick', 'twitch'] as const).map((platform) => ({
      id: `${platform}:fixture`,
      platform,
      name: `${platform} fixture`,
      handle: `${platform}_fixture`,
      image: '/assets/brand/mark.svg',
      color: '#9146ff',
      category: 'Fixture',
      bio: 'Historical fixture',
      donatedUsdCents: 1234,
    })),
  );
});
after(async () => {
  await vite?.close();
});

function render(Page: ComponentType, route = '/', path = '*') {
  return renderToStaticMarkup(
    createElement(
      router.MemoryRouter,
      { initialEntries: [route] },
      createElement(
        auth.SessionContext.Provider,
        { value: session },
        createElement(
          router.Routes,
          {},
          createElement(router.Route, { path, element: createElement(Page) }),
        ),
      ),
    ),
  );
}

test('launch selects the requested Kick recipient while both configured platforms remain selectable', () => {
  const html = render(launch.LaunchPage, '/launch?platform=kick');
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  const kick = buttons.find((button) => button.includes('alt="kick"'));
  const twitch = buttons.find((button) => button.includes('alt="twitch"'));
  assert.ok(kick);
  assert.ok(twitch);
  assert.match(kick, /aria-pressed="true"/);
  assert.doesNotMatch(kick, /disabled=|Coming soon/);
  assert.match(twitch, /aria-pressed="false"/);
  assert.doesNotMatch(twitch, /disabled=/);
  assert.doesNotMatch(html, /Kick is coming soon|Twitch is selected/);
});

test('EVM launch controls remain gated until the public launch path is configured', () => {
  const html = render(launch.LaunchPage, '/launch?launchpad=pons');
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  for (const brand of ['PONs', 'Flap']) {
    const button = buttons.find((value) => value.includes(`alt="${brand}"`));
    assert.ok(button);
    assert.match(button, /disabled=""/);
    assert.match(button, /Coming soon/);
  }
  const pump = buttons.find((value) => value.includes('alt="Pump.fun"'));
  assert.ok(pump);
  assert.doesNotMatch(pump, /disabled=/);
  assert.match(pump, /aria-pressed="true"/);
});

test('homepage presents both streamer platforms and keeps profile navigation', () => {
  const html = render(discover.HomePage);
  assert.match(html, /alt="kick"/);
  assert.doesNotMatch(html, /Kick <small>Coming soon/);
  assert.match(html, /href="\/launch"/);
  assert.match(html, /href="\/docs"/);
  assert.match(html, /href="\/streamer\/kick:fixture"/);
});

test('capital flow describes live status and independent card reconciliation for both platforms', () => {
  const html = render(transparency.FlowPage);
  assert.match(html, /Twitch or Kick live status/);
  assert.match(html, /independent credit-card capacity/);
  assert.match(html, /posted card charge and streamer receipt/);
  assert.match(html, /Before conversion, native creator fees split 80%/);
  assert.doesNotMatch(html, /20% remains in platform/);
});

test('navigation links exactly the three supported social accounts', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'pog.fun' } },
  });
  try {
    const html = render(app.default);
    const navigation = html.match(/<div class="social-links">[\s\S]*?<\/div>/)?.[0];
    assert.ok(navigation);
    const links = [...navigation.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(links, [
      'https://x.com/pogdotfun',
      'https://twitch.tv/pogdotfun',
      'https://kick.com/pogdotfun',
    ]);
    assert.doesNotMatch(navigation, /Coming soon/);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Kick profile keeps its channel link and explains browser and card evidence requirements', () => {
  const html = render(details.StreamerPage, '/streamer/kick:fixture', '/streamer/:id');
  assert.match(html, /href="https:\/\/kick\.com\/kick_fixture"/);
  assert.match(html, /configured browser and card evidence/);
  assert.doesNotMatch(html, /Coming soon/);
  assert.match(html, /\$12/);
});

test('autonomous donation payloads require exact public evidence fields and accept unknown historical dates', () => {
  const valid = {
    id: 'fee-1',
    tokenId: 'token-1',
    platform: 'kick',
    username: 'alice',
    chain: 'bnb',
    spentUsdCents: 1234,
    receiptReference: 'receipt-1',
    completedAt: null,
  };
  assert.equal(transparency.isAutonomousDonation(valid), true);
  for (const patch of [
    { chain: 'unknown' },
    { platform: 'unknown' },
    { spentUsdCents: 1.1 },
    { spentUsdCents: -1 },
    { receiptReference: '' },
    { completedAt: 'invalid' },
  ])
    assert.equal(transparency.isAutonomousDonation({ ...valid, ...patch }), false);
  assert.throws(() => transparency.parseAutonomousDonations([valid, valid]));
  assert.throws(() =>
    transparency.parseAutonomousDonations([
      { ...valid, spentUsdCents: Number.MAX_SAFE_INTEGER },
      { ...valid, id: 'fee-2', receiptReference: 'receipt-2' },
    ]),
  );
});

test('confirmed autonomous gifts display their real chain and receipt without fabricating links or dates', () => {
  const donations = [
    {
      id: 'fee-1',
      tokenId: 'token-1',
      platform: 'kick' as const,
      username: 'alice',
      chain: 'bnb' as const,
      spentUsdCents: 1234,
      receiptReference: 'receipt-one',
      completedAt: null,
    },
    {
      id: 'fee-2',
      tokenId: 'token-2',
      platform: 'twitch' as const,
      username: 'bravo',
      chain: 'solana' as const,
      spentUsdCents: 2000,
      receiptReference: 'receipt-two',
      completedAt: '2026-09-18T12:03:00Z',
    },
  ];
  const html = render(() => createElement(transparency.SentDonationList, { donations }));
  assert.match(html, /\$32\.34/);
  assert.match(html, /@alice/);
  assert.match(html, /BNB Chain/);
  assert.match(html, /Solana/);
  assert.match(html, /receipt-one/);
  assert.match(html, /Completion time unavailable/);
  assert.match(html, /dateTime="2026-09-18T12:03:00Z"/i);
  assert.doesNotMatch(
    html,
    /Invalid Date|1970|solscan|etherscan|bscscan|Card settlement pending|Original checkout/,
  );
  assert.ok(html.indexOf('receipt-two') < html.indexOf('receipt-one'));
});

test('official POG shows exact Solana native amounts without invented USD prices', async () => {
  const { PlatformTreasury } = await vite.ssrLoadModule('/src/PlatformTreasury.tsx');
  const token = {
    id: 'platform-pog',
    name: 'Pog',
    symbol: 'POG',
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    devWallet: 'AHshYUULwYdZjYTkrNmgqRUXCfnzdKZZZNgByJqxJGjY',
    tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    tokenDecimals: 9,
    verifiedAt: '2026-09-18T12:00:00Z',
    solSpentLamports: '1234567890',
    targetFeesSpentLamports: '1000000',
    burnedTokenBaseUnits: '1000000001',
    buybackCount: 1,
    burnCount: 1,
    lastExecutionAt: null,
  };
  const html = renderToStaticMarkup(createElement(PlatformTreasury, { token }));
  assert.match(html, /Solana/);
  assert.match(html, /1.23456789 SOL/);
  assert.match(html, /1.000000001/);
  assert.match(html, /Dev wallet/);
  assert.match(html, /solscan/);
  assert.doesNotMatch(html, /Market cap|TokenPriceChart/);
  const unconfigured = renderToStaticMarkup(createElement(PlatformTreasury, { token: null }));
  assert.match(unconfigured, /mint has not been verified/);
  assert.doesNotMatch(unconfigured, /Verified mint/);
});
