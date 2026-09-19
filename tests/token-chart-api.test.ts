import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../server/app.ts';
import { createOperations } from '../server/operations.ts';

test('public charts resolve registered token mints and reject arbitrary proxies and writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pog-chart-api-'));
  const dbPath = join(directory, 'ledger.db');
  const db = new DatabaseSync(dbPath);
  const operations = createOperations(db, { streamerBps: 8000 });
  const token = operations.registerToken(
    {
      name: 'Chart token',
      symbol: 'CHART',
      mint: Keypair.generate().publicKey.toBase58(),
      creatorAddress: Keypair.generate().publicKey.toBase58(),
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'streamer',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    'fixture',
  );
  const calls: string[] = [];
  const app = createApp({
    dbPath,
    production: true,
    publicServices: {
      env: { POG_AUTOMATION_ENABLED: 'false' },
      fetch: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://api.geckoterminal.com');
        assert.equal(url.pathname, `/api/v2/networks/solana/tokens/${token.mint}/pools`);
        calls.push(url.href);
        return Response.json({ data: [] });
      },
    },
  });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const path = `${base}/api/tokens/${token.id}/chart`;
    const before = operations.snapshot();
    const response = await fetch(`${path}?range=7d`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.tokenId, token.id);
    assert.equal(result.mint, token.mint);
    assert.equal(result.range, '7d');
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.candles, []);
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.equal((await fetch(path)).status, 200);
    assert.equal(calls.length, 1, 'pool discovery is shared between ranges');
    for (const query of [
      'range=1y',
      'range=7d&range=24h',
      'mint=foreign',
      'range=7d&url=https://example.com',
    ])
      assert.equal((await fetch(`${path}?${query}`)).status, 400);
    for (const method of ['POST', 'DELETE', 'PUT'])
      assert.equal((await fetch(path, { method })).status, 405);
    assert.equal(
      (await fetch(`${base}/api/tokens/da655bb2-9b24-4ec2-ad4f-ac266a2c83e4/chart`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/api/tokens/${token.mint}/chart`)).status, 404);
    assert.equal(calls.length, 1);
    assert.deepEqual(operations.snapshot(), before, 'chart reads cannot affect the ledger');
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
