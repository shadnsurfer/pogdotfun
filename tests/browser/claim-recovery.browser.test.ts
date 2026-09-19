import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';

declare global {
  interface Window {
    claimRecoveryFixture: {
      update: (value: { disabled?: boolean; sourceKey?: string; budgetFrozen?: boolean }) => void;
      refreshed: number;
    };
  }
}
const origin = 'https://claim-recovery-fixture.invalid';
const endpoint = `${origin}/api/admin/claims/recovery`;
const preview = {
  reviewFingerprint: 'b'.repeat(64),
  candidates: [
    {
      jobId: 'old-claim-job',
      tokenId: 'registered-token',
      symbol: 'POG',
      signature: 'original-signature',
      lastValidBlockHeight: 12345,
      gasHoldUsdCents: 25,
    },
  ],
  preservedGasHoldUsdCents: 25,
  transactionsEnabled: true,
  budgetFrozen: false,
};
let browser: Browser;
let bundle: string;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { AdminClaimRecovery } from './src/pages/AdminClaimRecovery';
        function Fixture() {
          const [props, setProps] = useState({ disabled: false, budgetFrozen: false, sourceKey: 'initial' });
          window.claimRecoveryFixture.update = (update) => setProps((previous) => ({ ...previous, ...update }));
          return <AdminClaimRecovery {...props} onRefresh={async () => { window.claimRecoveryFixture.refreshed += 1; }} />;
        }
        window.claimRecoveryFixture = { refreshed: 0 };
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0].text;
  const executablePath = [
    process.env.POG_CHECKOUT_TEST_CHROMIUM,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find((path) => path && existsSync(path));
  assert.ok(
    executablePath,
    'Set POG_CHECKOUT_TEST_CHROMIUM to an existing Chromium; no browser is installed by this test.',
  );
  browser = await chromium.launch({
    executablePath,
    headless: true,
    proxy: { server: 'http://127.0.0.1:1', bypass: '' },
    args: ['--disable-background-networking', '--disable-component-update'],
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(
  options: {
    getStatus?: number;
    postStatus?: number;
    abortPost?: boolean;
    readGate?: Promise<void>;
    postGate?: Promise<void>;
    preview?: unknown;
  } = {},
) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests: { method: string; body: unknown }[] = [];
  const blocked: string[] = [];
  const errors: string[] = [];
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && request.url() === `${origin}/`) {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Isolated global recovery fixture</title></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    } else if (request.method() === 'GET' && request.url() === `${origin}/fixture.js`) {
      await route.fulfill({ contentType: 'text/javascript', body: bundle });
    } else if (request.url() === endpoint && ['GET', 'POST'].includes(request.method())) {
      const read = request.method() === 'GET';
      requests.push({ method: request.method(), body: read ? null : request.postDataJSON() });
      await (read ? options.readGate : options.postGate);
      if (!read && options.abortPost) {
        await route.abort();
        return;
      }
      await route
        .fulfill({
          status: (read ? options.getStatus : options.postStatus) ?? 200,
          contentType: 'application/json',
          body: JSON.stringify(
            read
              ? (options.preview ?? preview)
              : {
                  recovery: {
                    id: 'recovery-record',
                    createdAt: '2026-09-16T12:00:00.000Z',
                    jobIds: ['old-claim-job'],
                    successorJobIds: ['fresh-claim-job'],
                  },
                },
          ),
        })
        .catch(() => undefined);
    } else {
      blocked.push(request.url());
      await route.abort();
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Review stalled claims', exact: true }).waitFor();
  return { page, requests, blocked, errors, close: () => context.close() };
}
const settle = async (page: Awaited<ReturnType<typeof fixture>>['page']) => {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
};
async function open(f: Awaited<ReturnType<typeof fixture>>) {
  await f.page.getByRole('button', { name: 'Review stalled claims', exact: true }).click();
  await f.page
    .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
    .waitFor();
}
async function acknowledge(f: Awaited<ReturnType<typeof fixture>>) {
  await f.page.getByRole('checkbox').check();
  await f.page.getByLabel('Operator note').fill('Reviewed old signatures and preserved gas holds.');
}

test(
  'review is read-only; explicit acknowledgment and a meaningful note submit exactly once',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      await settle(f.page);
      assert.deepEqual(f.requests, []);
      await open(f);
      assert.deepEqual(f.requests, [{ method: 'GET', body: null }]);
      const submit = f.page.getByRole('button', {
        name: 'Authorize fresh claim attempts',
        exact: true,
      });
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await f.page.getByRole('checkbox').isChecked(), false);
      await f.page
        .locator('form')
        .evaluate((form) =>
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
      await settle(f.page);
      assert.equal(f.requests.length, 1);
      const content = await f.page.getByRole('dialog').innerText();
      for (const value of [
        'old-claim-job',
        'registered-token',
        'POG',
        'original-signature',
        '12345',
        '$0.25',
        'gas holds',
        'not proof of zero spend',
        'gift purchases',
      ])
        assert.ok(content.includes(value), `Missing review detail: ${value}`);
      await f.page.getByRole('checkbox').check();
      assert.equal(await submit.isDisabled(), true);
      await f.page.getByLabel('Operator note').fill('too short');
      assert.equal(await submit.isDisabled(), true);
      await f.page
        .getByLabel('Operator note')
        .fill('Reviewed old signatures and preserved gas holds.');
      assert.equal(await submit.isEnabled(), true);
      await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await f.page
        .getByRole('status')
        .filter({ hasText: 'Claim recovery authorization recorded' })
        .waitFor();
      assert.deepEqual(f.requests, [
        { method: 'GET', body: null },
        {
          method: 'POST',
          body: {
            reviewFingerprint: 'b'.repeat(64),
            note: 'Reviewed old signatures and preserved gas holds.',
            acknowledge: true,
          },
        },
      ]);
      assert.equal(await f.page.evaluate(() => window.claimRecoveryFixture.refreshed), 1);
      assert.equal(await submit.count(), 0);
      assert.deepEqual(f.blocked, []);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test('canceling a loaded review sends no authorization', async () => {
  const f = await fixture();
  try {
    await open(f);
    await acknowledge(f);
    await f.page.getByRole('button', { name: 'Close', exact: true }).click();
    await f.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET'],
    );
  } finally {
    await f.close();
  }
});

test('a stale 409 clears consent and requires an explicit new read', async () => {
  const f = await fixture({ postStatus: 409 });
  try {
    await open(f);
    await acknowledge(f);
    await f.page
      .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
      .click();
    await f.page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
    assert.equal(
      await f.page
        .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
        .count(),
      0,
    );
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET', 'POST'],
    );
    await f.page.getByRole('button', { name: 'Refresh recovery status', exact: true }).click();
    await f.page.getByRole('checkbox').waitFor();
    assert.equal(await f.page.getByRole('checkbox').isChecked(), false);
    assert.equal(await f.page.getByLabel('Operator note').inputValue(), '');
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET', 'POST', 'GET'],
    );
  } finally {
    await f.close();
  }
});

for (const options of [
  { getStatus: 503 },
  { getStatus: 409 },
  { preview: { ...preview, reviewFingerprint: null } },
]) {
  test(`unavailable or invalid review cannot authorize: ${JSON.stringify(options).slice(0, 70)}`, async () => {
    const f = await fixture(options);
    try {
      await f.page.getByRole('button', { name: 'Review stalled claims', exact: true }).click();
      await f.page.getByRole('alert').waitFor();
      assert.equal(await f.page.getByRole('checkbox').count(), 0);
      assert.equal(
        await f.page
          .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
          .count(),
        0,
      );
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET'],
      );
    } finally {
      await f.close();
    }
  });
}

test('ambiguous POST failure refreshes admin status and never automatically retries', async () => {
  const f = await fixture({ abortPost: true });
  try {
    await open(f);
    await acknowledge(f);
    await f.page
      .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
      .click();
    await f.page.getByRole('alert').filter({ hasText: 'does not prove' }).waitFor();
    await settle(f.page);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET', 'POST'],
    );
    assert.equal(await f.page.evaluate(() => window.claimRecoveryFixture.refreshed), 1);
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
  } finally {
    await f.close();
  }
});

test('identical polling preserves review while stale or changed live data invalidates consent', async () => {
  const f = await fixture();
  try {
    await open(f);
    await acknowledge(f);
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ sourceKey: 'initial' }));
    await settle(f.page);
    assert.equal(await f.page.getByRole('checkbox').isChecked(), true);
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ disabled: true }));
    await f.page.getByRole('alert').filter({ hasText: 'not current' }).waitFor();
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
    assert.equal(
      await f.page
        .getByRole('button', { name: 'Review stalled claims', exact: true, includeHidden: true })
        .isDisabled(),
      true,
    );
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ disabled: false }));
    await f.page.getByRole('button', { name: 'Refresh recovery status', exact: true }).click();
    await acknowledge(f);
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ sourceKey: 'changed' }));
    await f.page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET', 'GET'],
    );
  } finally {
    await f.close();
  }
});

test('a canceled pending review cannot be revived by a late response', async () => {
  let release = () => {};
  const readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ readGate });
  try {
    await f.page.getByRole('button', { name: 'Review stalled claims', exact: true }).click();
    await f.page.getByRole('status').filter({ hasText: 'Loading' }).waitFor();
    await f.page.getByRole('button', { name: 'Close', exact: true }).click();
    release();
    await settle(f.page);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET'],
    );
  } finally {
    release();
    await f.close();
  }
});

test('an in-flight POST blocks repeated submissions and close actions', async () => {
  let release = () => {};
  const postGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ postGate });
  try {
    await open(f);
    await acknowledge(f);
    await f.page
      .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
      .click();
    await f.page.getByRole('button', { name: 'Checking claim history…', exact: true }).waitFor();
    await f.page.locator('form').evaluate((form) => {
      for (let i = 0; i < 3; i++)
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await f.page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal(await f.page.getByRole('dialog').count(), 1);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET', 'POST'],
    );
    release();
    await f.page
      .getByRole('status')
      .filter({ hasText: 'Claim recovery authorization recorded' })
      .waitFor();
  } finally {
    release();
    await f.close();
  }
});

test('source changes invalidate an in-flight read without accepting its late preview', async () => {
  let release = () => {};
  const readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ readGate });
  try {
    await f.page.getByRole('button', { name: 'Review stalled claims', exact: true }).click();
    await f.page.getByRole('status').filter({ hasText: 'Loading' }).waitFor();
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ sourceKey: 'changed' }));
    await f.page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    release();
    await settle(f.page);
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
    assert.equal(
      await f.page
        .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
        .count(),
      0,
    );
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET'],
    );
  } finally {
    release();
    await f.close();
  }
});

for (const state of [{ budgetFrozen: true }, { transactionsEnabled: false }]) {
  test(`preview gates block authorization: ${JSON.stringify(state)}`, async () => {
    const f = await fixture({ preview: { ...preview, ...state } });
    try {
      await open(f);
      await acknowledge(f);
      assert.equal(
        await f.page
          .getByRole('button', { name: 'Authorize fresh claim attempts', exact: true })
          .isDisabled(),
        true,
      );
      await f.page
        .locator('form')
        .evaluate((form) =>
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
      await settle(f.page);
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['GET'],
      );
    } finally {
      await f.close();
    }
  });
}

test('a newly frozen budget clears consent and disables another review', async () => {
  const f = await fixture();
  try {
    await open(f);
    await acknowledge(f);
    await f.page.evaluate(() => window.claimRecoveryFixture.update({ budgetFrozen: true }));
    await f.page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    assert.equal(await f.page.getByRole('checkbox').count(), 0);
    assert.equal(
      await f.page
        .getByRole('button', { name: 'Refresh recovery status', exact: true })
        .isDisabled(),
      true,
    );
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['GET'],
    );
  } finally {
    await f.close();
  }
});
