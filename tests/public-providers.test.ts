import assert from 'node:assert/strict';
import sharp from 'sharp';
import test from 'node:test';
import { createPublicIdentity, PublicError } from '../server/public/identity.ts';
import { StreamerDirectory } from '../server/public/streamers.ts';
import { PinataUploads, decodeTokenImage } from '../server/public/uploads.ts';

// These tests protect ownership checks and third-party request boundaries, not SDK internals.
test('public identity rejects missing credentials and binds current Solana wallets to verified subject', async () => {
  let reads = 0;
  const identity = createPublicIdentity({
    verify: async (token) => {
      if (token !== 'valid') throw Error('secret upstream detail');
      return 'did:privy:owner';
    },
    getUser: async (id) => {
      reads++;
      return {
        id,
        linked_accounts: [
          { type: 'wallet', chain_type: 'solana', address: 'sol-wallet' },
          { type: 'wallet', chain_type: 'ethereum', address: 'eth-wallet' },
        ],
      };
    },
  });
  await assert.rejects(identity.authorize(undefined), /wallet/);
  await assert.rejects(identity.authorize('Bearer bad'), /expired or is invalid/);
  assert.equal(reads, 0);
  assert.deepEqual(await identity.authorize('Bearer valid'), {
    userId: 'did:privy:owner',
    walletAddresses: ['sol-wallet'],
  });
});

test('social-only and embedded-only accounts cannot authorize public wallet actions', async () => {
  const rejectedAccounts: unknown[][] = [
    [],
    [{ type: 'email', address: 'person@example.test' }],
    [{ type: 'google_oauth', email: 'person@example.test' }],
    [{ type: 'wallet', chain_type: 'ethereum', address: 'ethereum-wallet' }],
    [{ type: 'wallet', chain_type: 'solana', address: '' }],
    ...[
      { connector_type: 'embedded' },
      { wallet_client_type: 'privy' },
      { wallet_client: 'privy' },
      { wallet_client_type: 'privy-v2' },
      { wallet_client: 'privy-v2' },
    ].map((metadata) => [
      { type: 'google_oauth', email: 'person@example.test' },
      { type: 'wallet', chain_type: 'solana', address: 'old-embedded-wallet', ...metadata },
    ]),
  ];
  for (const linked_accounts of rejectedAccounts) {
    const identity = createPublicIdentity({
      verify: async () => 'did:privy:owner',
      getUser: async (id) => ({ id, linked_accounts }),
    });
    await assert.rejects(identity.authorize('Bearer valid'), (error: unknown) => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.status, 403, 'ineligible accounts must not look like a provider outage');
      assert.match(error.message, /external Solana wallet/);
      return true;
    });
  }
});

test('old social accounts with external Solana wallets retain only external signer addresses', async () => {
  const identity = createPublicIdentity({
    verify: async () => 'did:privy:owner',
    getUser: async (id) => ({
      id,
      linked_accounts: [
        { type: 'google_oauth', email: 'person@example.test' },
        { type: 'wallet', chain_type: 'solana', address: 'embedded', connector_type: 'embedded' },
        {
          type: 'wallet',
          chain_type: 'solana',
          address: 'phantom-wallet',
          wallet_client_type: 'phantom',
        },
        {
          type: 'wallet',
          chain_type: 'solana',
          address: 'metamask-wallet',
          wallet_client_type: 'metamask',
        },
        { type: 'wallet', chain_type: 'solana', address: 'other-external-wallet' },
        { type: 'wallet', chain_type: 'solana', address: 'phantom-wallet' },
      ],
    }),
  });
  assert.deepEqual(await identity.authorize('Bearer valid'), {
    userId: 'did:privy:owner',
    walletAddresses: ['phantom-wallet', 'metamask-wallet', 'other-external-wallet'],
  });
});

test('identity provider failures remain sanitized service errors', async () => {
  const identity = createPublicIdentity({
    verify: async () => 'did:privy:owner',
    getUser: async () => {
      throw Error('private provider response');
    },
  });
  await assert.rejects(identity.authorize('Bearer valid'), (error: unknown) => {
    assert.ok(error instanceof PublicError);
    assert.equal(error.status, 503);
    assert.equal(error.message, 'We could not verify your wallet account. Please try again.');
    return true;
  });
});

test('identity cannot substitute a different user from the provider response', async () => {
  const identity = createPublicIdentity({
    verify: async () => 'did:privy:one',
    getUser: async () => ({ id: 'did:privy:two', linked_accounts: [] }),
  });
  await assert.rejects(identity.authorize('Bearer valid'), /verify your wallet account/);
});

test('Kick lookup uses official channel ID and profile, caches app token, and never infers gift eligibility', async () => {
  const urls: string[] = [];
  const directory = new StreamerDirectory(
    { KICK_CLIENT_ID: 'client', KICK_CLIENT_SECRET: 'secret' },
    async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url === 'https://id.kick.com/oauth/token') {
        assert.equal(
          new URLSearchParams(String(init?.body)).get('grant_type'),
          'client_credentials',
        );
        return Response.json({ access_token: 'opaque', expires_in: 3600 });
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opaque');
      if (url.includes('/channels?'))
        return Response.json({
          data: [
            {
              broadcaster_user_id: 17,
              slug: 'realstream',
              channel_description: 'A creator',
              category: { name: 'Gaming' },
              stream: { is_live: true },
            },
          ],
        });
      return Response.json({
        data: [
          {
            user_id: 17,
            name: 'Real Stream',
            profile_picture: 'https://files.kick.com/profile.png',
          },
        ],
      });
    },
  );
  const creator = await directory.lookup('kick', 'RealStream');
  assert.equal(creator.id, 'kick:17');
  assert.equal(creator.handle, 'realstream');
  assert.equal(creator.giftEligibility, 'unverified');
  assert.equal(creator.image, 'https://files.kick.com/profile.png');
  await directory.lookup('kick', 'realstream');
  assert.equal(urls.filter((x) => x.includes('/oauth/token')).length, 1);
  await assert.rejects(directory.lookup('kick', '../outside'), /username/);
});

test('missing Twitch configuration fails closed instead of returning a fixture profile', async () => {
  const directory = new StreamerDirectory({}, async () => {
    throw Error('should not call');
  });
  await assert.rejects(directory.lookup('twitch', 'someone'), /Twitch.*not connected/);
});

test('image validation rejects disguised SVG and oversized uploads before Pinata receives them', () => {
  assert.throws(
    () => decodeTokenImage('data:image/png;base64,PHN2Zz48L3N2Zz4='),
    /PNG, JPEG or WebP/,
  );
  assert.throws(() => decodeTokenImage('data:image/svg+xml;base64,PHN2Zz4='), /PNG, JPEG or WebP/);
});

test('Pinata uploads restrict returned CIDs and sanitize upstream error content', async () => {
  const cid = 'Qm' + 'a'.repeat(44);
  const uploader = new PinataUploads(
    { PINATA_API_KEY: 'key', PINATA_API_SECRET: 'secret' },
    async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('pinata_secret_api_key'), 'secret');
      return Response.json({ IpfsHash: cid });
    },
  );
  const png =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 16, height: 16, channels: 3, background: '#9146ff' } })
        .png()
        .toBuffer()
    ).toString('base64');
  assert.equal((await uploader.image(png)).uri, `https://gateway.pinata.cloud/ipfs/${cid}`);
  const bad = new PinataUploads({ PINATA_API_KEY: 'key', PINATA_API_SECRET: 'secret' }, async () =>
    Response.json({ IpfsHash: 'https://evil.invalid' }),
  );
  await assert.rejects(bad.image(png), /invalid content identifier/);
  const failed = new PinataUploads(
    { PINATA_API_KEY: 'key', PINATA_API_SECRET: 'secret' },
    async () => {
      throw Error('url includes secret');
    },
  );
  await assert.rejects(failed.image(png), {
    message: 'Image storage is unavailable. Please try again later.',
  });
});

test('profile cache follows stable IDs through channel rename without reassigning donation history', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createPublicServices } = await import('../server/public/service.ts');
  const db = new DatabaseSync(':memory:');
  let id = 11;
  let handle = 'firstuser';
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://id.twitch.tv/oauth2/token')
      return Response.json({ access_token: 'token', expires_in: 3600 });
    return Response.json({
      data: [
        {
          id: String(id),
          login: handle,
          display_name: handle,
          profile_image_url: 'https://static-cdn.jtvnw.net/p.png',
        },
      ],
    });
  };
  try {
    const service = createPublicServices(db, {
      env: { TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret' },
      fetch: request,
    });
    const who = { userId: 'did:privy:one', walletAddresses: [] };
    await service.lookup(who, 'twitch', handle);
    handle = 'renameduser';
    await service.lookup(who, 'twitch', handle);
    id = 22;
    handle = 'firstuser';
    await service.lookup(who, 'twitch', handle);
    assert.equal(service.recipients().find((p) => p.id === 'twitch:11')?.handle, 'renameduser');
    assert.equal(service.recipients().find((p) => p.id === 'twitch:22')?.handle, 'firstuser');
  } finally {
    db.close();
  }
});

test('cached metadata refreshes verification for the same identity and rejects a reassigned handle', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Keypair } = await import('@solana/web3.js');
  const { createPublicServices } = await import('../server/public/service.ts');
  const db = new DatabaseSync(':memory:');
  let pins = 0;
  let account = 17;
  const service = createPublicServices(db, {
    env: {
      TWITCH_CLIENT_ID: 'id',
      TWITCH_CLIENT_SECRET: 'secret',
      PINATA_API_KEY: 'key',
      PINATA_API_SECRET: 'secret',
    },
    fetch: async (input) => {
      const u = String(input);
      if (u === 'https://id.twitch.tv/oauth2/token')
        return Response.json({ access_token: 'token', expires_in: 3600 });
      if (u.includes('/users?'))
        return Response.json({
          data: [{ id: String(account), login: 'creator', display_name: 'Creator' }],
        });
      pins++;
      return Response.json({ IpfsHash: 'Qm' + 'a'.repeat(44) });
    },
  });
  try {
    const wallet = Keypair.generate().publicKey.toBase58();
    const who = { userId: 'did:privy:one', walletAddresses: [wallet] };
    const uri = 'https://gateway.pinata.cloud/ipfs/Qm' + 'a'.repeat(44);
    db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
      who.userId,
      'image',
      uri,
    );
    const body = {
      requestId: '12345678-1234-4321-9876-123456789abc',
      name: 'Token Name',
      symbol: 'TEST',
      description: 'Token',
      walletAddress: wallet,
      imageUri: uri,
      recipientPlatform: 'twitch',
      recipientUsername: 'creator',
    };
    const first = await service.verifiedLaunch(who, body);
    first.recipient.verifiedAt = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE public_metadata SET payload=? WHERE owner=?').run(
      JSON.stringify(first),
      who.userId,
    );
    const again = await service.verifiedLaunch(who, body);
    assert.notEqual(again.recipient.verifiedAt, first.recipient.verifiedAt);
    assert.equal(pins, 1);
    assert.equal(again.metadataUri, first.metadataUri);
    account = 18;
    await assert.rejects(service.verifiedLaunch(who, body), /different account/);
    assert.equal(pins, 1);
    await assert.rejects(
      service.verifiedLaunch({ userId: 'did:privy:other', walletAddresses: [wallet] }, body),
      /own account/,
    );
  } finally {
    db.close();
  }
});

test('Pinata accepts a real raw-file CIDv1 returned by the live API', async () => {
  const cid = 'bafkreie3j6yflhno3sxekpy23su6r5e75wsezfzhy73ymdj3srtd4rirai';
  const uploads = new PinataUploads(
    { PINATA_API_KEY: 'key', PINATA_API_SECRET: 'secret' },
    async () => Response.json({ IpfsHash: cid }),
  );
  const png =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 16, height: 16, channels: 3, background: '#9146ff' } })
        .png()
        .toBuffer()
    ).toString('base64');
  assert.equal((await uploads.image(png)).cid, cid);
});

async function tokenLinkFixture() {
  const { DatabaseSync } = await import('node:sqlite');
  const { Keypair } = await import('@solana/web3.js');
  const { createPublicServices } = await import('../server/public/service.ts');
  const db = new DatabaseSync(':memory:');
  const pinned: Record<string, unknown>[] = [];
  const service = createPublicServices(db, {
    env: {
      TWITCH_CLIENT_ID: 'id',
      TWITCH_CLIENT_SECRET: 'secret',
      PINATA_API_KEY: 'key',
      PINATA_API_SECRET: 'secret',
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url === 'https://id.twitch.tv/oauth2/token')
        return Response.json({ access_token: 'token', expires_in: 3600 });
      if (url.includes('/users?'))
        return Response.json({ data: [{ id: '17', login: 'creator', display_name: 'Creator' }] });
      pinned.push(JSON.parse(String(init?.body)).pinataContent);
      return Response.json({ IpfsHash: 'Qm' + 'a'.repeat(44) });
    },
  });
  const wallet = Keypair.generate().publicKey.toBase58();
  const who = { userId: 'did:privy:links', walletAddresses: [wallet] };
  const uri = 'https://gateway.pinata.cloud/ipfs/Qm' + 'a'.repeat(44);
  db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
    who.userId,
    'image',
    uri,
  );
  const body = {
    requestId: 'token-metadata-links-0001',
    name: 'Token Name',
    symbol: 'TEST',
    description: 'Token',
    walletAddress: wallet,
    imageUri: uri,
    recipientPlatform: 'twitch',
    recipientUsername: 'creator',
  };
  return { db, service, who, body, pinned };
}

test('new token metadata pins both website fields to Pog and omits an absent X link', async () => {
  const f = await tokenLinkFixture();
  try {
    const result = await f.service.verifiedLaunch(f.who, f.body);
    assert.equal(f.pinned.length, 1);
    assert.equal(f.pinned[0].website, 'https://pog.fun');
    assert.equal(f.pinned[0].external_url, 'https://pog.fun');
    assert.equal('twitter' in f.pinned[0], false);
    assert.equal(result.website, 'https://pog.fun');
    assert.equal(result.recipient.channelUrl, 'https://www.twitch.tv/creator');
  } finally {
    f.db.close();
  }
});

test('X profile and community links survive pinning, caching and verified launch data', async () => {
  const f = await tokenLinkFixture();
  try {
    const body = { ...f.body, twitter: 'https://twitter.com/community_owner' };
    const first = await f.service.verifiedLaunch(f.who, body);
    assert.equal(f.pinned[0].twitter, 'https://x.com/community_owner');
    assert.equal(first.twitter, 'https://x.com/community_owner');
    const again = await f.service.verifiedLaunch(f.who, body);
    assert.equal(again.twitter, first.twitter);
    assert.equal(f.pinned.length, 1);
    await assert.rejects(
      f.service.verifiedLaunch(f.who, { ...body, twitter: 'https://x.com/changed' }),
      /different launch details/,
    );
    const community = await f.service.verifiedLaunch(f.who, {
      ...body,
      requestId: 'token-metadata-links-0002',
      twitter: 'https://x.com/i/communities/123456789',
    });
    assert.equal(community.twitter, 'https://x.com/i/communities/123456789');
    assert.equal(f.pinned[1].website, 'https://pog.fun');
  } finally {
    f.db.close();
  }
});

test('custom website, other social fields and non-X URLs fail before pinning metadata', async () => {
  const f = await tokenLinkFixture();
  try {
    for (const fields of [
      { website: 'https://elsewhere.example' },
      { telegram: 'https://t.me/community' },
      { twitter: 'https://elsewhere.example/profile' },
      { twitter: 'http://x.com/profile' },
      { twitter: 'https://x.com.evil.example/profile' },
      { twitter: 'https://x.com@evil.example/profile' },
      { twitter: 'https://user:password@x.com/profile' },
      { twitter: 'https://x.com:8443/profile' },
      { twitter: 'https://x.com/' },
      { twitter: 42 },
    ]) {
      await assert.rejects(f.service.verifiedLaunch(f.who, { ...f.body, ...fields }));
    }
    assert.equal(f.pinned.length, 0);
  } finally {
    f.db.close();
  }
});

test('cached metadata under the old link policy cannot create a new launch under the new policy', async () => {
  const f = await tokenLinkFixture();
  try {
    const { createHash } = await import('node:crypto');
    const oldHash = createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(f.body).sort(([a], [b]) => a.localeCompare(b))),
        ),
      )
      .digest('hex');
    f.db
      .prepare('INSERT INTO public_metadata(owner,request_id,digest,uri,payload) VALUES(?,?,?,?,?)')
      .run(
        f.who.userId,
        f.body.requestId,
        oldHash,
        'https://example.test/old-metadata',
        JSON.stringify({ website: 'https://elsewhere.example' }),
      );
    await assert.rejects(f.service.verifiedLaunch(f.who, f.body), /different launch details/);
    assert.equal(f.pinned.length, 0);
  } finally {
    f.db.close();
  }
});
