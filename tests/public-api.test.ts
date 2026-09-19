import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.ts';
const identity = {
  verify: async (token: string) => {
    if (!['valid', 'social', 'embedded'].includes(token)) throw Error();
    return `did:privy:${token}`;
  },
  getUser: async (id: string) => ({
    id,
    linked_accounts:
      id === 'did:privy:social'
        ? [{ type: 'google_oauth', email: 'person@example.test' }]
        : [
            {
              type: 'wallet',
              chain_type: 'solana',
              address: 'verified-external-wallet',
              ...(id === 'did:privy:embedded'
                ? { connector_type: 'embedded', wallet_client_type: 'privy' }
                : {}),
            },
          ],
  }),
};
async function start() {
  const app = createApp({
    dbPath: ':memory:',
    production: true,
    publicServices: { env: { PRIVY_APP_ID: 'public-id' }, identity },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { ...app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}
test('public config and empty catalog reveal no secrets or fabricated totals', async () => {
  const app = await start();
  try {
    const config = await (await fetch(`${app.url}/api/config`)).json();
    assert.equal(config.privyAppId, 'public-id');
    assert.equal(config.launchesEnabled, false);
    assert.equal('appSecret' in config, false);
    const catalog = await (await fetch(`${app.url}/api/catalog`)).json();
    assert.deepEqual(catalog.tokens, []);
    assert.deepEqual(catalog.streamers, []);
    assert.equal(catalog.stats.totalDonatedUsdCents, 0);
    assert.equal(catalog.stats.heldUsdCents, 0);
  } finally {
    await app.close();
  }
});
test('public mutations require user auth and disabled launch does not upload metadata', async () => {
  const app = await start();
  try {
    for (const path of ['/api/uploads/token-image', '/api/launches/prepare']) {
      const r = await fetch(app.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 401);
    }
    const r = await fetch(`${app.url}/api/launches/prepare`, {
      method: 'POST',
      headers: { authorization: 'Bearer valid', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 503);
    const me = await fetch(`${app.url}/api/me`, { headers: { authorization: 'Bearer valid' } });
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).walletAddresses, ['verified-external-wallet']);
    assert.equal(
      (await fetch(`${app.url}/api/streamers/lookup?platform=kick&username=someone`)).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test('public account and mutation routes reject social and embedded-only sessions', async () => {
  const app = await start();
  try {
    for (const token of ['social', 'embedded']) {
      for (const path of [
        '/api/me',
        '/api/streamers/lookup?platform=twitch&username=someone',
        '/api/uploads/token-image',
        '/api/launches/prepare',
      ]) {
        const isMutation = path === '/api/uploads/token-image' || path === '/api/launches/prepare';
        const response = await fetch(app.url + path, {
          method: isMutation ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(isMutation ? { body: '{}' } : {}),
        });
        assert.equal(response.status, 403, `${token} cannot access ${path}`);
        assert.match((await response.json()).error, /external Solana wallet/);
      }
    }
  } finally {
    await app.close();
  }
});
