import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamerDirectory } from '../server/public/streamers.ts';
import { isRecipientPlatformEnabled } from '../server/platform-policy.ts';
const channel = {
  broadcaster_user_id: 42,
  slug: 'streamer',
  stream: { is_live: true, start_time: '2026-01-01T12:00:00Z' },
};
function directory(data: unknown) {
  const calls: string[] = [];
  const request = async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify(
        String(url).includes('/oauth/token')
          ? { access_token: 'fixture-token', expires_in: 3600 }
          : { data },
      ),
    );
  };
  return {
    calls,
    service: new StreamerDirectory(
      { KICK_CLIENT_ID: 'fixture', KICK_CLIENT_SECRET: 'fixture' },
      request as typeof fetch,
    ),
  };
}
test('Kick is available for verified recipients', () => {
  assert.equal(isRecipientPlatformEnabled('kick'), true);
  assert.equal(isRecipientPlatformEnabled('unknown'), false);
});
test('Kick live status pins broadcaster ID and verifies channel slug and stream start', async () => {
  const f = directory([channel]);
  const status = await f.service.liveStatus('kick', 'kick:42', 'streamer');
  assert.equal(status.isLive, true);
  assert.equal(status.streamId, `kick:42:${Date.parse('2026-01-01T12:00:00Z')}`);
  assert.ok(f.calls.includes('https://api.kick.com/public/v1/channels?broadcaster_user_id=42'));
});
test('only explicit offline status on the exact Kick identity establishes offline', async () => {
  const f = directory([{ ...channel, stream: { is_live: false, start_time: '' } }]);
  assert.equal((await f.service.liveStatus('kick', 'kick:42', 'streamer')).isLive, false);
});
test('Kick rejects missing, ambiguous, renamed, wrong-ID and malformed live responses', async () => {
  for (const data of [
    [],
    [channel, channel],
    [{ ...channel, broadcaster_user_id: 43 }],
    [{ ...channel, slug: 'other' }],
    [{ ...channel, broadcaster_user_id: '42' }],
    [{ ...channel, stream: null }],
    [{ ...channel, stream: { is_live: 'true' } }],
    [{ ...channel, stream: { is_live: true, start_time: '2099-01-01T00:00:00Z' } }],
    [{ ...channel, stream: { is_live: true, start_time: 'invalid' } }],
  ]) {
    await assert.rejects(directory(data).service.liveStatus('kick', 'kick:42', 'streamer'));
  }
});
test('verified Kick live session passes the shared durable live gate', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { StreamerLiveGate } = await import('../server/workers/streamer-live.ts');
  const db = new DatabaseSync(':memory:');
  const f = directory([channel]);
  const gate = new StreamerLiveGate(db, {
    lookup: (r) => f.service.liveStatus(r.platform, r.providerId, r.username),
  });
  try {
    const recipient = { platform: 'kick' as const, providerId: 'kick:42', username: 'streamer' };
    await gate.requireLive(recipient);
    gate.assertFreshLive(recipient);
  } finally {
    await gate.close();
    db.close();
  }
});
