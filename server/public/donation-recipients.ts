/** Public presentation only: never a source of payout identity or financial evidence. */
export interface DonationRecipientProfile {
  id: string;
  platform: 'twitch' | 'kick';
  username: string;
  displayName: string;
  imageUrl: string;
  channelUrl: string;
}
export interface PublicDonationRecipientRecord {
  id: string;
  recipientPlatform: string;
  recipientUsername: string;
  completedAt: string;
  tokenId?: string;
  origin?: string;
  recipientProfile?: DonationRecipientProfile;
}
export interface DonationRecipientOptions {
  profiles: () => readonly unknown[];
  /** Only server-loaded, already-public completed records enter this callback.
   * undefined means legacy/unbound; null means a contradictory saved identity. */
  expectedId: (record: PublicDonationRecipientRecord) => string | null | undefined;
  lookup: (platform: 'twitch' | 'kick', username: string) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
  maximumCacheEntries?: number;
}
const TTL_MS = 300_000;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function username(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_]{3,25}$/.test(value)
    ? value.toLowerCase()
    : null;
}
function identity(value: unknown, platform: 'twitch' | 'kick'): value is string {
  return typeof value === 'string' && new RegExp(`^${platform}:[a-zA-Z0-9_-]{1,100}$`).test(value);
}
function projection(
  value: unknown,
  platform: 'twitch' | 'kick',
  handle: string,
  now: number,
): DonationRecipientProfile | undefined {
  const profile = object(value);
  if (
    !profile ||
    profile.platform !== platform ||
    username(profile.handle) !== handle ||
    !identity(profile.id, platform)
  )
    return;
  if (
    typeof profile.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(profile.verifiedAt)) ||
    Date.parse(profile.verifiedAt) > now + 5000
  )
    return;
  if (
    typeof profile.name !== 'string' ||
    !profile.name.trim() ||
    profile.name.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(profile.name)
  )
    return;
  if (typeof profile.image !== 'string' || profile.image.length > 2048) return;
  let image: URL;
  try {
    image = new URL(profile.image);
  } catch {
    return;
  }
  if (image.protocol !== 'https:' || !image.hostname || image.username || image.password) return;
  // Do not expose provider credentials, biography, verification internals, or supplied channel URLs.
  return {
    id: profile.id,
    platform,
    username: handle,
    displayName: profile.name.trim(),
    imageUrl: image.href,
    channelUrl: `https://${platform === 'twitch' ? 'www.twitch.tv' : 'kick.com'}/${handle}`,
  };
}

export class DonationRecipientProfiles {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maximumCacheEntries: number;
  private readonly cache = new Map<
    string,
    { expires: number; profile: DonationRecipientProfile | undefined }
  >();
  private readonly pending = new Map<string, Promise<DonationRecipientProfile | undefined>>();
  private active = 0;
  private requestTimes: number[] = [];
  constructor(private readonly options: DonationRecipientOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maximumCacheEntries = options.maximumCacheEntries ?? 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000)
      throw new Error('Recipient profile timeout must be 1–5000 milliseconds.');
    if (
      !Number.isSafeInteger(this.maximumCacheEntries) ||
      this.maximumCacheEntries < 1 ||
      this.maximumCacheEntries > 10000
    )
      throw new Error('Recipient profile cache must hold 1–10000 entries.');
  }
  private remember(key: string, profile: DonationRecipientProfile | undefined) {
    this.cache.delete(key);
    this.cache.set(key, { expires: this.now() + TTL_MS, profile });
    while (this.cache.size > this.maximumCacheEntries)
      this.cache.delete(this.cache.keys().next().value!);
  }
  private lookup(
    platform: 'twitch' | 'kick',
    handle: string,
    id: string,
  ): Promise<DonationRecipientProfile | undefined> {
    const key = `${platform}:${handle}:${id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached.profile);
    if (cached) this.cache.delete(key);
    const prior = this.pending.get(key);
    if (prior) return prior;
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => time > now - 60000);
    if (
      this.active >= 2 ||
      this.pending.size >= Math.min(32, this.maximumCacheEntries) ||
      this.requestTimes.length >= 20
    )
      return Promise.resolve(undefined);
    this.active++;
    this.requestTimes.push(now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The directory itself bounds its HTTP calls. Retain the physical slot until it
    // finishes, even after the public response deadline, so an ignored timeout cannot
    // create an unbounded number of provider requests.
    const fetch = Promise.resolve()
      .then(() => this.options.lookup(platform, handle))
      .finally(() => {
        this.active--;
      });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Recipient profile unavailable.')), this.timeoutMs);
    });
    const work = Promise.race([fetch, timeout])
      .then((value) => {
        const profile = projection(value, platform, handle, this.now());
        return profile?.id === id ? profile : undefined;
      })
      .catch(() => undefined)
      .then((profile) => {
        this.remember(key, profile);
        return profile;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.pending.delete(key);
      });
    this.pending.set(key, work);
    return work;
  }
  async enrich<T extends PublicDonationRecipientRecord>(
    records: readonly T[],
  ): Promise<Array<T & { recipientProfile?: DonationRecipientProfile }>> {
    let saved: readonly unknown[] = [];
    try {
      const value = this.options.profiles();
      if (Array.isArray(value)) saved = value.slice(0, 10000);
    } catch {
      /* Profile failure never suppresses receipts. */
    }
    return Promise.all(
      records.map(async (record) => {
        const { recipientProfile: _oldProfile, ...base } = record;
        const unchanged = base as T;
        const handle = username(record.recipientUsername),
          platform = record.recipientPlatform;
        if (
          !handle ||
          (platform !== 'twitch' && platform !== 'kick') ||
          typeof record.completedAt !== 'string' ||
          !Number.isFinite(Date.parse(record.completedAt)) ||
          Date.parse(record.completedAt) > this.now() + 5000
        )
          return unchanged;
        let expected: string | null | undefined;
        try {
          expected = this.options.expectedId(record);
        } catch {
          return unchanged;
        }
        if (!identity(expected, platform)) return unchanged;
        const candidates = saved
          .map((raw) => projection(raw, platform, handle, this.now()))
          .filter((value): value is DonationRecipientProfile => !!value);
        const matching = candidates.find((profile) => profile.id === expected);
        // Even a single current cached handle cannot establish historical ownership.
        // Only the persisted donation/launch identity may authorize profile enrichment.
        const profile = matching ?? (await this.lookup(platform, handle, expected));
        return profile ? { ...unchanged, recipientProfile: { ...profile } } : unchanged;
      }),
    );
  }
}
