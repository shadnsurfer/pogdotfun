import type { LedgerEvent, Platform, Streamer, Token } from './data';

export interface RecipientProfile {
  id: string;
  platform: 'twitch' | 'kick';
  username: string;
  displayName: string;
  imageUrl: string;
  channelUrl: string;
}

const isPlatform = (value: unknown): value is Platform => value === 'twitch' || value === 'kick';
const username = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value.toLowerCase() : null;

function imageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

/** Profiles may decorate the recorded recipient, never replace their identity. */
export function verifiedRecipientProfile(
  platform: Platform,
  recordedUsername: string,
  value: unknown,
): RecipientProfile | null {
  const handle = username(recordedUsername);
  if (
    !isPlatform(platform) ||
    !handle ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return null;
  const profile = value as Record<string, unknown>;
  if (
    profile.platform !== platform ||
    username(profile.username) !== handle ||
    typeof profile.id !== 'string' ||
    !new RegExp(`^${platform}:[a-zA-Z0-9_-]{1,100}$`).test(profile.id) ||
    typeof profile.displayName !== 'string' ||
    !profile.displayName.trim() ||
    profile.displayName.length > 100
  )
    return null;
  return {
    id: profile.id,
    platform,
    username: handle,
    displayName: profile.displayName.trim(),
    imageUrl: imageUrl(profile.imageUrl),
    channelUrl: `https://${platform === 'twitch' ? 'www.twitch.tv' : 'kick.com'}/${encodeURIComponent(handle)}`,
  };
}

type ActivityIdentity = Pick<
  LedgerEvent,
  'tokenId' | 'recipientId' | 'recipientPlatform' | 'recipientUsername' | 'route'
>;
type TokenIdentity = Pick<Token, 'id' | 'streamerId'>;
type StreamerIdentity = Pick<Streamer, 'id' | 'platform' | 'handle' | 'name' | 'image'>;
export interface ActivityRecipient {
  platform: Platform;
  username: string;
  profile: RecipientProfile | null;
}

/** Resolve rows, search and receipt modals from the same recorded recipient binding. */
export function activityRecipient(
  event: ActivityIdentity,
  tokenList: readonly TokenIdentity[],
  streamerList: readonly StreamerIdentity[],
): ActivityRecipient | null {
  if (event.route === 'treasury') return null;
  // A supplied ID is authoritative even when its profile has disappeared.
  const id = event.recipientId ?? tokenList.find((token) => token.id === event.tokenId)?.streamerId;
  const legacy = /^legacy:(twitch|kick):([a-zA-Z0-9_-]{1,100})$/.exec(id ?? '');
  const identityPlatform = legacy?.[1] ?? /^(twitch|kick):[^:]+$/.exec(id ?? '')?.[1];
  const recordedPlatform = event.recipientPlatform;
  const recordedUsername = username(event.recipientUsername);
  if (
    (recordedPlatform !== undefined && !isPlatform(recordedPlatform)) ||
    (event.recipientUsername !== undefined && !recordedUsername) ||
    (recordedPlatform && identityPlatform && recordedPlatform !== identityPlatform) ||
    (recordedUsername && legacy && recordedUsername !== legacy[2].toLowerCase())
  )
    return null;
  const streamer =
    typeof id === 'string' && id ? streamerList.find((streamer) => streamer.id === id) : undefined;
  const candidatePlatform = recordedPlatform ?? identityPlatform ?? streamer?.platform;
  const handle =
    recordedUsername ?? (legacy ? legacy[2].toLowerCase() : username(streamer?.handle));
  if (!isPlatform(candidatePlatform) || !handle) return null;
  return {
    platform: candidatePlatform,
    username: handle,
    profile: streamer
      ? verifiedRecipientProfile(candidatePlatform, handle, {
          id: streamer.id,
          platform: streamer.platform,
          username: streamer.handle,
          displayName: streamer.name,
          imageUrl: streamer.image,
        })
      : null,
  };
}
