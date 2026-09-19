import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretVault } from '../server/security/secret-vault.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import sharp from 'sharp';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { createApp } from '../server/app.ts';
import { PumpLaunchChain } from '../server/launch/pump-chain.ts';
import type { LaunchChain } from '../server/launch/types.ts';

test('HTTP launch flow hides launch history while binding active status, signatures, retries and receipts to their owner', async () => {
  const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const state = { pins: 0, builds: 0, broadcasts: 0, finalized: false };
  const builder = new PumpLaunchChain(
    {
      rpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: genesis,
      transactionsEnabled: false,
    },
    {
      getGenesisHash: async () => genesis,
      getMultipleAccountsInfo: async () => [null, null],
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 500,
      }),
      getBalance: async () => 1_000_000_000,
      simulateTransaction: async () => ({
        value: { err: null, accounts: [{ lamports: 980_000_000 }] },
      }),
      getFeeForMessage: async () => ({ value: 10_300 }),
    } as unknown as Connection,
  );
  const chain: LaunchChain = {
    prepare: async (plan, mint) => {
      state.builds++;
      return builder.prepare(plan, mint);
    },
    broadcast: async () => {
      state.broadcasts++;
    },
    reconcile: async (record) =>
      record.signature && state.finalized
        ? { status: 'confirmed', slot: 900 }
        : { status: 'pending' },
  };
  const temporary = mkdtempSync(join(tmpdir(), 'pog-api-test-'));
  const dbPath = join(temporary, 'test.db');
  const secretDb = new DatabaseSync(dbPath);
  const vault = new SecretVault(secretDb, Buffer.alloc(32, 9));
  for (const [name, value] of Object.entries({
    PINATA_API_KEY: 'test-key',
    PINATA_API_SECRET: 'test-secret',
    TWITCH_CLIENT_ID: 'test-twitch',
    TWITCH_CLIENT_SECRET: 'test-twitch-secret',
  }))
    vault.provision(name, value, ['identity']);
  vault.close();
  secretDb.close();
  const app = createApp({
    dbPath,
    production: true,
    launches: {
      launchesEnabled: true,
      transactionsEnabled: true,
      encryptionKey: new Uint8Array(32).fill(2),
      chain,
    },
    publicServices: {
      env: {
        PRIVY_APP_ID: 'public-test-id',
        POG_VAULT_KEY: Buffer.alloc(32, 9).toString('hex'),
      },
      identity: {
        verify: async (token) => {
          if (!['alice', 'bob'].includes(token)) throw Error();
          return `did:privy:${token}`;
        },
        getUser: async (id) => ({
          id,
          linked_accounts: [
            {
              type: 'wallet',
              chain_type: 'solana',
              address: (id === 'did:privy:alice' ? alice : bob).publicKey.toBase58(),
            },
          ],
        }),
      },
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.pinata.cloud') {
          state.pins++;
          return Response.json({ IpfsHash: 'Qm' + 'a'.repeat(44) });
        }
        if (url.hostname === 'id.twitch.tv')
          return Response.json({ access_token: 'fake-token', expires_in: 3600 });
        if (url.hostname === 'api.twitch.tv' && url.pathname.endsWith('/users'))
          return Response.json({ data: [{ id: '17', login: 'creator', display_name: 'Creator' }] });
        throw Error('Unexpected provider request');
      },
    },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = (path: string, user: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const image = await request('/api/uploads/token-image', 'alice', {
      imageDataUrl:
        'data:image/png;base64,' +
        (
          await sharp({ create: { width: 32, height: 32, channels: 3, background: '#9146ff' } })
            .png()
            .toBuffer()
        ).toString('base64'),
    });
    assert.equal(image.status, 201);
    const imageUri = (await image.json()).uri;
    const body = {
      requestId: '12345678-1234-4321-9876-123456789abc',
      name: 'Creator Token',
      symbol: 'CRT',
      description: 'Support a stream',
      imageUri,
      walletAddress: alice.publicKey.toBase58(),
      recipientPlatform: 'twitch',
      recipientUsername: 'creator',
    };
    const wrongOwner = await request('/api/launches/prepare', 'bob', {
      ...body,
      walletAddress: bob.publicKey.toBase58(),
    });
    assert.equal(wrongOwner.status, 403);
    assert.match((await wrongOwner.json()).error, /own account/);
    assert.equal(
      (
        await request('/api/launches/prepare', 'alice', {
          ...body,
          walletAddress: bob.publicKey.toBase58(),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/launches/prepare', 'alice', {
          ...body,
          imageUri: 'https://private.example/anything',
        })
      ).status,
      403,
    );
    assert.equal(state.pins, 1, 'unauthorized inputs cannot trigger metadata uploads');
    assert.equal(state.builds, 0);
    const preparedResponse = await request('/api/launches/prepare', 'alice', body);
    assert.equal(preparedResponse.status, 201);
    const prepared = await preparedResponse.json();
    assert.equal(prepared.walletAddress, alice.publicKey.toBase58());
    assert.equal(prepared.summary.recipientId, 'twitch:17');
    assert.doesNotMatch(
      JSON.stringify(prepared),
      /test-secret|test-twitch-secret|encrypted|userId|secretKey|signedTransaction/,
    );
    for (const user of ['alice', 'bob']) {
      const history = await request('/api/launches', user);
      assert.equal(history.status, 404);
      assert.equal('launches' in (await history.json()), false);
    }
    assert.equal((await fetch(`${origin}/api/launches`)).status, 404);
    assert.equal((await request(`/api/launches/${prepared.launchId}`, 'bob')).status, 404);
    const status = await request(`/api/launches/${prepared.launchId}`, 'alice');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).launchId, prepared.launchId);
    const repeated = await request('/api/launches/prepare', 'alice', body);
    assert.equal(repeated.status, 201);
    assert.equal((await repeated.json()).launchId, prepared.launchId);
    assert.equal(state.builds, 1, 'removing history must preserve request idempotency');
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    tx.sign([alice]);
    const signedTransaction = Buffer.from(tx.serialize()).toString('base64');
    assert.equal(
      (await request(`/api/launches/${prepared.launchId}/submit`, 'bob', { signedTransaction }))
        .status,
      404,
    );
    assert.equal(state.broadcasts, 0);
    const submitted = await request(`/api/launches/${prepared.launchId}/submit`, 'alice', {
      signedTransaction,
    });
    assert.equal(submitted.status, 200);
    assert.equal((await submitted.json()).status, 'submitted');
    assert.equal(state.broadcasts, 1);
    assert.equal(
      (await request(`/api/launches/${prepared.launchId}/cancel`, 'alice', {})).status,
      409,
      'signed launches must never be cancelled',
    );
    assert.equal(
      (await request(`/api/launches/${prepared.launchId}/submit`, 'bob', { retry: true })).status,
      404,
    );
    assert.equal(state.broadcasts, 1);
    const savedRetry = await request(`/api/launches/${prepared.launchId}/submit`, 'alice', {
      retry: true,
    });
    assert.equal(savedRetry.status, 200);
    assert.equal((await savedRetry.json()).status, 'submitted');
    assert.equal(state.broadcasts, 2);
    await request(`/api/launches/${prepared.launchId}`, 'alice');
    assert.equal(state.broadcasts, 2, 'status reads cannot rebroadcast');
    state.finalized = true;
    const final = await (await request(`/api/launches/${prepared.launchId}`, 'alice')).json();
    assert.equal(final.status, 'confirmed');
    assert.equal(
      (await request(`/api/launches/${prepared.launchId}/cancel`, 'alice', {})).status,
      409,
    );
    await request(`/api/launches/${prepared.launchId}/submit`, 'alice', { retry: true });
    assert.equal(state.broadcasts, 2, 'finalized launches cannot rebroadcast');
    const publicResponse = await fetch(origin + '/api/catalog');
    const catalog = await publicResponse.json();
    assert.equal(catalog.tokens[0].streamerId, 'twitch:17');
    assert.match(catalog.tokens[0].image, /^\/api\/token-images\/[a-f0-9]{64}$/);
    assert.notEqual(
      catalog.tokens[0].image,
      imageUri,
      'cards use the saved thumbnail, not the original upload',
    );
    const artwork = await fetch(origin + catalog.tokens[0].image);
    assert.equal(artwork.status, 200);
    assert.equal(artwork.headers.get('content-type'), 'image/webp');
    assert.equal(catalog.stats.totalDonatedUsdCents, 0);
    assert.equal(catalog.tokens[0].mcap, null);
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /did:privy:|test-secret|signedTransaction|encrypted|secretKey/,
    );
    const abandoned = await (
      await request('/api/launches/prepare', 'alice', {
        ...body,
        requestId: 'cancelled-launch-request-0001',
      })
    ).json();
    assert.equal(
      (await fetch(`${origin}/api/launches/${abandoned.launchId}/cancel`, { method: 'POST' }))
        .status,
      401,
    );
    assert.equal(
      (await request(`/api/launches/${abandoned.launchId}/cancel`, 'bob', {})).status,
      404,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const cancelled = await request(`/api/launches/${abandoned.launchId}/cancel`, 'alice', {});
      assert.equal(cancelled.status, 200);
      const result = await cancelled.json();
      assert.equal(result.status, 'failed');
      assert.equal(result.transaction, null);
      assert.equal(
        result.error,
        'Launch cancelled before submission. No transaction was broadcast.',
      );
    }
    assert.equal(
      (await (await request(`/api/launches/${abandoned.launchId}`, 'alice')).json()).status,
      'failed',
      'cancellation retains the internal transaction record',
    );
    assert.equal(state.broadcasts, 2);
  } finally {
    await app.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
