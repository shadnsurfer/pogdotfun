import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';
import { activityRecipient, verifiedRecipientProfile } from '../src/donation-recipient-data.ts';

const alice = {
  id: 'twitch:101',
  platform: 'twitch' as const,
  handle: 'alice',
  name: 'Alice',
  image: 'https://static-cdn.jtvnw.net/alice.png',
  channelUrl: 'https://www.twitch.tv/alice',
};
const bob = {
  id: 'twitch:202',
  platform: 'twitch' as const,
  handle: 'bob',
  name: 'Bob',
  image: 'https://static-cdn.jtvnw.net/bob.png',
  channelUrl: 'https://www.twitch.tv/bob',
};
const profile = {
  id: alice.id,
  platform: alice.platform,
  username: alice.handle,
  displayName: alice.name,
  imageUrl: alice.image,
  channelUrl: 'https://evil.invalid/wrong',
};

test('profile identity requires matching platform and username and rebuilds the canonical channel', () => {
  assert.deepEqual(verifiedRecipientProfile('twitch', 'ALICE', profile), {
    ...profile,
    username: 'alice',
    channelUrl: 'https://www.twitch.tv/alice',
  });
  for (const invalid of [
    { ...profile, username: 'bob' },
    { ...profile, platform: 'kick' },
    { ...profile, id: 'kick:101' },
    { ...profile, id: 'legacy:twitch:alice' },
    { ...profile, displayName: '' },
    null,
  ]) {
    assert.equal(verifiedRecipientProfile('twitch', 'alice', invalid), null);
  }
});

test('unsafe profile images become an empty-image fallback without changing the recorded identity', () => {
  for (const imageUrl of [
    'http://images.invalid/alice.png',
    'javascript:alert(1)',
    'data:image/png;base64,123',
    'https://user:pass@images.invalid/photo.png',
    'not-a-url',
    '',
  ]) {
    assert.equal(
      verifiedRecipientProfile('twitch', 'alice', { ...profile, imageUrl })?.imageUrl,
      '',
    );
  }
  assert.equal(verifiedRecipientProfile('twitch', 'alice', profile)?.imageUrl, alice.image);
});

test('recorded activity recipient wins over a stale token and works when the token is absent', () => {
  const event = {
    tokenId: 'token-a',
    recipientId: alice.id,
    recipientPlatform: 'twitch' as const,
    recipientUsername: 'alice',
    route: 'streamer' as const,
  };
  for (const tokenList of [[], [{ id: 'token-a', streamerId: bob.id }]]) {
    const result = activityRecipient(event, tokenList, [alice, bob]);
    assert.equal(result?.username, 'alice');
    assert.equal(result?.profile?.displayName, 'Alice');
    assert.equal(result?.profile?.imageUrl, alice.image);
  }
});

test('missing or contradictory profiles never borrow another token recipient photo', () => {
  const event = {
    tokenId: 'token-a',
    recipientId: alice.id,
    recipientPlatform: 'twitch' as const,
    recipientUsername: 'alice',
    route: 'streamer' as const,
  };
  const tokens = [{ id: 'token-a', streamerId: bob.id }];
  assert.deepEqual(activityRecipient(event, tokens, [bob]), {
    platform: 'twitch',
    username: 'alice',
    profile: null,
  });
  assert.equal(
    activityRecipient({ ...event, recipientPlatform: 'kick' }, tokens, [alice, bob]),
    null,
  );
  assert.deepEqual(activityRecipient(event, tokens, [{ ...alice, platform: 'kick' }, bob]), {
    platform: 'twitch',
    username: 'alice',
    profile: null,
  });
  assert.deepEqual(activityRecipient(event, tokens, [{ ...alice, handle: 'new_owner' }, bob]), {
    platform: 'twitch',
    username: 'alice',
    profile: null,
  });
  assert.equal(
    activityRecipient({ tokenId: 'token-a', recipientId: 'twitch:404' }, tokens, [bob]),
    null,
  );
});

test('legacy records keep their exact recorded handle without inventing a verified portrait', () => {
  const event = {
    tokenId: 'missing',
    recipientId: 'legacy:twitch:alice',
    route: 'streamer' as const,
  };
  assert.deepEqual(activityRecipient(event, [], [alice, bob]), {
    platform: 'twitch',
    username: 'alice',
    profile: null,
  });
  assert.equal(
    activityRecipient(
      { ...event, recipientUsername: 'bob', recipientPlatform: 'twitch' },
      [],
      [alice, bob],
    ),
    null,
  );
});

test('token mapping is used only without a recorded recipient ID and treasury has no streamer', () => {
  const event = { tokenId: 'token-a' };
  const tokens = [{ id: 'token-a', streamerId: alice.id }];
  assert.equal(activityRecipient(event, tokens, [alice])?.profile?.id, alice.id);
  assert.equal(activityRecipient({ ...event, recipientId: bob.id }, tokens, [alice]), null);
  assert.equal(
    activityRecipient({ ...event, recipientId: alice.id, route: 'treasury' }, tokens, [alice]),
    null,
  );
  assert.equal(activityRecipient({ tokenId: 'missing' }, tokens, [alice]), null);
});

test('catalog activity retains the recorded recipient handle separately from a refreshed profile', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const operations = createOperations(db, { streamerBps: 8000 });
    const token = operations.registerToken(
      {
        name: 'Community',
        symbol: 'COMM',
        mint: '1'.repeat(32),
        creatorAddress: '1'.repeat(31) + '2',
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: 'alice',
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      'test',
    );
    operations.recordClaim(
      {
        tokenId: token.id,
        signature: '1'.repeat(64),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 1,
        valuationAt: '2026-09-16T12:00:00.000Z',
        slot: 1,
        confirmation: 'finalized',
      },
      'test',
    );
    const launches = {
      allConfirmedMetadata: () => [{ id: token.id, recipientId: alice.id }],
    } as Parameters<typeof publicCatalog>[1];
    const result = publicCatalog(operations, launches, [{ ...alice, handle: 'renamed_alice' }]);
    const event = result.activity[0];
    assert.equal(event.recipientId, alice.id);
    assert.equal(event.recipientPlatform, 'twitch');
    assert.equal(event.recipientUsername, 'alice');
    assert.equal(result.streamers[0].handle, 'renamed_alice');
    assert.deepEqual(activityRecipient(event, result.tokens, result.streamers), {
      platform: 'twitch',
      username: 'alice',
      profile: null,
    });
  } finally {
    db.close();
  }
});
