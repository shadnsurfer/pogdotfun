import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { dkimSign } from 'mailauth';
import { TwitchReceiptEmailReader } from '../server/providers/twitch-receipt-email.ts';

const now = Date.parse('2026-09-16T18:10:00Z');
const submittedAt = '2026-09-16T18:00:00Z';
const sender = 'receipt@twitch.tv';
const target = 'receipts@fixture.resend.app';
const donor = 'donor@fixture.example';
const host = 'fixture-receiving.cloudfront.net';
const id = '18458c1b-d8a4-4771-87d9-c533d2c59744';
const secondId = '28458c1b-d8a4-4771-87d9-c533d2c59744';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const match = {
  username: 'cloverreggie',
  giftUnits: 10,
  nativeCurrency: 'HKD' as const,
  nativeTotalMinorUnits: 36200,
  submittedAt,
};
const receipt =
  'Invoice #US-115941\r\nCommunity Gift for 10 user(s) to Subscription (cloverreggie) (x 10)\r\nTotal: $362.00 HKD\r\n';

async function signed(
  text = receipt,
  options: {
    from?: string;
    to?: string;
    date?: string;
    domain?: string;
    headers?: string[];
    partial?: boolean;
    html?: boolean;
  } = {},
) {
  const from = options.from ?? sender;
  const body = `From: Twitch <${from}>\r\nTo: ${options.to ?? donor}\r\nDate: ${options.date ?? 'Wed, 16 Sep 2026 18:00:30 +0000'}\r\nSubject: Your Twitch purchase receipt\r\nMessage-ID: <fixture-receipt@twitch.tv>\r\nMIME-Version: 1.0\r\nContent-Type: ${options.html ? 'text/html' : 'text/plain'}; charset=utf-8\r\n\r\n${text}`;
  const result = await dkimSign(body, {
    signingDomain: options.domain ?? from.split('@')[1],
    selector: 'fixture',
    privateKey,
    signTime: new Date(submittedAt),
    // mailauth 5.0.3's implementation consumes a colon-separated list although
    // its declaration currently says string[]. This creates genuinely unsigned-date fixtures.
    headerList: (
      options.headers ?? [
        'from',
        'to',
        'date',
        'subject',
        'message-id',
        'mime-version',
        'content-type',
      ]
    ).join(':') as unknown as string[],
    signatureData: [
      {
        signingDomain: options.domain ?? from.split('@')[1],
        selector: 'fixture',
        privateKey,
        ...(options.partial ? { maxBodyLength: 40 } : {}),
      },
    ],
  });
  assert.equal(result.errors.length, 0);
  return result.signatures + body;
}

function fixture(raw: string, overrides: Record<string, unknown> = {}) {
  const messages = new Map([[id, { raw, from: sender }]]);
  const calls: { url: string; auth: string | null }[] = [];
  let pages: string[][] = [[id]];
  let extra = {};
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, auth: new Headers(init?.headers).get('authorization') });
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    if (url.hostname === host) {
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return new Response(messages.get(url.pathname.slice(1))!.raw);
    }
    assert.equal(url.origin, 'https://api.resend.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
    if (url.pathname === '/emails/receiving') {
      const cursor = url.searchParams.get('after');
      const page = cursor ? pages.findIndex((p) => p.at(-1) === cursor) + 1 : 0;
      return Response.json({
        object: 'list',
        has_more: page < pages.length - 1,
        data: pages[page].map((emailId) => ({
          id: emailId,
          to: [target],
          from: messages.get(emailId)!.from,
          created_at: '2026-09-16T18:01:00Z',
        })),
      });
    }
    const emailId = url.pathname.split('/').at(-1)!;
    return Response.json({
      object: 'email',
      id: emailId,
      to: [target],
      from: messages.get(emailId)!.from,
      created_at: '2026-09-16T18:01:00Z',
      text: 'Untrusted API rendering is ignored',
      headers: { 'authentication-results': 'forged; dkim=pass' },
      raw: {
        download_url: `https://${host}/${emailId}?Signature=private-capability`,
        expires_at: '2026-09-16T19:00:00Z',
      },
      ...extra,
    });
  };
  const reader = new TwitchReceiptEmailReader(
    {
      apiKey: 'fixture-secret',
      receivingAddress: target,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      rawEmailHosts: [host],
      ...overrides,
    },
    {
      fetch: fetcher,
      now: () => now,
      resolveTxt: async (name) => {
        assert.equal(name, 'fixture._domainkey.twitch.tv');
        return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
      },
      resolveHost: async () => ['8.8.8.8'],
    },
  );
  return {
    reader,
    calls,
    messages,
    pages: (value: string[][]) => {
      pages = value;
    },
    extra: (value: object) => {
      extra = value;
    },
  };
}

test('authenticates raw MIME and returns only the exact matched invoice evidence', async () => {
  const f = fixture(await signed());
  const result = await f.reader.findMatchingInvoice(match);
  assert.deepEqual(
    Object.keys(result!).sort(),
    ['nativeReceiptId', 'emailId', 'receivedAt', 'evidenceDigest'].sort(),
  );
  assert.equal(result!.nativeReceiptId, 'US-115941');
  assert.equal(result!.emailId, id);
  assert.equal(result!.receivedAt, '2026-09-16T18:01:00.000Z');
  assert.match(result!.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fixture-secret|private-capability|receipt@|<html|cloverreggie/,
  );
  assert.equal(f.calls.length, 3);
});

test('bare dollars are corroborating numeric evidence and never an invented email currency', async () => {
  const f = fixture(await signed(receipt.replace(' HKD', '')));
  const result = await f.reader.findMatchingInvoice(match);
  assert.equal(result?.nativeReceiptId, 'US-115941');
  assert.equal(Object.hasOwn(result!, 'nativeCurrency'), false);
  assert.equal(
    await fixture(await signed(receipt.replace('HKD', 'USD'))).reader.findMatchingInvoice(match),
    null,
  );
});

test('Channel Subscription receipts retain exact recipient, quantity and amount matching', async () => {
  const channelReceipt = receipt.replace('to Subscription', 'to Channel Subscription');
  const result = await fixture(await signed(channelReceipt)).reader.findMatchingInvoice(match);
  assert.equal(result?.nativeReceiptId, 'US-115941');
  for (const mismatch of [
    channelReceipt.replace('cloverreggie', 'other_streamer'),
    channelReceipt.replace('(x 10)', '(x 9)'),
    channelReceipt.replace('for 10 user(s)', 'for 9 user(s)'),
    channelReceipt.replace('362.00', '362.01'),
    channelReceipt.replace('HKD', 'USD'),
  ]) {
    assert.equal(await fixture(await signed(mismatch)).reader.findMatchingInvoice(match), null);
  }
});

test('real HTML MIME is parsed without executing or fetching embedded content', async () => {
  const f = fixture(
    await signed(
      '<h1>Invoice #US-115941</h1><p>Community Gift for 10 user(s) to Subscription (cloverreggie) (x 10)</p><p>Total: HK$362.00</p><img src="https://evil.test/pixel">',
      { html: true },
    ),
  );
  assert.equal((await f.reader.findMatchingInvoice(match))?.nativeReceiptId, 'US-115941');
  assert.equal(f.calls.length, 3);
});

test('wrong recipient, quantity, total, date and Bits purchases cannot match a gift', async () => {
  for (const text of [
    receipt.replace('cloverreggie', 'other_streamer'),
    receipt.replace('(x 10)', '(x 9)'),
    receipt.replace('362.00', '362.01'),
    'Invoice #US-115941\r\n5000 Bits\r\nTotal: HK$362.00',
  ]) {
    assert.equal(await fixture(await signed(text)).reader.findMatchingInvoice(match), null);
  }
  assert.equal(
    await fixture(
      await signed(receipt, { date: 'Tue, 15 Sep 2026 18:00:30 +0000' }),
    ).reader.findMatchingInvoice(match),
    null,
  );
});

test('forged Authentication-Results, changed body and partial-body or unsigned-date DKIM fail closed', async () => {
  const good = await signed();
  for (const [index, raw] of [
    good.replace('362.00', '361.00'),
    good.replace(
      /^DKIM-Signature:[\s\S]*?(?=From:)/,
      'Authentication-Results: trusted.test; dkim=pass\r\n',
    ),
    await signed(receipt, { partial: true }),
    await signed(receipt, { headers: ['from', 'to', 'subject'] }),
    await signed(receipt, { headers: ['from', 'to', 'date', 'subject'] }),
  ].entries()) {
    assert.equal(
      await fixture(raw).reader.findMatchingInvoice(match),
      null,
      `authentication variant ${index}`,
    );
  }
});

test('sender and signing domain are pinned rather than accepting any valid DKIM signature', async () => {
  const f = fixture(await signed(receipt, { from: 'attacker@twitch.tv' }));
  assert.equal(await f.reader.findMatchingInvoice(match), null);
  const unknown = fixture(await signed(), {
    trustedSenders: [{ address: sender, signingDomains: ['other.example'], role: 'original' }],
  });
  assert.equal(await unknown.reader.findMatchingInvoice(match), null);
});

test('pagination scans the full candidate window and rejects two different matching invoices', async () => {
  const f = fixture(await signed());
  f.messages.set(secondId, {
    raw: await signed(receipt.replace('US-115941', 'US-115942')),
    from: sender,
  });
  f.pages([[id], [secondId]]);
  await assert.rejects(() => f.reader.findMatchingInvoice(match), /ambiguous/i);
  assert.ok(f.calls.some((call) => call.url.includes(`after=${id}`)));
});

test('duplicate deliveries of the same signed receipt are idempotent', async () => {
  const f = fixture(await signed());
  f.messages.set(secondId, f.messages.get(id)!);
  f.pages([[id], [secondId]]);
  const first = await f.reader.findMatchingInvoice(match);
  assert.equal(first?.nativeReceiptId, 'US-115941');
  assert.deepEqual(await f.reader.findMatchingInvoice(match), first);
});

test('wrong receiving address and missing raw evidence return no match', async () => {
  for (const extra of [{ to: ['someone@fixture.resend.app'] }, { raw: null }]) {
    const f = fixture(await signed());
    f.extra(extra);
    assert.equal(await f.reader.findMatchingInvoice(match), null);
  }
});

test('unsafe raw hosts, redirects, oversized bodies and provider failures never expose capabilities or credentials', async () => {
  const raw = await signed();
  for (const url of [
    'http://fixture-receiving.cloudfront.net/private',
    'https://127.0.0.1/private',
    'https://evil.test/private',
    `https://user:secret@${host}/private`,
  ]) {
    const f = fixture(raw);
    f.extra({ raw: { download_url: url, expires_at: '2026-09-16T19:00:00Z' } });
    await assert.rejects(
      () => f.reader.findMatchingInvoice(match),
      (error: unknown) => !/secret|127\.0\.0\.1|evil\.test|private-capability/.test(String(error)),
    );
  }
  const f = fixture(raw.repeat(2000));
  await assert.rejects(() => f.reader.findMatchingInvoice(match), /unavailable|limit|verify/i);
  const failure = new TwitchReceiptEmailReader(
    {
      apiKey: 'fixture-secret',
      receivingAddress: target,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      rawEmailHosts: [host],
    },
    {
      fetch: async () => {
        throw Error('fixture-secret private-capability');
      },
      now: () => now,
    },
  );
  await assert.rejects(
    () => failure.findMatchingInvoice(match),
    (error: unknown) => !/fixture-secret|private-capability/.test(String(error)),
  );
});

test('private storage DNS answers stop before the capability is requested', async () => {
  let calls = 0;
  const reader = new TwitchReceiptEmailReader(
    {
      apiKey: 'fixture-secret',
      receivingAddress: target,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      rawEmailHosts: [host],
    },
    {
      now: () => now,
      resolveHost: async () => ['127.0.0.1'],
      fetch: async (url) => {
        calls++;
        if (String(url).includes('?limit='))
          return Response.json({
            object: 'list',
            has_more: false,
            data: [{ id, from: sender, created_at: '2026-09-16T18:01:00Z' }],
          });
        return Response.json({
          object: 'email',
          id,
          from: sender,
          to: [target],
          created_at: '2026-09-16T18:01:00Z',
          raw: { download_url: `https://${host}/${id}`, expires_at: '2026-09-16T19:00:00Z' },
        });
      },
    },
  );
  await assert.rejects(() => reader.findMatchingInvoice(match));
  assert.equal(calls, 2);
});

test('pagination loops and redirects are errors, not permission to return a partial match', async () => {
  const f = fixture(await signed());
  f.pages([[id], [id]]);
  await assert.rejects(() => f.reader.findMatchingInvoice(match));
  let calls = 0;
  const reader = new TwitchReceiptEmailReader(
    {
      apiKey: 'fixture-secret',
      receivingAddress: target,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      rawEmailHosts: [host],
    },
    {
      now: () => now,
      fetch: async () => {
        calls++;
        return Response.redirect('https://evil.test/secret');
      },
    },
  );
  await assert.rejects(() => reader.findMatchingInvoice(match));
  assert.equal(calls, 1);
});

test('an explicitly trusted forwarder still needs its own full aligned DKIM signature', async () => {
  const forwarder = 'owner@twitch.tv';
  const raw = await signed(receipt, { from: forwarder });
  const f = fixture(raw, {
    trustedSenders: [{ address: forwarder, signingDomains: ['twitch.tv'], role: 'forwarder' }],
  });
  f.messages.set(id, { raw, from: forwarder });
  assert.equal((await f.reader.findMatchingInvoice(match))?.nativeReceiptId, 'US-115941');
  f.messages.set(id, { raw: raw.replace('US-115941', 'US-999999'), from: forwarder });
  assert.equal(await f.reader.findMatchingInvoice(match), null);
});

test('the saved lookup intent cannot be retargeted while provider reads await', async () => {
  const f = fixture(await signed());
  const query = { ...match };
  const work = f.reader.findMatchingInvoice(query);
  query.username = 'other_streamer';
  assert.equal((await work)?.nativeReceiptId, 'US-115941');
});

test('an authentic Twitch receipt addressed to a different donor cannot match this checkout', async () => {
  const f = fixture(await signed(receipt, { to: 'someone-else@fixture.example' }));
  assert.equal(await f.reader.findMatchingInvoice(match), null);
});

test('Resend connection preflight only checks receiving access and rejects revoked authorization', async () => {
  const f = fixture(await signed());
  assert.equal(await f.reader.checkConnection(), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0].url).searchParams.get('limit'), '1');
  const denied = new TwitchReceiptEmailReader(
    {
      apiKey: 'fixture-secret',
      receivingAddress: target,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      rawEmailHosts: [host],
    },
    {
      fetch: async () => new Response('private authorization failure', { status: 403 }),
      now: () => now,
    },
  );
  await assert.rejects(
    () => denied.checkConnection(),
    (error: unknown) => !/private authorization/.test(String(error)),
  );
});
