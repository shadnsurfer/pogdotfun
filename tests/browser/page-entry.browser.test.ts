/** Actual App/PublicServices/Privy bridge; synthetic wallet boundary and intercepted read-only APIs. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
let server: ViteDevServer, browser: Browser, origin: string;
const sdk = `import React,{useSyncExternalStore} from 'react';
const listeners=new Set();let state={authenticated:false,user:null,wallets:[],failed:false};
const read=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state);
window.setEntryIdentity=address=>{state={authenticated:Boolean(address),user:address?{id:'user-'+address,linkedAccounts:[{type:'wallet',chainType:'solana',address,walletClientType:'phantom'}]}:null,wallets:address?[{address,standardWallet:{name:'Phantom',accounts:[{address}]}}]:[],failed:false};listeners.forEach(fn=>fn());};
window.failEntryRuntime=()=>{state={...state,failed:true};listeners.forEach(fn=>fn());};
export function usePrivy(){const s=read();if(s.failed)throw Error('Synthetic wallet runtime failure');return {...s,ready:true,logout:async()=>{},getAccessToken:async()=>{throw Error('No token access in entry fixture')}};}
export const useWallets=()=>({ready:true,wallets:read().wallets});export const useLogin=()=>({login:()=>{throw Error('No login in entry fixture')}});export const useLinkAccount=()=>({linkWallet:()=>{throw Error('No linking in entry fixture')}});export const useSignTransaction=()=>({signTransaction:()=>{throw Error('No signing in entry fixture')}});
export const PrivyProvider=({children})=>children;export const defaultSolanaRpcsPlugin=()=>({});export const toSolanaWalletConnectors=()=>({});`;

const connector = `let pending;export function initializeMetaMaskSolana(){return pending??=new Promise((resolve,reject)=>{window.finishConnector=resolve;window.failConnector=()=>reject(Error('fixture unavailable'));});}`;
const catalog = {
  tokens: [],
  streamers: [],
  activity: [],
  stats: {
    totalDonatedUsdCents: 0,
    totalClaimedUsdCents: 0,
    streamerAllocatedUsdCents: 0,
    buybackAllocatedUsdCents: 0,
    streamerPendingUsdCents: 0,
    tokenCount: 0,
    streamerCount: 0,
  },
};
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    root: process.cwd(),
    cacheDir: '/tmp/pog-entry-vite',
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { exclude: ['@privy-io/react-auth', '@privy-io/react-auth/solana'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'page-entry-wallet-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@privy-io/react-auth' || id === '@privy-io/react-auth/solana')
            return '\0entry-sdk';
          if (id === './metamask-solana') return '\0entry-connector';
        },
        load(id) {
          if (id === '\0entry-sdk') return sdk;
          if (id === '\0entry-connector') return connector;
        },
        configureServer(vite) {
          vite.middlewares.use('/__page_entry', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/__page_entry',
                `<!doctype html><div id="root"></div><script type="module">
 import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import App from'/src/App.tsx';import{PublicServices,useSession}from'/src/auth.tsx';import'/src/styles.css';import'/src/pog-interface.css';
 function SessionProbe(){const s=useSession();window.entryActions=s;window.entrySession={ready:s.ready,authenticated:s.authenticated,error:s.error,wallets:s.wallets,userId:s.userId,generation:s.generation};return null;}
 createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(MemoryRouter,{initialEntries:[new URLSearchParams(location.search).get('route')||'/']},React.createElement(PublicServices,null,React.createElement(React.Fragment,null,React.createElement(App),React.createElement(SessionProbe))))));
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
async function fixture(reduced = false, route = '/', holdRoute = false) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    viewport: { width: 1440, height: 1000 },
  });
  let configRelease!: () => void, moduleRelease!: () => void, routeRelease!: () => void;
  const configGate = new Promise<void>((r) => (configRelease = r)),
    moduleGate = new Promise<void>((r) => (moduleRelease = r)),
    routeGate = new Promise<void>((r) => (routeRelease = r));
  let moduleRequested = false;
  const errors: string[] = [];
  // A raw script avoids the test transpiler injecting helpers into a serialized closure.
  await context.addInitScript(`
    window.entryEvents=[];window.rollback=[];
    document.addEventListener('animationstart',function(e){
      const t=e.target;
      if(t.matches('.topbar,#main>.page,.home-intro>h1'))
        window.entryEvents.push({name:e.animationName,target:t.className||t.tagName});
    });
    function sample(){
      if(window.entryNodes)for(const [selector,node] of window.entryNodes){
        const current=document.querySelector(selector);
        if(current!==node)window.rollback.push('replaced:'+selector);
        else if(Number(getComputedStyle(current).opacity)<0.99)window.rollback.push('opacity:'+selector);
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  `);
  await context.route('**/*', async (r) => {
    const url = new URL(r.request().url());
    if (url.origin !== origin) return r.abort();
    if (r.request().method() !== 'GET') throw Error('No mutations permitted');
    if (url.pathname === '/api/config') {
      await configGate;
      return r
        .fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            privyAppId: 'fixture',
            launchesEnabled: false,
            chain: 'solana:mainnet',
            providers: { twitch: false, kick: false },
          }),
        })
        .catch(() => {});
    }
    if (url.pathname === '/api/catalog')
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) });
    if (url.pathname === '/api/donations')
      return r.fulfill({ contentType: 'application/json', body: '{"donations":[],"receipts":[]}' });
    if (url.pathname === '/src/privy-session.tsx') {
      moduleRequested = true;
      await moduleGate;
      return r.continue().catch(() => {});
    }
    if (holdRoute && url.pathname === '/src/pages/Details.tsx') {
      await routeGate;
      return r.continue().catch(() => {});
    }
    if (url.pathname.startsWith('/api/')) throw Error('Unexpected API ' + url.pathname);
    return r.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/__page_entry?route=' + encodeURIComponent(route), {
    waitUntil: 'domcontentloaded',
  });
  return {
    page,
    errors,
    configRelease,
    moduleRelease,
    routeRelease,
    moduleRequested: () => moduleRequested,
    close: async () => {
      configRelease();
      moduleRelease();
      routeRelease();
      await context.close();
    },
  };
}
async function pin(page: Page) {
  await page.locator('.home-intro h1').waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    (window as any).entryNodes = ['.topbar', '#main>.home-page', '.home-intro>h1'].map((s) => [
      s,
      document.querySelector(s),
    ]);
  });
  await page
    .getByRole('textbox', { name: 'Search tokens or contract address' })
    .fill('persistent query');
}
async function assertStable(page: Page, stage: string) {
  await page.waitForTimeout(350);
  assert.equal(
    await page.evaluate(() =>
      (window as any).entryNodes.every(
        ([selector, node]: [string, Element]) => document.querySelector(selector) === node,
      ),
    ),
    true,
    stage,
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  assert.deepEqual(await page.evaluate(() => (window as any).rollback), [], stage);
  assert.equal(
    await page.getByRole('textbox', { name: 'Search tokens or contract address' }).inputValue(),
    'persistent query',
    stage,
  );
}

test('wallet config, lazy runtime and connector readiness preserve mounted public page and its completed entrance', async () => {
  const f = await fixture();
  try {
    await pin(f.page);
    const runtimeRequested = f.page.waitForRequest('**/src/privy-session.tsx');
    f.configRelease();
    await runtimeRequested;
    await assertStable(f.page, 'config must not replace the public app');
    f.moduleRelease();
    await f.page.waitForFunction(() => typeof (window as any).finishConnector === 'function');
    await assertStable(f.page, 'lazy runtime must not replace the public app');
    await f.page.evaluate(() => (window as any).finishConnector());
    await f.page.waitForFunction(
      () => !(document.querySelector('.wallet-button') as HTMLButtonElement).disabled,
    );
    await assertStable(f.page, 'connector/provider readiness must not replace the public app');
    const entries = await f.page.evaluate(() => (window as any).entryEvents);
    assert.equal(
      entries.filter((e: any) => e.name === 'pog-page-enter' && e.target === 'H1').length,
      1,
    );
    assert.ok(
      entries.filter((e: any) => e.target === 'topbar').length <= 1,
      'chrome never repeats its entrance',
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('wallet runtime failure preserves the readable public page and its typed search', async () => {
  const f = await fixture();
  try {
    await pin(f.page);
    f.moduleRelease();
    f.configRelease();
    await f.page.waitForFunction(() => typeof (window as any).failConnector === 'function');
    await f.page.evaluate(() => (window as any).failConnector());
    await assertStable(f.page, 'wallet initialization failure must stay outside public page');
    const session = await f.page.evaluate(() => (window as any).entrySession);
    assert.equal(session.authenticated, false);
    assert.deepEqual(session.wallets, []);
    assert.match(session.error, /could not load|unavailable|refresh/i);
    const wallet = f.page.getByRole('button', { name: 'Connect wallet', exact: true });
    if (!(await wallet.isDisabled())) {
      await wallet.click();
      await f.page.getByRole('dialog').waitFor();
      assert.match(
        await f.page.getByRole('dialog').innerText(),
        /could not load|unavailable|Refresh/i,
      );
    }
    assert.equal(await f.page.locator('.home-intro h1').count(), 1);
  } finally {
    await f.close();
  }
});

test('cold lazy-route loader has no entrance; each subsequent SPA page enters once', async () => {
  const f = await fixture(false, '/docs', true);
  try {
    const loader = f.page.locator('#main>[role=status]');
    await loader.waitFor();
    assert.equal(await loader.evaluate((e) => getComputedStyle(e).animationName), 'none');
    f.routeRelease();
    await f.page.locator('.docs-page').waitFor();
    await f.page.waitForTimeout(550);
    for (const [name, selector] of [
      ['Explore', '.explore-page'],
      ['Home', '.home-page'],
      ['Docs', '.docs-page'],
    ]) {
      await f.page.locator('.sidebar nav').getByRole('link', { name, exact: true }).click();
      await f.page.locator(selector).waitFor();
      await f.page.waitForTimeout(550);
    }
    const entries = await f.page.evaluate(() =>
      (window as any).entryEvents.filter(
        (e: any) => e.name === 'pog-page-enter' && String(e.target).split(' ').includes('page'),
      ),
    );
    assert.equal(entries.length, 3, 'Docs twice and Explore once; Home animates its hero children');
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).entryEvents.filter(
            (e: any) => e.name === 'pog-page-enter' && e.target === 'H1',
          ).length,
      ),
      1,
      'Home hero enters once',
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('reduced motion keeps route and wallet initialization fully visible without entry animations', async () => {
  const f = await fixture(true);
  try {
    await pin(f.page);
    f.moduleRelease();
    f.configRelease();
    await f.page.waitForFunction(() => typeof (window as any).finishConnector === 'function');
    await f.page.evaluate(() => (window as any).finishConnector());
    await f.page.waitForFunction(
      () => !(document.querySelector('.wallet-button') as HTMLButtonElement).disabled,
    );
    await assertStable(f.page, 'reduced motion startup remains mounted');
    await f.page.evaluate(() => ((window as any).entryNodes = null));
    await f.page
      .locator('.sidebar nav')
      .getByRole('link', { name: 'Explore', exact: true })
      .click();
    await f.page.locator('.explore-page').waitFor();
    assert.equal(
      await f.page.locator('#main>.page').evaluate((e) => getComputedStyle(e).animationName),
      'none',
    );
    assert.deepEqual(await f.page.evaluate(() => (window as any).entryEvents), []);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('authenticated feed updates and runtime failure clear wallet authority without remounting the public app', async () => {
  const f = await fixture();
  try {
    await pin(f.page);
    f.moduleRelease();
    f.configRelease();
    await f.page.waitForFunction(() => typeof (window as any).finishConnector === 'function');
    await f.page.evaluate(() => (window as any).finishConnector());
    await f.page.waitForFunction(() => (window as any).entrySession.ready);
    let generation = -1;
    for (const address of ['wallet-A', null, 'wallet-B']) {
      await f.page.evaluate((address) => (window as any).setEntryIdentity(address), address);
      await f.page.waitForFunction(
        (address) => (window as any).entrySession.userId === (address ? 'user-' + address : null),
        address,
      );
      const session = await f.page.evaluate(() => (window as any).entrySession);
      assert.equal(session.authenticated, Boolean(address));
      assert.deepEqual(session.wallets, address ? [address] : []);
      assert.ok(
        session.generation > generation,
        'each identity transition invalidates prior authority',
      );
      generation = session.generation;
      await assertStable(f.page, 'identity feed update ' + address);
      assert.equal(
        await f.page.locator('.wallet-button').innerText(),
        address ? 'My wallet' : 'Connect wallet',
      );
    }
    await f.page.evaluate(() => (window as any).failEntryRuntime());
    await f.page.waitForFunction(() => Boolean((window as any).entrySession.error));
    const failed = await f.page.evaluate(() => (window as any).entrySession);
    assert.equal(failed.authenticated, false);
    assert.equal(failed.userId, null);
    assert.deepEqual(failed.wallets, []);
    await assertStable(f.page, 'runtime failure clears published authority but preserves page');
    assert.equal(await f.page.locator('.wallet-button').innerText(), 'Connect wallet');
    const rejection = await f.page.evaluate(async () => {
      try {
        await (window as any).entryActions.request('/api/forbidden');
        return 'unexpected success';
      } catch (error) {
        return String(error);
      }
    });
    assert.match(rejection, /unavailable|wallet|connect/i);
    assert.ok(
      f.errors.every((error) => error.includes('Synthetic wallet runtime failure')),
      'only intentional SDK failure is allowed',
    );
  } finally {
    await f.close();
  }
});
