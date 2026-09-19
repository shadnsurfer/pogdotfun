import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../server/app.ts';
import { createOperations } from '../server/operations.ts';

test(
  'catalog returns all205 durable identities and images while market provider is held',
  { timeout: 10_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pog-market-catalog-'));
    const dbPath = join(directory, 'catalog.sqlite');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const requested = new Set<string>();
    const app = createApp({
      dbPath,
      production: true,
      publicServices: {
        env: {},
        fetch: async (url, init) => {
          assert.equal(new URL(String(url)).origin, 'https://api.dexscreener.com');
          assert.equal(init?.redirect, 'error');
          const mints = String(url).split('/').at(-1)!.split(',');
          assert.ok(mints.length <= 30);
          calls++;
          for (const mint of mints) {
            assert.equal(requested.has(mint), false, 'coalesced refresh must not duplicate a mint');
            requested.add(mint);
          }
          await held;
          return Response.json(
            mints.map((mint) => ({
              chainId: 'solana',
              pairAddress: Keypair.generate().publicKey.toBase58(),
              baseToken: { address: mint },
              quoteToken: { address: 'So11111111111111111111111111111111111111112' },
              marketCap: 1234,
              volume: { h24: 12 },
              priceChange: { h24: 3 },
              liquidity: { usd: 100 },
            })),
          );
        },
      },
    });
    const db = new DatabaseSync(dbPath);
    const operations = createOperations(db, { streamerBps: 8000 });
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) {
      const token = operations.registerToken(
        {
          name: `Market Token ${i}`,
          symbol: 'MKT',
          mint: Keypair.generate().publicKey.toBase58(),
          creatorAddress: Keypair.generate().publicKey.toBase58(),
          chain: 'solana',
          launchpad: 'pump',
          recipientPlatform: 'twitch',
          recipientUsername: 'market_streamer',
          recipientVerified: true,
          dedicatedCreatorVerified: true,
        },
        'test',
      );
      ids.push(token.id);
      db.prepare(
        'INSERT INTO launch_intents(id,user_id,request_id,fingerprint,mint,creator,status,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
        `launch-${i}`,
        'fixture',
        `request-${i}`,
        `fingerprint-${i}`,
        token.mint,
        token.creatorAddress,
        'confirmed',
        token.createdAt,
        JSON.stringify({
          tokenId: token.id,
          launchId: `launch-${i}`,
          imageUri: `https://images.example.test/${i}.png`,
          description: `Saved ${i}`,
          recipient: { id: 'twitch:123' },
        }),
      );
    }
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/catalog`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Catalog waited for the held market provider.')),
          500,
        );
      });
      const requestedAt = performance.now();
      const response = await Promise.race([fetch(url).then((r) => r.json()), deadline]);
      t.diagnostic(
        `Held-provider catalog response: ${(performance.now() - requestedAt).toFixed(1)}ms; ${response.tokens.length} tokens; ${calls} active provider requests.`,
      );
      clearTimeout(timer);
      assert.equal(response.tokens.length, 205);
      assert.deepEqual(response.tokens.map((t: { id: string }) => t.id).sort(), ids.sort());
      assert.ok(
        response.tokens.every(
          (t: { image: string; mcap: null; donatedUsdCents: number }) =>
            t.image.startsWith('https://images.example.test/') &&
            t.mcap === null &&
            t.donatedUsdCents === 0,
        ),
      );
      assert.equal(response.marketData.refreshing, true);
      assert.ok(calls <= 3);
      const again = await (await fetch(url)).json();
      assert.equal(again.tokens.length, 205);
      assert.ok(calls <= 3);
      release();
      let updated = again;
      for (let i = 0; i < 50 && updated.marketData.refreshing; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        updated = await (await fetch(url)).json();
      }
      assert.equal(updated.tokens.length, 205);
      assert.ok(
        updated.tokens.every(
          (t: { mcap: number; marketDataStatus: string }) =>
            t.mcap === 1234 && t.marketDataStatus === 'fresh',
        ),
      );
      assert.equal(calls, 7);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await app.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
