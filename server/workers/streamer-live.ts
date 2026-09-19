import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { StreamLiveStatus } from '../public/streamers.ts';

export interface LiveRecipient {
  platform: 'twitch' | 'kick';
  providerId: string;
  username: string;
}
export interface LiveStatus extends LiveRecipient {
  status: 'live' | 'offline' | 'unknown';
  checkedAt: string | null;
  nextCheckAt: string;
  streamId: string | null;
}
export class LiveGateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
interface Options {
  lookup: (recipient: LiveRecipient) => Promise<StreamLiveStatus>;
  now?: () => number;
  intervalMs?: number;
}
interface Stored extends LiveStatus {
  revision: number;
  requestToken: string | null;
}
const pendingByDatabase = new WeakMap<DatabaseSync, Map<string, Promise<LiveStatus>>>();
const intervalDefault = 30 * 60 * 1000;
const freshMaximum = 15000;
const batchSize = 50;
function recipient(input: LiveRecipient): LiveRecipient {
  if (
    !input ||
    !['twitch', 'kick'].includes(input.platform) ||
    typeof input.providerId !== 'string' ||
    !new RegExp(`^${input.platform}:[a-zA-Z0-9_-]{1,100}$`).test(input.providerId) ||
    typeof input.username !== 'string' ||
    !/^[a-zA-Z0-9_]{3,25}$/.test(input.username)
  )
    throw new LiveGateError(400, 'A verified streamer identity is required.');
  return {
    platform: input.platform,
    providerId: input.providerId,
    username: input.username.toLowerCase(),
  };
}
function publicStatus(row: Stored): LiveStatus {
  return {
    platform: row.platform,
    providerId: row.providerId,
    username: row.username,
    status: row.status,
    checkedAt: row.checkedAt,
    nextCheckAt: row.nextCheckAt,
    streamId: row.streamId,
  };
}
/** Shared observations only: this gate never opens browsers, reserves capital, or pays. */
export class StreamerLiveGate {
  private readonly now: () => number;
  private readonly interval: number;
  private readonly pending: Map<string, Promise<LiveStatus>>;
  private readonly active = new Set<Promise<unknown>>();
  private polling: Promise<{ checked: number }> | undefined;
  private stopped = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? intervalDefault;
    if (
      !Number.isSafeInteger(this.interval) ||
      this.interval < 1 ||
      this.interval > 86400000 ||
      typeof options.lookup !== 'function'
    )
      throw new LiveGateError(503, 'The streamer polling configuration is invalid.');
    db.exec(`CREATE TABLE IF NOT EXISTS worker_streamer_live (
      platform TEXT NOT NULL, provider_id TEXT NOT NULL, username TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('live','offline','unknown')),
      checked_at TEXT, next_check_at TEXT NOT NULL, stream_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0, request_token TEXT,
      PRIMARY KEY(platform,provider_id)
    ); CREATE INDEX IF NOT EXISTS worker_streamer_live_due ON worker_streamer_live(next_check_at,platform,provider_id);`);
    let pending = pendingByDatabase.get(db);
    if (!pending) {
      pending = new Map();
      pendingByDatabase.set(db, pending);
    }
    this.pending = pending;
  }
  private running() {
    if (this.stopped) throw new LiveGateError(503, 'The streamer status service is stopping.');
  }
  private time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new LiveGateError(503, 'The streamer observation clock is unavailable.');
    return now;
  }
  private read(r: LiveRecipient): Stored | null {
    const row = this.db
      .prepare('SELECT * FROM worker_streamer_live WHERE platform=? AND provider_id=?')
      .get(r.platform, r.providerId);
    return row
      ? {
          platform: String(row.platform) as LiveRecipient['platform'],
          providerId: String(row.provider_id),
          username: String(row.username),
          status: String(row.status) as LiveStatus['status'],
          checkedAt: row.checked_at === null ? null : String(row.checked_at),
          nextCheckAt: String(row.next_check_at),
          streamId: row.stream_id === null ? null : String(row.stream_id),
          revision: Number(row.revision),
          requestToken: row.request_token === null ? null : String(row.request_token),
        }
      : null;
  }
  watch(input: LiveRecipient): void {
    this.running();
    const r = recipient(input);
    const at = new Date(this.time()).toISOString();
    this.db
      .prepare(
        `INSERT INTO worker_streamer_live(platform,provider_id,username,status,checked_at,next_check_at,stream_id) VALUES(?,?,?,'unknown',NULL,?,NULL)
      ON CONFLICT(platform,provider_id) DO UPDATE SET username=excluded.username,status='unknown',checked_at=NULL,next_check_at=excluded.next_check_at,stream_id=NULL,request_token=NULL,revision=worker_streamer_live.revision+1 WHERE worker_streamer_live.username<>excluded.username`,
      )
      .run(r.platform, r.providerId, r.username, at);
  }
  async check(input: LiveRecipient, options: { fresh?: boolean } = {}): Promise<LiveStatus> {
    this.running();
    const r = recipient(input);
    this.watch(r);
    const key = JSON.stringify([r.platform, r.providerId, r.username]);
    const pending = this.pending.get(key);
    if (pending) {
      this.track(pending);
      return pending;
    }
    const old = this.read(r)!;
    if (!options.fresh && Date.parse(old.nextCheckAt) > this.time()) return publicStatus(old);
    const request = this.perform(r, old);
    this.pending.set(key, request);
    this.track(request);
    void request
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      })
      .catch(() => {});
    return request;
  }
  private track<T>(promise: Promise<T>) {
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
  }
  private unknown(r: LiveRecipient): LiveStatus {
    return {
      ...r,
      status: 'unknown',
      checkedAt: null,
      nextCheckAt: new Date(this.time() + this.interval).toISOString(),
      streamId: null,
    };
  }
  private async perform(r: LiveRecipient, old: Stored): Promise<LiveStatus> {
    const started = this.time(),
      token = randomUUID();
    // Revoke any previous live authority before an asynchronous fresh lookup.
    // Revision/token CAS also prevents a renamed or superseded reply from restoring it.
    const startedRow = this.db
      .prepare(
        `UPDATE worker_streamer_live SET status='unknown',checked_at=NULL,stream_id=NULL,next_check_at=?,request_token=?,revision=revision+1 WHERE platform=? AND provider_id=? AND username=? AND revision=?`,
      )
      .run(
        new Date(started + this.interval).toISOString(),
        token,
        r.platform,
        r.providerId,
        r.username,
        old.revision,
      );
    if (startedRow.changes !== 1) return this.unknown(r);
    let status: LiveStatus = this.unknown(r);
    try {
      const raw = await this.options.lookup({ ...r });
      const ended = this.time();
      const checked = typeof raw?.checkedAt === 'string' ? Date.parse(raw.checkedAt) : NaN;
      if (
        raw.platform !== r.platform ||
        raw.providerId !== r.providerId ||
        raw.username !== r.username ||
        typeof raw.isLive !== 'boolean' ||
        !Number.isFinite(checked) ||
        checked < started ||
        checked > ended ||
        ended - checked > freshMaximum ||
        (raw.isLive
          ? typeof raw.streamId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(raw.streamId)
          : raw.streamId !== null)
      )
        throw new Error('Unverified observation');
      status = {
        ...r,
        status: raw.isLive ? 'live' : 'offline',
        checkedAt: new Date(checked).toISOString(),
        nextCheckAt: new Date(ended + this.interval).toISOString(),
        streamId: raw.isLive ? raw.streamId : null,
      };
    } catch {
      status = this.unknown(r);
    }
    const saved = this.db
      .prepare(
        `UPDATE worker_streamer_live SET status=?,checked_at=?,next_check_at=?,stream_id=?,request_token=NULL,revision=revision+1 WHERE platform=? AND provider_id=? AND username=? AND request_token=? AND revision=?`,
      )
      .run(
        status.status,
        status.checkedAt,
        status.nextCheckAt,
        status.streamId,
        r.platform,
        r.providerId,
        r.username,
        token,
        old.revision + 1,
      );
    return saved.changes === 1 ? status : this.unknown(r);
  }
  async requireLive(input: LiveRecipient): Promise<LiveStatus> {
    const status = await this.check(input, { fresh: true });
    if (status.status === 'offline')
      throw new LiveGateError(409, 'The selected streamer is offline. The payout remains held.');
    if (status.status !== 'live')
      throw new LiveGateError(503, 'Live status could not be verified. The payout remains held.');
    this.assertFreshLive(input);
    return status;
  }
  assertFreshLive(input: LiveRecipient, maxAgeMs = 15000): void {
    this.running();
    const r = recipient(input),
      row = this.read(r),
      now = this.time();
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > freshMaximum)
      throw new LiveGateError(400, 'The live observation validity window is invalid.');
    if (
      !row ||
      row.username !== r.username ||
      row.status === 'unknown' ||
      row.requestToken ||
      row.checkedAt === null
    )
      throw new LiveGateError(503, 'A fresh verified live stream is required before payout.');
    if (row.status === 'offline')
      throw new LiveGateError(409, 'The selected streamer is offline. The payout remains held.');
    const checked = Date.parse(row.checkedAt);
    if (!row.streamId || !Number.isFinite(checked) || checked > now || now - checked > maxAgeMs)
      throw new LiveGateError(503, 'The live observation expired. Recheck before payout.');
  }
  list(): LiveStatus[] {
    return this.db
      .prepare(
        'SELECT platform,provider_id FROM worker_streamer_live ORDER BY next_check_at,platform,provider_id',
      )
      .all()
      .map((row) =>
        publicStatus(
          this.read({
            platform: String(row.platform) as LiveRecipient['platform'],
            providerId: String(row.provider_id),
            username: '',
          })!,
        ),
      );
  }
  pollDue(): Promise<{ checked: number }> {
    this.running();
    if (this.polling) return this.polling;
    const due = this.db
      .prepare(
        'SELECT platform,provider_id,username FROM worker_streamer_live WHERE next_check_at<=? ORDER BY next_check_at,platform,provider_id LIMIT ?',
      )
      .all(new Date(this.time()).toISOString(), batchSize)
      .map((row) => ({
        platform: String(row.platform) as LiveRecipient['platform'],
        providerId: String(row.provider_id),
        username: String(row.username),
      }));
    const task = (async () => {
      let checked = 0;
      for (const r of due) {
        if (this.stopped) break;
        await this.check(r);
        checked++;
      }
      return { checked };
    })();
    this.polling = task;
    this.track(task);
    void task
      .finally(() => {
        if (this.polling === task) this.polling = undefined;
      })
      .catch(() => {});
    return task;
  }
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active]);
  }
}
