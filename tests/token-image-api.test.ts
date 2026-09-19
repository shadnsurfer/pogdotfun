import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import sharp from 'sharp';
import { createApp } from '../server/app.ts';
import { createOperations } from '../server/operations.ts';
import { prepareTokenImageAsset, TokenImageAssets } from '../server/public/image-assets.ts';

test('public token image route serves only immutable stored WebP and catalog uses its same-origin URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pog-image-api-'));
  const dbPath = join(directory, 'images.sqlite');
  let providerCalls = 0;
  const app = createApp({
    dbPath,
    production: true,
    publicServices: {
      env: {},
      fetch: async (url) => {
        assert.equal(new URL(String(url)).origin, 'https://api.dexscreener.com');
        providerCalls++;
        return Response.json([]);
      },
    },
  });
  const db = new DatabaseSync(dbPath);
  const uri = 'https://fixture.example.test/private-owner/original.png';
  const original = await sharp({
    create: { width: 1000, height: 500, channels: 3, background: '#9944cc' },
  })
    .png()
    .toBuffer();
  const asset = await prepareTokenImageAsset(
    `data:image/png;base64,${original.toString('base64')}`,
  );
  new TokenImageAssets(db).save(uri, asset);
  db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
    'private-owner-id',
    'private-digest',
    uri,
  );
  const token = createOperations(db, { streamerBps: 8000 }).registerToken(
    {
      name: 'Fast Image',
      symbol: 'IMG',
      mint: Keypair.generate().publicKey.toBase58(),
      creatorAddress: Keypair.generate().publicKey.toBase58(),
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'image_streamer',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    'fixture',
  );
  db.prepare(
    'INSERT INTO launch_intents(id,user_id,request_id,fingerprint,mint,creator,status,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    'image-launch',
    'private-owner-id',
    'image-request',
    'private-fingerprint',
    token.mint,
    token.creatorAddress,
    'confirmed',
    token.createdAt,
    JSON.stringify({ tokenId: token.id, imageUri: uri, recipient: { id: 'twitch:123' } }),
  );
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const path = `/api/token-images/${asset.id}`;
  try {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('content-length'), String(asset.bytes.byteLength));
    assert.equal(response.headers.get('etag'), `"${asset.id}"`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    for (const header of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'])
      assert.equal(response.headers.get(header), 'public, max-age=31536000, immutable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(bytes, new Uint8Array(asset.bytes));
    assert.doesNotMatch(
      Buffer.from(bytes).toString(),
      /private-owner|private-digest|private-fingerprint/,
    );
    assert.equal(providerCalls, 0, 'reading an image must never fetch an arbitrary remote URI');
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(catalog.tokens[0].image, path);
    assert.equal(catalog.tokens[0].id, token.id);
    assert.equal(catalog.tokens[0].donatedUsdCents, 0);

    for (const [url, method, status] of [
      [path + '?url=https://untrusted.invalid', 'GET', 400],
      [path, 'POST', 405],
      [`/api/token-images/${'a'.repeat(64)}`, 'GET', 404],
      [`/api/token-images/${asset.id.toUpperCase()}`, 'GET', 404],
      ['/api/token-images/owner/private-owner-id', 'GET', 404],
    ] as const) {
      const rejected = await fetch(base + url, { method });
      assert.equal(rejected.status, status);
      assert.equal(rejected.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(
        await rejected.text(),
        /private-owner-id|private-digest|private-fingerprint|fixture.example.test/,
      );
    }
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
