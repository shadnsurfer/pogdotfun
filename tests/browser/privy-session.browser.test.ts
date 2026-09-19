/** Actual SessionBridge, synthetic SDK boundary only. No wallet extensions or external calls. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';

let server: ViteDevServer, browser: Browser, origin: string;
const sdk = `import React,{useSyncExternalStore} from 'react';
const listeners=new Set();
const f=window.fixture={calls:[],mode:'success',nextAddress:'wallet-B',nextName:'MetaMask',failDisconnect:false,holdDisconnect:false,holdLogout:false,signResult:null};
const notify=()=>listeners.forEach(fn=>fn());
const wallet=(name,address)=>{const standardWallet={name,accounts:[{address}]};return {standardWallet,address,disconnect:async()=>{
f.calls.push('disconnect:'+name);if(f.failDisconnect)throw Error('denied');if(f.holdDisconnect)await new Promise(r=>f.finishDisconnect=r);standardWallet.accounts=[];state={...state,wallets:state.wallets.filter(w=>w.standardWallet!==standardWallet)};notify();}};};
const user=address=>({id:'user-'+address,linkedAccounts:[{type:'wallet',chainType:'solana',address,walletClientType:'phantom'}]});
let state={ready:true,authenticated:true,user:user('wallet-A'),wallets:[wallet('Phantom','wallet-A')]};
const read=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state);
f.snapshot=()=>state;
f.complete=()=>{state={...state,authenticated:true,user:user(f.nextAddress),wallets:[wallet(f.nextName,f.nextAddress)]};notify();f.onComplete?.();};
export function usePrivy(){const value=read();return {...value,logout:async()=>{f.calls.push('logout');if(f.holdLogout)await new Promise(r=>f.finishLogout=r);state={...state,authenticated:false,user:null};notify();},getAccessToken:async()=>'fixture-token'};}
export function useWallets(){const value=read();return {ready:value.ready,wallets:value.wallets};}
export function useLogin(callbacks){const capturedUser=read().user;f.onComplete=callbacks.onComplete;return {login:options=>{if(capturedUser){f.calls.push('login-refused-already-authenticated');return;}f.calls.push('login');f.loginOptions=options;if(f.mode==='cancel')callbacks.onError('user_exited_auth_flow');else f.complete();}};}
export function useLinkAccount(callbacks){return {linkWallet:()=>{f.calls.push('link');callbacks.onError('user_rejected');}};}
export function useSignTransaction(){return {signTransaction:async()=>{f.calls.push('sign');return new Promise(r=>f.finishSign=r);}};}
export const defaultSolanaRpcsPlugin=()=>({}); export const toSolanaWalletConnectors=options=>{f.connectorOptions=options;return {};};
export const PrivyProvider=({children,config})=>{f.config=config;return children;};`;
const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import ConnectedServices from '/src/privy-session.tsx'; import {useSession} from '/src/auth.tsx';
function Probe(){const s=useSession();window.session=s;return React.createElement('div',null,
React.createElement('output',{id:'identity'},JSON.stringify({ready:s.ready,authenticated:s.authenticated,userId:s.userId,wallets:s.wallets,generation:s.generation})),
React.createElement('output',{id:'error'},s.error),
React.createElement('button',{disabled:!s.ready,onClick:()=>s.logout().catch(e=>window.lastError=e.message)},'Sign out'),
React.createElement('button',{disabled:!s.ready,onClick:s.login},'Sign in'));}
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
root.render(React.createElement(React.StrictMode,null,React.createElement(ConnectedServices,{config:{privyAppId:'fixture',launchesEnabled:true,providers:{twitch:true,kick:true},chain:'solana:mainnet'}},React.createElement(Probe))));
</script>`;
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    cacheDir: '/tmp/pog-privy-session-vite',
    root: process.cwd(),
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { exclude: ['@privy-io/react-auth', '@privy-io/react-auth/solana'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'synthetic-privy-boundary',
        enforce: 'pre',
        resolveId(id) {
          if (id === '@privy-io/react-auth' || id === '@privy-io/react-auth/solana')
            return '\0privy-fixture';
          if (id === './metamask-solana') return '\0metamask-fixture';
        },
        load(id) {
          if (id === '\0privy-fixture') return sdk;
          if (id === '\0metamask-fixture')
            return 'export const initializeMetaMaskSolana=async()=>{};';
        },
        configureServer(vite) {
          vite.middlewares.use('/__privy_session', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(await vite.transformIndexHtml('/__privy_session', html));
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
async function fixture() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/__privy_session');
  await page.waitForFunction(
    () => (window as any).session?.authenticated && (window as any).session?.ready,
  );
  return { page, errors, close: () => context.close() };
}

test('actual bridge signs out A, clears Standard provider state, then signs into B or A under StrictMode', async () => {
  for (const address of ['wallet-B', 'wallet-A']) {
    const f = await fixture();
    try {
      await f.page.evaluate((address) => {
        (window as any).fixture.nextAddress = address;
        (window as any).fixture.nextName = address === 'wallet-A' ? 'Phantom' : 'MetaMask';
      }, address);
      await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await f.page.waitForFunction(
        () => !(window as any).session.authenticated && (window as any).session.ready,
      );
      assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.snapshot().wallets), []);
      await f.page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await f.page.waitForFunction(
        (address) => (window as any).session.wallets[0] === address,
        address,
      );
      const actual = await f.page.evaluate(() => ({
        calls: (window as any).fixture.calls,
        options: (window as any).fixture.loginOptions,
        auto: (window as any).fixture.connectorOptions,
        config: (window as any).fixture.config,
      }));
      assert.deepEqual(actual.calls, ['disconnect:Phantom', 'logout', 'logout', 'login']);
      assert.deepEqual(actual.options, {
        loginMethods: ['wallet'],
        walletChainType: 'solana-only',
      });
      assert.equal(actual.auto.shouldAutoConnect, false);
      assert.deepEqual(actual.config.appearance.walletList, ['phantom', 'metamask']);
      assert.equal(actual.config.embeddedWallets.solana.createOnLogin, 'off');
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('actual bridge keeps pending cleanup disabled, retains a failed provider for retry, and cancellation recovers', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      (window as any).fixture.failDisconnect = true;
    });
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await f.page.waitForFunction(() => Boolean((window as any).lastError));
    assert.match(await f.page.locator('#error').innerText(), /Retry sign-out/);
    assert.equal(await f.page.evaluate(() => (window as any).session.authenticated), false);
    await f.page.evaluate(() => {
      (window as any).fixture.failDisconnect = false;
      (window as any).fixture.holdDisconnect = true;
    });
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await f.page.waitForFunction(() => Boolean((window as any).fixture.finishDisconnect));
    assert.equal(
      await f.page.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(),
      true,
    );
    await f.page.evaluate(() => {
      (window as any).fixture.finishDisconnect();
    });
    await f.page.waitForFunction(() => (window as any).session.ready);
    await f.page.evaluate(() => {
      (window as any).fixture.mode = 'cancel';
    });
    await f.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await f.page
      .getByText('Wallet sign-in was not completed. You can try again.', { exact: true })
      .waitFor();
    await f.page.evaluate(() => {
      (window as any).fixture.mode = 'success';
    });
    await f.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await f.page.waitForFunction(() => (window as any).session.wallets[0] === 'wallet-B');
    assert.equal(await f.page.locator('#error').innerText(), '');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('an old request closure and delayed signature are revoked immediately at logout', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const w = window as any;
      w.oldRequest = w.session.request;
      w.signature = w.session.sign('AA==', 'wallet-A').then(
        () => 'accepted',
        (error: Error) => error.name,
      );
    });
    await f.page.waitForFunction(() => Boolean((window as any).fixture.finishSign));
    await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    const actual = await f.page.evaluate(async () => {
      const w = window as any;
      w.fixture.finishSign({ signedTransaction: new Uint8Array([0]) });
      return {
        signature: await w.signature,
        request: await w.oldRequest('/must-not-fetch').then(
          () => 'accepted',
          (error: Error) => error.name,
        ),
      };
    });
    assert.deepEqual(actual, {
      signature: 'WalletSessionChangedError',
      request: 'WalletSessionChangedError',
    });
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('a queued fresh login cannot open its modal after its bridge unmounts', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      (window as any).fixture.holdLogout = true;
      (window as any).session.login();
    });
    await f.page.waitForFunction(() => Boolean((window as any).fixture.finishLogout));
    await f.page.evaluate(() => {
      (window as any).unmount();
      (window as any).fixture.finishLogout();
    });
    await f.page.waitForTimeout(30);
    assert.equal(
      await f.page.evaluate(() => (window as any).fixture.calls.includes('login')),
      false,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('login from an authenticated session waits for the fresh unauthenticated SDK callback', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await f.page.waitForFunction(() =>
      (window as any).fixture.calls.some((call: string) => call.startsWith('login')),
    );
    assert.equal(
      await f.page.evaluate(() =>
        (window as any).fixture.calls.includes('login-refused-already-authenticated'),
      ),
      false,
    );
    await f.page.waitForFunction(() => (window as any).session.wallets[0] === 'wallet-B');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('explicit logout supersedes a pending login cleanup without opening a new modal', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      (window as any).fixture.holdLogout = true;
      (window as any).session.login();
    });
    await f.page.waitForFunction(() => Boolean((window as any).fixture.finishLogout));
    await f.page.evaluate(() => {
      void (window as any).session.logout();
      (window as any).fixture.finishLogout();
    });
    await f.page.waitForFunction(
      () => (window as any).session.ready && !(window as any).session.authenticated,
    );
    assert.equal(
      await f.page.evaluate(() => (window as any).fixture.calls.includes('login')),
      false,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
