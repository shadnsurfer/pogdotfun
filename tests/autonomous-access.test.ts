import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.ts';

async function fixture() {
  let externalCalls = 0;
  const app = createApp({
    dbPath: ':memory:',
    publicServices: {
      env: {},
      fetch: async () => {
        externalCalls++;
        throw new Error('Tests must not access external services.');
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  return {
    app,
    origin: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    externalCalls: () => externalCalls,
  };
}

test('autonomous API has no admin session, worker-run, or browser access with any presented credential', async () => {
  const f = await fixture();
  const secret = 'fixture-secret-do-not-reflect';
  try {
    const routes = [
      ['GET', '/api/admin/session'],
      ['POST', '/api/admin/session'],
      ['POST', '/api/admin/workers/run'],
      ['GET', '/api/admin/browser'],
      ['POST', '/api/admin/browser'],
      ['GET', '/api/admin/browser/sessions'],
      ['POST', '/api/admin/browser/sessions'],
      ['GET', '/api/admin/browser/attempts/fixture/live-view'],
      ['POST', '/api/admin/browser/attempts/fixture/handoff'],
    ];
    for (const headers of [
      {},
      { cookie: `pog_admin=${secret}` },
      { authorization: `Bearer ${secret}` },
      { cookie: `pog_admin=${secret}`, authorization: `Bearer ${secret}` },
    ]) {
      for (const [method, path] of routes) {
        const response = await fetch(`${f.origin}${path}`, {
          method,
          headers: {
            ...headers,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          } as Record<string, string>,
          ...(method === 'POST'
            ? { body: JSON.stringify({ token: secret, password: secret }) }
            : {}),
          redirect: 'error',
        });
        assert.equal(response.status, 404, `${method} ${path}`);
        const body = await response.text();
        assert.deepEqual(JSON.parse(body), { error: 'This API route does not exist.' });
        assert.equal(response.headers.get('set-cookie'), null);
        assert.doesNotMatch(
          body + JSON.stringify([...response.headers]),
          /fixture-secret-do-not-reflect|connectUrl|signingKey|debuggerFullscreenUrl|privateKey/,
        );
      }
    }
    assert.equal(f.externalCalls(), 0);
  } finally {
    await f.app.close();
  }
});

test('unconfigured health reports autonomous operation with disabled funding and no human access', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.origin}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.providerReadiness.autonomous, true);
    assert.equal(body.providerReadiness.enabled, false);
    assert.equal(body.providerReadiness.settlementConfigured, false);
    assert.equal(body.providerReadiness.fundingProvider, 'coinbase');
    assert.equal(body.providerReadiness.humanAccess, false);
    assert.doesNotMatch(
      JSON.stringify(body),
      /access_token|client_secret|private_key|connectUrl|signingKey/,
    );
    assert.equal(f.externalCalls(), 0);
  } finally {
    await f.app.close();
  }
});

test('public endpoints project streamer-only USD proceeds without inventing a USD buyback reserve', async () => {
  let db!: DatabaseSync;
  const app = createApp({
    dbPath: ':memory:',
    publicServices: {
      env: {},
      fetch: async () => {
        throw new Error('No external calls');
      },
    },
    workerBindings: (context) => {
      db = context.db;
      return {};
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const job = {
      id: 'published-job',
      tokenId: 'token-1',
      chain: 'bnb',
      asset: 'BNB',
      amountBaseUnits: '100',
      decimals: 18,
      claimReference: 'claim-1',
      recipient: { platform: 'kick', providerId: 'kick:123', username: 'streamer' },
      phase: 'completed',
      allocationVersion: 'native-streamer-v1',
      netUsdCents: 8000,
      streamerBudgetUsdCents: 8000,
      platformReserveUsdCents: 0,
      spentUsdCents: 7500,
      residualUsdCents: 500,
      receiptReference: 'receipt-1',
      completedAt: '2026-09-18T12:00:00.000Z',
      cardAccountId: 'PRIVATE-CARD-ACCOUNT',
      conversionReference: 'PRIVATE-ORDER',
    };
    db.prepare('INSERT INTO agent_fee_jobs VALUES(?,?,?,0,?)').run(
      job.id,
      'bnb:claim-1:token-1',
      job.phase,
      JSON.stringify(job),
    );
    const donations = await (await fetch(`${origin}/api/donations`)).json();
    assert.equal(donations.donations[0].spentUsdCents, 7500);
    assert.equal(donations.ledger.platformReserveUsdCents, 0);
    assert.equal(donations.ledger.heldUsdCents, 500);
    assert.equal(donations.ledger.byChain.bnb.spentUsdCents, 7500);
    assert.doesNotMatch(JSON.stringify(donations), /PRIVATE-/);
    const catalog = await (await fetch(`${origin}/api/catalog`)).json();
    assert.equal(catalog.stats.totalDonatedUsdCents, 7500);
    assert.equal(catalog.stats.platformReserveUsdCents, 0);
    assert.equal(catalog.stats.heldUsdCents, 500);
    assert.equal(catalog.stats.cardResidualUsdCents, 0);
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE-/);
  } finally {
    await app.close();
  }
});
