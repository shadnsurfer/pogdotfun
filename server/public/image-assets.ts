import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { PublicError } from './identity.ts';
import { decodeTokenImage } from './uploads.ts';

export const TOKEN_IMAGE_MAX_BYTES = 256 * 1024;
const MAX_PIXELS = 4096 * 4096;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface TokenImageAsset {
  id: string;
  bytes: Uint8Array;
  mime: 'image/webp';
  width: number;
  height: number;
}

// Keep raster decoding off the event loop and bound native memory across uploaders.
let active = 0;
const waiting: Array<() => void> = [];
async function acquire() {
  if (active < 2) {
    active++;
    return;
  }
  if (waiting.length >= 32)
    throw new PublicError(503, 'Image processing is busy. Try again shortly.');
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(ready);
      if (index >= 0) waiting.splice(index, 1);
      reject(new PublicError(503, 'Image processing is busy. Try again shortly.'));
    }, 5000);
    waiting.push(ready);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export async function prepareTokenImageAsset(input: unknown): Promise<TokenImageAsset> {
  const { bytes, mime } = decodeTokenImage(input);
  await acquire();
  try {
    const image = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      limitInputChannels: 4,
      failOn: 'warning',
      pages: 1,
    });
    const metadata = await image.metadata();
    if (
      `image/${metadata.format}` !== mime ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 16384 ||
      metadata.height > 16384
    )
      throw Error('invalid raster');
    let output = await image
      .autoOrient()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, alphaQuality: 80, effort: 3 })
      .timeout({ seconds: 3 })
      .toBuffer({ resolveWithObject: true });
    if (output.data.length > TOKEN_IMAGE_MAX_BYTES) {
      output = await sharp(output.data, { limitInputPixels: 512 * 512, failOn: 'warning' })
        .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 65, alphaQuality: 65, effort: 3 })
        .timeout({ seconds: 3 })
        .toBuffer({ resolveWithObject: true });
    }
    if (!output.data.length || output.data.length > TOKEN_IMAGE_MAX_BYTES)
      throw Error('oversized derivative');
    return {
      id: hash(output.data),
      bytes: output.data,
      mime: 'image/webp',
      width: output.info.width,
      height: output.info.height,
    };
  } catch {
    throw new PublicError(
      400,
      'Choose a valid PNG, JPEG or WebP image with no more than 16 megapixels.',
    );
  } finally {
    release();
  }
}

export class TokenImageAssets {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS public_image_assets (
      id TEXT PRIMARY KEY, bytes BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      CHECK(length(bytes)>0 AND length(bytes)<=262144),
      CHECK(width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 512)
    );
    CREATE TABLE IF NOT EXISTS public_image_asset_sources (
      uri TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES public_image_assets(id)
    );
    CREATE TRIGGER IF NOT EXISTS public_image_assets_no_update BEFORE UPDATE ON public_image_assets BEGIN SELECT RAISE(ABORT,'Image asset is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS public_image_assets_no_delete BEFORE DELETE ON public_image_assets BEGIN SELECT RAISE(ABORT,'Image asset is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS public_image_sources_no_update BEFORE UPDATE ON public_image_asset_sources BEGIN SELECT RAISE(ABORT,'Image source is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS public_image_sources_no_delete BEFORE DELETE ON public_image_asset_sources BEGIN SELECT RAISE(ABORT,'Image source is immutable'); END;`);
  }

  url(originalUri: string): string {
    const row = this.db
      .prepare('SELECT asset_id FROM public_image_asset_sources WHERE uri=?')
      .get(originalUri);
    return row ? `/api/token-images/${String(row.asset_id)}` : originalUri;
  }

  get(id: string): TokenImageAsset | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return;
    const row = this.db
      .prepare('SELECT bytes,width,height FROM public_image_assets WHERE id=?')
      .get(id);
    if (!row || !(row.bytes instanceof Uint8Array) || hash(row.bytes) !== id) return;
    return {
      id,
      bytes: row.bytes,
      mime: 'image/webp',
      width: Number(row.width),
      height: Number(row.height),
    };
  }

  /** Called inside the upload's synchronous savepoint with its ownership record. */
  save(originalUri: string, asset: TokenImageAsset) {
    const previous = this.db
      .prepare('SELECT asset_id FROM public_image_asset_sources WHERE uri=?')
      .get(originalUri);
    if (previous && previous.asset_id !== asset.id)
      throw new PublicError(502, 'Image storage returned a conflicting image reference.');
    this.db
      .prepare('INSERT OR IGNORE INTO public_image_assets(id,bytes,width,height) VALUES(?,?,?,?)')
      .run(asset.id, asset.bytes, asset.width, asset.height);
    this.db
      .prepare('INSERT OR IGNORE INTO public_image_asset_sources(uri,asset_id) VALUES(?,?)')
      .run(originalUri, asset.id);
  }
}
