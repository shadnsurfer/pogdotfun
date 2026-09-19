import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { TwitchCheckoutError } from '../server/providers/twitch-checkout.ts';
import {
  BrowserbaseCdpConnector,
  BrowserCdpError,
  type OwnedBrowserLease,
} from '../server/providers/browserbase-cdp.ts';

const lease: OwnedBrowserLease = {
  paymentId: 'payment-1',
  sessionId: 'session-1',
  contextId: 'context-1',
  browserAttemptId: 'attempt-1',
  leaseId: 'lease-1',
};

test('known checkout failures preserve a sanitized phase across the CDP boundary', async () => {
  const t = fixture();
  const error = new TwitchCheckoutError('unexpected_checkout', 'channel_heading');
  error.message = 'private capability or card details';
  await assert.rejects(
    t.connector.withOwnedPage(lease, async () => {
      throw error;
    }),
    (caught) =>
      caught instanceof TwitchCheckoutError &&
      caught.phase === 'channel_heading' &&
      !caught.message.includes('private'),
  );
  assert.equal(t.closes(), 1);
  assert.equal(t.connector.hasActiveConnection(lease.sessionId), false);
});
function fixture() {
  let owned = true,
    connected = true,
    gets = 0,
    connects = 0,
    closes = 0;
  const request: { url: string; init?: RequestInit }[] = [];
  let now = Date.parse('2026-09-16T00:00:00Z');
  const payload: Record<string, unknown> = {
    id: lease.sessionId,
    projectId: 'project-1',
    contextId: lease.contextId,
    status: 'RUNNING',
    keepAlive: true,
    expiresAt: '2026-09-16T00:30:00Z',
    userMetadata: { pogAttemptId: lease.browserAttemptId },
    connectUrl: 'wss://connect.browserbase.com/?apiKey=private-capability&sessionId=session-1',
  };
  const page = {
    isClosed: () => false,
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  } as unknown as Page;
  const context = { pages: () => [page] } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    isConnected: () => connected,
    async close() {
      closes++;
      connected = false;
    },
  } as unknown as Browser;
  const dependencies = {
    ownsLease: (value: Readonly<OwnedBrowserLease>) => owned && value.leaseId === lease.leaseId,
    now: () => now,
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      gets++;
      request.push({ url: String(input), init });
      return new Response(JSON.stringify(payload));
    },
    connect: async (_url: string, options: { timeout: number; noDefaults: true }) => {
      connects++;
      assert.equal(options.noDefaults, true);
      assert.ok(options.timeout > 0);
      return browser;
    },
  };
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    dependencies,
  );
  return {
    connector,
    dependencies,
    payload,
    page,
    context,
    browser,
    request,
    gets: () => gets,
    connects: () => connects,
    closes: () => closes,
    setOwned: (value: boolean) => {
      owned = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

test('attaches only the existing owned keep-alive session and disconnects without lifecycle mutations', async () => {
  const t = fixture();
  const result = await t.connector.withOwnedPage(lease, async ({ page, context, assertOwned }) => {
    assert.equal(page, t.page);
    assert.equal(context, t.context);
    assertOwned();
    assert.equal(t.connector.hasActiveConnection(lease.sessionId), true);
    return { observed: true };
  });
  assert.deepEqual(result, { observed: true });
  assert.equal(t.gets(), 1);
  assert.equal(t.connects(), 1);
  assert.equal(t.closes(), 1);
  assert.equal(t.request[0].url, 'https://api.browserbase.com/v1/sessions/session-1');
  assert.equal(t.request[0].init?.method, 'GET');
  assert.equal(t.request[0].init?.redirect, 'error');
  assert.equal(t.request[0].init?.body, undefined);
  assert.equal(t.connector.hasActiveConnection(lease.sessionId), false);
  assert.equal(JSON.stringify(t.connector).includes('private-'), false);
});

test('lost ownership before retrieval or during retrieval prevents a CDP connection', async () => {
  for (const when of ['before', 'during']) {
    const t = fixture();
    if (when === 'before') t.setOwned(false);
    else {
      const read = t.dependencies.fetch;
      t.dependencies.fetch = async (...args) => {
        const response = await read(...args);
        t.setOwned(false);
        return response;
      };
    }
    const connector = new BrowserbaseCdpConnector(
      { apiKey: 'private-api-key', projectId: 'project-1' },
      t.dependencies,
    );
    await assert.rejects(
      () =>
        connector.withOwnedPage(lease, async () => {
          throw Error('must not run');
        }),
      BrowserCdpError,
    );
    assert.equal(t.gets(), when === 'before' ? 0 : 1);
    assert.equal(t.connects(), 0);
  }
});

test('wrong project, context, attempt, session, status, expiry, or keep-alive never reaches connect', async () => {
  for (const changed of [
    { projectId: 'wrong' },
    { contextId: 'wrong' },
    { userMetadata: { pogAttemptId: 'wrong' } },
    { id: 'wrong' },
    { status: 'PENDING' },
    { expiresAt: 'invalid' },
    { expiresAt: '2020-01-01T00:00:00Z' },
    { keepAlive: false },
  ]) {
    const t = fixture();
    Object.assign(t.payload, changed);
    await assert.rejects(() => t.connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
    assert.equal(t.connects(), 0);
  }
});

test('untrusted URLs and connection URLs for another session are rejected without disclosure', async () => {
  for (const connectUrl of [
    'ws://connect.browserbase.com/?sessionId=session-1',
    'wss://connect.browserbase.com.evil.test/?sessionId=session-1',
    'wss://connect.evil.test/?sessionId=session-1',
    'wss://private:password@connect.browserbase.com/?sessionId=session-1',
    'wss://connect.browserbase.com:444/?sessionId=session-1',
    'wss://connect.browserbase.com/?sessionId=wrong',
    'wss://connect.browserbase.com/?sessionId=session-1&sessionId=wrong',
    'wss://connect.browserbase.com/?apiKey=private-capability',
    'wss://connect.browserbase.com/?sessionId=session-1#private-fragment',
  ]) {
    const t = fixture();
    t.payload.connectUrl = connectUrl;
    await assert.rejects(
      () => t.connector.withOwnedPage(lease, async () => {}),
      (error) =>
        error instanceof BrowserCdpError &&
        !String(error).includes(connectUrl) &&
        !String(error).includes('private-'),
    );
    assert.equal(t.connects(), 0);
  }
});

test('ownership lost while CDP connects disconnects before any driver callback', async () => {
  const t = fixture();
  let callbacks = 0;
  const connect = t.dependencies.connect;
  t.dependencies.connect = async (...args) => {
    const browser = await connect(...args);
    t.setOwned(false);
    return browser;
  };
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    t.dependencies,
  );
  await assert.rejects(
    () =>
      connector.withOwnedPage(lease, async () => {
        callbacks++;
      }),
    BrowserCdpError,
  );
  assert.equal(t.closes(), 1);
  assert.equal(callbacks, 0);
  assert.equal(connector.hasActiveConnection(lease.sessionId), false);
});

test('an expired session after connect is detached before inspection', async () => {
  const t = fixture();
  const connect = t.dependencies.connect;
  t.dependencies.connect = async (...args) => {
    const browser = await connect(...args);
    t.setNow(Date.parse('2026-09-17T00:00:00Z'));
    return browser;
  };
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    t.dependencies,
  );
  await assert.rejects(() => connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
  assert.equal(t.closes(), 1);
});

test('callback exceptions and lost ownership are sanitized and always disconnect', async () => {
  for (const mode of ['throw', 'lease-loss']) {
    const t = fixture();
    await assert.rejects(
      () =>
        t.connector.withOwnedPage(lease, async () => {
          if (mode === 'throw') throw Error('private-api-key private-cookie 4111111111111111');
          t.setOwned(false);
          return 'private-result';
        }),
      (error) =>
        error instanceof BrowserCdpError &&
        !JSON.stringify(error).includes('private-') &&
        !String(error).includes('411111'),
    );
    assert.equal(t.closes(), 1);
  }
});

test('failed attachment exposes no raw error and clears its local connection guard', async () => {
  const t = fixture();
  t.dependencies.connect = async () => {
    throw Error('wss://connect.browserbase.com/?apiKey=private-capability');
  };
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    t.dependencies,
  );
  await assert.rejects(
    () => connector.withOwnedPage(lease, async () => {}),
    (error) => error instanceof BrowserCdpError && !String(error).includes('private-'),
  );
  assert.equal(connector.hasActiveConnection(lease.sessionId), false);
});

test('a missing existing page does not create one and still disconnects', async () => {
  const t = fixture();
  t.context.pages = () => [];
  await assert.rejects(() => t.connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
  assert.equal(t.closes(), 1);
});

test('concurrent attachments to one session are rejected even with the same valid lease', async () => {
  const t = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const run = t.connector.withOwnedPage(lease, async () => {
    entered();
    await hold;
  });
  await started;
  try {
    const other = new BrowserbaseCdpConnector(
      { apiKey: 'private-api-key', projectId: 'project-1' },
      t.dependencies,
    );
    await assert.rejects(() => other.withOwnedPage(lease, async () => {}), BrowserCdpError);
    assert.equal(t.connects(), 1);
  } finally {
    release();
    await run;
  }
});

test('supports the documented existing-session debug path without provisioning', async () => {
  const t = fixture();
  t.payload.connectUrl = 'wss://connect.browserbase.com/debug/session-1/devtools/browser/browser-1';
  await t.connector.withOwnedPage(lease, async () => {});
  assert.equal(t.gets(), 1);
  assert.equal(t.connects(), 1);
  assert.equal(t.closes(), 1);
});

test('attaches a regional signed URL only using the matching owned REST session capability', async () => {
  for (const suffix of ['', '&sessionId=session-1']) {
    const t = fixture();
    t.payload.signingKey = 'private-session-capability';
    const connectUrl = `wss://connect.usw2.browserbase.com/?signingKey=private-session-capability${suffix}`;
    t.payload.connectUrl = connectUrl;
    const connect = t.dependencies.connect;
    t.dependencies.connect = async (url, options) => {
      assert.equal(url, connectUrl);
      assert.equal(t.gets(), 1);
      return connect(url, options);
    };
    const connector = new BrowserbaseCdpConnector(
      { apiKey: 'private-api-key', projectId: 'project-1' },
      t.dependencies,
    );
    assert.equal(await connector.withOwnedPage(lease, async () => 'observed'), 'observed');
    assert.equal(t.connects(), 1);
    assert.equal(t.closes(), 1);
    assert.equal(t.request[0].init?.method, 'GET');
    assert.equal(connector.hasActiveConnection(lease.sessionId), false);
    assert.equal(JSON.stringify(connector).includes('private-'), false);
  }
});

test('signed URLs reject absent, empty, mismatched, duplicate or conflicting binding credentials', async () => {
  for (const changed of [
    { signingKey: undefined },
    { signingKey: '' },
    { signingKey: 'private-other-capability' },
    { connectUrl: 'wss://connect.usw2.browserbase.com/' },
    { connectUrl: 'wss://connect.usw2.browserbase.com/?apiKey=private-api-key' },
    { connectUrl: 'wss://connect.usw2.browserbase.com/?signingKey=' },
    { connectUrl: 'wss://connect.usw2.browserbase.com/?signingKey=%20', signingKey: ' ' },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&signingKey=private-session-capability',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&signingKey=private-other-capability',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&sessionId=wrong',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&sessionId=session-1&sessionId=session-1',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-other-capability&sessionId=session-1',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&apiKey=private-api-key',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability&SessionId=wrong',
    },
    {
      connectUrl:
        'wss://connect.usw2.browserbase.com.evil.test/?signingKey=private-session-capability',
    },
    { connectUrl: 'ws://connect.usw2.browserbase.com/?signingKey=private-session-capability' },
    {
      connectUrl: 'wss://connect.usw2.browserbase.com/create?signingKey=private-session-capability',
    },
  ]) {
    const t = fixture();
    Object.assign(
      t.payload,
      {
        signingKey: 'private-session-capability',
        connectUrl: 'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability',
      },
      changed,
    );
    await assert.rejects(
      () => t.connector.withOwnedPage(lease, async () => {}),
      (error) =>
        error instanceof BrowserCdpError &&
        error.code === 'connection_invalid' &&
        !String(error).includes('private-') &&
        !JSON.stringify(error).includes('private-'),
    );
    assert.equal(t.connects(), 0);
    assert.equal(t.connector.hasActiveConnection(lease.sessionId), false);
  }
});

test('a matching signing key never replaces session ownership and liveness checks', async () => {
  for (const changed of [
    { projectId: 'wrong' },
    { contextId: 'wrong' },
    { userMetadata: { pogAttemptId: 'wrong' } },
    { id: 'wrong' },
    { status: 'COMPLETED' },
    { expiresAt: '2020-01-01T00:00:00Z' },
    { keepAlive: false },
  ]) {
    const t = fixture();
    Object.assign(
      t.payload,
      {
        signingKey: 'private-session-capability',
        connectUrl: 'wss://connect.usw2.browserbase.com/?signingKey=private-session-capability',
      },
      changed,
    );
    await assert.rejects(() => t.connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
    assert.equal(t.connects(), 0);
  }
});

test('recovered browser metadata binds its provider generation while retaining the logical attempt lease', async () => {
  for (const providerAttemptId of ['generation-1', 'attempt-1']) {
    const t = fixture();
    t.payload.userMetadata = { pogAttemptId: providerAttemptId };
    const currentLease = { ...lease, providerAttemptId: 'generation-1' };
    const checked: Readonly<OwnedBrowserLease>[] = [];
    const connector = new BrowserbaseCdpConnector(
      { apiKey: 'private-api-key', projectId: 'project-1' },
      {
        ...t.dependencies,
        ownsLease(value) {
          checked.push(value);
          return (
            value.browserAttemptId === 'attempt-1' && value.providerAttemptId === 'generation-1'
          );
        },
      },
    );
    if (providerAttemptId === 'generation-1') {
      await connector.withOwnedPage(currentLease, async () => {});
      assert.equal(t.connects(), 1);
    } else {
      await assert.rejects(
        () => connector.withOwnedPage(currentLease, async () => {}),
        BrowserCdpError,
      );
      assert.equal(t.connects(), 0);
    }
    assert.ok(checked.length > 0);
    assert.ok(
      checked.every(
        (value) =>
          value.browserAttemptId === 'attempt-1' && value.providerAttemptId === 'generation-1',
      ),
    );
  }
});

test('an async ownership callback is never accepted as a live exclusive claim', async () => {
  const t = fixture();
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    {
      ...t.dependencies,
      ownsLease: (() => Promise.resolve(true)) as unknown as (value: OwnedBrowserLease) => boolean,
    },
  );
  await assert.rejects(() => connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
  assert.equal(t.gets(), 0);
  assert.equal(t.connects(), 0);
});

test('provider failures discard raw response bodies and callback failures discard raw errors', async () => {
  for (const mode of ['http', 'json', 'callback']) {
    const t = fixture();
    if (mode === 'http')
      t.dependencies.fetch = async () => new Response('private-card-and-key', { status: 503 });
    if (mode === 'json') t.dependencies.fetch = async () => new Response('private-invalid-json');
    if (mode === 'callback')
      t.dependencies.ownsLease = () => {
        throw Error('private-card-and-key');
      };
    const connector = new BrowserbaseCdpConnector(
      { apiKey: 'private-api-key', projectId: 'project-1' },
      t.dependencies,
    );
    await assert.rejects(
      () => connector.withOwnedPage(lease, async () => {}),
      (error) => error instanceof BrowserCdpError && !String(error).includes('private-'),
    );
    assert.equal(t.connects(), 0);
  }
});

test('verbose Playwright logging is rejected before retrieval', async () => {
  const previous = process.env.DEBUG;
  try {
    process.env.DEBUG = 'pw:*';
    const t = fixture();
    await assert.rejects(() => t.connector.withOwnedPage(lease, async () => {}), BrowserCdpError);
    assert.equal(t.gets(), 0);
  } finally {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  }
});

test('multiple contexts are ambiguous and never reach a driver', async () => {
  const t = fixture();
  t.browser.contexts = () => [t.context, t.context];
  let callbacks = 0;
  await assert.rejects(
    () =>
      t.connector.withOwnedPage(lease, async () => {
        callbacks++;
      }),
    BrowserCdpError,
  );
  assert.equal(callbacks, 0);
  assert.equal(t.closes(), 1);
});

test('multiple open pages are ambiguous while a closed page is safely ignored', async () => {
  for (const secondPageClosed of [false, true]) {
    const t = fixture();
    const second = { ...t.page, isClosed: () => secondPageClosed } as Page;
    t.context.pages = () => [t.page, second];
    let callbacks = 0;
    const run = () =>
      t.connector.withOwnedPage(lease, async ({ page }) => {
        assert.equal(page, t.page);
        callbacks++;
      });
    if (secondPageClosed) await run();
    else
      await assert.rejects(
        run,
        (error) => error instanceof BrowserCdpError && error.code === 'page_unavailable',
      );
    assert.equal(callbacks, secondPageClosed ? 1 : 0);
    assert.equal(t.closes(), 1);
  }
});

test('lease input is snapshotted before asynchronous retrieval', async () => {
  const t = fixture();
  const input = { ...lease };
  let callbacks = 0;
  const read = t.dependencies.fetch;
  t.dependencies.fetch = async (...args) => {
    input.sessionId = 'other-session';
    input.leaseId = 'other-lease';
    return read(...args);
  };
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'project-1' },
    t.dependencies,
  );
  await connector.withOwnedPage(input, async () => {
    callbacks++;
  });
  assert.equal(callbacks, 1);
  assert.equal(t.connects(), 1);
});

test('a thrown close is safe only when the transport actually disconnected', async () => {
  const t = fixture();
  const close = t.browser.close.bind(t.browser);
  t.browser.close = async () => {
    await close();
    throw Error('private-close-output');
  };
  await t.connector.withOwnedPage(lease, async () => {});
  assert.equal(t.connector.hasActiveConnection(lease.sessionId), false);
});

test('a hung disconnect times out without releasing its ownership guard', async () => {
  const t = fixture();
  t.payload.projectId = 'timeout-project';
  t.browser.close = async () => new Promise<void>(() => {});
  const connector = new BrowserbaseCdpConnector(
    { apiKey: 'private-api-key', projectId: 'timeout-project', disconnectTimeoutMs: 100 },
    t.dependencies,
  );
  await assert.rejects(
    () => connector.withOwnedPage(lease, async () => {}),
    (error) => error instanceof BrowserCdpError && error.code === 'disconnect_failed',
  );
  assert.equal(connector.hasActiveConnection(lease.sessionId), true);
});

test('a failed disconnect keeps a guard until the connection is known closed', async () => {
  const t = fixture();
  t.browser.close = async () => {
    throw Error('private-close-payload');
  };
  await assert.rejects(
    () => t.connector.withOwnedPage(lease, async () => {}),
    (error) =>
      error instanceof BrowserCdpError &&
      error.code === 'disconnect_failed' &&
      !String(error).includes('private-'),
  );
  assert.equal(t.connector.hasActiveConnection(lease.sessionId), true);
  // The next test uses another session; this unresolved guard must not be force-cleared.
});
