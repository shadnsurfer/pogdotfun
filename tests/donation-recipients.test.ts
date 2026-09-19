import assert from 'node:assert/strict';
import test from 'node:test';
import { DonationRecipientProfiles } from '../server/public/donation-recipients.ts';
const NOW = Date.parse('2026-09-16T12:00:00Z');
const record = {
  id: 'receipt-1',
  recipientPlatform: 'twitch' as const,
  recipientUsername: 'SecretKatchii',
  completedAt: new Date(NOW - 60000).toISOString(),
  spentUsdCents: 955,
  origin: 'owner_funded_acceptance',
  verification: 'operator_reviewed_card_verified',
};
const profile = {
  id: 'twitch:1141996070',
  platform: 'twitch',
  handle: 'secretkatchii',
  name: 'SecretKatchii',
  image: 'https://static-cdn.jtvnw.net/profile.jpg',
  channelUrl: 'https://evil.example/replace',
  verifiedAt: new Date(NOW).toISOString(),
  privateToken: 'secret',
  bio: 'irrelevant',
};

test('verified recipient enrichment preserves recorded identity and every financial/provenance field', async () => {
  let calls = 0;
  const enrich = new DonationRecipientProfiles({
    profiles: () => [profile],
    expectedId: () => profile.id,
    lookup: async () => {
      calls++;
      throw Error('unused');
    },
    now: () => NOW,
  });
  const [result] = await enrich.enrich([record]);
  assert.deepEqual(
    { ...result, recipientProfile: undefined },
    { ...record, recipientProfile: undefined },
  );
  assert.deepEqual(result.recipientProfile, {
    id: profile.id,
    platform: 'twitch',
    username: 'secretkatchii',
    displayName: 'SecretKatchii',
    imageUrl: profile.image,
    channelUrl: 'https://www.twitch.tv/secretkatchii',
  });
  assert.equal(calls, 0);
  assert.equal('recipientProfile' in record, false);
  assert.equal(JSON.stringify(result).includes('privateToken'), false);
  assert.equal(JSON.stringify(result).includes('secret"'), false);
});
test('missing cached profile resolves only the completed public recipient and is cached/coalesced', async () => {
  let calls = 0,
    now = NOW,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  const enrich = new DonationRecipientProfiles({
    profiles: () => [],
    expectedId: () => profile.id,
    lookup: async (platform, username) => {
      calls++;
      requests.push([platform, username]);
      await gate;
      return profile;
    },
    now: () => now,
  });
  const a = enrich.enrich([record]),
    b = enrich.enrich([record]);
  release();
  assert.equal((await a)[0].recipientProfile?.id, profile.id);
  assert.equal((await b)[0].recipientProfile?.id, profile.id);
  now += 15000;
  await enrich.enrich([record]);
  assert.equal(calls, 1);
  assert.deepEqual(requests, [['twitch', 'secretkatchii']]);
  now += 300000;
  await enrich.enrich([record]);
  assert.equal(calls, 2);
});
test('wrong platform, username, stable ID and recycled handles never acquire another user profile', async () => {
  for (const changed of [
    { ...profile, platform: 'kick', id: 'kick:1141996070' },
    { ...profile, handle: 'someone_else' },
    { ...profile, id: 'twitch:999' },
  ]) {
    let calls = 0;
    const enrich = new DonationRecipientProfiles({
      profiles: () => [changed],
      expectedId: () => profile.id,
      lookup: async () => {
        calls++;
        return changed;
      },
      now: () => NOW,
    });
    assert.equal((await enrich.enrich([record]))[0].recipientProfile, undefined);
    assert.ok(calls <= 1);
  }
  const conflict = new DonationRecipientProfiles({
    profiles: () => [profile],
    expectedId: () => null,
    lookup: async () => {
      throw Error('must not lookup inconsistent saved identity');
    },
    now: () => NOW,
  });
  assert.equal((await conflict.enrich([record]))[0].recipientProfile, undefined);
});
test('legacy receipts never adopt a current cached owner of a reused handle or trigger unbound lookups', async () => {
  let calls = 0;
  for (const saved of [[], [profile], [profile, { ...profile, id: 'twitch:999' }]]) {
    const enrich = new DonationRecipientProfiles({
      profiles: () => saved,
      expectedId: () => undefined,
      lookup: async () => {
        calls++;
        return profile;
      },
      now: () => NOW,
    });
    assert.equal((await enrich.enrich([record]))[0].recipientProfile, undefined);
  }
  assert.equal(calls, 0);
});
test('failed, malformed and slow profile responses preserve the public receipt and negative-cache the failure', async () => {
  for (const lookup of [
    async () => {
      throw Error('private provider credentials');
    },
    async () => ({ ...profile, image: 'javascript:alert(1)' }),
    async () => ({ ...profile, image: 'https://user:secret@example.com/photo.jpg' }),
    async () => new Promise<never>(() => {}),
  ]) {
    let calls = 0;
    const enrich = new DonationRecipientProfiles({
      profiles: () => [],
      expectedId: () => profile.id,
      lookup: async () => {
        calls++;
        return lookup();
      },
      timeoutMs: 5,
      now: () => NOW,
    });
    const [value] = await enrich.enrich([record]);
    assert.deepEqual(value, record);
    await enrich.enrich([record]);
    assert.equal(calls, 1);
  }
});
test('unpublished/incomplete records and invalid handles cause no provider calls', async () => {
  let calls = 0;
  const enrich = new DonationRecipientProfiles({
    profiles: () => [],
    expectedId: () => profile.id,
    lookup: async () => {
      calls++;
      return profile;
    },
    now: () => NOW,
  });
  for (const bad of [
    { ...record, completedAt: '' },
    { ...record, recipientUsername: '../../who' },
    { ...record, recipientPlatform: 'youtube' },
  ]) {
    assert.equal((await enrich.enrich([bad]))[0].recipientProfile, undefined);
  }
  assert.equal(calls, 0);
});

test('missing profiles have bounded concurrent work, timeout and rolling provider quota', async () => {
  let calls = 0;
  const blocked = new DonationRecipientProfiles({
    profiles: () => [],
    expectedId: (r) => `twitch:${r.id}`,
    lookup: async () => {
      calls++;
      return new Promise<never>(() => {});
    },
    timeoutMs: 5,
    now: () => NOW,
  });
  const records = Array.from({ length: 20 }, (_, i) => ({
    ...record,
    id: String(i + 1),
    recipientUsername: `user_${i}`,
  }));
  const results = await blocked.enrich(records);
  assert.equal(calls, 2);
  assert.ok(results.every((r) => !r.recipientProfile));
  await blocked.enrich(records);
  assert.equal(calls, 2);
  let count = 0,
    now = NOW;
  const quota = new DonationRecipientProfiles({
    profiles: () => [],
    expectedId: (r) => `twitch:${r.id}`,
    lookup: async () => {
      count++;
      throw Error('not found');
    },
    now: () => now,
  });
  for (let i = 0; i < 30; i++)
    await quota.enrich([{ ...record, id: String(i + 1), recipientUsername: `user_${i}` }]);
  assert.equal(count, 20);
  now += 60000;
  await quota.enrich([{ ...record, id: 'new', recipientUsername: 'next_user' }]);
  assert.equal(count, 21);
});
