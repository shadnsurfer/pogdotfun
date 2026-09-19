import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { dkimSign } from 'mailauth';
import { OutlookReceiptEmailReader } from '../server/providers/outlook-receipt-email.ts';

const now = Date.parse('2026-09-16T18:10:00Z');
const submittedAt = '2026-09-16T18:00:00Z';
const sender = 'receipt@twitch.tv';
const donor = 'donor@outlook.com';
const messageId = 'AAkALongImmutableMessageId/With+Padding==';
const secondId = 'AAkASecondImmutableMessageId==';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const expected = {
  username: 'cloverreggie',
  giftUnits: 1,
  nativeCurrency: 'USD' as const,
  nativeTotalMinorUnits: 599,
  submittedAt,
};
const text =
  'Invoice #US-115941\r\nCommunity Gift for 1 user(s) to Subscription (cloverreggie) (x 1)\r\nTotal: US$5.99\r\n';
async function signed(
  bodyText = text,
  options: { from?: string; to?: string; partial?: boolean; headers?: string[] } = {},
) {
  const from = options.from ?? sender;
  const body = `From: Twitch <${from}>\r\nTo: ${options.to ?? donor}\r\nDate: Wed, 16 Sep 2026 18:00:30 +0000\r\nSubject: Your Twitch receipt\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`;
  const result = await dkimSign(body, {
    signingDomain: from.split('@')[1],
    selector: 'fixture',
    privateKey,
    signTime: new Date(submittedAt),
    headerList: (
      options.headers ?? ['from', 'to', 'date', 'subject', 'mime-version', 'content-type']
    ).join(':') as unknown as string[],
    signatureData: [
      {
        signingDomain: from.split('@')[1],
        selector: 'fixture',
        privateKey,
        ...(options.partial ? { maxBodyLength: 40 } : {}),
      },
    ],
  });
  assert.equal(result.errors.length, 0);
  return result.signatures + body;
}

function fixture(raw: string, config: Record<string, unknown> = {}) {
  const messages = new Map([
    [messageId, { raw, from: sender, receivedDateTime: '2026-09-16T18:01:00Z', isDraft: false }],
  ]);
  const calls: URL[] = [];
  let pages: string[][] = [[messageId]];
  let nextOverride: string | undefined;
  let identity = { id: 'mailbox-fixture', mail: donor, userPrincipalName: donor };
  let responseOverride: ((url: URL) => Response | undefined) | undefined;
  let tokens = 0;
  const reader = new OutlookReceiptEmailReader(
    {
      mailboxAddress: donor,
      donorReceiptAddress: donor,
      trustedSenders: [{ address: sender, signingDomains: ['twitch.tv'], role: 'original' }],
      getAccessToken: async () => {
        tokens++;
        return 'fixture-access-token';
      },
      ...config,
    },
    {
      now: () => now,
      resolveTxt: async () => [[`v=DKIM1; k=rsa; p=${publicKey}`]],
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        assert.equal(url.origin, 'https://graph.microsoft.com');
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'error');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer fixture-access-token');
        assert.equal(headers.get('prefer'), 'IdType="ImmutableId"');
        assert.ok(init?.signal);
        const override = responseOverride?.(url);
        if (override) return override;
        if (url.pathname === '/v1.0/me') return Response.json(identity);
        if (url.pathname === '/v1.0/me/messages') {
          const page = Number(url.searchParams.get('$skip') ?? '0');
          const next = new URL(url);
          next.searchParams.set('$skip', String(page + 1));
          return Response.json({
            value: pages[page].map((id) => ({
              id,
              from: { emailAddress: { address: messages.get(id)!.from } },
              receivedDateTime: messages.get(id)!.receivedDateTime,
              isDraft: messages.get(id)!.isDraft,
              body: { content: 'Untrusted Graph rendering; never purchase proof' },
            })),
            ...(nextOverride !== undefined
              ? { '@odata.nextLink': nextOverride }
              : page < pages.length - 1
                ? { '@odata.nextLink': next.href }
                : {}),
          });
        }
        const match = /^\/v1\.0\/me\/messages\/([^/]+)\/\$value$/.exec(url.pathname);
        assert.ok(match, 'only the original message MIME may be fetched');
        const message = messages.get(decodeURIComponent(match[1]));
        assert.ok(message);
        return new Response(message.raw);
      },
    },
  );
  return {
    reader,
    calls,
    messages,
    setPages(value: string[][]) {
      pages = value;
    },
    setNext(value: string) {
      nextOverride = value;
    },
    setIdentity(value: typeof identity) {
      identity = value;
    },
    setResponse(value: typeof responseOverride) {
      responseOverride = value;
    },
    tokens: () => tokens,
  };
}

test('Graph scans the pinned mailbox with immutable IDs and authenticates raw MIME', async () => {
  const f = fixture(await signed());
  const result = await f.reader.findMatchingInvoice(expected);
  assert.equal(result?.nativeReceiptId, 'US-115941');
  assert.match(result!.emailId, /^outlook_[a-f0-9]{64}$/);
  assert.match(result!.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(result!.receivedAt, '2026-09-16T18:01:00.000Z');
  assert.deepEqual(
    Object.keys(result!).sort(),
    ['nativeReceiptId', 'emailId', 'receivedAt', 'evidenceDigest'].sort(),
  );
  assert.equal(f.calls[0].pathname, '/v1.0/me');
  assert.equal(
    f.calls[1].searchParams.get('$filter'),
    'receivedDateTime ge 2026-09-16T17:59:55.000Z and receivedDateTime le 2026-09-16T18:10:05.000Z',
  );
  assert.equal(f.calls[1].searchParams.get('$top'), '100');
  assert.equal(f.calls[1].searchParams.get('$select'), 'id,from,receivedDateTime,isDraft');
  assert.equal(f.calls.length, 3);
  assert.equal(f.tokens(), 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-access-token|donor@|ImmutableMessage/);
});

test('each scan rechecks mailbox identity before reading any mail', async () => {
  const f = fixture(await signed());
  const first = await f.reader.findMatchingInvoice(expected);
  assert.deepEqual(await f.reader.findMatchingInvoice(expected), first);
  f.setIdentity({ id: 'different-mailbox', mail: 'someone@outlook.com', userPrincipalName: donor });
  await assert.rejects(() => f.reader.findMatchingInvoice(expected), /unavailable|verified/i);
  assert.equal(f.calls.filter((url) => url.pathname === '/v1.0/me').length, 3);
  assert.equal(f.calls.at(-1)!.pathname, '/v1.0/me');
  assert.equal(f.tokens(), 3);
});

test('another donor, sender, changed signed body, unsigned body and partial DKIM never match', async () => {
  const good = await signed();
  for (const raw of [
    await signed(text, { to: 'different@outlook.com' }),
    await signed(text, { from: 'attacker@twitch.tv' }),
    good.replace('US-115941', 'US-999999'),
    good.replace(
      /^DKIM-Signature:[\s\S]*?(?=From:)/,
      'Authentication-Results: outlook.com; dkim=pass\r\n',
    ),
    await signed(text, { partial: true }),
    await signed(text, { headers: ['from', 'to', 'subject'] }),
  ])
    assert.equal(await fixture(raw).reader.findMatchingInvoice(expected), null);
});

test('wrong invoice facts never become a match from Graph body metadata', async () => {
  for (const body of [
    text.replace('cloverreggie', 'other_streamer'),
    text.replace('(x 1)', '(x 2)'),
    text.replace('5.99', '6.00'),
    text.replace('US$', 'HK$'),
  ]) {
    assert.equal(await fixture(await signed(body)).reader.findMatchingInvoice(expected), null);
  }
});

test('an explicit trusted forwarder needs its own complete aligned DKIM signature', async () => {
  const forwarder = 'forwarder@fixture.example';
  const raw = await signed(text, { from: forwarder, to: 'receipt-archive@outlook.com' });
  const f = fixture(raw, {
    trustedSenders: [
      { address: forwarder, signingDomains: ['fixture.example'], role: 'forwarder' },
    ],
  });
  f.messages.get(messageId)!.from = forwarder;
  assert.equal((await f.reader.findMatchingInvoice(expected))?.nativeReceiptId, 'US-115941');
  f.messages.get(messageId)!.raw = raw.replace('US-115941', 'US-999999');
  assert.equal(await f.reader.findMatchingInvoice(expected), null);
});

test('all pages are scanned, duplicate deliveries are stable, distinct matching invoices are ambiguous', async () => {
  const f = fixture(await signed());
  f.messages.set(secondId, { ...f.messages.get(messageId)! });
  f.setPages([[messageId], [secondId]]);
  const first = await f.reader.findMatchingInvoice(expected);
  assert.ok(first);
  assert.deepEqual(await f.reader.findMatchingInvoice(expected), first);
  f.messages.get(secondId)!.raw = await signed(text.replace('US-115941', 'US-115942'));
  await assert.rejects(() => f.reader.findMatchingInvoice(expected), /ambiguous/i);
});

test('off-origin, credentialed, alternate-path and fragment next links fail before another authenticated request', async () => {
  for (const next of [
    'https://evil.test/v1.0/me/messages',
    'https://graph.microsoft.com.evil.test/v1.0/me/messages',
    'https://private:secret@graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/users/other/messages',
    'https://graph.microsoft.com/v1.0/me/messages#private',
    'http://graph.microsoft.com/v1.0/me/messages',
  ]) {
    const f = fixture(await signed());
    f.setNext(next);
    await assert.rejects(
      () => f.reader.findMatchingInvoice(expected),
      (error: unknown) => !/evil|secret|private/.test(String(error)),
    );
    assert.equal(f.calls.filter((url) => url.pathname === '/v1.0/me/messages').length, 1);
  }
});

test('repeated IDs, incomplete pages and page overflow never return a partial receipt', async () => {
  const raw = await signed();
  const repeated = fixture(raw);
  repeated.setPages([[messageId], [messageId]]);
  await assert.rejects(() => repeated.reader.findMatchingInvoice(expected));
  const empty = fixture(raw);
  empty.setPages([[messageId], [], [secondId]]);
  await assert.rejects(() => empty.reader.findMatchingInvoice(expected));
  const overflow = fixture(raw);
  const pages = Array.from({ length: 11 }, (_, i) => [`AAkMessage${i}==`]);
  for (const page of pages)
    overflow.messages.set(page[0], { ...overflow.messages.get(messageId)! });
  overflow.setPages(pages);
  await assert.rejects(() => overflow.reader.findMatchingInvoice(expected));
  assert.equal(overflow.calls.filter((url) => url.pathname === '/v1.0/me/messages').length, 10);
});

test('drafts, untrusted senders and messages outside the purchase window are not downloaded', async () => {
  for (const override of [
    { isDraft: true },
    { from: 'other@twitch.tv' },
    { receivedDateTime: '2026-09-15T18:01:00Z' },
    { receivedDateTime: '2026-09-17T18:01:00Z' },
  ]) {
    const f = fixture(await signed());
    Object.assign(f.messages.get(messageId)!, override);
    assert.equal(await f.reader.findMatchingInvoice(expected), null);
    assert.equal(f.calls.length, 2);
  }
});

test('redirects, throttling, oversized responses and provider errors expose no token or raw evidence', async () => {
  for (const response of [
    Response.redirect('https://evil.test/private'),
    new Response('private provider error', { status: 429 }),
    new Response('x'.repeat(1_000_001)),
  ]) {
    const f = fixture(await signed());
    f.setResponse(() => response);
    await assert.rejects(
      () => f.reader.findMatchingInvoice(expected),
      (error: unknown) => !/fixture-access-token|private provider|evil/.test(String(error)),
    );
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(await signed(), {
    getAccessToken: async () => {
      throw new Error('private-token-value');
    },
  });
  await assert.rejects(
    () => f.reader.findMatchingInvoice(expected),
    (error: unknown) => !/private-token-value/.test(String(error)),
  );
  assert.equal(f.calls.length, 0);
});

test('caller mutation cannot retarget an in-flight receipt lookup', async () => {
  const f = fixture(await signed());
  const input = { ...expected };
  const promise = f.reader.findMatchingInvoice(input);
  input.username = 'other_streamer';
  assert.equal((await promise)?.nativeReceiptId, 'US-115941');
});

test('unrelated drafts without sender metadata cannot block legitimate receipt lookup', async () => {
  const f = fixture(await signed());
  f.setResponse((url) =>
    url.pathname === '/v1.0/me/messages'
      ? Response.json({
          value: [
            { id: 'UnsentDraftId==', isDraft: true },
            {
              id: messageId,
              isDraft: false,
              from: { emailAddress: { address: sender } },
              receivedDateTime: '2026-09-16T18:01:00Z',
            },
          ],
        })
      : undefined,
  );
  assert.equal((await f.reader.findMatchingInvoice(expected))?.nativeReceiptId, 'US-115941');
  assert.equal(f.calls.length, 3);
});

test('Graph cannot expand or remove the bounded scan through a pagination link', async () => {
  for (const change of [
    (url: URL) => url.searchParams.delete('$filter'),
    (url: URL) => url.searchParams.set('$top', '1000'),
    (url: URL) => url.searchParams.set('$expand', 'attachments'),
  ]) {
    const f = fixture(await signed());
    f.setResponse((url) => {
      if (url.pathname !== '/v1.0/me/messages') return undefined;
      const next = new URL(url);
      change(next);
      return Response.json({
        value: [{ id: 'DraftId==', isDraft: true }],
        '@odata.nextLink': next.href,
      });
    });
    await assert.rejects(() => f.reader.findMatchingInvoice(expected));
    assert.equal(f.calls.length, 2);
  }
});

test('oversized raw MIME and too many list items fail without partial publication', async () => {
  const oversized = fixture('x'.repeat(1_000_001));
  await assert.rejects(() => oversized.reader.findMatchingInvoice(expected));
  const page = fixture(await signed());
  page.setResponse((url) =>
    url.pathname === '/v1.0/me/messages'
      ? Response.json({
          value: Array.from({ length: 101 }, (_, i) => ({ id: `Draft${i}`, isDraft: true })),
        })
      : undefined,
  );
  await assert.rejects(() => page.reader.findMatchingInvoice(expected));
  assert.equal(page.calls.length, 2);
});

test('connection preflight checks pinned mailbox and body read access without downloading MIME', async () => {
  const f = fixture(await signed());
  assert.equal(await f.reader.checkConnection(), undefined);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].pathname, '/v1.0/me');
  assert.equal(f.calls[1].pathname, '/v1.0/me/messages');
  assert.equal(f.calls[1].searchParams.get('$top'), '1');
  assert.equal(f.calls[1].searchParams.get('$select'), 'id,body');
});

test('revoked access, denied Graph access and mailbox changes fail the purchase preflight', async () => {
  const raw = await signed();
  const revoked = fixture(raw, {
    getAccessToken: async () => {
      throw Error('private revoked-token');
    },
  });
  await assert.rejects(
    () => revoked.reader.checkConnection(),
    (error: unknown) => !/revoked-token/.test(String(error)),
  );
  assert.equal(revoked.calls.length, 0);
  const denied = fixture(raw);
  denied.setResponse((url) =>
    url.pathname === '/v1.0/me/messages'
      ? new Response('Private permission detail', { status: 403 })
      : undefined,
  );
  await assert.rejects(() => denied.reader.checkConnection(), /unavailable|verified/i);
  assert.equal(denied.calls.length, 2);
  const basicOnly = fixture(raw);
  basicOnly.setResponse((url) =>
    url.pathname === '/v1.0/me/messages'
      ? Response.json({ value: [{ id: messageId }] })
      : undefined,
  );
  await assert.rejects(() => basicOnly.reader.checkConnection(), /unavailable|verified/i);
  const wrong = fixture(raw);
  wrong.setIdentity({ id: 'other-mailbox', mail: 'other@outlook.com', userPrincipalName: donor });
  await assert.rejects(() => wrong.reader.checkConnection(), /unavailable|verified/i);
  assert.equal(wrong.calls.length, 1);
});
