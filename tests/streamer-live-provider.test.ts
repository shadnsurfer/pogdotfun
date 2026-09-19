import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicError } from '../server/public/identity.ts';
import { StreamerDirectory } from '../server/public/streamers.ts';

const env = { TWITCH_CLIENT_ID: 'fixture-client', TWITCH_CLIENT_SECRET: 'fixture-secret' };
const liveStream = {
  id: '40952121085',
  user_id: '1422545006',
  user_login: 'cloverreggie',
  user_name: 'CloverReggie',
  game_id: '509658',
  game_name: 'Just Chatting',
  type: 'live',
  title: 'Fixture stream',
  tags: ['English'],
  viewer_count: 12,
  started_at: '2026-01-01T00:00:00Z',
  language: 'en',
  thumbnail_url:
    'https://static-cdn.jtvnw.net/previews-ttv/live_user_cloverreggie-{width}x{height}.jpg',
  tag_ids: [],
  is_mature: false,
};
function provider(response: unknown) {
  const urls: string[] = [];
  const directory = new StreamerDirectory(env, async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.href);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (url.origin === 'https://id.twitch.tv') {
      assert.equal(url.pathname, '/oauth2/token');
      assert.equal(init?.method, 'POST');
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'client_credentials');
      assert.equal(body.get('client_id'), 'fixture-client');
      assert.equal(body.get('client_secret'), 'fixture-secret');
      return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    assert.equal(url.origin, 'https://api.twitch.tv');
    assert.equal(url.pathname, '/helix/streams');
    assert.equal(url.searchParams.get('user_id'), '1422545006');
    assert.equal(url.searchParams.getAll('user_id').length, 1);
    assert.equal(url.searchParams.has('user_login'), false);
    assert.equal(url.searchParams.get('type'), 'live');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access-token');
    assert.equal(new Headers(init?.headers).get('client-id'), 'fixture-client');
    return Response.json(response);
  });
  return { directory, urls };
}
function publicFailure(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof PublicError);
    assert.equal(error.status, status);
    assert.doesNotMatch(
      String(error),
      /fixture-secret|fixture-access-token|sensitive-provider-detail/,
    );
    return true;
  };
}

test('live status uses the stable account filter and existing cached app OAuth', async () => {
  const { directory, urls } = provider({ data: [liveStream], pagination: {} });
  const status = await directory.liveStatus('twitch', 'twitch:1422545006', 'CloverReggie');
  assert.deepEqual(
    { ...status, checkedAt: undefined },
    {
      platform: 'twitch',
      providerId: 'twitch:1422545006',
      username: 'cloverreggie',
      isLive: true,
      streamId: '40952121085',
      checkedAt: undefined,
    },
  );
  assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
  await directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie');
  assert.equal(urls.filter((url) => url.includes('/oauth2/token')).length, 1);
  assert.equal(urls.filter((url) => url.includes('/helix/streams')).length, 2);
});

test('a valid empty Get Streams result means offline and does not invent a stream ID', async () => {
  const { directory } = provider({ data: [], pagination: {} });
  const status = await directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie');
  assert.equal(status.isLive, false);
  assert.equal(status.streamId, null);
  assert.equal(status.providerId, 'twitch:1422545006');
});

test('the observed single exact live account remains positive when Twitch supplies a cursor', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-16T12:00:00Z') });
  // Real response shape and public stream facts; the opaque cursor is a fixture.
  const { directory, urls } = provider({
    data: [{ ...liveStream, id: '316920456020', started_at: '2026-09-15T12:31:45Z' }],
    pagination: { cursor: 'eyJiIjp7IkN1cnNvciI6ImZpeHR1cmUifX0=' },
  });
  const status = await directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie');
  assert.equal(status.isLive, true);
  assert.equal(status.streamId, '316920456020');
  assert.equal(status.checkedAt, '2026-09-16T12:00:00.000Z');
  assert.equal(urls.filter((url) => url.includes('/helix/streams')).length, 1);
});

test('checkedAt is observed after response body completion, never request initiation', async (t) => {
  const start = new Date('2026-09-16T12:00:00Z');
  const responseAt = new Date('2026-09-16T12:00:09Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const directory = new StreamerDirectory(env, async (input) => {
    if (String(input).includes('/oauth2/token'))
      return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
    return {
      ok: true,
      json: async () => {
        t.mock.timers.setTime(responseAt.getTime());
        return { data: [liveStream], pagination: {} };
      },
    } as Response;
  });
  const status = await directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie');
  assert.equal(status.checkedAt, '2026-09-16T12:00:09.000Z');
});

test('malformed, inconclusive empty pages and mismatching responses cannot grant live or offline status', async () => {
  for (const response of [
    null,
    [],
    {},
    { data: [] },
    { data: {}, pagination: {} },
    { data: [], pagination: null },
    { data: [], pagination: [] },
    { data: [], pagination: { cursor: 'more' } },
    { data: [liveStream], pagination: { cursor: 1 } },
    { data: [liveStream], pagination: { cursor: null } },
    { data: [liveStream], pagination: { cursor: '' } },
    { data: [liveStream], pagination: { cursor: '  ' } },
    { data: [liveStream], pagination: { cursor: 'a'.repeat(4097) } },
    { data: [liveStream], pagination: { cursor: 'more', other: true } },
    { data: [liveStream], pagination: { other: 'more' } },
    { data: [liveStream, liveStream], pagination: {} },
    { data: [null], pagination: {} },
    { data: [{ ...liveStream, user_id: '999' }], pagination: {} },
    { data: [{ ...liveStream, user_id: '999' }], pagination: { cursor: 'more' } },
    { data: [{ ...liveStream, user_login: 'anotheruser' }], pagination: {} },
    { data: [{ ...liveStream, user_login: undefined }], pagination: {} },
    { data: [{ ...liveStream, type: '' }], pagination: {} },
    { data: [{ ...liveStream, type: 'rerun' }], pagination: {} },
    { data: [{ ...liveStream, id: '' }], pagination: {} },
    { data: [{ ...liveStream, id: 40952121085 }], pagination: {} },
    { data: [{ ...liveStream, started_at: 'invalid' }], pagination: {} },
    { data: [{ ...liveStream, started_at: '2099-01-01T00:00:00Z' }], pagination: {} },
  ]) {
    const { directory } = provider(response);
    await assert.rejects(
      directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie'),
      publicFailure(502),
    );
  }
});

test('provider HTTP, parsing and transport errors stay sanitized errors rather than offline', async () => {
  for (const reply of [
    async () => new Response('sensitive-provider-detail', { status: 401 }),
    async () => new Response('sensitive-provider-detail', { status: 429 }),
    async () => new Response('not-json sensitive-provider-detail', { status: 200 }),
    async () => {
      throw new Error('sensitive-provider-detail fixture-access-token fixture-secret');
    },
  ]) {
    let streamReads = 0;
    const directory = new StreamerDirectory(env, async (input) => {
      if (String(input).includes('/oauth2/token'))
        return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
      streamReads++;
      return reply();
    });
    await assert.rejects(
      directory.liveStatus('twitch', 'twitch:1422545006', 'cloverreggie'),
      publicFailure(502),
    );
    assert.equal(streamReads, 1);
  }
});

test('invalid pinned identities and missing configuration stop before provider calls', async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    throw new Error('unexpected');
  };
  const directory = new StreamerDirectory(env, request);
  for (const [id, username] of [
    ['1422545006', 'cloverreggie'],
    ['kick:1422545006', 'cloverreggie'],
    ['twitch:1422545006&user_id=9', 'cloverreggie'],
    ['twitch:0', 'cloverreggie'],
    ['twitch:1422545006', '../outside'],
    ['twitch:1422545006', 'cloverreggie '],
  ])
    await assert.rejects(directory.liveStatus('twitch', id, username), publicFailure(400));
  await assert.rejects(
    new StreamerDirectory({}, request).liveStatus('twitch', 'twitch:1422545006', 'cloverreggie'),
    publicFailure(503),
  );
  assert.equal(calls, 0);
});

test('ordinary Twitch profile lookup does not add a live-status request', async () => {
  const urls: string[] = [];
  const directory = new StreamerDirectory(env, async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/oauth2/token'))
      return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
    assert.equal(new URL(url).pathname, '/helix/users');
    return Response.json({
      data: [{ id: '1422545006', login: 'cloverreggie', display_name: 'CloverReggie' }],
    });
  });
  const streamer = await directory.lookup('twitch', 'cloverreggie');
  assert.equal(streamer.isLive, null);
  assert.equal(streamer.id, 'twitch:1422545006');
  assert.equal(urls.length, 2);
});
