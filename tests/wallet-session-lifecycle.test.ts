import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectedStandardSolanaWallet } from '@privy-io/js-sdk-core';
import { disconnectWalletSession } from '../src/wallet-session-lifecycle.ts';

function provider(name: string, initial = ['wallet-A']) {
  let addresses = initial;
  let disconnectCalls = 0;
  const standardWallet = {
    name,
    get accounts() {
      return addresses.map((address) => ({ address }));
    },
    features: {
      'standard:disconnect': {
        disconnect: async () => {
          disconnectCalls++;
          addresses = [];
        },
      },
    },
  };
  return {
    standardWallet,
    wallets: initial.map(
      (address) =>
        new ConnectedStandardSolanaWallet({
          wallet: standardWallet as never,
          account: { address } as never,
        }),
    ),
    connect: (chosen: string) => {
      // Standard wallet connect may return its existing authorized accounts.
      if (!addresses.length) addresses = [chosen];
      return [...addresses];
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
  };
}

test('sign-out disconnects the actual SDK provider so a subsequent chosen wallet B replaces A', async () => {
  const phantom = provider('Phantom');
  let authenticated = true;
  await disconnectWalletSession(phantom.wallets, async () => {
    authenticated = false;
  });
  assert.equal(authenticated, false);
  assert.deepEqual(phantom.connect('wallet-B'), ['wallet-B']);
  assert.equal(phantom.disconnectCalls, 1);
});

test('disconnect each external provider once, including unlinked accounts, before auth logout', async () => {
  const phantom = provider('Phantom', ['wallet-A', 'wallet-A-second']);
  const metamask = provider('MetaMask', ['unlinked']);
  await disconnectWalletSession([...phantom.wallets, ...metamask.wallets], async () => {
    assert.equal(phantom.standardWallet.accounts.length, 0);
    assert.equal(metamask.standardWallet.accounts.length, 0);
  });
  assert.equal(phantom.disconnectCalls, 1);
  assert.equal(metamask.disconnectCalls, 1);
});

import {
  WalletSessionLifecycle,
  walletSessionAction,
  walletSessionRequest,
} from '../src/wallet-session-lifecycle.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const identity = (userId: string | null, address = 'wallet-A') => ({
  userId,
  linkedAddresses: userId ? [address] : [],
  connectedAddresses: userId ? [`Phantom:${address}`] : [],
});

test('logout is single-flight, revokes old work immediately, and permits B and the same wallet after fresh login', async () => {
  for (const next of ['wallet-B', 'wallet-A']) {
    const life = new WalletSessionLifecycle();
    const generation = life.observe(identity('user-A'));
    const old = life.capture(generation);
    const disconnect = deferred<void>();
    let disconnects = 0;
    let logouts = 0;
    const wallet = {
      standardWallet: { name: 'Phantom' },
      disconnect: () => {
        disconnects++;
        return disconnect.promise;
      },
    };
    const run = () =>
      life.logout([wallet], async () => {
        logouts++;
      });
    const first = run();
    const second = run();
    assert.equal(first, second);
    assert.equal(life.pending, true);
    assert.equal(old.signal.aborted, true);
    assert.throws(() => old.assertCurrent(), /session changed/);
    assert.throws(() => life.capture(life.generation), /session changed/);
    disconnect.resolve();
    await first;
    assert.equal(disconnects, 1);
    assert.equal(logouts, 1);
    // A still-stale authenticated React render cannot revive the signed-out user.
    life.observe(identity('user-A'));
    assert.equal(life.blocked, true);
    life.observe(identity(null));
    const current = life.observe(identity(next === 'wallet-A' ? 'user-A' : 'user-B', next));
    assert.equal(life.blocked, false);
    life.capture(current).assertCurrent();
    assert.throws(() => old.assertCurrent(), /session changed/);
  }
});

test('failed provider cleanup still logs out, blocks reuse, and retries retained providers even after SDK list clears', async () => {
  const life = new WalletSessionLifecycle();
  life.observe(identity('user-A'));
  let attempts = 0;
  let logouts = 0;
  const wallet = {
    standardWallet: { name: 'MetaMask' },
    disconnect: async () => {
      if (++attempts === 1) throw new Error('extension denied');
    },
  };
  await assert.rejects(
    life.logout([wallet], async () => {
      logouts++;
    }),
    /Retry sign-out/,
  );
  life.observe(identity(null));
  assert.equal(life.pending, false);
  assert.equal(life.blocked, true);
  await life.logout([], async () => {
    logouts++;
  });
  assert.equal(attempts, 2);
  assert.equal(logouts, 2);
  life.observe(identity('user-B', 'wallet-B'));
  life.capture(life.generation).assertCurrent();
});

test('authentication logout failure and a provider that falsely reports disconnect success cannot reopen the old session', async () => {
  const life = new WalletSessionLifecycle();
  life.observe(identity('user-A'));
  await assert.rejects(
    life.logout([], async () => {
      throw new Error('auth failed');
    }),
    /Retry sign-out/,
  );
  assert.equal(life.blocked, true);
  await life.logout([], async () => {});
  assert.equal(life.blocked, true);
  life.observe(identity(null));
  assert.equal(life.blocked, false);
  const wallet = {
    standardWallet: { name: 'Phantom', accounts: [{ address: 'wallet-A' }] },
    disconnect: async () => {},
  };
  await assert.rejects(
    life.logout([wallet], async () => {}),
    /Retry sign-out/,
  );
  assert.equal(life.blocked, true);
});

test('a delayed token cannot launch a request after logout or an account switch', async () => {
  for (const transition of ['logout', 'account-switch']) {
    const life = new WalletSessionLifecycle();
    const generation = life.observe(identity('user-A'));
    const token = deferred<string>();
    let fetches = 0;
    const pending = walletSessionRequest(
      life.capture(generation),
      () => token.promise,
      '/api/launch/prepare',
      { method: 'POST' },
      async () => {
        fetches++;
        return new Response('{}');
      },
    );
    if (transition === 'logout') await life.logout([], async () => {});
    else life.observe(identity('user-B', 'wallet-B'));
    token.resolve('old-token');
    await assert.rejects(pending, /session changed/);
    assert.equal(fetches, 0);
  }
});

test('in-flight fetch is aborted and even a transport ignoring cancellation cannot return old-account data', async () => {
  const life = new WalletSessionLifecycle();
  const generation = life.observe(identity('user-A'));
  const response = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const started = deferred<void>();
  const pending = walletSessionRequest(
    life.capture(generation),
    async () => 'token-A',
    '/api/launches',
    {},
    async (_path, init) => {
      signal = init?.signal;
      started.resolve();
      return response.promise;
    },
  );
  await started.promise;
  life.observe(identity('user-B', 'wallet-B'));
  assert.equal(signal?.aborted, true);
  response.resolve(new Response(JSON.stringify({ private: 'old-user' })));
  await assert.rejects(pending, /session changed/);
});

test('session changes during body decoding also discard the result', async () => {
  const life = new WalletSessionLifecycle();
  const generation = life.observe(identity('user-A'));
  const body = deferred<unknown>();
  const reading = deferred<void>();
  const pending = walletSessionRequest(
    life.capture(generation),
    async () => 'token-A',
    '/api/launches',
    {},
    async () =>
      ({
        ok: true,
        json: () => {
          reading.resolve();
          return body.promise;
        },
      }) as Response,
  );
  await reading.promise;
  life.observe(identity(null));
  body.resolve({ launches: ['A'] });
  await assert.rejects(pending, /session changed/);
});

test('a pending wallet signature cannot escape into a subsequent account, and rejected signing can be retried', async () => {
  const life = new WalletSessionLifecycle();
  const generation = life.observe(identity('user-A'));
  const signed = deferred<string>();
  const pending = walletSessionAction(life.capture(generation), () => signed.promise);
  life.observe(identity('user-B', 'wallet-B'));
  signed.resolve('signed-by-A');
  await assert.rejects(pending, /session changed/);
  const current = life.capture(life.generation);
  await assert.rejects(
    walletSessionAction(current, async () => {
      throw new Error('User cancelled');
    }),
    /cancelled/,
  );
  assert.equal(await walletSessionAction(current, async () => 'signed-by-B'), 'signed-by-B');
});

test('live provider account change is rejected even before React handles its Wallet Standard event', async () => {
  const life = new WalletSessionLifecycle();
  const generation = life.observe(identity('user-A'));
  let account = 'wallet-A';
  const scope = life.capture(generation, () => account === 'wallet-A');
  const signed = deferred<string>();
  const pending = walletSessionAction(scope, () => signed.promise);
  account = 'wallet-B';
  signed.resolve('obsolete');
  await assert.rejects(pending, /session changed/);
});

test('identity order changes are stable; auth, linked accounts, connected provider, or unmount revoke prior work', () => {
  const life = new WalletSessionLifecycle();
  const a = life.observe({
    userId: 'user-A',
    linkedAddresses: ['A', 'B'],
    connectedAddresses: ['Phantom:A', 'MetaMask:B'],
  });
  assert.equal(
    life.observe({
      userId: 'user-A',
      linkedAddresses: ['B', 'A'],
      connectedAddresses: ['MetaMask:B', 'Phantom:A'],
    }),
    a,
  );
  const previous = life.capture(a);
  life.observe({
    userId: 'user-A',
    linkedAddresses: ['A', 'B'],
    connectedAddresses: ['MetaMask:A'],
  });
  assert.throws(() => previous.assertCurrent(), /session changed/);
  const active = life.capture(life.generation);
  life.dispose();
  assert.throws(() => active.assertCurrent(), /session changed/);
});

test('caller cancellation and service errors are preserved; embedded wallet providers are not disconnected', async () => {
  const life = new WalletSessionLifecycle();
  const generation = life.observe(identity('user-A'));
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    walletSessionRequest(
      life.capture(generation),
      async () => 'token',
      '/api/launches',
      { signal: caller.signal },
      async (_path, init) => {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException('Aborted', 'AbortError');
      },
    ),
    /Aborted/,
  );
  await assert.rejects(
    walletSessionRequest(
      life.capture(generation),
      async () => 'token',
      '/api/launches',
      {},
      async () =>
        new Response(JSON.stringify({ error: 'existing launch pending' }), { status: 409 }),
    ),
    /existing launch pending/,
  );
  await disconnectWalletSession(
    [
      {
        standardWallet: { name: 'Privy' },
        disconnect: async () => {
          assert.fail('embedded wallet disconnect');
        },
      },
    ],
    async () => {},
  );
});
