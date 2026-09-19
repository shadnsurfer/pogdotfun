import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StreamerLiveGate,
  LiveGateError,
  type LiveRecipient,
} from '../server/workers/streamer-live.ts';
import type { StreamLiveStatus } from '../server/public/streamers.ts';
const recipient: LiveRecipient = {
  platform: 'twitch',
  providerId: 'twitch:1422545006',
  username: 'cloverreggie',
};
function fixture(db = new DatabaseSync(':memory:')) {
  let now = Date.parse('2026-09-16T18:00:00.000Z');
  let calls = 0;
  let lookup = async (r: LiveRecipient): Promise<StreamLiveStatus> => ({
    ...r,
    isLive: true,
    checkedAt: new Date(now).toISOString(),
    streamId: 'stream-1',
  });
  const options = {
    now: () => now,
    lookup: async (r: LiveRecipient) => {
      calls++;
      return lookup(r);
    },
  };
  const gate = new StreamerLiveGate(db, options);
  return {
    db,
    gate,
    options,
    calls: () => calls,
    setLookup: (f: typeof lookup) => {
      lookup = f;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    close: async () => {
      await gate.close();
      db.close();
    },
  };
}
test('many token watches share one persisted streamer lookup and default 30-minute schedule', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 12; i++) f.gate.watch(recipient);
    assert.equal(f.gate.list().length, 1);
    assert.equal(f.gate.list()[0].status, 'unknown');
    const live = await f.gate.check(recipient);
    assert.equal(live.status, 'live');
    assert.equal(Date.parse(live.nextCheckAt) - f.now(), 1800000);
    await f.gate.check(recipient);
    assert.equal(f.calls(), 1);
    f.advance(1800000);
    await f.gate.check(recipient);
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('fresh payout preflight bypasses cache and synchronous final guard rejects stale or offline observations', async () => {
  const f = fixture();
  try {
    await f.gate.requireLive(recipient);
    f.gate.assertFreshLive(recipient);
    f.advance(15001);
    assert.throws(() => f.gate.assertFreshLive(recipient), LiveGateError);
    await f.gate.requireLive(recipient);
    assert.equal(f.calls(), 2);
    f.setLookup(async (r) => ({
      ...r,
      isLive: false,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: null,
    }));
    await assert.rejects(
      f.gate.requireLive(recipient),
      (e: unknown) => e instanceof LiveGateError && e.status === 409,
    );
    assert.throws(() => f.gate.assertFreshLive(recipient));
  } finally {
    await f.close();
  }
});
test('provider failures, identity substitutions and stale timestamps become unknown without leaking errors', async () => {
  const f = fixture();
  try {
    const invalid: Array<(r: LiveRecipient) => Promise<StreamLiveStatus>> = [
      async () => {
        throw new Error('private credential provider response');
      },
      async (r) => ({
        ...r,
        providerId: 'twitch:999',
        isLive: true,
        checkedAt: new Date(f.now()).toISOString(),
        streamId: 'x',
      }),
      async (r) => ({
        ...r,
        isLive: true,
        checkedAt: new Date(f.now() - 1).toISOString(),
        streamId: 'x',
      }),
      async (r) => ({
        ...r,
        isLive: true,
        checkedAt: new Date(f.now() + 1).toISOString(),
        streamId: 'x',
      }),
      async (r) => ({
        ...r,
        isLive: true,
        checkedAt: new Date(f.now()).toISOString(),
        streamId: null,
      }),
    ];
    for (const lookup of invalid) {
      f.setLookup(lookup);
      const status = await f.gate.check(recipient, { fresh: true });
      assert.equal(status.status, 'unknown');
      assert.equal(status.streamId, null);
      assert.equal(status.checkedAt, null);
      assert.doesNotMatch(JSON.stringify(status), /credential/);
      await assert.rejects(
        f.gate.requireLive(recipient),
        (e: unknown) =>
          e instanceof LiveGateError && e.status === 503 && !e.message.includes('credential'),
      );
    }
  } finally {
    await f.close();
  }
});
test('overlapping fresh checks share the in-flight request and cannot use old live authority while pending', async () => {
  const f = fixture();
  try {
    await f.gate.requireLive(recipient);
    let release!: (value: StreamLiveStatus) => void;
    f.setLookup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const a = f.gate.check(recipient, { fresh: true });
    const b = f.gate.requireLive(recipient);
    assert.throws(() => f.gate.assertFreshLive(recipient));
    release({
      ...recipient,
      isLive: true,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: 'new-stream',
    });
    assert.equal((await a).status, 'live');
    assert.equal((await b).streamId, 'new-stream');
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('renaming a stable provider identity invalidates old live status and rejects an old in-flight response', async () => {
  const f = fixture();
  try {
    let release!: (value: StreamLiveStatus) => void;
    f.setLookup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = f.gate.check(recipient, { fresh: true });
    const renamed = { ...recipient, username: 'new_name' };
    f.gate.watch(renamed);
    assert.throws(() => f.gate.assertFreshLive(renamed));
    release({
      ...recipient,
      isLive: true,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: 'old-stream',
    });
    assert.equal((await old).status, 'unknown');
    assert.equal(f.gate.list()[0].username, 'new_name');
    assert.equal(f.gate.list()[0].status, 'unknown');
    assert.equal(f.gate.list().length, 1);
  } finally {
    await f.close();
  }
});
test('offline schedule survives a real database reopen and only due watched rows are polled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pog-live-'));
  const file = join(directory, 'test.db');
  const f = fixture(new DatabaseSync(file));
  try {
    f.setLookup(async (r) => ({
      ...r,
      isLive: false,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: null,
    }));
    await f.gate.check(recipient);
    await f.gate.close();
    f.db.close();
    const reopened = new DatabaseSync(file);
    const gate = new StreamerLiveGate(reopened, f.options);
    assert.equal((await gate.check(recipient)).status, 'offline');
    assert.equal(f.calls(), 1);
    assert.deepEqual(await gate.pollDue(), { checked: 0 });
    f.advance(1800000);
    assert.deepEqual(await gate.pollDue(), { checked: 1 });
    assert.equal(f.calls(), 2);
    await gate.close();
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('due polling uses a bounded fair batch and never changes financial tables', async () => {
  const f = fixture();
  try {
    f.db.exec('CREATE TABLE owner_capital(amount INTEGER);INSERT INTO owner_capital VALUES(1000)');
    for (let i = 1; i <= 65; i++)
      f.gate.watch({ ...recipient, providerId: `twitch:${i}`, username: `streamer_${i}` });
    const first = await f.gate.pollDue();
    assert.equal(first.checked, 50);
    assert.equal((await f.gate.pollDue()).checked, 15);
    assert.equal(f.calls(), 65);
    assert.equal(f.db.prepare('SELECT amount FROM owner_capital').get()!.amount, 1000);
    assert.equal((await f.gate.pollDue()).checked, 0);
  } finally {
    await f.close();
  }
});
test('close waits for active lookup, rejects new work, and exposes only the status allowlist', async () => {
  const f = fixture();
  let release!: (value: StreamLiveStatus) => void;
  f.setLookup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.gate.check(recipient);
  let closed = false;
  const closing = f.gate.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(f.gate.check(recipient));
  assert.throws(() => f.gate.watch(recipient));
  release({
    ...recipient,
    isLive: true,
    checkedAt: new Date(f.now()).toISOString(),
    streamId: 'x',
    privateValue: 'never store',
  } as StreamLiveStatus);
  const result = await pending;
  await closing;
  assert.deepEqual(
    Object.keys(result).sort(),
    ['platform', 'providerId', 'username', 'status', 'checkedAt', 'nextCheckAt', 'streamId'].sort(),
  );
  assert.equal(closed, true);
  f.db.close();
});

test('two gate instances sharing a database deduplicate lookups and retain one immutable provider identity', async () => {
  const f = fixture();
  const other = new StreamerLiveGate(f.db, f.options);
  try {
    let release!: (value: StreamLiveStatus) => void;
    f.setLookup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.gate.requireLive(recipient);
    const second = other.requireLive(recipient);
    release({
      ...recipient,
      isLive: true,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: 'shared-stream',
    });
    assert.deepEqual(await first, await second);
    assert.equal(f.calls(), 1);
    assert.equal(other.list().length, 1);
  } finally {
    await other.close();
    await f.close();
  }
});

test('a late response cannot overwrite a newer observation through another database connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pog-live-race-')),
    file = join(directory, 'test.db');
  const firstDb = new DatabaseSync(file),
    secondDb = new DatabaseSync(file);
  const f = fixture(firstDb);
  let release!: (value: StreamLiveStatus) => void;
  const other = new StreamerLiveGate(secondDb, {
    now: f.now,
    lookup: async (r) => ({
      ...r,
      isLive: false,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: null,
    }),
  });
  try {
    f.setLookup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = f.gate.requireLive(recipient);
    assert.equal((await other.check(recipient, { fresh: true })).status, 'offline');
    release({
      ...recipient,
      isLive: true,
      checkedAt: new Date(f.now()).toISOString(),
      streamId: 'late-stream',
    });
    await assert.rejects(old, LiveGateError);
    assert.equal(f.gate.list()[0].status, 'offline');
    assert.equal(f.gate.list()[0].streamId, null);
  } finally {
    await other.close();
    secondDb.close();
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restarted interrupted observation remains unknown until a new verified check', async () => {
  const f = fixture();
  try {
    await f.gate.requireLive(recipient);
    f.db
      .prepare(
        "UPDATE worker_streamer_live SET status='unknown',checked_at=NULL,stream_id=NULL,request_token='interrupted'",
      )
      .run();
    const other = new StreamerLiveGate(f.db, f.options);
    assert.equal((await other.check(recipient)).status, 'unknown');
    assert.throws(() => other.assertFreshLive(recipient));
    assert.equal((await other.requireLive(recipient)).status, 'live');
    await other.close();
  } finally {
    await f.close();
  }
});
