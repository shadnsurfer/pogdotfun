import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createVercelGateway } from '../server/vercel-gateway.ts';

async function serve(
  options: Parameters<typeof createVercelGateway>[0],
  run: (url: string) => Promise<void>,
  parsedBody?: unknown,
) {
  const handler = createVercelGateway(options);
  const server = createServer((request, response) => {
    if (parsedBody !== undefined)
      (request as IncomingMessage & { body: unknown }).body = parsedBody;
    void handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// Node fetch rewrites Host on this runtime; the HTTP client exercises real Host checks.
function send(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }));
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(init.body);
  });
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('stored image route forwards no credentials and caches only matching bounded WebP bytes', async () => {
  const bytes = await sharp({
    create: { width: 12, height: 12, channels: 3, background: '#9146ff' },
  })
    .webp()
    .toBuffer();
  const id = createHash('sha256').update(bytes).digest('hex');
  const calls: string[] = [];
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: async (url, init) => {
        calls.push(String(url));
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        assert.equal(new Headers(init?.headers).get('cookie'), null);
        assert.equal(new Headers(init?.headers).get('origin'), null);
        return new Response(bytes, {
          headers: { 'content-type': 'image/webp', etag: '"untrusted"' },
        });
      },
    },
    async (base) => {
      const response = await send(
        `${base}/api/gateway?__pog_path=token-images/${id}&path=token-images/${id}`,
        {
          headers: {
            authorization: 'Bearer private',
            cookie: 'private=session',
            origin: 'https://foreign.test',
          },
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.equal(response.headers.get('etag'), `"${id}"`);
      for (const header of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'])
        assert.match(response.headers.get(header)!, /public.*max-age=31536000.*immutable/);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      for (const query of [
        '',
        `?path=token-images/${id}`,
        `?__pog_path=token-images/${id}&path=token-images/${id}`,
      ]) {
        const originalUrl = await send(`${base}/api/token-images/${id}${query}`);
        assert.equal(originalUrl.status, 200);
        assert.deepEqual(Buffer.from(await originalUrl.arrayBuffer()), bytes);
      }
      assert.equal(
        (
          await send(
            `${base}/api/token-images/${id}?path=token-images/${id}&url=https://private.test`,
          )
        ).status,
        400,
      );
      assert.equal((await send(`${base}/api/token-images/${id}`, { method: 'POST' })).status, 405);
      assert.equal((await send(`${base}/api/token-images/${id.toUpperCase()}`)).status, 404);
      assert.deepEqual(calls, Array(4).fill(`https://backend.test/api/token-images/${id}`));
    },
  );
});

test('missing, redirected, mismatched, oversized and non-WebP image responses remain uncacheable', async () => {
  const bytes = await sharp({
    create: { width: 12, height: 12, channels: 3, background: '#53fc18' },
  })
    .webp()
    .toBuffer();
  const id = createHash('sha256').update(bytes).digest('hex');
  const cases = [
    { result: () => json({ error: 'Image not found.' }, 404), status: 404 },
    {
      result: () =>
        new Response(null, { status: 302, headers: { location: 'https://private.test' } }),
      status: 502,
    },
    {
      result: () => new Response(bytes, { headers: { 'content-type': 'text/html' } }),
      status: 502,
    },
    {
      result: () =>
        new Response(Buffer.from('wrong hash'), { headers: { 'content-type': 'image/webp' } }),
      status: 502,
    },
    {
      result: () =>
        new Response(Buffer.alloc(256 * 1024 + 1), { headers: { 'content-type': 'image/webp' } }),
      status: 502,
    },
    {
      result: () =>
        new Response(bytes, {
          headers: { 'content-type': 'image/webp', 'set-cookie': 'private=session' },
        }),
      status: 502,
    },
  ];
  for (const item of cases)
    await serve(
      { backendUrl: 'https://backend.test', fetch: async () => item.result() },
      async (base) => {
        const response = await send(`${base}/api/token-images/${id}`);
        assert.equal(response.status, item.status);
        for (const header of ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'])
          assert.match(response.headers.get(header)!, /no-store/);
        assert.equal(response.headers.get('set-cookie'), null);
      },
    );
});

test('image fetch and body deadlines stay uncached even when upstream ignores abort', async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#222222' } })
    .webp()
    .toBuffer();
  const id = createHash('sha256').update(bytes).digest('hex');
  for (const stage of ['fetch', 'body']) {
    let release: () => void = () => {};
    let signal: AbortSignal | undefined;
    await serve(
      {
        backendUrl: 'https://backend.test',
        timeoutMs: 15,
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined;
          if (stage === 'fetch')
            return new Promise<Response>((resolve) => {
              release = () =>
                resolve(new Response(bytes, { headers: { 'content-type': 'image/webp' } }));
            });
          return new Response(
            new ReadableStream({
              start(controller) {
                release = () => {
                  controller.enqueue(bytes);
                  controller.close();
                };
              },
            }),
            { headers: { 'content-type': 'image/webp' } },
          );
        },
      },
      async (base) => {
        const response = await send(`${base}/api/token-images/${id}`);
        assert.equal(response.status, 504);
        assert.equal(signal?.aborted, true);
        assert.match(response.headers.get('cache-control')!, /no-store/);
        assert.match(response.headers.get('vercel-cdn-cache-control')!, /no-store/);
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(response.headers.get('etag'), null);
        assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      },
    );
  }
});

test('token chart forwarding is read-only and preserves the selected range without credentials', async () => {
  const id = 'da655bb2-9b24-4ec2-ad4f-ac266a2c83e4';
  const calls: string[] = [];
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: async (url, init) => {
        calls.push(String(url));
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('cookie'), null);
        assert.equal(headers.get('authorization'), null);
        return json({ tokenId: id, range: '7d', status: 'empty', candles: [] });
      },
    },
    async (base) => {
      const response = await send(
        `${base}/api/gateway?__pog_path=tokens/${id}/chart&path=tokens/${id}/chart&range=7d`,
        {
          headers: { host: 'pog.fun', cookie: 'private=session', authorization: 'Bearer private' },
        },
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).range, '7d');
      assert.deepEqual(calls, [`https://backend.test/api/tokens/${id}/chart?range=7d`]);
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
        assert.equal((await send(`${base}/api/tokens/${id}/chart`, { method })).status, 405);
      for (const path of [`/api/tokens/${id}/chart/private`, '/api/tokens/arbitrary-mint/chart'])
        assert.equal((await send(`${base}${path}`)).status, 404);
      assert.equal(calls.length, 1);
    },
  );
});

test('gateway returns honest unavailable status when no persistent HTTPS backend is configured', async () => {
  for (const backendUrl of [
    undefined,
    'http://backend.test',
    'https://secret:password@backend.test',
    'https://pog.fun',
    'https://backend.test/base',
  ]) {
    await serve({ backendUrl }, async (base) => {
      const response = await send(`${base}/api/health`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /persistent pog backend is not connected/);
      assert.match(response.headers.get('cache-control')!, /no-store/);
    });
  }
});

test('only public reads are forwarded; production drafts and unknown routes are closed', async () => {
  let called = 0;
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: (async () => {
        called++;
        const result = json({ donations: [] });
        result.headers.set('set-cookie', 'secret=value');
        return result;
      }) as typeof fetch,
    },
    async (base) => {
      for (const path of ['/api/drafts', '/api/drafts/id']) {
        assert.equal((await send(`${base}${path}`)).status, 503);
      }
      assert.equal((await send(`${base}/api/other`)).status, 404);
      assert.equal((await send(`${base}/api/donations`, { method: 'POST' })).status, 405);
      const feed = await send(`${base}/api/donations?limit=10`);
      assert.equal(feed.status, 200);
      assert.equal(feed.headers.get('set-cookie'), null);
      assert.equal(called, 1);
    },
  );
});

test('ambiguous reserved routing values and encoded traversal cannot choose an upstream target', async () => {
  let called = 0;
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: (async () => {
        called++;
        return json({});
      }) as typeof fetch,
    },
    async (base) => {
      for (const path of [
        '/api/gateway?__pog_path=health&__pog_path=admin/operations',
        '/api/gateway?__pog_path=../secret',
        '/api/gateway?__pog_path=https://evil.test',
        '/api/donations?__pog_path=admin/operations',
        '/api/gateway?__pog_path=health&path=admin/operations',
        '/api/gateway?__pog_path=health&path=health&path=health',
        '/api/donations?path=admin/operations',
        '/api/donations?path=donations&path=admin/operations',
        '/api/donations?path=%2Fdonations',
        '/api/donations?path=donations%2F',
        '/api/donations?path=donations%3Fadmin%3Dtrue',
        '/api/%61dmin/operations',
      ])
        assert.equal((await send(`${base}${path}`)).status, 400);
      assert.equal(
        (await send(`${base}/api/gateway?path=health`)).status,
        404,
        'the wildcard capture alone can never choose a route',
      );
      const originalUrl = await send(
        `${base}/api/donations?__pog_path=donations&path=donations&cursor=next`,
      );
      assert.equal(originalUrl.status, 200);
      assert.equal(called, 1);
    },
  );
});

test('body limits protect public launch streams and Vercel parsed JSON before forwarding', async () => {
  let calls = 0;
  const options = {
    backendUrl: 'https://backend.test',
    fetch: (async () => {
      calls++;
      return json({ ok: true });
    }) as typeof fetch,
  };
  await serve(options, async (base) => {
    const response = await send(`${base}/api/launches/prepare`, {
      method: 'POST',
      headers: { host: 'pog.fun', 'content-type': 'application/json' },
      body: JSON.stringify({ huge: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
  });
  await serve(
    options,
    async (base) => {
      const response = await send(`${base}/api/launches/prepare`, {
        method: 'POST',
        headers: { host: 'pog.fun', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 413);
    },
    { huge: 'x'.repeat(3 * 1024 * 1024) },
  );
  assert.equal(calls, 0);
});

test('upstream failures, redirects and non-JSON bodies produce safe errors and never follow redirects', async () => {
  for (const backendFetch of [
    async () => {
      throw new Error('secret-token and private request data');
    },
    async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    async () =>
      new Response('<html>private login</html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await serve(
      { backendUrl: 'https://backend.test', fetch: backendFetch as typeof fetch },
      async (base) => {
        const response = await send(`${base}/api/health`);
        assert.equal(response.status, 502);
        const body = await response.text();
        assert.doesNotMatch(body, /secret-token|private request|private login|evil\.test/);
      },
    );
  }
});

test('timeout aborts upstream without turning an unknown payment result into success', async () => {
  await serve(
    {
      backendUrl: 'https://backend.test',
      timeoutMs: 10,
      fetch: ((_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })) as typeof fetch,
    },
    async (base) => {
      const response = await send(`${base}/api/launches/prepare`, {
        method: 'POST',
        headers: { host: 'pog.fun', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 504);
      assert.match((await response.json()).error, /Check operation status before retrying/);
    },
  );
});

test('public launch routes reject history while retaining authenticated active status and submission', async () => {
  const calls: { url: string; method: unknown; auth: string | null }[] = [];
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: (async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          auth: new Headers(init?.headers).get('authorization'),
        });
        const result = json({ accepted: true });
        result.headers.set('set-cookie', 'pog_operator=private');
        return result;
      }) as typeof fetch,
    },
    async (base) => {
      for (const headers of [{}, { authorization: 'Bearer user-token' }] as HeadersInit[]) {
        const history = await send(`${base}/api/launches`, { headers });
        assert.equal(history.status, 404);
        assert.equal('launches' in (await history.json()), false);
      }
      assert.equal(calls.length, 0, 'launch history must not be forwarded to the backend');
      const response = await send(`${base}/api/launches/prepare`, {
        method: 'POST',
        headers: {
          host: 'pog.fun',
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(calls[0], {
        url: 'https://backend.test/api/launches/prepare',
        method: 'POST',
        auth: 'Bearer user-token',
      });
      const id = '12345678-1234-4321-9876-123456789abc';
      const status = await send(`${base}/api/launches/${id}`, {
        headers: { authorization: 'Bearer user-token' },
      });
      assert.equal(status.status, 200);
      assert.equal(status.headers.get('set-cookie'), null);
      assert.deepEqual(calls[1], {
        url: `https://backend.test/api/launches/${id}`,
        method: 'GET',
        auth: 'Bearer user-token',
      });
      const submit = await send(`${base}/api/launches/${id}/submit`, {
        method: 'POST',
        headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: JSON.stringify({ signedTransaction: 'synthetic-signature' }),
      });
      assert.equal(submit.status, 200);
      assert.equal(submit.headers.get('set-cookie'), null);
      assert.deepEqual(calls[2], {
        url: `https://backend.test/api/launches/${id}/submit`,
        method: 'POST',
        auth: 'Bearer user-token',
      });
      const cancel = await send(`${base}/api/launches/${id}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(cancel.status, 200);
      assert.deepEqual(calls[3], {
        url: `https://backend.test/api/launches/${id}/cancel`,
        method: 'POST',
        auth: 'Bearer user-token',
      });
      assert.equal((await send(`${base}/api/launches/${id}/cancel`)).status, 405);
      assert.equal((await send(`${base}/api/uploads/token-image`, { method: 'GET' })).status, 405);
      assert.equal((await send(`${base}/api/catalog`, { method: 'DELETE' })).status, 405);
      assert.equal(
        (
          await send(`${base}/api/launches/1234/submit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
    },
  );
});

test('upstream plain-text rate limits stay JSON 429 with retry timing and never replay writes', async () => {
  let calls = 0;
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: async () => {
        calls++;
        return new Response('private upstream detail', {
          status: 429,
          headers: { 'content-type': 'text/plain', 'retry-after': '120' },
        });
      },
    },
    async (base) => {
      for (const [path, init] of [
        ['/api/catalog', {}],
        [
          '/api/uploads/token-image',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        ],
      ] as const) {
        const response = await send(`${base}${path}`, init);
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '120');
        assert.match(response.headers.get('content-type')!, /application\/json/);
        assert.match(response.headers.get('cache-control')!, /no-store/);
        assert.doesNotMatch(await response.text(), /private upstream detail/);
      }
      assert.equal(calls, 2, 'no automatic replay of a potentially consequential request');
    },
  );
});

test('admin routes are absent on every Host and never forward cookies, bearer tokens or bodies', async () => {
  let calls = 0;
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: async () => {
        calls++;
        return json({});
      },
    },
    async (base) => {
      for (const host of [
        'pog.fun',
        'admin.pog.fun',
        'preview.vercel.app',
        'admin.pog.fun.evil.test',
      ]) {
        const credentials: Record<string, string>[] = [
          {},
          { authorization: 'Bearer fixture-secret' },
          { cookie: 'pog_operator=fixture-secret' },
        ];
        for (const headers of credentials) {
          for (const [method, path] of [
            ['GET', '/api/admin/session'],
            ['POST', '/api/admin/session'],
            ['DELETE', '/api/admin/session'],
            ['POST', '/api/admin/workers/run'],
            ['GET', '/api/admin/browser/sessions'],
            ['POST', '/api/gateway?__pog_path=admin/browser/handoff&path=admin/browser/handoff'],
          ]) {
            const response = await send(`${base}${path}`, {
              method,
              headers: {
                ...headers,
                host,
                'x-forwarded-host': 'admin.pog.fun',
                'content-type': 'application/json',
              },
              ...(method === 'POST' ? { body: '{"secret":"fixture-secret"}' } : {}),
            });
            assert.equal(response.status, 404);
            assert.equal(response.headers.get('set-cookie'), null);
            assert.match(response.headers.get('cache-control')!, /no-store/);
            assert.doesNotMatch(await response.text(), /fixture-secret/);
          }
        }
      }
      assert.equal(calls, 0);
    },
  );
});

test('public launch forwarding preserves authorization and drops cookies and untrusted host headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  await serve(
    {
      backendUrl: 'https://backend.test',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        const result = json({ accepted: true });
        result.headers.append('set-cookie', 'private=value');
        return result;
      },
    },
    async (base) => {
      const response = await send(`${base}/api/gateway?__pog_path=launches/prepare&next=a%2Fb`, {
        method: 'POST',
        headers: {
          host: 'pog.fun',
          origin: 'https://pog.fun',
          authorization: 'Bearer user-token',
          cookie: 'private=secret',
          'content-type': 'application/json',
          'x-forwarded-host': 'evil.test',
        },
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://backend.test/api/launches/prepare?next=a%2Fb');
      const headers = new Headers(calls[0].init.headers);
      assert.equal(headers.get('authorization'), 'Bearer user-token');
      assert.equal(headers.get('origin'), 'https://pog.fun');
      for (const name of ['cookie', 'host', 'x-forwarded-host'])
        assert.equal(headers.get(name), null);
      assert.equal(String(calls[0].init.body), '{}');
      assert.equal(calls[0].init.redirect, 'manual');
    },
  );
});

test('public read and write deadlines use the bounded default or explicit override', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timeoutMs of [undefined, 17]) {
    for (const [method, path] of [
      ['GET', '/api/health'],
      ['POST', '/api/launches/prepare'],
    ]) {
      const observed: boolean[] = [];
      await serve(
        {
          backendUrl: 'https://backend.test',
          timeoutMs,
          fetch: async (_url, init) => {
            context.mock.timers.tick((timeoutMs ?? 20000) - 1);
            observed.push(init!.signal!.aborted);
            context.mock.timers.tick(1);
            observed.push(init!.signal!.aborted);
            throw new Error('private-upstream-timeout');
          },
        },
        async (base) => {
          const response = await send(`${base}${path}`, {
            method,
            headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          assert.deepEqual(observed, [false, true]);
          assert.equal(response.status, 504);
          assert.doesNotMatch(await response.text(), /private-upstream/);
        },
      );
    }
  }
});
