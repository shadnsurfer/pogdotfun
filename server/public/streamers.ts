import { PublicError } from './identity.ts';
export interface VerifiedStreamer {
  id: string;
  name: string;
  handle: string;
  platform: 'twitch' | 'kick';
  image: string;
  channelUrl: string;
  category: string;
  bio: string;
  color: string;
  isLive: boolean | null;
  giftEligibility: 'unverified';
  verifiedAt: string;
}
export interface StreamLiveStatus {
  platform: 'twitch' | 'kick';
  providerId: string;
  username: string;
  isLive: boolean;
  checkedAt: string;
  streamId: string | null;
}
type Env = Record<string, string | undefined>;
type Token = { value: string; expires: number };
function httpsImage(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}
export class StreamerDirectory {
  private tokens = new Map<string, Token>();
  private pending = new Map<string, Promise<string>>();
  constructor(
    private env: Env = process.env,
    private request: typeof fetch = fetch,
  ) {}
  configured(platform: 'twitch' | 'kick') {
    const p = platform.toUpperCase();
    return !!(this.env[`${p}_CLIENT_ID`] && this.env[`${p}_CLIENT_SECRET`]);
  }
  private async json(url: string, init: RequestInit = {}) {
    try {
      const r = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw Error('upstream');
      return await r.json();
    } catch {
      throw new PublicError(502, 'The streaming provider is unavailable. Please try again later.');
    }
  }
  private async token(platform: 'twitch' | 'kick') {
    const stored = this.tokens.get(platform);
    if (stored && stored.expires > Date.now()) return stored.value;
    const inflight = this.pending.get(platform);
    if (inflight) return inflight;
    const promise = (async () => {
      const prefix = platform.toUpperCase();
      const data = await this.json(
        platform === 'kick'
          ? 'https://id.kick.com/oauth/token'
          : 'https://id.twitch.tv/oauth2/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.env[`${prefix}_CLIENT_ID`]!,
            client_secret: this.env[`${prefix}_CLIENT_SECRET`]!,
          }),
        },
      );
      if (typeof data.access_token !== 'string' || !Number.isFinite(Number(data.expires_in)))
        throw new PublicError(502, 'The streaming provider returned an invalid session.');
      this.tokens.set(platform, {
        value: data.access_token,
        expires: Date.now() + Math.max(0, Number(data.expires_in) - 60) * 1000,
      });
      return data.access_token as string;
    })();
    this.pending.set(platform, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(platform);
    }
  }
  async liveStatus(
    platform: 'twitch' | 'kick',
    providerId: string,
    username: string,
  ): Promise<StreamLiveStatus> {
    if (platform !== 'twitch' && platform !== 'kick')
      throw new PublicError(400, 'Choose Twitch or Kick.');
    if (
      typeof providerId !== 'string' ||
      !new RegExp(`^${platform}:[1-9]\\d{0,29}$`).test(providerId) ||
      typeof username !== 'string' ||
      !/^[a-zA-Z0-9_]{3,25}$/.test(username)
    )
      throw new PublicError(400, 'A verified streamer identity is required.');
    if (!this.configured(platform))
      throw new PublicError(
        503,
        `${platform === 'kick' ? 'Kick' : 'Twitch'} live-status lookup is not connected yet.`,
      );
    const handle = username.toLowerCase();
    const userId = providerId.slice(platform.length + 1);
    try {
      // Get Streams returns only broadcasting accounts. Filter by the durable ID;
      // a matching login alone must never redirect a payment after a rename.
      // https://dev.twitch.tv/docs/api/reference/#get-streams
      const token = await this.token(platform);
      if (platform === 'kick') {
        // Official channel API accepts the durable broadcaster ID and exposes
        // stream.is_live + start_time, but no native stream ID.
        // https://docs.kick.com/apis/channels
        const result = await this.json(
          `https://api.kick.com/public/v1/channels?broadcaster_user_id=${userId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const checked = Date.now();
        if (!result || !Array.isArray(result.data) || result.data.length !== 1)
          throw Error('ambiguous channel identity');
        const channel = result.data[0];
        if (
          !channel ||
          !Number.isSafeInteger(channel.broadcaster_user_id) ||
          channel.broadcaster_user_id <= 0 ||
          String(channel.broadcaster_user_id) !== userId ||
          typeof channel.slug !== 'string' ||
          channel.slug.toLowerCase() !== handle ||
          !channel.stream ||
          typeof channel.stream.is_live !== 'boolean'
        )
          throw Error('invalid channel identity');
        const base = {
          platform,
          providerId,
          username: handle,
          checkedAt: new Date(checked).toISOString(),
        };
        if (!channel.stream.is_live) return { ...base, isLive: false, streamId: null };
        const started = channel.stream.start_time;
        if (
          typeof started !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(started) ||
          !Number.isFinite(Date.parse(started)) ||
          Date.parse(started) > checked + 5000
        )
          throw Error('invalid stream identity');
        return {
          ...base,
          isLive: true,
          streamId: `${providerId}:${Date.parse(started)}`,
        };
      }
      const result = await this.json(
        `https://api.twitch.tv/helix/streams?user_id=${userId}&type=live&first=100`,
        { headers: { Authorization: `Bearer ${token}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! } },
      );
      const checked = Date.now();
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        !Array.isArray(result.data) ||
        result.data.length > 1 ||
        !result.pagination ||
        typeof result.pagination !== 'object' ||
        Array.isArray(result.pagination) ||
        Object.keys(result.pagination).some((key) => key !== 'cursor') ||
        ('cursor' in result.pagination &&
          (typeof result.pagination.cursor !== 'string' ||
            !/^[\x21-\x7e]{1,4096}$/.test(result.pagination.cursor)))
      )
        throw Error('invalid live status');
      const base = {
        platform,
        providerId,
        username: handle,
        checkedAt: new Date(checked).toISOString(),
      };
      if (result.data.length === 0) {
        // A partial empty page cannot establish that the pinned account is offline.
        if ('cursor' in result.pagination) throw Error('incomplete live status');
        return { ...base, isLive: false, streamId: null };
      }
      const stream = result.data[0];
      if (
        !stream ||
        typeof stream !== 'object' ||
        Array.isArray(stream) ||
        stream.user_id !== userId ||
        typeof stream.user_login !== 'string' ||
        stream.user_login.toLowerCase() !== handle ||
        stream.type !== 'live' ||
        typeof stream.id !== 'string' ||
        !/^[1-9]\d{0,29}$/.test(stream.id) ||
        typeof stream.started_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(stream.started_at) ||
        !Number.isFinite(Date.parse(stream.started_at)) ||
        Date.parse(stream.started_at) > checked + 5000
      )
        throw Error('invalid stream identity');
      // Twitch may include a cursor even for a single filtered live account.
      // This exact positive identity needs no further page to prove it is live.
      return { ...base, isLive: true, streamId: stream.id };
    } catch {
      throw new PublicError(
        502,
        `${platform === 'kick' ? 'Kick' : 'Twitch'} live status could not be verified. Please try again later.`,
      );
    }
  }
  async lookup(platform: unknown, username: unknown): Promise<VerifiedStreamer> {
    if (platform !== 'kick' && platform !== 'twitch')
      throw new PublicError(400, 'Choose Twitch or Kick.');
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,25}$/.test(username))
      throw new PublicError(400, 'Enter a valid streamer username.');
    if (!this.configured(platform))
      throw new PublicError(
        503,
        `${platform === 'kick' ? 'Kick' : 'Twitch'} profile lookup is not connected yet.`,
      );
    const handle = username.toLowerCase();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token(platform)}`,
    };
    const base = {
      platform: platform as 'twitch' | 'kick',
      handle,
      channelUrl:
        platform === 'kick' ? `https://kick.com/${handle}` : `https://www.twitch.tv/${handle}`,
      giftEligibility: 'unverified' as const,
      verifiedAt: new Date().toISOString(),
    };
    if (platform === 'kick') {
      const channels = await this.json(
        `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(handle)}`,
        { headers },
      );
      const c = Array.isArray(channels.data)
        ? channels.data.find((x: { slug?: string }) => x.slug?.toLowerCase() === handle)
        : undefined;
      if (!c || !Number.isSafeInteger(c.broadcaster_user_id))
        throw new PublicError(404, 'This Kick channel could not be found.');
      const users = await this.json(
        `https://api.kick.com/public/v1/users?id=${c.broadcaster_user_id}`,
        { headers },
      );
      const u = Array.isArray(users.data)
        ? users.data.find((x: { user_id?: number }) => x.user_id === c.broadcaster_user_id)
        : undefined;
      return {
        ...base,
        id: `kick:${c.broadcaster_user_id}`,
        name: typeof u?.name === 'string' ? u.name : handle,
        image: httpsImage(u?.profile_picture),
        category: c.category?.name ?? '',
        bio: c.channel_description ?? '',
        color: '#53FC18',
        isLive: typeof c.stream?.is_live === 'boolean' ? c.stream.is_live : null,
      };
    }
    headers['Client-Id'] = this.env.TWITCH_CLIENT_ID!;
    const users = await this.json(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(handle)}`,
      { headers },
    );
    const u = Array.isArray(users.data)
      ? users.data.find((x: { login?: string }) => x.login?.toLowerCase() === handle)
      : undefined;
    if (!u || typeof u.id !== 'string' || !/^\d+$/.test(u.id))
      throw new PublicError(404, 'This Twitch channel could not be found.');
    return {
      ...base,
      id: `twitch:${u.id}`,
      name: u.display_name ?? handle,
      image: httpsImage(u.profile_image_url),
      category: '',
      bio: u.description ?? '',
      color: '#9146FF',
      isLive: null,
    };
  }
}
