import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createOperations } from '../server/operations.ts';
import { createPumpLaunchService } from '../server/launch/service.ts';
import type { LaunchChain, VerifiedLaunchInput } from '../server/launch/types.ts';
import { createPublicServices } from '../server/public/service.ts';

const now = Date.parse('2026-09-16T02:00:00Z');
const invalidAmounts: unknown[] = [
  '',
  ' ',
  '-1',
  '+1',
  '00',
  '01',
  '1.0',
  '0.1',
  '1e9',
  '0x10',
  ' 1',
  '1 ',
  '1\n',
  '0\r',
  '1\u2028',
  '9007199254740992',
  '9999999999999999999999999999999999',
  1,
  0,
  null,
  true,
  {},
  [],
];

function fixture() {
  const db = new DatabaseSync(':memory:');
  const walletAddress = Keypair.generate().publicKey.toBase58();
  const principal = { userId: 'did:privy:initial-buy', walletAddresses: [walletAddress] };
  const imageUri = 'https://gateway.pinata.cloud/ipfs/Qm' + 'a'.repeat(44);
  const body = {
    requestId: 'initial-buy-request-00001',
    name: 'Pog Token',
    symbol: 'POG',
    description: 'Support a streamer',
    walletAddress,
    imageUri,
    recipientPlatform: 'twitch',
    recipientUsername: 'creator',
  };
  const input: VerifiedLaunchInput = {
    requestId: body.requestId,
    name: body.name,
    symbol: body.symbol,
    description: body.description,
    walletAddress,
    metadataUri: 'https://example.test/metadata',
    imageUri,
    recipient: {
      id: 'twitch:17',
      platform: 'twitch',
      username: 'creator',
      channelUrl: 'https://www.twitch.tv/creator',
      verified: true,
      verifiedAt: new Date(now).toISOString(),
    },
  };
  const pinned: Record<string, unknown>[] = [];
  const publicService = createPublicServices(db, {
    env: {
      TWITCH_CLIENT_ID: 'id',
      TWITCH_CLIENT_SECRET: 'secret',
      PINATA_API_KEY: 'key',
      PINATA_API_SECRET: 'secret',
    },
    fetch: async (url, init) => {
      if (String(url) === 'https://id.twitch.tv/oauth2/token')
        return Response.json({ access_token: 'token', expires_in: 3600 });
      if (String(url).startsWith('https://api.twitch.tv/helix/users?'))
        return Response.json({ data: [{ id: '17', login: 'creator', display_name: 'Creator' }] });
      if (String(url) === 'https://api.pinata.cloud/pinning/pinJSONToIPFS') {
        pinned.push(JSON.parse(String(init?.body)).pinataContent);
        return Response.json({ IpfsHash: 'Qm' + 'a'.repeat(44) });
      }
      throw new Error(`Unexpected upstream request: ${String(url)}`);
    },
  });
  db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
    principal.userId,
    'image',
    imageUri,
  );
  const chain: LaunchChain = {
    async prepare() {
      return {
        transaction: 'fixture-transaction',
        message: 'fixture-message',
        blockhash: 'fixture-blockhash',
        lastValidBlockHeight: 100,
        networkFeeLamports: '10000',
        creatorReserveLamports: '2000000',
        estimatedTotalLamports: '5000000',
      };
    },
    async broadcast() {
      throw new Error('This test must not broadcast.');
    },
    async reconcile() {
      return { status: 'pending' };
    },
  };
  const launchService = createPumpLaunchService(db, createOperations(db, { streamerBps: 8000 }), {
    launchesEnabled: true,
    transactionsEnabled: false,
    encryptionKey: new Uint8Array(32).fill(7),
    chain,
    now: () => now,
  });
  return { db, principal, body, input, pinned, publicService, launchService };
}

test('verified launch persists a nonzero initial buy through cached metadata', async () => {
  const f = fixture();
  try {
    const body = { ...f.body, initialBuyLamports: '125000000' };
    const first = await f.publicService.verifiedLaunch(f.principal, body);
    assert.equal(first.initialBuyLamports, '125000000');
    const saved = JSON.parse(
      String(f.db.prepare('SELECT payload FROM public_metadata').get()!.payload),
    );
    assert.equal(saved.initialBuyLamports, '125000000');
    const again = await f.publicService.verifiedLaunch(f.principal, body);
    assert.equal(again.initialBuyLamports, '125000000');
    assert.equal(f.pinned.length, 1);
    assert.equal('initialBuyLamports' in f.pinned[0], false);
  } finally {
    f.db.close();
  }
});

test('public launch rejects malformed initial buys before uploading metadata', async () => {
  const f = fixture();
  try {
    for (const initialBuyLamports of invalidAmounts)
      await assert.rejects(
        f.publicService.verifiedLaunch(f.principal, { ...f.body, initialBuyLamports }),
        { status: 400, message: /initial buy/i },
        `Amount ${JSON.stringify(initialBuyLamports)} must be rejected`,
      );
    assert.equal(f.pinned.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM public_metadata').get()!.n, 0);
  } finally {
    f.db.close();
  }
});

test('public metadata preserves its previous digest for omitted or zero initial buys', async () => {
  const f = fixture();
  try {
    const first = await f.publicService.verifiedLaunch(f.principal, f.body);
    const legacyDigest = createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries({ ...f.body, metadataPolicy: 'pog-website-x-v1' }).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        ),
      )
      .digest('hex');
    assert.equal(f.db.prepare('SELECT digest FROM public_metadata').get()!.digest, legacyDigest);
    const again = await f.publicService.verifiedLaunch(f.principal, {
      ...f.body,
      initialBuyLamports: '0',
    });
    assert.equal(again.metadataUri, first.metadataUri);
    assert.equal('initialBuyLamports' in again, false);
    assert.equal(f.pinned.length, 1);
  } finally {
    f.db.close();
  }
});

test('public metadata refuses a changed initial buy under the same request ID', async () => {
  const f = fixture();
  try {
    await f.publicService.verifiedLaunch(f.principal, { ...f.body, initialBuyLamports: '1' });
    for (const initialBuyLamports of ['2', '0', undefined])
      await assert.rejects(
        f.publicService.verifiedLaunch(f.principal, { ...f.body, initialBuyLamports }),
        { status: 409 },
      );
    assert.equal(f.pinned.length, 1);
  } finally {
    f.db.close();
  }
});

test('launch records and summaries keep the requested initial buy', async () => {
  const f = fixture();
  try {
    const result = await f.launchService.prepare(f.principal, {
      ...f.input,
      initialBuyLamports: '125000000',
    });
    assert.equal(result.summary.initialBuyLamports, '125000000');
    const saved = JSON.parse(
      String(f.db.prepare('SELECT payload FROM launch_intents').get()!.payload),
    );
    assert.equal(saved.initialBuyLamports, '125000000');
    assert.equal(
      (await f.launchService.get(f.principal, result.launchId)).summary.initialBuyLamports,
      '125000000',
    );
  } finally {
    f.db.close();
  }
});

test('launch service independently rejects invalid initial buys before persisting a launch', async () => {
  const f = fixture();
  try {
    for (const initialBuyLamports of invalidAmounts)
      await assert.rejects(
        f.launchService.prepare(f.principal, {
          ...f.input,
          initialBuyLamports,
        } as VerifiedLaunchInput),
        { status: 400, message: /initial buy/i },
        `Amount ${JSON.stringify(initialBuyLamports)} must be rejected`,
      );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_intents').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_secrets').get()!.n, 0);
  } finally {
    f.db.close();
  }
});

test('launch service preserves its previous fingerprint for omitted or zero initial buys', async () => {
  const f = fixture();
  try {
    const first = await f.launchService.prepare(f.principal, f.input);
    const legacyInput = { ...f.input, website: 'https://pog.fun' };
    // Legacy validation put website before recipient; preserve that order in the historical fingerprint.
    const { recipient, ...details } = legacyInput;
    const legacyFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          ...details,
          recipient: { ...recipient, verifiedAt: undefined },
        }),
      )
      .digest('hex');
    assert.equal(
      f.db.prepare('SELECT fingerprint FROM launch_intents').get()!.fingerprint,
      legacyFingerprint,
    );
    const again = await f.launchService.prepare(f.principal, {
      ...f.input,
      initialBuyLamports: '0',
    });
    assert.equal(again.launchId, first.launchId);
    assert.equal(again.summary.initialBuyLamports, '0');
    const saved = JSON.parse(
      String(f.db.prepare('SELECT payload FROM launch_intents').get()!.payload),
    );
    assert.equal('initialBuyLamports' in saved, false);
  } finally {
    f.db.close();
  }
});

test('launch service accepts the safe integer limit and binds it to request ID', async () => {
  const f = fixture();
  try {
    const result = await f.launchService.prepare(f.principal, {
      ...f.input,
      initialBuyLamports: '9007199254740991',
    });
    assert.equal(result.summary.initialBuyLamports, '9007199254740991');
    for (const initialBuyLamports of ['9007199254740990', '0', undefined])
      await assert.rejects(
        f.launchService.prepare(f.principal, { ...f.input, initialBuyLamports }),
        { status: 409 },
      );
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_intents').get()!.n, 1);
  } finally {
    f.db.close();
  }
});
