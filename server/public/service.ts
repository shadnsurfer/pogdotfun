import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';
import { PublicError, createPublicIdentity } from './identity.ts';
import type { IdentityProvider, PublicPrincipal } from './identity.ts';
import { StreamerDirectory } from './streamers.ts';
import { PinataUploads } from './uploads.ts';
import { prepareTokenImageAsset, TokenImageAssets } from './image-assets.ts';
import type { VerifiedLaunchInput } from '../launch/types.ts';
import { normalizeInitialBuyLamports } from '../launch/initial-buy.ts';
import { isRecipientPlatformEnabled } from '../platform-policy.ts';
import {
  normalizeTokenXLink,
  TOKEN_METADATA_POLICY,
  TOKEN_WEBSITE,
} from '../launch/metadata-policy.ts';

export interface PublicServiceOptions {
  env?: Record<string, string | undefined>;
  identity?: IdentityProvider;
  fetch?: typeof fetch;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function createPublicServices(db: DatabaseSync, options: PublicServiceOptions = {}) {
  const env = options.env ?? process.env;
  const identity = createPublicIdentity(options.identity, env);
  const directory = new StreamerDirectory(env, options.fetch);
  const uploads = new PinataUploads(env, options.fetch);
  const imageAssets = new TokenImageAssets(db);
  db.exec(`CREATE TABLE IF NOT EXISTS public_uploads (owner TEXT NOT NULL,digest TEXT NOT NULL,uri TEXT NOT NULL,PRIMARY KEY(owner,digest));
 CREATE TABLE IF NOT EXISTS public_recipients (id TEXT PRIMARY KEY,platform TEXT NOT NULL,username TEXT NOT NULL,payload TEXT NOT NULL, UNIQUE(platform,username));
 CREATE TABLE IF NOT EXISTS public_profiles (id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 INSERT OR IGNORE INTO public_profiles(id,payload) SELECT id,payload FROM public_recipients;
 CREATE TABLE IF NOT EXISTS public_rate_limits (owner TEXT NOT NULL,action TEXT NOT NULL,period INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(owner,action));
 CREATE TABLE IF NOT EXISTS public_metadata (owner TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,uri TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,request_id));`);
  const pending = new Map<string, Promise<unknown>>();
  async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = pending.get(key);
    if (prior) {
      await prior.catch(() => {});
      return serial(key, work);
    }
    const p = work();
    pending.set(key, p);
    try {
      return await p;
    } finally {
      pending.delete(key);
    }
  }
  function rateLimit(owner: string, action: string, maximum: number, periodMs = 3600000) {
    const period = Math.floor(Date.now() / periodMs);
    const row = db
      .prepare('SELECT period,count FROM public_rate_limits WHERE owner=? AND action=?')
      .get(owner, action);
    if (row && row.period === period && Number(row.count) >= maximum)
      throw new PublicError(429, 'Too many requests. Please try again later.');
    db.prepare(
      'INSERT INTO public_rate_limits(owner,action,period,count) VALUES(?,?,?,1) ON CONFLICT(owner,action) DO UPDATE SET count=CASE WHEN period=excluded.period THEN count+1 ELSE 1 END,period=excluded.period',
    ).run(owner, action, period);
  }
  async function lookup(platform: unknown, username: unknown) {
    if (platform === 'kick' && !isRecipientPlatformEnabled(platform))
      throw new PublicError(503, 'Choose a supported Twitch or Kick recipient.');
    const profile = await directory.lookup(platform, username);
    db.prepare(
      'INSERT INTO public_profiles(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
    ).run(profile.id, JSON.stringify(profile));
    return profile;
  }
  return {
    identity,
    rateLimit,
    verifyRecipient: lookup,
    imageAssetUrl: (originalUri: string) => imageAssets.url(originalUri),
    imageAsset: (id: string) => imageAssets.get(id),
    config() {
      return {
        privyAppId: identity.configured ? (env.PRIVY_APP_ID ?? null) : null,
        chain: 'solana:mainnet',
        providers: {
          twitch: isRecipientPlatformEnabled('twitch') && directory.configured('twitch'),
          kick: isRecipientPlatformEnabled('kick') && directory.configured('kick'),
        },
        uploadsEnabled: uploads.configured(),
      };
    },
    async lookup(principal: PublicPrincipal, platform: unknown, username: unknown) {
      rateLimit(principal.userId, 'lookup', 120);
      return lookup(platform, username);
    },
    async image(principal: PublicPrincipal, input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((k) => k !== 'imageDataUrl')
      )
        throw new PublicError(400, 'Send one token image.');
      const imageDataUrl = (input as { imageDataUrl: unknown }).imageDataUrl;
      if (typeof imageDataUrl !== 'string' || imageDataUrl.length > 2800000)
        throw new PublicError(400, 'Choose an image no larger than 2 MiB.');
      const digest = hash(imageDataUrl);
      return serial(`image:${principal.userId}:${digest}`, async () => {
        const existing = db
          .prepare('SELECT uri FROM public_uploads WHERE owner=? AND digest=?')
          .get(principal.userId, digest);
        if (existing && imageAssets.url(String(existing.uri)) !== existing.uri)
          return { uri: existing.uri as string };
        if (!existing) rateLimit(principal.userId, 'upload', 10, 86400000);
        const derivative = await prepareTokenImageAsset(imageDataUrl);
        const result = existing ? { uri: String(existing.uri) } : await uploads.image(imageDataUrl);
        db.exec('SAVEPOINT public_image_upload');
        try {
          imageAssets.save(result.uri, derivative);
          if (!existing)
            db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
              principal.userId,
              digest,
              result.uri,
            );
          db.exec('RELEASE public_image_upload');
        } catch (error) {
          db.exec('ROLLBACK TO public_image_upload; RELEASE public_image_upload');
          throw error;
        }
        return result;
      });
    },
    async verifiedLaunch(principal: PublicPrincipal, input: unknown): Promise<VerifiedLaunchInput> {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new PublicError(400, 'Enter your token details.');
      const b = input as Record<string, unknown>;
      if (
        Object.keys(b).some(
          (k) =>
            ![
              'requestId',
              'name',
              'symbol',
              'description',
              'imageUri',
              'twitter',
              'recipientPlatform',
              'recipientUsername',
              'walletAddress',
              'initialBuyLamports',
            ].includes(k),
        )
      )
        throw new PublicError(400, 'Unknown launch field.');
      if (typeof b.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(b.requestId))
        throw new PublicError(400, 'A valid request ID is required.');
      if (
        typeof b.name !== 'string' ||
        b.name.trim().length < 2 ||
        b.name.trim().length > 32 ||
        /[\u0000-\u001f]/.test(b.name)
      )
        throw new PublicError(400, 'Use a token name of 2–32 characters.');
      if (typeof b.symbol !== 'string' || !/^[A-Z0-9]{2,10}$/.test(b.symbol))
        throw new PublicError(400, 'Use a symbol of 2–10 uppercase letters or numbers.');
      if (typeof b.description !== 'string' || b.description.length > 500)
        throw new PublicError(400, 'Use a description of up to 500 characters.');
      let initialBuyLamports: string | undefined;
      try {
        initialBuyLamports = normalizeInitialBuyLamports(b.initialBuyLamports);
      } catch {
        throw new PublicError(400, 'Enter a valid initial buy amount in whole lamports.');
      }
      if (
        typeof b.walletAddress !== 'string' ||
        !principal.walletAddresses.includes(b.walletAddress)
      )
        throw new PublicError(403, 'Connect and verify this Solana wallet before launching.');
      try {
        new PublicKey(b.walletAddress);
      } catch {
        throw new PublicError(400, 'Invalid Solana wallet.');
      }
      if (
        typeof b.imageUri !== 'string' ||
        !db
          .prepare('SELECT 1 FROM public_uploads WHERE owner=? AND uri=?')
          .get(principal.userId, b.imageUri)
      )
        throw new PublicError(403, 'Upload this token image from your own account first.');
      let twitter: string | undefined;
      try {
        twitter = normalizeTokenXLink(b.twitter);
      } catch {
        throw new PublicError(400, 'Use a full HTTPS X profile, community, or post link.');
      }
      const inputHash = hash(
        JSON.stringify(
          Object.fromEntries(
            Object.entries({
              ...b,
              initialBuyLamports,
              twitter,
              metadataPolicy: TOKEN_METADATA_POLICY,
            }).sort(([left], [right]) => left.localeCompare(right)),
          ),
        ),
      );
      return serial(`launch-meta:${principal.userId}:${b.requestId}`, async () => {
        const prior = db
          .prepare('SELECT digest,payload FROM public_metadata WHERE owner=? AND request_id=?')
          .get(principal.userId, b.requestId as string);
        if (prior) {
          if (prior.digest !== inputHash)
            throw new PublicError(
              409,
              'This request ID already belongs to different launch details.',
            );
          rateLimit(principal.userId, 'lookup', 120);
          const saved = JSON.parse(prior.payload as string) as VerifiedLaunchInput;
          const current = await lookup(saved.recipient.platform, saved.recipient.username);
          if (current.id !== saved.recipient.id)
            throw new PublicError(
              409,
              'This username now belongs to a different account. Verify the intended streamer again.',
            );
          saved.recipient.verifiedAt = current.verifiedAt;
          db.prepare('UPDATE public_metadata SET payload=? WHERE owner=? AND request_id=?').run(
            JSON.stringify(saved),
            principal.userId,
            saved.requestId,
          );
          return saved;
        }
        rateLimit(principal.userId, 'prepare', 10, 86400000);
        const recipient = await lookup(b.recipientPlatform, b.recipientUsername);
        const content = {
          name: (b.name as string).trim(),
          symbol: b.symbol,
          description: b.description,
          image: b.imageUri,
          showName: true,
          website: TOKEN_WEBSITE,
          external_url: TOKEN_WEBSITE,
          ...(twitter ? { twitter } : {}),
        };
        const metadata = await uploads.metadata(content);
        const verified: VerifiedLaunchInput = {
          requestId: b.requestId as string,
          name: content.name,
          symbol: b.symbol as string,
          description: b.description as string,
          imageUri: b.imageUri as string,
          metadataUri: metadata.uri,
          walletAddress: b.walletAddress as string,
          website: TOKEN_WEBSITE,
          ...(twitter ? { twitter } : {}),
          ...(initialBuyLamports ? { initialBuyLamports } : {}),
          recipient: {
            id: recipient.id,
            platform: recipient.platform,
            username: recipient.handle,
            channelUrl: recipient.channelUrl,
            verified: true,
            verifiedAt: recipient.verifiedAt,
          },
        };
        db.prepare(
          'INSERT INTO public_metadata(owner,request_id,digest,uri,payload) VALUES(?,?,?,?,?)',
        ).run(
          principal.userId,
          verified.requestId,
          inputHash,
          metadata.uri,
          JSON.stringify(verified),
        );
        return verified;
      });
    },
    recipients() {
      return db
        .prepare('SELECT payload FROM public_profiles')
        .all()
        .map((r) => JSON.parse(r.payload as string));
    },
  };
}
