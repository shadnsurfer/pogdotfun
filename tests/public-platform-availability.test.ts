import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createPublicServices } from '../server/public/service.ts';

test('configured Twitch and Kick identities are available while missing credentials stay disabled', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(createPublicServices(db, { env: {} }).config().providers, {
      twitch: false,
      kick: false,
    });
    const service = createPublicServices(db, {
      env: {
        TWITCH_CLIENT_ID: 'fixture',
        TWITCH_CLIENT_SECRET: 'fixture',
        KICK_CLIENT_ID: 'fixture',
        KICK_CLIENT_SECRET: 'fixture',
      },
    });
    assert.deepEqual(service.config().providers, { twitch: true, kick: true });
  } finally {
    db.close();
  }
});

test('Kick public lookup verifies provider identity and preserves an unverified gifting status', async () => {
  const db = new DatabaseSync(':memory:');
  const calls: string[] = [];
  try {
    const service = createPublicServices(db, {
      env: { KICK_CLIENT_ID: 'fixture', KICK_CLIENT_SECRET: 'fixture' },
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        assert.equal(init?.redirect, 'error');
        if (url === 'https://id.kick.com/oauth/token')
          return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
        if (url === 'https://api.kick.com/public/v1/channels?slug=creator')
          return Response.json({
            data: [{ broadcaster_user_id: 17, slug: 'creator', stream: { is_live: false } }],
          });
        if (url === 'https://api.kick.com/public/v1/users?id=17')
          return Response.json({
            data: [
              {
                user_id: 17,
                name: 'Creator',
                profile_picture: 'https://images.example.test/creator.webp',
              },
            ],
          });
        throw new Error('Unexpected provider request');
      },
    });
    const profile = await service.lookup(
      { userId: 'did:privy:fixture', walletAddresses: [] },
      'kick',
      'creator',
    );
    assert.equal(profile.id, 'kick:17');
    assert.equal(profile.platform, 'kick');
    assert.equal(profile.channelUrl, 'https://kick.com/creator');
    assert.equal(profile.giftEligibility, 'unverified');
    assert.equal((await service.verifyRecipient('kick', 'creator')).id, 'kick:17');
    assert.equal(calls.filter((url) => url.includes('/oauth/token')).length, 1);
    assert.equal(calls.filter((url) => url.includes('/channels?slug=creator')).length, 2);
    assert.equal(calls.length, 5);
    assert.equal(service.recipients()[0].id, 'kick:17');
  } finally {
    db.close();
  }
});

test('Kick lookup rejects a provider channel that does not match the requested username', async () => {
  const db = new DatabaseSync(':memory:');
  let requests = 0;
  try {
    const service = createPublicServices(db, {
      env: { KICK_CLIENT_ID: 'fixture', KICK_CLIENT_SECRET: 'fixture' },
      fetch: async (input) => {
        requests++;
        return Response.json(
          String(input).includes('/oauth/token')
            ? { access_token: 'fixture', expires_in: 3600 }
            : { data: [{ broadcaster_user_id: 17, slug: 'different' }] },
        );
      },
    });
    await assert.rejects(service.verifyRecipient('kick', 'creator'), { status: 404 });
    assert.equal(requests, 2);
    assert.deepEqual(service.recipients(), []);
  } finally {
    db.close();
  }
});

test('saved Kick profiles remain readable when provider credentials are absent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const service = createPublicServices(db, { env: {} });
    const profile = { id: 'kick:17', platform: 'kick', handle: 'creator', name: 'Creator' };
    db.prepare('INSERT INTO public_profiles(id,payload) VALUES(?,?)').run(
      profile.id,
      JSON.stringify(profile),
    );
    assert.deepEqual(service.recipients(), [profile]);
  } finally {
    db.close();
  }
});
