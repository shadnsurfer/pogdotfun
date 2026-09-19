import { CID } from 'multiformats/cid';
import { PublicError } from './identity.ts';
export function decodeTokenImage(input: unknown) {
  const invalid = () =>
    new PublicError(400, 'Upload a PNG, JPEG or WebP image no larger than 2 MiB.');
  if (typeof input !== 'string' || input.length > 2_800_000) throw invalid();
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!m || m[2].length % 4) throw invalid();
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== m[2]) throw invalid();
  const valid =
    m[1] === 'png'
      ? bytes.length > 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : m[1] === 'jpeg'
        ? bytes.length > 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255 &&
          bytes.at(-2) === 255 &&
          bytes.at(-1) === 217
        : bytes.length > 12 &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw invalid();
  return { bytes, mime: `image/${m[1]}`, extension: m[1] };
}
export class PinataUploads {
  constructor(
    private env: Record<string, string | undefined> = process.env,
    private request: typeof fetch = fetch,
  ) {}
  configured() {
    return !!(this.env.PINATA_JWT || (this.env.PINATA_API_KEY && this.env.PINATA_API_SECRET));
  }
  private async upload(path: string, body: BodyInit, json = false) {
    if (!this.configured()) throw new PublicError(503, 'Image storage is not connected yet.');
    const headers: Record<string, string> = this.env.PINATA_JWT
      ? { Authorization: `Bearer ${this.env.PINATA_JWT}` }
      : {
          pinata_api_key: this.env.PINATA_API_KEY!,
          pinata_secret_api_key: this.env.PINATA_API_SECRET!,
        };
    if (json) headers['content-type'] = 'application/json';
    let payload;
    try {
      const r = await this.request(`https://api.pinata.cloud/pinning/${path}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw Error('upstream');
      payload = await r.json();
    } catch {
      throw new PublicError(502, 'Image storage is unavailable. Please try again later.');
    }
    try {
      if (typeof payload.IpfsHash !== 'string' || payload.IpfsHash.length > 120) throw Error();
      const cid = CID.parse(payload.IpfsHash);
      if (![0, 1].includes(cid.version) || cid.toString() !== payload.IpfsHash) throw Error();
    } catch {
      throw new PublicError(502, 'Image storage returned an invalid content identifier.');
    }
    return {
      uri: `https://gateway.pinata.cloud/ipfs/${payload.IpfsHash}`,
      cid: payload.IpfsHash as string,
    };
  }
  image(dataUrl: unknown) {
    const { bytes, mime, extension } = decodeTokenImage(dataUrl);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `token.${extension}`);
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    return this.upload('pinFileToIPFS', form);
  }
  metadata(content: Record<string, unknown>) {
    return this.upload(
      'pinJSONToIPFS',
      JSON.stringify({ pinataContent: content, pinataOptions: { cidVersion: 1 } }),
      true,
    );
  }
}
