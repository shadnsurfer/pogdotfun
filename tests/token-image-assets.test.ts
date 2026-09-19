import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import { createPublicServices } from '../server/public/service.ts';

const owner = { userId: 'did:privy:image-owner', walletAddresses: [] };
const cid = 'Qm' + 'a'.repeat(44);
const originalUri = `https://gateway.pinata.cloud/ipfs/${cid}`;
const dataUrl = (bytes: Buffer, format = 'png') =>
  `data:image/${format};base64,${bytes.toString('base64')}`;
function fixture(db: DatabaseSync) {
  const originals: Buffer[] = [];
  const service = createPublicServices(db, {
    env: { PINATA_API_KEY: 'fixture-key', PINATA_API_SECRET: 'fixture-secret' },
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.pinata.cloud/pinning/pinFileToIPFS');
      const file = (init!.body as FormData).get('file') as File;
      originals.push(Buffer.from(await file.arrayBuffer()));
      return Response.json({ IpfsHash: cid });
    },
  });
  return { service, originals };
}

test('upload persists a bounded local WebP while pinning the untouched original', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { service, originals } = fixture(db);
    const original = await sharp({
      create: { width: 1600, height: 900, channels: 4, background: '#8f46ff80' },
    })
      .png()
      .withExif({ IFD0: { Copyright: 'private image metadata' } })
      .toBuffer();
    const result = await service.image(owner, { imageDataUrl: dataUrl(original) });
    assert.equal(result.uri, originalUri);
    assert.deepEqual(originals, [original]);
    assert.equal(
      typeof service.imageAssetUrl,
      'function',
      'upload should publish a stored derivative',
    );
    const url = service.imageAssetUrl(result.uri);
    assert.match(url, /^\/api\/token-images\/[a-f0-9]{64}$/);
    const asset = service.imageAsset(url.split('/').at(-1)!);
    assert.ok(asset);
    assert.equal(asset.mime, 'image/webp');
    assert.ok(asset.bytes.length > 0 && asset.bytes.length <= 256 * 1024);
    assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), asset.id);
    const decoded = await sharp(asset.bytes).metadata();
    assert.equal(decoded.format, 'webp');
    assert.equal(decoded.width, 512);
    assert.equal(decoded.height, 288);
    assert.equal(decoded.hasAlpha, true);
    assert.equal(decoded.exif, undefined);
    assert.equal(service.imageAsset('a'.repeat(64)), undefined);
    assert.equal(service.imageAsset('../private'), undefined);
    assert.equal(
      service.imageAssetUrl('https://legacy.invalid/original.png'),
      'https://legacy.invalid/original.png',
    );
  } finally {
    db.close();
  }
});

test('image mapping survives database reopen and exact retries never repin or replace ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pog-image-assets-'));
  let db = new DatabaseSync(join(directory, 'db.sqlite'));
  try {
    const original = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#fafa01' },
    })
      .jpeg()
      .toBuffer();
    const input = { imageDataUrl: dataUrl(original, 'jpeg') };
    const first = fixture(db);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => first.service.image(owner, input)),
    );
    assert.equal(first.originals.length, 1);
    assert.equal(typeof first.service.imageAssetUrl, 'function');
    const url = first.service.imageAssetUrl(results[0].uri);
    const bytes = first.service.imageAsset(url.split('/').at(-1)!)!.bytes;
    db.close();
    db = new DatabaseSync(join(directory, 'db.sqlite'));
    const second = fixture(db);
    await second.service.image(owner, input);
    assert.equal(second.originals.length, 0);
    assert.equal(second.service.imageAssetUrl(originalUri), url);
    assert.deepEqual(second.service.imageAsset(url.split('/').at(-1)!)!.bytes, bytes);
    assert.equal((await sharp(bytes).metadata()).width, 40, 'small originals must not be enlarged');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_uploads').get()!.n, 1);
    assert.throws(() => db.prepare('UPDATE public_image_assets SET width=1').run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM public_image_asset_sources').run(), /immutable/);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt raster and oversized pixel dimensions fail before any remote pin or saved upload', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { service, originals } = fixture(db);
    const corrupt = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const tooManyPixels = await sharp({
      create: { width: 4097, height: 4096, channels: 3, background: '#555555' },
    })
      .png()
      .toBuffer();
    for (const bytes of [corrupt, tooManyPixels]) {
      await assert.rejects(service.image(owner, { imageDataUrl: dataUrl(bytes) }), /image|Image/);
    }
    assert.equal(originals.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_uploads').get()!.n, 0);
  } finally {
    db.close();
  }
});

test('legacy owned upload can acquire a thumbnail only from its exact resent original', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { service, originals } = fixture(db);
    const original = await sharp({
      create: { width: 50, height: 50, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const imageDataUrl = dataUrl(original);
    db.prepare('INSERT INTO public_uploads(owner,digest,uri) VALUES(?,?,?)').run(
      owner.userId,
      createHash('sha256').update(imageDataUrl).digest('hex'),
      originalUri,
    );
    await service.image(owner, { imageDataUrl });
    assert.equal(typeof service.imageAssetUrl, 'function');
    assert.match(service.imageAssetUrl(originalUri), /^\/api\/token-images\/[a-f0-9]{64}$/);
    assert.equal(originals.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_uploads').get()!.n, 1);
  } finally {
    db.close();
  }
});

test('high-detail artwork stays within the derivative byte budget across a rapid upload burst', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { service, originals } = fixture(db);
    const pixels = Buffer.alloc(1024 * 1024 * 3);
    let seed = 123456789;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
    const source = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    assert.ok(source.length > 512 * 1024 && source.length < 2 * 1024 * 1024);
    const input = { imageDataUrl: dataUrl(source, 'jpeg') };
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        service.image({ ...owner, userId: `fixture:${index}` }, input),
      ),
    );
    const asset = service.imageAsset(service.imageAssetUrl(originalUri).split('/').at(-1)!)!;
    assert.equal(originals.length, 24, 'each uploader retains their original authenticated upload');
    assert.ok(asset.bytes.length <= 256 * 1024);
    assert.ok(asset.bytes.length < source.length / 4);
    assert.equal(asset.width, 512);
    assert.equal(asset.height, 512);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_image_assets').get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_uploads').get()!.n, 24);
    console.log(
      `Local image measurement: ${source.length} original bytes -> ${asset.bytes.length} WebP bytes (1024px -> 512px).`,
    );
  } finally {
    db.close();
  }
});

test('a failed ownership commit leaves no derivative or URI mapping published', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { service } = fixture(db);
    db.exec(
      "CREATE TRIGGER fixture_upload_failure BEFORE INSERT ON public_uploads BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;",
    );
    const source = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#800080' },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      service.image(owner, { imageDataUrl: dataUrl(source) }),
      /fixture storage failure/,
    );
    assert.equal(service.imageAssetUrl(originalUri), originalUri);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_image_assets').get()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_image_asset_sources').get()!.n, 0);
  } finally {
    db.close();
  }
});
