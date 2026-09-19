import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { retryAfterSeconds } from './retry-after.js';

const BODY_LIMIT = 3 * 1024 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
// No raster decoder belongs in the stateless gateway. Only serve backend-stored,
// content-addressed WebP bytes after checking their exact type, size and digest.
const TOKEN_IMAGE_LIMIT = 256 * 1024;
const ROUTE_PARAM = '__pog_path';
const REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'origin', 'idempotency-key'];

interface GatewayOptions {
  backendUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type GatewayRequest = IncomingMessage & { body?: unknown };

class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function reply(response: ServerResponse, status: number, message: string) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: message }));
}

function route(request: IncomingMessage) {
  const rawUrl = request.url ?? '/';
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//'))
    throw new GatewayError(400, 'Invalid API route.');
  // Validate before URL parsing, which would otherwise normalize traversal segments.
  const rawPath = rawUrl.split('?')[0];
  if (!/^\/api\/[a-zA-Z0-9_/-]+$/.test(rawPath) || rawPath.includes('//'))
    throw new GatewayError(400, 'Invalid API route.');
  const url = new URL(rawUrl, 'https://gateway.invalid');
  const routedPaths = url.searchParams.getAll(ROUTE_PARAM);
  if (routedPaths.length > 1) throw new GatewayError(400, 'Ambiguous API route.');
  let pathname = rawPath;
  if (pathname === '/api/gateway') {
    if (routedPaths.length !== 1) throw new GatewayError(404, 'API route not found.');
    pathname = `/api/${routedPaths[0]}`;
  } else if (routedPaths.length && pathname !== `/api/${routedPaths[0]}`) {
    throw new GatewayError(400, 'Ambiguous API route.');
  }
  if (!/^\/api\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(pathname))
    throw new GatewayError(400, 'Invalid API route.');
  // Vercel also appends the named :path* capture when it is only used in the
  // rewrite query. It is redundant metadata, never an authority to select a route.
  const wildcardPaths = url.searchParams.getAll('path');
  if (
    wildcardPaths.length &&
    (wildcardPaths.length !== 1 || pathname !== `/api/${wildcardPaths[0]}`)
  )
    throw new GatewayError(400, 'Ambiguous API route.');
  url.searchParams.delete(ROUTE_PARAM);
  url.searchParams.delete('path');
  return { pathname, search: url.searchParams.toString() };
}

function backendOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      ['pog.fun', 'www.pog.fun'].includes(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readBody(request: GatewayRequest, signal: AbortSignal) {
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    throw new GatewayError(415, 'Compressed API request bodies are not supported.');
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new GatewayError(415, 'Send this request as application/json.');
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))
    throw new GatewayError(413, 'Request body exceeds the 3 MiB limit.');

  // Vercel may parse JSON before invoking its Node handler. The local Node server
  // instead supplies the original stream. Bound both forms before forwarding.
  let parsedBody: unknown;
  try {
    parsedBody = request.body;
  } catch {
    throw new GatewayError(400, 'Invalid JSON request body.');
  }
  if (parsedBody !== undefined) {
    let bytes: Buffer;
    try {
      bytes = Buffer.isBuffer(parsedBody) ? parsedBody : Buffer.from(JSON.stringify(parsedBody));
    } catch {
      throw new GatewayError(400, 'Invalid JSON request body.');
    }
    if (bytes.length > BODY_LIMIT)
      throw new GatewayError(413, 'Request body exceeds the 3 MiB limit.');
    return bytes;
  }
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const clean = () => {
      signal.removeEventListener('abort', aborted);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('error', failed);
      request.removeListener('aborted', failed);
    };
    const fail = (error: GatewayError) => {
      if (settled) return;
      settled = true;
      clean();
      request.resume();
      reject(error);
    };
    const aborted = () => fail(new GatewayError(504, 'The API request timed out.'));
    const failed = () => fail(new GatewayError(400, 'The API request could not be read.'));
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > BODY_LIMIT)
        return fail(new GatewayError(413, 'Request body exceeds the 3 MiB limit.'));
      chunks.push(bytes);
    };
    const end = () => {
      if (settled) return;
      settled = true;
      clean();
      resolve(Buffer.concat(chunks));
    };
    signal.addEventListener('abort', aborted, { once: true });
    request.on('data', data);
    request.on('end', end);
    request.on('error', failed);
    request.on('aborted', failed);
    if (signal.aborted) aborted();
  });
}

async function readResponse(upstream: Response, limit = RESPONSE_LIMIT) {
  if (!upstream.body) return Buffer.alloc(0);
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks);
      size += next.value.length;
      if (size > limit)
        throw new GatewayError(502, 'The backend response exceeded the gateway limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function withinDeadline<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(new GatewayError(504, 'The receipt request timed out. Try again.'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    task.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

export function createVercelGateway(options: GatewayOptions = {}) {
  const fetchBackend = options.fetch ?? fetch;
  const origin = backendOrigin(options.backendUrl);
  return async (request: GatewayRequest, response: ServerResponse) => {
    response.setHeader('cache-control', 'private, no-store, max-age=0');
    response.setHeader('cdn-cache-control', 'no-store');
    response.setHeader('vercel-cdn-cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { pathname, search } = route(request);
      const method = request.method ?? 'GET';
      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/'))
        throw new GatewayError(404, 'API route not found.');
      const tokenImageId = /^\/api\/token-images\/([a-f0-9]{64})$/.exec(pathname)?.[1];
      if (tokenImageId && search)
        throw new GatewayError(400, 'Image requests do not accept query parameters.');
      const tokenChart =
        /^\/api\/tokens\/(?:platform-pog|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/chart$/.test(
          pathname,
        );
      if (pathname === '/api/drafts' || pathname.startsWith('/api/drafts/')) {
        throw new GatewayError(
          503,
          'Token drafts are not supported. Use Launch to create a token.',
        );
      } else if (
        ['/api/config', '/api/catalog', '/api/me', '/api/streamers/lookup'].includes(pathname) ||
        /^\/api\/launches\/[a-f0-9-]{36}$/.test(pathname) ||
        tokenChart ||
        tokenImageId
      ) {
        if (method !== 'GET') throw new GatewayError(405, 'API method not allowed.');
      } else if (
        ['/api/uploads/token-image', '/api/launches/prepare'].includes(pathname) ||
        /^\/api\/launches\/[a-f0-9-]{36}\/(?:submit|cancel)$/.test(pathname)
      ) {
        if (method !== 'POST') throw new GatewayError(405, 'API method not allowed.');
      } else if (!['/api/donations', '/api/health'].includes(pathname)) {
        throw new GatewayError(404, 'API route not found.');
      } else if (method !== 'GET') {
        throw new GatewayError(405, 'API method not allowed.');
      }
      if (!origin)
        throw new GatewayError(
          503,
          'The persistent pog backend is not connected. Confirmed donations are unavailable until deployment setup is complete.',
        );
      timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      const headers = new Headers();
      for (const name of REQUEST_HEADERS) {
        if (tokenImageId || (tokenChart && name === 'authorization')) continue;
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      if (tokenImageId) headers.set('accept', 'image/webp');
      const body = method === 'POST' ? await readBody(request, controller.signal) : undefined;
      const upstreamPath = pathname;
      const upstreamSearch = search ? `?${search}` : '';
      const fetching = fetchBackend(`${origin}${upstreamPath}${upstreamSearch}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const upstream = tokenImageId
        ? await withinDeadline(fetching, controller.signal)
        : await fetching;
      if (controller.signal.aborted)
        throw new GatewayError(504, 'The API request timed out. Try again.');
      if (upstream.status === 429) {
        response.setHeader('retry-after', retryAfterSeconds(upstream.headers.get('retry-after')));
        await upstream.body?.cancel().catch(() => {});
        throw new GatewayError(429, 'The service is temporarily busy. Please try again shortly.');
      }
      if (upstream.status >= 300 && upstream.status < 400)
        throw new GatewayError(502, 'The backend returned an unexpected redirect.');
      if (tokenImageId && upstream.status === 200) {
        if (
          upstream.headers.get('content-type')?.toLowerCase() !== 'image/webp' ||
          upstream.headers.has('set-cookie')
        )
          throw new GatewayError(502, 'The backend did not return a valid token image.');
        const bytes = await withinDeadline(
          readResponse(upstream, TOKEN_IMAGE_LIMIT),
          controller.signal,
        );
        if (
          bytes.length < 12 ||
          bytes.toString('ascii', 0, 4) !== 'RIFF' ||
          bytes.toString('ascii', 8, 12) !== 'WEBP' ||
          bytes.readUInt32LE(4) + 8 !== bytes.length ||
          createHash('sha256').update(bytes).digest('hex') !== tokenImageId
        )
          throw new GatewayError(502, 'The backend did not return the requested token image.');
        if (controller.signal.aborted)
          throw new GatewayError(504, 'The image request timed out. Try again.');
        response.statusCode = 200;
        response.setHeader('content-type', 'image/webp');
        response.setHeader('content-length', bytes.length);
        response.setHeader('etag', `"${tokenImageId}"`);
        for (const name of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'])
          response.setHeader(name, 'public, max-age=31536000, immutable');
        response.end(bytes);
        return;
      }
      if (
        upstream.status !== 204 &&
        !upstream.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      ) {
        console.error('pog_gateway_invalid_upstream', {
          origin,
          status: upstream.status,
          contentType: upstream.headers.get('content-type'),
        });
        throw new GatewayError(502, 'The backend did not return a valid API response.');
      }
      const bytes = await readResponse(upstream);
      response.statusCode = upstream.status;
      response.setHeader(
        'content-type',
        upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      );
      response.end(bytes);
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof GatewayError) reply(response, error.status, error.message);
      else if (controller.signal.aborted)
        reply(
          response,
          504,
          'The backend did not respond in time. Check operation status before retrying a payment or funding action.',
        );
      else
        reply(
          response,
          502,
          'The persistent backend is unreachable. Check operation status before retrying a payment or funding action.',
        );
    } finally {
      clearTimeout(timer);
    }
  };
}
