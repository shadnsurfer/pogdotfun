/** Isolated synthetic SessionContext; no wallet provider, signatures or broadcast. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';

let server: ViteDevServer, browser: Browser, origin: string;
const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router-dom';
import {SessionContext} from '/src/auth.tsx'; import {LaunchPage} from '/src/pages/Launch.tsx';
window.fixture={calls:[],waits:[],pending:{},history:[],epoch:0};
function App(){
const [state,setState]=React.useState({authenticated:false,userId:null,wallets:[],generation:0});
window.changeSession=next=>setState({...next,generation:++window.fixture.epoch});
const wait=async(key,value)=>{if(window.fixture.waits.includes(key))return new Promise(resolve=>window.fixture.pending[key]=resolve);return value;};
const request=async(path,init)=>{window.fixture.calls.push({path,method:init?.method??'GET',body:init?.body?JSON.parse(init.body):null,userId:state.userId});
if(path==='/api/launches')return wait('history',{launches:window.fixture.history});
if(path==='/api/uploads/token-image')return wait('upload',{uri:'https://fixture.invalid/art'});
if(path==='/api/launches/prepare'){if(window.fixture.prepareError)throw new Error(window.fixture.prepareError);return wait('prepare',window.fixture.record);}
if(path.startsWith('/api/streamers/lookup'))return {streamer:{id:'streamer',platform:'twitch',handle:'fixturestreamer',name:'Fixture Streamer',channelUrl:'https://www.twitch.tv/fixturestreamer'}};
if(path.endsWith('/cancel'))return {...window.fixture.record,status:'failed',transaction:null,error:'Launch cancelled before submission'};
if(path.endsWith('/submit')){if(window.fixture.submitError){window.fixture.statusError=window.fixture.failStatusAfterSubmit;throw new Error(window.fixture.submitError);}const result=await wait('submit',{...window.fixture.record,status:window.fixture.submitStatus??'submitted',transaction:null,signature:'synthetic-signature'});window.fixture.record=result;return result;}
if(window.fixture.statusError)throw new Error(window.fixture.statusError);
return wait('status',window.fixture.record);};
const sign=async(transaction,address)=>{window.fixture.calls.push({path:'SIGN',transaction,address,userId:state.userId});if(window.fixture.signError)throw new Error(window.fixture.signError);return wait('sign','synthetic-not-a-signature');};
return React.createElement(SessionContext.Provider,{value:{...state,ready:true,config:{launchesEnabled:true},login(){},connectWallet(){},logout:async()=>{},error:'',request,sign}},React.createElement(MemoryRouter,null,React.createElement(LaunchPage)));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script>`;
const record = {
  launchId: 'launch-a',
  walletAddress: 'wallet-a',
  status: 'prepared',
  transaction: 'synthetic-unsigned',
  summary: {
    name: 'Saved A',
    symbol: 'SAVA',
    mint: 'mint',
    creatorAddress: 'creator',
    recipientPlatform: 'twitch',
    recipientUsername: 'fixturestreamer',
    networkFeeLamports: '5000',
    creatorReserveLamports: '10000',
    estimatedTotalLamports: '15000',
    initialBuyLamports: '0',
  },
};
before(async () => {
  server = await createServer({
    configFile: false,
    envFile: false,
    cacheDir: '/tmp/pog-launch-session-vite',
    root: process.cwd(),
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
    plugins: [
      {
        name: 'synthetic-launch-session',
        configureServer(vite) {
          vite.middlewares.use('/__launch_session', async (_req, res) => {
            res.setHeader('content-type', 'text/html');
            res.end(await vite.transformIndexHtml('/__launch_session', html));
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
async function pageFor(saved = false, launchRecord = record) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(
    ({ saved }) => {
      const read = Storage.prototype.getItem;
      const write = Storage.prototype.setItem;
      const remove = Storage.prototype.removeItem;
      if (saved) write.call(sessionStorage, 'pog:launch:user-a:wallet-a', 'launch-a');
      (window as any).launchStorageCalls = [];
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('pog:launch:')) (window as any).launchStorageCalls.push(['get', key]);
        return read.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('pog:launch:')) (window as any).launchStorageCalls.push(['set', key]);
        return write.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key) {
        if (key.startsWith('pog:launch:')) (window as any).launchStorageCalls.push(['remove', key]);
        return remove.call(this, key);
      };
    },
    { saved },
  );
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/__launch_session');
  await page.waitForFunction(() => Boolean((window as any).changeSession));
  await page.evaluate(
    ({ record, saved }) => {
      (window as any).fixture.record = record;
      (window as any).fixture.history = saved ? [record] : [];
      (window as any).changeSession({
        authenticated: true,
        userId: 'user-a',
        wallets: ['wallet-a'],
      });
    },
    { record: launchRecord, saved },
  );
  await page.getByRole('heading', { name: 'Launch a token', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Launch token', exact: true }).waitFor();
  return { page, close: () => context.close() };
}
async function switchToB(page: Page) {
  await page.evaluate(() => {
    (window as any).fixture.history = [];
    (window as any).changeSession({ authenticated: false, userId: null, wallets: [] });
  });
  await page.getByRole('button', { name: 'Connect wallet to launch', exact: true }).waitFor();
  await page.evaluate(() => {
    (window as any).changeSession({ authenticated: true, userId: 'user-b', wallets: ['wallet-b'] });
  });
}
async function openLaunch(page: Page) {
  await page.getByLabel('Token name', { exact: true }).fill('Fixture Token');
  await page.getByPlaceholder('CHAT', { exact: true }).fill('FIX');
  await page.getByPlaceholder('twitch_username', { exact: true }).fill('fixturestreamer');
  await page.getByLabel('Token image file', { exact: true }).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD4kAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Verify channel', exact: true }).click();
  await page.getByText('Fixture Streamer · View channel', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Launch token', exact: true }).click();
  await page.getByRole('dialog', { name: 'Launch token', exact: true }).waitFor();
}

const confirmLaunch = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: 'Launch token', exact: true }).click();
const submitted = (page: Page) =>
  page
    .getByRole('dialog')
    .getByRole('button', { name: 'Check confirmation', exact: true })
    .waitFor();
async function assertNoSavedFeatures(page: Page) {
  assert.deepEqual(await page.evaluate(() => (window as any).launchStorageCalls), []);
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).fixture.calls.filter((call: any) => call.path === '/api/launches').length,
    ),
    0,
  );
  assert.equal(await page.getByLabel('Your launches', { exact: false }).count(), 0);
  for (const name of ['View launch', 'Continue in wallet', 'Retry existing transaction'])
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
}

test('stale launch storage and server history are ignored on a fresh visit', async () => {
  const f = await pageFor(true);
  try {
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), []);
    await assertNoSavedFeatures(f.page);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    await openLaunch(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '');
  } finally {
    await f.close();
  }
});

test('one launch confirmation with a blank dev buy uploads, prepares, signs and submits without extra steps', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '');
    assert.equal(
      await f.page.getByRole('button', { name: 'Prepare launch', exact: true }).count(),
      0,
    );
    assert.equal(
      await f.page.getByRole('button', { name: 'Approve launch in wallet', exact: true }).count(),
      0,
    );
    await confirmLaunch(f.page);
    await submitted(f.page);
    await assertNoSavedFeatures(f.page);
    const calls = await f.page.evaluate(() =>
      (window as any).fixture.calls.filter(
        (call: any) =>
          call.path !== '/api/launches' && !call.path.startsWith('/api/streamers/lookup'),
      ),
    );
    assert.deepEqual(
      calls.map((call: any) => call.path),
      [
        '/api/uploads/token-image',
        '/api/launches/prepare',
        '/api/launches/launch-a',
        'SIGN',
        '/api/launches/launch-a/submit',
      ],
    );
    assert.equal(calls[1].body.initialBuyLamports, '0');
    assert.equal(calls[3].transaction, record.transaction);
    assert.deepEqual(calls[4].body, { signedTransaction: 'synthetic-not-a-signature' });
    assert.equal(
      await f.page
        .getByRole('dialog')
        .locator('dl > div')
        .filter({ hasText: 'Initial token purchase' })
        .innerText(),
      'Initial token purchase\nNone',
    );
  } finally {
    await f.close();
  }
});

test('one launch confirmation includes the exact dev buy and locks it throughout wallet approval', async () => {
  const f = await pageFor(false, {
    ...record,
    summary: { ...record.summary, initialBuyLamports: '100000001' },
  });
  try {
    await openLaunch(f.page);
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('0.100000001');
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['upload', 'sign'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.upload));
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).isDisabled(), true);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.upload({ uri: 'https://fixture.invalid/art' });
    });
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.sign));
    const prepared = await f.page.evaluate(() =>
      (window as any).fixture.calls.find((call: any) => call.path === '/api/launches/prepare'),
    );
    assert.equal(prepared.body.initialBuyLamports, '100000001');
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).count(), 0);
    assert.equal(
      await f.page
        .getByRole('dialog')
        .locator('dl > div')
        .filter({ hasText: 'Initial token purchase' })
        .innerText(),
      'Initial token purchase\n0.100000001 SOL',
    );
    assert.equal(
      await f.page.getByRole('button', { name: 'Prepare launch', exact: true }).count(),
      0,
    );
    assert.equal(
      await f.page.getByRole('button', { name: 'Continue in wallet', exact: true }).count(),
      0,
    );
    await f.page.evaluate(() => {
      (window as any).fixture.pending.sign('synthetic-not-a-signature');
    });
    await submitted(f.page);
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter((call: any) => call.path.endsWith('/submit')).length,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});

test('invalid dev buy stops before artwork upload or transaction preparation', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('1e-9');
    await confirmLaunch(f.page);
    await f.page
      .getByRole('alert')
      .filter({ hasText: /SOL.*9 decimal places/ })
      .waitFor();
    const mutations = await f.page.evaluate(() =>
      (window as any).fixture.calls.filter((call: any) => call.method === 'POST'),
    );
    assert.deepEqual(mutations, []);
  } finally {
    await f.close();
  }
});

test('the active transaction displays its exact dev buy without saved-launch controls', async () => {
  const f = await pageFor(false, {
    ...record,
    summary: { ...record.summary, initialBuyLamports: '9007199254740991' },
  });
  try {
    await openLaunch(f.page);
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('9007199.254740991');
    await confirmLaunch(f.page);
    await submitted(f.page);
    await assertNoSavedFeatures(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).count(), 0);
    assert.equal(
      await f.page
        .getByRole('dialog')
        .locator('dl > div')
        .filter({ hasText: 'Initial token purchase' })
        .innerText(),
      'Initial token purchase\n9,007,199.254740991 SOL',
    );
  } finally {
    await f.close();
  }
});

test('new attempts use fresh request IDs while equivalent SOL text keeps the same exact amount', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.prepareError = 'Synthetic preparation failure';
    });
    for (const amount of ['0.10', '0.100', '0.2']) {
      await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill(amount);
      await confirmLaunch(f.page);
      await f.page
        .getByRole('dialog')
        .getByRole('alert')
        .filter({ hasText: 'Synthetic preparation failure' })
        .waitFor();
    }
    const prepared = await f.page.evaluate(() =>
      (window as any).fixture.calls.filter((call: any) => call.path === '/api/launches/prepare'),
    );
    assert.equal(prepared.length, 3);
    assert.equal(new Set(prepared.map((call: any) => call.body.requestId)).size, 3);
    assert.deepEqual(
      prepared.map((call: any) => call.body.initialBuyLamports),
      ['100000000', '100000000', '200000000'],
    );
  } finally {
    await f.close();
  }
});

test('wallet cancellation returns to an editable buy and a retry starts a new launch operation', async () => {
  const f = await pageFor(false, {
    ...record,
    summary: { ...record.summary, initialBuyLamports: '100000000' },
  });
  try {
    await openLaunch(f.page);
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('0.1');
    await f.page.evaluate(() => {
      (window as any).fixture.signError = 'Wallet request cancelled';
    });
    await confirmLaunch(f.page);
    await f.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Launch token', exact: true })
      .waitFor();
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '0.1');
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).isEnabled(), true);
    await assertNoSavedFeatures(f.page);
    assert.equal(
      await f.page
        .getByRole('dialog')
        .getByText('Wallet request cancelled', { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter((call: any) => call.path.endsWith('/submit')).length,
      ),
      0,
    );
    await f.page.evaluate(() => {
      (window as any).fixture.signError = null;
      (window as any).fixture.record = {
        ...(window as any).fixture.record,
        launchId: 'launch-b',
        transaction: 'synthetic-new-unsigned',
        summary: { ...(window as any).fixture.record.summary, initialBuyLamports: '200000000' },
      };
    });
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('0.2');
    await confirmLaunch(f.page);
    await submitted(f.page);
    const calls = await f.page.evaluate(() => (window as any).fixture.calls);
    assert.equal(calls.filter((call: any) => call.path === '/api/uploads/token-image').length, 2);
    const preparations = calls.filter((call: any) => call.path === '/api/launches/prepare');
    assert.equal(preparations.length, 2);
    assert.notEqual(preparations[0].body.requestId, preparations[1].body.requestId);
    assert.deepEqual(
      preparations.map((call: any) => call.body.initialBuyLamports),
      ['100000000', '200000000'],
    );
    assert.deepEqual(
      calls
        .filter((call: any) => call.path === 'SIGN')
        .map((call: any) => [call.transaction, call.address]),
      [
        [record.transaction, 'wallet-a'],
        ['synthetic-new-unsigned', 'wallet-a'],
      ],
    );
    assert.equal(
      calls.filter((call: any) => call.path === '/api/launches/launch-a/cancel').length,
      1,
    );
    assert.deepEqual(
      calls.filter((call: any) => call.path.endsWith('/submit')).map((call: any) => call.path),
      ['/api/launches/launch-b/submit'],
    );
  } finally {
    await f.close();
  }
});

test('duplicate launch clicks cannot interrupt the single upload, preparation, status, sign and submit flight', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['upload', 'prepare', 'status', 'sign', 'submit'];
    });
    await f.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Launch token', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.upload));
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).isDisabled(), true);
    for (const phase of ['upload', 'prepare', 'status', 'sign', 'submit']) {
      await f.page.waitForFunction((key) => Boolean((window as any).fixture.pending[key]), phase);
      assert.equal(
        await f.page.getByRole('dialog').locator('.lv-launch-button').isDisabled(),
        true,
      );
      assert.equal(
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: 'Launch token', exact: true })
          .count(),
        0,
      );
      assert.equal(
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: 'Continue in wallet', exact: true })
          .count(),
        0,
      );
      await f.page.evaluate((key) => {
        const fixture = (window as any).fixture;
        const value =
          key === 'upload'
            ? { uri: 'https://fixture.invalid/art' }
            : key === 'sign'
              ? 'synthetic-not-a-signature'
              : key === 'submit'
                ? {
                    ...fixture.record,
                    status: 'submitted',
                    transaction: null,
                    signature: 'synthetic-signature',
                  }
                : fixture.record;
        fixture.pending[key](value);
      }, phase);
    }
    await submitted(f.page);
    const paths = await f.page.evaluate(() =>
      (window as any).fixture.calls
        .filter(
          (call: any) =>
            call.path !== '/api/launches' && !call.path.startsWith('/api/streamers/lookup'),
        )
        .map((call: any) => call.path),
    );
    assert.deepEqual(paths, [
      '/api/uploads/token-image',
      '/api/launches/prepare',
      '/api/launches/launch-a',
      'SIGN',
      '/api/launches/launch-a/submit',
    ]);
  } finally {
    await f.close();
  }
});

test('an active submitted launch checks confirmation without saved controls or another mint', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await confirmLaunch(f.page);
    await submitted(f.page);
    await assertNoSavedFeatures(f.page);
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.getByRole('dialog').count(), 1);
    await f.page.getByRole('button', { name: 'Check confirmation', exact: true }).click();
    await submitted(f.page);
    const calls = await f.page.evaluate(() => (window as any).fixture.calls);
    assert.equal(calls.filter((call: any) => call.path === '/api/launches/prepare').length, 1);
    assert.equal(calls.filter((call: any) => call.path === 'SIGN').length, 1);
    assert.equal(calls.filter((call: any) => call.path.endsWith('/submit')).length, 1);
    assert.equal(calls.filter((call: any) => call.path.endsWith('/cancel')).length, 0);
  } finally {
    await f.close();
  }
});

test('a lost submission and status response retains only the active uncertain transaction', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.submitError = 'Synthetic response lost after submission';
      (window as any).fixture.failStatusAfterSubmit = 'Synthetic status unavailable';
    });
    await confirmLaunch(f.page);
    await submitted(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).count(), 0);
    await assertNoSavedFeatures(f.page);
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.getByRole('dialog').count(), 1);
    await f.page.evaluate(() => {
      (window as any).fixture.statusError = null;
    });
    await f.page.getByRole('button', { name: 'Check confirmation', exact: true }).click();
    await submitted(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).count(), 0);
    assert.equal(
      await f.page
        .getByRole('dialog')
        .locator('dl > div')
        .filter({ hasText: /^Status/ })
        .innerText(),
      'Status\nreview',
    );
    await f.page.evaluate(() => {
      (window as any).fixture.record = {
        ...(window as any).fixture.record,
        status: 'submitted',
        transaction: null,
        signature: 'synthetic-signature',
      };
    });
    await f.page.getByRole('button', { name: 'Check confirmation', exact: true }).click();
    await submitted(f.page);
    const calls = await f.page.evaluate(() => (window as any).fixture.calls);
    assert.equal(calls.filter((call: any) => call.path === '/api/launches/prepare').length, 1);
    assert.equal(calls.filter((call: any) => call.path === 'SIGN').length, 1);
    assert.equal(calls.filter((call: any) => call.path.endsWith('/submit')).length, 1);
    assert.equal(calls.filter((call: any) => call.path.endsWith('/cancel')).length, 0);
  } finally {
    await f.close();
  }
});

test('closing confirmed or failed operations returns an enabled fresh form and a new operation', async () => {
  for (const status of ['confirmed', 'failed']) {
    const f = await pageFor();
    try {
      await openLaunch(f.page);
      await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('0.1');
      await f.page.evaluate((status) => {
        (window as any).fixture.submitStatus = status;
      }, status);
      await confirmLaunch(f.page);
      await f.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await f.page.getByRole('dialog').count(), 0);
      await f.page.getByRole('button', { name: 'Launch token', exact: true }).click();
      assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '');
      assert.equal(
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: 'Launch token', exact: true })
          .isEnabled(),
        true,
      );
      await assertNoSavedFeatures(f.page);
      await f.page.evaluate((record) => {
        (window as any).fixture.record = {
          ...record,
          launchId: 'launch-b',
          transaction: 'synthetic-new-unsigned',
        };
        (window as any).fixture.submitStatus = 'submitted';
      }, record);
      await confirmLaunch(f.page);
      await submitted(f.page);
      const preparations = await f.page.evaluate(() =>
        (window as any).fixture.calls.filter((call: any) => call.path === '/api/launches/prepare'),
      );
      assert.equal(preparations.length, 2);
      assert.notEqual(preparations[0].body.requestId, preparations[1].body.requestId);
      assert.deepEqual(
        preparations.map((call: any) => call.body.initialBuyLamports),
        ['100000000', '0'],
      );
      await assertNoSavedFeatures(f.page);
    } finally {
      await f.close();
    }
  }
});

test('reloading after a launch opens a fresh form and ignores stale pending records', async () => {
  const f = await pageFor(true);
  try {
    await openLaunch(f.page);
    await confirmLaunch(f.page);
    await submitted(f.page);
    const pending = await f.page.evaluate(() => (window as any).fixture.record);
    await f.page.reload();
    await f.page.waitForFunction(() => Boolean((window as any).changeSession));
    await f.page.evaluate((pending) => {
      (window as any).fixture.record = pending;
      (window as any).fixture.history = [pending];
      (window as any).changeSession({
        authenticated: true,
        userId: 'user-a',
        wallets: ['wallet-a'],
      });
    }, pending);
    await f.page.getByRole('button', { name: 'Launch token', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(await f.page.getByLabel('Token name', { exact: true }).inputValue(), '');
    assert.deepEqual(await f.page.evaluate(() => (window as any).fixture.calls), []);
    await assertNoSavedFeatures(f.page);
    await openLaunch(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '');
  } finally {
    await f.close();
  }
});

test('an automatic status check that finishes after switching wallets cannot request a signature', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['status'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.status));
    await switchToB(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.status((window as any).fixture.record);
    });
    await f.page.waitForTimeout(50);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (call: any) => call.path === 'SIGN' || call.path.endsWith('/submit'),
          ).length,
      ),
      0,
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('logout and login clear the current operation and a late signed response cannot submit', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['sign'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.sign));
    await switchToB(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.sign('synthetic-not-a-signature');
    });
    await f.page.waitForTimeout(50);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(
      await f.page.getByLabel('Launch wallet', { exact: false }).inputValue(),
      'wallet-b',
    );
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter((call: any) => call.path.endsWith('/submit')).length,
      ),
      0,
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('late upload after identity change cannot prepare a transaction or leak old progress', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['upload'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.upload));
    await switchToB(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.upload({ uri: 'https://fixture.invalid/old' });
    });
    await f.page.waitForTimeout(50);
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter((call: any) => call.path === '/api/launches/prepare')
            .length,
      ),
      0,
    );
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(
      await f.page.getByRole('button', { name: 'Launch token', exact: true }).isEnabled(),
      true,
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('equal-length wallet replacement invalidates an active signature without reading history', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['sign'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.sign));
    await f.page.evaluate(() => {
      (window as any).changeSession({
        authenticated: true,
        userId: 'user-a',
        wallets: ['wallet-b'],
      });
    });
    await f.page.getByRole('button', { name: 'Launch token', exact: true }).waitFor();
    await f.page.evaluate(() => {
      (window as any).fixture.pending.sign('synthetic-not-a-signature');
    });
    await f.page.waitForTimeout(50);
    assert.equal(
      await f.page.getByLabel('Launch wallet', { exact: false }).inputValue(),
      'wallet-b',
    );
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(
      await f.page.evaluate(
        () =>
          (window as any).fixture.calls.filter((call: any) => call.path.endsWith('/submit')).length,
      ),
      0,
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('a late preparation is discarded and signing back in does not recover the old intent', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['prepare'];
    });
    await confirmLaunch(f.page);
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.prepare));
    await switchToB(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.prepare((window as any).fixture.record);
    });
    await f.page.waitForTimeout(50);
    await f.page.evaluate(() => {
      (window as any).fixture.history = [(window as any).fixture.record];
      (window as any).changeSession({
        authenticated: true,
        userId: 'user-a',
        wallets: ['wallet-a'],
      });
    });
    await f.page.getByRole('button', { name: 'Launch token', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(await f.page.getByLabel('Token name', { exact: true }).inputValue(), '');
    assert.equal(
      await f.page.evaluate(
        () => (window as any).fixture.calls.filter((call: any) => call.path === 'SIGN').length,
      ),
      0,
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('late confirmation status cannot reopen an old operation after logout and login', async () => {
  const f = await pageFor();
  try {
    await openLaunch(f.page);
    await confirmLaunch(f.page);
    await submitted(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.waits = ['status'];
    });
    await f.page.getByRole('button', { name: 'Check confirmation', exact: true }).click();
    await f.page.waitForFunction(() => Boolean((window as any).fixture.pending.status));
    await switchToB(f.page);
    await f.page.evaluate(() => {
      (window as any).fixture.pending.status({
        ...(window as any).fixture.record,
        status: 'confirmed',
      });
    });
    await f.page.waitForTimeout(50);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(
      await f.page.getByLabel('Launch wallet', { exact: false }).inputValue(),
      'wallet-b',
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});

test('selecting another connected wallet starts a new empty form without a saved launch', async () => {
  const f = await pageFor();
  try {
    await f.page.evaluate(() => {
      (window as any).changeSession({
        authenticated: true,
        userId: 'user-a',
        wallets: ['wallet-a', 'wallet-b'],
      });
    });
    await openLaunch(f.page);
    await f.page.getByLabel('Dev buy (SOL)', { exact: true }).fill('0.1');
    await f.page.evaluate(() => {
      (window as any).fixture.signError = 'Synthetic wallet cancellation';
    });
    await confirmLaunch(f.page);
    await f.page
      .getByRole('dialog')
      .getByRole('button', { name: 'Launch token', exact: true })
      .waitFor();
    await f.page.keyboard.press('Escape');
    await f.page.getByLabel('Launch wallet', { exact: false }).selectOption('wallet-b');
    assert.equal(await f.page.getByLabel('Token name', { exact: true }).inputValue(), '');
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    await f.page.evaluate(() => {
      (window as any).fixture.signError = null;
      (window as any).fixture.record = {
        ...(window as any).fixture.record,
        launchId: 'launch-b',
        walletAddress: 'wallet-b',
      };
    });
    await openLaunch(f.page);
    assert.equal(await f.page.getByLabel('Dev buy (SOL)', { exact: true }).inputValue(), '');
    await confirmLaunch(f.page);
    await submitted(f.page);
    const prepared = await f.page.evaluate(() =>
      (window as any).fixture.calls.filter((call: any) => call.path === '/api/launches/prepare'),
    );
    assert.equal(prepared.length, 2);
    assert.notEqual(prepared[0].body.requestId, prepared[1].body.requestId);
    assert.deepEqual(
      prepared.map((call: any) => call.body.walletAddress),
      ['wallet-a', 'wallet-b'],
    );
    await assertNoSavedFeatures(f.page);
  } finally {
    await f.close();
  }
});
