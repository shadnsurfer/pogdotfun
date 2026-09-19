import assert from 'node:assert/strict';
import test from 'node:test';
import * as catalog from '../src/data.ts';
import bs58 from 'bs58';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

function catalogFixture(count = 14) {
  const streamers: catalog.Streamer[] = Array.from({ length: Math.min(2, count) }, (_, i) => ({
    id: `twitch:${i + 123}`,
    name: `Streamer ${i}`,
    handle: `streamer_${i}`,
    platform: 'twitch',
    color: '#9146ff',
    image: '',
    category: '',
    bio: '',
  }));
  const tokens: catalog.Token[] = Array.from({ length: count }, (_, i) => {
    const mint = new Uint8Array(32);
    new DataView(mint.buffer).setUint32(28, i + 1);
    return {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: i < 2 ? 'Shared Name' : `Token ${i}`,
      symbol: i < 2 ? 'SAME' : `T${i}`,
      image: '',
      color: '#9146ff',
      launchpad: 'pump',
      streamerId: streamers[i % streamers.length].id,
      mcap: null,
      volume: null,
      change: null,
      created: Date.UTC(2026, 8, 1) + i * 1000,
      address: bs58.encode(mint),
      description: '',
      donatedUsdCents: i * 100,
    };
  });
  return {
    tokens,
    streamers,
    activity: [],
    stats: {
      totalDonatedUsdCents: 10000,
      totalClaimedUsdCents: 20000,
      streamerAllocatedUsdCents: 16000,
      buybackAllocatedUsdCents: 4000,
      streamerPendingUsdCents: 5000,
      tokenCount: tokens.length,
      streamerCount: streamers.length,
    },
  };
}
function state() {
  let value!: ReturnType<typeof catalog.useCatalog>;
  renderToString(
    createElement(() => {
      value = catalog.useCatalog();
      return null;
    }),
  );
  return value;
}
function saved() {
  return {
    tokens: catalog.tokens,
    streamers: catalog.streamers,
    ledger: catalog.ledger,
    payments: catalog.payments,
    treasury: catalog.treasury,
    counts: catalog.catalogCounts,
    total: catalog.totalDonations,
    overall: catalog.overallGiftSpending,
    donationSummary: catalog.donationSummary,
    updatedAt: state().updatedAt,
  };
}

test('unclaimed fees retain exact cents without changing gifts; malformed or expired estimates stay unknown', async () => {
  const previous = globalThis.fetch;
  try {
    const value = catalogFixture(1);
    value.tokens[0].feeAccrual = {
      unclaimedUsdCents: 76249,
      unclaimedLamports: '7759187457',
      observedAt: new Date().toISOString(),
      status: 'fresh',
    };
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens[0].feeAccrual?.unclaimedUsdCents, 76249);
    assert.equal(catalog.tokens[0].donatedUsdCents, 0);
    assert.equal(catalog.totalDonations, 100);
    for (const invalid of [
      { ...value.tokens[0].feeAccrual, unclaimedUsdCents: -1 },
      { ...value.tokens[0].feeAccrual, observedAt: new Date(Date.now() - 600_000).toISOString() },
      { ...value.tokens[0].feeAccrual, status: 'unavailable' },
      { ...value.tokens[0].feeAccrual, unclaimedLamports: 'NaN' },
    ]) {
      globalThis.fetch = async () =>
        Response.json({ ...value, tokens: [{ ...value.tokens[0], feeAccrual: invalid }] });
      await catalog.refreshCatalog();
      assert.equal(catalog.tokens.length, 1);
      assert.equal(catalog.tokens[0].feeAccrual?.unclaimedUsdCents, null);
      assert.equal(catalog.totalDonations, 100);
      assert.equal(state().error, '');
    }
  } finally {
    globalThis.fetch = previous;
  }
});

const summaryFixture = (manualGiftSpendingUsdCents = 2381) => ({
  totalGiftSpendingUsdCents: 10000 + manualGiftSpendingUsdCents,
  creatorFeeGiftSpendingUsdCents: 10000,
  manualGiftSpendingUsdCents,
  completedGiftCount: 3,
  manualGiftCount: 1,
});

test('streamer spending combines verified manual gifts and creator fees without changing token totals', async () => {
  const previous = globalThis.fetch;
  try {
    const value = catalogFixture(2);
    Object.assign(value.streamers[0], {
      donatedUsdCents: 4751,
      totalGiftSpendingUsdCents: 11883,
      manualGiftSpendingUsdCents: 7132,
      manualGiftCount: 2,
    });
    Object.assign(value.streamers[1], {
      donatedUsdCents: 4751,
      totalGiftSpendingUsdCents: 4751,
      manualGiftSpendingUsdCents: 0,
      manualGiftCount: 0,
    });
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(state().error, '');
    assert.equal(catalog.streamerDonations(value.streamers[0].id), 118.83);
    assert.equal(catalog.streamerDonations(value.streamers[1].id), 47.51);
    assert.equal(catalog.giftMoney(catalog.streamerDonations(value.streamers[0].id)), '$118.83');
    assert.equal(catalog.tokenDonations(value.tokens[0].id), 0);
    delete value.streamers[0].totalGiftSpendingUsdCents;
    delete value.streamers[0].manualGiftSpendingUsdCents;
    delete value.streamers[0].manualGiftCount;
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(catalog.streamerDonations(value.streamers[0].id), 47.51);
    assert.equal(catalog.streamerDonations('missing'), null);
  } finally {
    globalThis.fetch = previous;
  }
});

for (const [field, value] of [
  ['totalGiftSpendingUsdCents', -1],
  ['totalGiftSpendingUsdCents', 118.83],
  ['totalGiftSpendingUsdCents', Number.MAX_SAFE_INTEGER + 1],
  ['totalGiftSpendingUsdCents', 11884],
  ['manualGiftSpendingUsdCents', '7132'],
  ['manualGiftSpendingUsdCents', -1],
  ['manualGiftCount', 1.5],
  ['manualGiftCount', -1],
] as const) {
  test(`invalid streamer ${field}=${value} retains the last verified catalog`, async () => {
    const previous = globalThis.fetch;
    try {
      const fixture = catalogFixture(2);
      Object.assign(fixture.streamers[0], {
        donatedUsdCents: 4751,
        totalGiftSpendingUsdCents: 11883,
        manualGiftSpendingUsdCents: 7132,
        manualGiftCount: 2,
      });
      globalThis.fetch = async () => Response.json(fixture);
      await catalog.refreshCatalog();
      const before = saved();
      Object.assign(fixture.streamers[0], { [field]: value });
      await catalog.refreshCatalog();
      assertRetained(before);
    } finally {
      globalThis.fetch = previous;
    }
  });
}

test('overall gift spending refreshes independently of creator-fee totals and falls back for older catalogs', async () => {
  const previous = globalThis.fetch;
  try {
    for (const manual of [2381, 4602]) {
      globalThis.fetch = async () =>
        Response.json({
          ...catalogFixture(1),
          donationSummary: summaryFixture(manual),
        });
      await catalog.refreshCatalog();
      assert.equal(state().error, '');
      assert.equal(catalog.overallGiftSpending, (10000 + manual) / 100);
      assert.equal(catalog.totalDonations, 100);
      assert.equal(catalog.treasury.paid, 100);
      assert.equal(catalog.tokens[0].donatedUsdCents, 0);
      assert.equal(catalog.donationSummary?.manualGiftSpendingUsdCents, manual);
    }
    globalThis.fetch = async () => Response.json(catalogFixture(1));
    await catalog.refreshCatalog();
    assert.equal(catalog.overallGiftSpending, 100);
    assert.equal(catalog.donationSummary, null);
  } finally {
    globalThis.fetch = previous;
  }
});

for (const [name, summary] of [
  ['missing amount', { ...summaryFixture(), totalGiftSpendingUsdCents: undefined }],
  ['negative cents', { ...summaryFixture(), manualGiftSpendingUsdCents: -1 }],
  ['fractional cents', { ...summaryFixture(), manualGiftSpendingUsdCents: 23.81 }],
  ['unsafe cents', { ...summaryFixture(), totalGiftSpendingUsdCents: Number.MAX_SAFE_INTEGER + 1 }],
  ['numeric string', { ...summaryFixture(), manualGiftCount: '1' }],
  ['fractional count', { ...summaryFixture(), completedGiftCount: 1.5 }],
  ['inconsistent sum', { ...summaryFixture(), totalGiftSpendingUsdCents: 12380 }],
  [
    'inconsistent creator fees',
    { ...summaryFixture(), creatorFeeGiftSpendingUsdCents: 9999, totalGiftSpendingUsdCents: 12380 },
  ],
  ['inconsistent count', { ...summaryFixture(), completedGiftCount: 0 }],
  ['null summary', null],
] as const) {
  test(`an invalid ${name} in the overall donation summary preserves the verified catalog`, async () => {
    const previous = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        Response.json({ ...catalogFixture(1), donationSummary: summaryFixture() });
      await catalog.refreshCatalog();
      const before = saved();
      globalThis.fetch = async () =>
        Response.json({ ...catalogFixture(4), donationSummary: summary });
      await catalog.refreshCatalog();
      assertRetained(before);
    } finally {
      globalThis.fetch = previous;
    }
  });
}
function assertRetained(before: ReturnType<typeof saved>) {
  const after = saved();
  for (const key of Object.keys(before) as (keyof typeof before)[])
    assert.equal(after[key], before[key], key);
  assert.ok(state().error);
  assert.equal(state().loading, false);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('frontend uses lifetime counts and recorded reserve rather than its recent donation feed', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      tokens: catalogFixture(4).tokens,
      streamers: catalogFixture(4).streamers,
      stats: {
        totalDonatedUsdCents: 10000,
        totalClaimedUsdCents: 20000,
        streamerAllocatedUsdCents: 16000,
        buybackAllocatedUsdCents: 4000,
        streamerPendingUsdCents: 5000,
        buybackSpentUsdCents: 1000,
        buybackReserveUsdCents: 2900,
        buybackNetworkFeesUsdCents: 100,
        heldUsdCents: 7900,
        convertedUsdCents: 12000,
        paymentCostsUsdCents: 1000,
        claimNetworkFeesUsdCents: 10,
        completedPaymentCount: 250,
        pendingPaymentCount: 3,
        tokenCount: 4,
        streamerCount: 2,
        claimCount: 300,
        buybackCount: 1,
        burnCount: 1,
        burnedTokenBaseUnits: '1234567890123456789',
        burnedTokenDecimals: 6,
      },
      activity: [
        {
          id: 'gift-1',
          tokenId: 'token-1',
          kind: 'Donation',
          amountUsdCents: 5000,
          amountMeaning: 'spent',
          status: 'Confirmed',
          createdAt: '2026-09-16T12:00:00Z',
          reference: 'gift-1',
        },
        {
          id: 'pending-1',
          tokenId: 'token-1',
          kind: 'Payout',
          amountUsdCents: 5000,
          amountMeaning: 'budget',
          status: 'Pending',
          createdAt: '2026-09-16T12:00:00Z',
          reference: 'pending-1',
        },
      ],
      activitySummary: { totalCount: 700, returnedCount: 2, truncated: true },
    });
  try {
    await catalog.refreshCatalog();
    assert.equal(catalog.catalogCounts.completedPayments, 250);
    assert.equal(catalog.payments.length, 1);
    assert.equal(catalog.treasury.buybackReserve, 29);
    assert.equal(catalog.treasury.held, 79);
    assert.equal(catalog.treasury.converted, 120);
    assert.equal(catalog.treasury.burnedTokens, '1,234,567,890,123.456789');
    assert.equal(catalog.activitySummary.totalCount, 700);
    assert.equal(catalog.activitySummary.truncated, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('burn token amounts preserve base-unit precision and unavailable data never becomes zero', () => {
  assert.equal(catalog.formatTokenUnits('1000000000000000001', 9), '1,000,000,000.000000001');
  assert.equal(catalog.formatTokenUnits('0', null), '0');
  assert.equal(catalog.formatTokenUnits('100', null), null);
  assert.equal(catalog.formatTokenUnits(null, 6), null);
  assert.equal(catalog.decimalMoney(null), '—');
});

test('a malformed totals refresh cannot partially replace a previously verified catalog', async () => {
  const oldFetch = globalThis.fetch;
  const before = {
    tokens: catalog.tokens,
    streamers: catalog.streamers,
    ledger: catalog.ledger,
    payments: catalog.payments,
    treasury: catalog.treasury,
    counts: catalog.catalogCounts,
    total: catalog.totalDonations,
  };
  globalThis.fetch = async () =>
    Response.json({
      tokens: [{ id: 'invalid-new-token' }],
      streamers: [{ id: 'invalid-new-streamer' }],
      activity: [{ kind: 'Donation', amountUsdCents: 999999, createdAt: '2026-09-16T12:00:00Z' }],
      stats: { totalDonatedUsdCents: 'not-money' },
    });
  try {
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens, before.tokens);
    assert.equal(catalog.streamers, before.streamers);
    assert.equal(catalog.ledger, before.ledger);
    assert.equal(catalog.payments, before.payments);
    assert.equal(catalog.treasury, before.treasury);
    assert.equal(catalog.catalogCounts, before.counts);
    assert.equal(catalog.totalDonations, before.total);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

const corruptions: Record<string, (value: ReturnType<typeof catalogFixture>) => void> = {
  'a partial token': (value) => {
    value.tokens[1] = { id: value.tokens[1].id } as catalog.Token;
  },
  'a null token': (value) => {
    value.tokens[1] = null as unknown as catalog.Token;
  },
  'a repeated token ID': (value) => {
    value.tokens[1].id = value.tokens[0].id;
  },
  'a repeated mint': (value) => {
    value.tokens[1].address = value.tokens[0].address;
  },
  'a noncanonical mint': (value) => {
    value.tokens[1].address = '0'.repeat(44);
  },
  'a noncanonical ID': (value) => {
    value.tokens[1].id = 'duplicate-view-row';
  },
  'a repeated streamer ID': (value) => {
    value.streamers[1].id = value.streamers[0].id;
  },
  'a partial streamer': (value) => {
    value.streamers[1] = { id: value.streamers[1].id } as catalog.Streamer;
  },
  'a crossed streamer platform': (value) => {
    value.streamers[1].platform = 'kick';
  },
  'a missing recipient': (value) => {
    value.tokens[1].streamerId = 'twitch:999';
  },
  'a mismatched token count': (value) => {
    value.stats.tokenCount++;
  },
  'a missing token count': (value) => {
    delete (value.stats as Partial<typeof value.stats>).tokenCount;
  },
  'a mismatched streamer count': (value) => {
    value.stats.streamerCount++;
  },
  'a missing name': (value) => {
    value.tokens[1].name = undefined as unknown as string;
  },
  'a string market price': (value) => {
    value.tokens[1].mcap = '1000' as unknown as number;
  },
  'a negative market value': (value) => {
    value.tokens[1].volume = -1;
  },
  'an invalid timestamp': (value) => {
    value.tokens[1].created = NaN;
  },
  'a fractional financial amount': (value) => {
    value.tokens[1].donatedUsdCents = 0.1;
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`catalog rejects ${name} without replacing any last confirmed data`, async () => {
    const previous = globalThis.fetch;
    try {
      globalThis.fetch = async () => Response.json(catalogFixture());
      await catalog.refreshCatalog();
      const before = saved();
      const malformed = catalogFixture(40);
      corrupt(malformed);
      globalThis.fetch = async () => Response.json(malformed);
      await catalog.refreshCatalog();
      assertRetained(before);
    } finally {
      globalThis.fetch = previous;
    }
  });
}

test('all 107 distinct tokens survive validation with unknown prices and shared names, including canonical legacy recipients', async () => {
  const previous = globalThis.fetch;
  try {
    const value = catalogFixture(107);
    value.streamers[0].id = 'legacy:twitch:streamer_0';
    value.tokens.forEach((token, i) => {
      if (i % 2 === 0) token.streamerId = 'legacy:twitch:streamer_0';
    });
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 107);
    assert.equal(catalog.catalogCounts.tokens, 107);
    assert.equal(state().error, '');
    assert.equal(catalog.tokens.filter((token) => token.name === 'Shared Name').length, 2);
    assert.equal(
      catalog.tokens.every((token) => token.mcap === null && token.volume === null),
      true,
    );
    assert.equal(catalog.tokens[0].image, '/assets/brand/mark.svg');
  } finally {
    globalThis.fetch = previous;
  }
});

test('a launch refresh burst queues exactly one fresh read and resolves all callers after 14 becomes 40', async () => {
  const previous = globalThis.fetch;
  const first = deferred<Response>(),
    second = deferred<Response>(),
    secondStarted = deferred<void>();
  let initial: Promise<void> | undefined;
  let calls = 0;
  try {
    globalThis.fetch = () => {
      calls++;
      if (calls === 2) secondStarted.resolve();
      return calls === 1 ? first.promise : second.promise;
    };
    initial = catalog.refreshCatalog();
    assert.equal(catalog.refreshCatalog(), initial);
    for (let i = 0; i < 20; i++) assert.equal(catalog.refreshCatalog({ force: true }), initial);
    let finished = false;
    void initial.then(() => {
      finished = true;
    });
    first.resolve(Response.json(catalogFixture(14)));
    await secondStarted.promise;
    assert.equal(calls, 2);
    assert.equal(finished, false);
    assert.equal(catalog.tokens.length, 14);
    second.resolve(Response.json(catalogFixture(40)));
    await initial;
    assert.equal(calls, 2);
    assert.equal(catalog.tokens.length, 40);
    assert.equal(finished, true);
  } finally {
    first.resolve(Response.json(catalogFixture()));
    second.resolve(Response.json(catalogFixture()));
    await initial;
    globalThis.fetch = previous;
  }
});

test('failed queued launch read preserves the latest complete catalog and exposes retry state', async () => {
  const previous = globalThis.fetch;
  const first = deferred<Response>();
  let calls = 0;
  try {
    globalThis.fetch = () =>
      ++calls === 1 ? first.promise : Promise.resolve(new Response('{}', { status: 503 }));
    const read = catalog.refreshCatalog();
    catalog.refreshCatalog({ force: true });
    first.resolve(Response.json(catalogFixture(14)));
    await read;
    assert.equal(calls, 2);
    assert.equal(catalog.tokens.length, 14);
    assert.ok(state().error);
    globalThis.fetch = async () => Response.json(catalogFixture(40));
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 40);
    assert.equal(state().error, '');
  } finally {
    first.resolve(Response.json(catalogFixture()));
    globalThis.fetch = previous;
  }
});

for (const stage of ['fetch', 'body'] as const) {
  test(`catalog ${stage} deadline aborts, releases singleflight and ignores late stale data`, async (context) => {
    const previous = globalThis.fetch;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const delayed = deferred<unknown>();
    let signal: AbortSignal | undefined;
    try {
      globalThis.fetch = async () => Response.json(catalogFixture(14));
      await catalog.refreshCatalog();
      const before = saved();
      globalThis.fetch = async (_url, init) => {
        signal = init?.signal ?? undefined;
        if (stage === 'fetch') return (await delayed.promise) as Response;
        const response = new Response('{}');
        response.json = () => delayed.promise;
        return response;
      };
      const pending = catalog.refreshCatalog();
      await flush();
      context.mock.timers.tick(12001);
      await pending;
      assert.equal(signal?.aborted, true);
      assertRetained(before);
      globalThis.fetch = async () => Response.json(catalogFixture(40));
      await catalog.refreshCatalog();
      assert.equal(catalog.tokens.length, 40);
      delayed.resolve(stage === 'fetch' ? Response.json(catalogFixture(90)) : catalogFixture(90));
      await flush();
      assert.equal(catalog.tokens.length, 40);
      assert.equal(state().error, '');
    } finally {
      delayed.resolve(stage === 'fetch' ? Response.json(catalogFixture()) : catalogFixture());
      globalThis.fetch = previous;
      context.mock.timers.reset();
    }
  });
}

test('sorting uses each supplied token financial totals, deterministic age and ID ties, and never drops unpriced rows', () => {
  const rows = catalogFixture(4).tokens;
  rows[0].donatedUsdCents = 900;
  rows[1].donatedUsdCents = 100;
  rows[2].donatedUsdCents = 800;
  rows[3].donatedUsdCents = 800;
  rows[2].created = rows[3].created;
  assert.deepEqual(
    catalog.sortTokens(rows, 'donations').map((row) => row.id),
    [rows[0].id, rows[2].id, rows[3].id, rows[1].id],
  );
  const savedRows = structuredClone(rows);
  for (const sort of ['newest', 'mcap', 'volume'] as const) {
    const forward = catalog.sortTokens(rows, sort).map((row) => row.id),
      backward = catalog.sortTokens([...rows].reverse(), sort).map((row) => row.id);
    assert.deepEqual(forward, backward);
    assert.equal(forward.length, 4);
    assert.equal(forward.at(-1), rows[0].id);
  }
  assert.deepEqual(rows, savedRows);
});

test('valid multiline and emoji text and optional malformed profile presentation never hide a valid catalog', async () => {
  const previous = globalThis.fetch;
  try {
    const value = catalogFixture(40);
    value.tokens[0].name = 'Community\u007f';
    value.tokens[0].description = 'Community 💚\nSecond line\r\nThird\tline\f\u007f';
    value.streamers[0].bio = 'Bio 💜\nAnother line';
    value.streamers[0].handle = 'StReAmEr_0';
    value.streamers[0].id = 'legacy:twitch:streamer_0';
    value.tokens.forEach((token, i) => {
      if (i % 2 === 0) token.streamerId = 'legacy:twitch:streamer_0';
    });
    value.streamers[1].name = '';
    value.streamers[1].bio = { invalid: true } as unknown as string;
    value.streamers[1].category = 22 as unknown as string;
    value.streamers[1].image = 'https://credential:private@cdn.example/image';
    value.streamers[1].color = 'bad-color';
    value.streamers[1].channelUrl = 'javascript:alert(1)';
    value.tokens[1].image = 'javascript:alert(1)';
    value.tokens[1].color = 'bad-color';
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 40);
    assert.equal(state().error, '');
    assert.equal(catalog.tokens[0].description, value.tokens[0].description);
    assert.equal(catalog.streamers[0].bio, value.streamers[0].bio);
    assert.equal(catalog.streamers[0].handle, 'StReAmEr_0');
    assert.equal(catalog.streamers[1].name, 'streamer_1');
    assert.equal(catalog.streamers[1].bio, '');
    assert.equal(catalog.streamers[1].category, '');
    assert.equal(catalog.streamers[1].image, '');
    assert.equal(catalog.streamers[1].channelUrl, 'https://www.twitch.tv/streamer_1');
    assert.equal(catalog.tokens[1].image, '/assets/brand/mark.svg');
    assert.equal(catalog.tokens[1].color, '#9146FF');
    value.streamers[1].name = 'Name'.repeat(100);
    value.streamers[1].bio = 'Bio'.repeat(4000);
    value.streamers[1].category = 'Category'.repeat(100);
    globalThis.fetch = async () => Response.json(value);
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 40);
    assert.equal(state().error, '');
  } finally {
    globalThis.fetch = previous;
  }
});

for (const stage of ['fetch', 'body'] as const) {
  test(`late rejected ${stage} after deadline has no unhandled rejection or effect on the successful retry`, async (context) => {
    const previous = globalThis.fetch;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let reject!: (error: Error) => void;
    const delayed = new Promise<never>((_resolve, no) => {
      reject = no;
    });
    try {
      globalThis.fetch = async () => {
        if (stage === 'fetch') return delayed;
        const response = new Response('{}');
        response.json = () => delayed;
        return response;
      };
      const expired = catalog.refreshCatalog();
      await flush();
      context.mock.timers.tick(12001);
      await expired;
      globalThis.fetch = async () => Response.json(catalogFixture(40));
      await catalog.refreshCatalog();
      reject(new Error('Late ignored fixture failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(catalog.tokens.length, 40);
      assert.equal(state().error, '');
    } finally {
      globalThis.fetch = previous;
      context.mock.timers.reset();
    }
  });
}

test('a forced refresh queued behind a stalled read proceeds automatically after its deadline', async (context) => {
  const previous = globalThis.fetch;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stalled = deferred<Response>();
  try {
    globalThis.fetch = () =>
      ++calls === 1 ? stalled.promise : Promise.resolve(Response.json(catalogFixture(40)));
    const read = catalog.refreshCatalog();
    assert.equal(catalog.refreshCatalog({ force: true }), read);
    await flush();
    context.mock.timers.tick(12001);
    await read;
    assert.equal(calls, 2);
    assert.equal(catalog.tokens.length, 40);
    assert.equal(state().error, '');
    stalled.resolve(Response.json(catalogFixture(14)));
    await flush();
    assert.equal(catalog.tokens.length, 40);
  } finally {
    stalled.resolve(Response.json(catalogFixture()));
    globalThis.fetch = previous;
    context.mock.timers.reset();
  }
});

test('a verified empty snapshot removes old catalog rows rather than keeping phantom tokens', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(catalogFixture(40));
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 40);
    globalThis.fetch = async () => Response.json(catalogFixture(0));
    await catalog.refreshCatalog();
    assert.deepEqual(catalog.tokens, []);
    assert.deepEqual(catalog.streamers, []);
    assert.equal(catalog.catalogCounts.tokens, 0);
    assert.equal(state().error, '');
  } finally {
    globalThis.fetch = previous;
  }
});

test('market refresh hints cannot delay new identity reads or create rapid retry loops', async () => {
  const oldFetch = globalThis.fetch;
  try {
    for (const [hint, expected] of [
      [{ refreshing: true, retryAfterMs: 1000 }, 1000],
      [{ refreshing: true, retryAfterMs: 0 }, 1000],
      [{ refreshing: true, retryAfterMs: 60000 }, 5000],
      [{ refreshing: true, retryAfterMs: 'bad' }, 2000],
      [{ refreshing: false, retryAfterMs: 1000 }, 5000],
      [undefined, 5000],
    ] as const) {
      globalThis.fetch = async () => Response.json({ ...catalogFixture(), marketData: hint });
      await catalog.refreshCatalog();
      assert.equal(catalog.nextCatalogRefreshMs(), expected);
      assert.equal(catalog.tokens.length, 14);
    }
    globalThis.fetch = async () => new Response('', { status: 503 });
    await catalog.refreshCatalog();
    assert.equal(catalog.nextCatalogRefreshMs(), 10000);
    assert.equal(catalog.tokens.length, 14, 'outages keep all last verified identities');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('optional market freshness metadata is normalized without dropping token identities or changing ledger values', async () => {
  const oldFetch = globalThis.fetch;
  const value = catalogFixture(2);
  Object.assign(value.tokens[0], {
    marketDataStatus: 'stale',
    marketDataUpdatedAt: '2026-09-16T12:00:00.000Z',
  });
  Object.assign(value.tokens[1], { marketDataStatus: '<invalid>', marketDataUpdatedAt: 'invalid' });
  globalThis.fetch = async () => Response.json(value);
  try {
    await catalog.refreshCatalog();
    assert.equal(catalog.tokens.length, 2);
    assert.equal(catalog.tokens[0].marketDataStatus, 'stale');
    assert.equal(catalog.tokens[0].marketDataUpdatedAt, '2026-09-16T12:00:00.000Z');
    assert.equal(catalog.tokens[1].marketDataStatus, undefined);
    assert.equal(catalog.tokens[1].marketDataUpdatedAt, null);
    assert.equal(catalog.treasury.claimed, 200);
    assert.equal(catalog.treasury.payoutPending, 50);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('community token prices preserve precise micro-prices alongside verified identity and financial totals', async () => {
  const previous = globalThis.fetch;
  const value = catalogFixture(1);
  Object.assign(value.tokens[0], { priceUsd: 0.0000001234 });
  globalThis.fetch = async () => Response.json(value);
  try {
    await catalog.refreshCatalog();
    assert.equal(state().error, '');
    assert.equal(catalog.tokens.length, 1);
    assert.equal(catalog.tokens[0].priceUsd, 0.0000001234);
    assert.equal(catalog.tokens[0].address, value.tokens[0].address);
    assert.equal(catalog.treasury.claimed, 200);
  } finally {
    globalThis.fetch = previous;
  }
});

for (const [name, priceUsd] of [
  ['omitted', undefined],
  ['null', null],
  ['zero', 0],
  ['negative', -0.0000001234],
  ['numeric string', '0.0000001234'],
  ['invalid string', 'invalid'],
  ['boolean', true],
  ['object', {}],
  ['excessive value', Number.MAX_SAFE_INTEGER],
] as const) {
  test(`community token price (${name}) becomes unavailable without hiding the token`, async () => {
    const previous = globalThis.fetch;
    const value = catalogFixture(1);
    Object.assign(value.tokens[0], { priceUsd });
    globalThis.fetch = async () => Response.json(value);
    try {
      await catalog.refreshCatalog();
      assert.equal(state().error, '');
      assert.equal(catalog.tokens.length, 1);
      assert.equal(catalog.tokens[0].priceUsd, null);
      assert.equal(catalog.tokens[0].address, value.tokens[0].address);
      assert.equal(catalog.treasury.claimed, 200);
    } finally {
      globalThis.fetch = previous;
    }
  });
}

test('a non-finite community token price decoded from JSON becomes unavailable', async () => {
  const previous = globalThis.fetch;
  const value = catalogFixture(1);
  Object.assign(value.tokens[0], { priceUsd: 'overflow-price' });
  globalThis.fetch = async () =>
    new Response(JSON.stringify(value).replace('"overflow-price"', '1e309'));
  try {
    await catalog.refreshCatalog();
    assert.equal(state().error, '');
    assert.equal(catalog.tokens.length, 1);
    assert.equal(catalog.tokens[0].priceUsd, null);
    assert.equal(catalog.tokens[0].address, value.tokens[0].address);
  } finally {
    globalThis.fetch = previous;
  }
});

const conversionLocations = ['token', 'streamer', 'stats'] as const;
function setConversionDifference(
  value: ReturnType<typeof catalogFixture>,
  location: (typeof conversionLocations)[number],
  difference: unknown,
) {
  const target =
    location === 'token'
      ? value.tokens[0]
      : location === 'streamer'
        ? value.streamers[0]
        : value.stats;
  Object.assign(target, { conversionPendingUsdCents: difference });
}

for (const difference of [-971, 0, 400]) {
  test(`signed native conversion difference ${difference} cents is accepted across token, streamer and totals`, async () => {
    const previous = globalThis.fetch;
    try {
      const value = catalogFixture(1);
      for (const location of conversionLocations)
        setConversionDifference(value, location, difference);
      globalThis.fetch = async () => Response.json(value);
      await catalog.refreshCatalog();
      assert.equal(state().error, '');
      assert.equal(catalog.tokens.length, 1);
      assert.equal(catalog.tokens[0].conversionPendingUsdCents, difference);
      assert.equal(catalog.streamers[0].conversionPendingUsdCents, difference);
      assert.equal(catalog.treasury.claimed, 200, 'conversion differences do not create revenue');
      assert.equal(
        catalog.treasury.payoutPending,
        50,
        'conversion differences are not spendable funds',
      );
      assert.equal(
        catalog.totalDonations,
        100,
        'conversion differences are not completed donations',
      );
    } finally {
      globalThis.fetch = previous;
    }
  });
}

for (const location of conversionLocations) {
  for (const [name, difference] of [
    ['fractional cents', -9.71],
    ['positive infinity', Infinity],
    ['negative infinity', -Infinity],
    ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1],
    ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1],
    ['numeric string', '-971'],
  ] as const) {
    test(`invalid ${name} in ${location} conversion difference retains the entire last confirmed catalog`, async () => {
      const previous = globalThis.fetch;
      try {
        globalThis.fetch = async () => Response.json(catalogFixture(1));
        await catalog.refreshCatalog();
        const before = saved();
        const invalid = catalogFixture(4);
        if (typeof difference === 'number' && !Number.isFinite(difference)) {
          // JSON overflow is legal syntax and decodes to a non-finite number.
          setConversionDifference(invalid, location, 'overflow-conversion');
          globalThis.fetch = async () =>
            new Response(
              JSON.stringify(invalid).replace(
                '"overflow-conversion"',
                difference < 0 ? '-1e309' : '1e309',
              ),
            );
        } else {
          setConversionDifference(invalid, location, difference);
          globalThis.fetch = async () => Response.json(invalid);
        }
        await catalog.refreshCatalog();
        assertRetained(before);
      } finally {
        globalThis.fetch = previous;
      }
    });
  }
  test(`signed conversion permission does not allow negative ordinary ${location} money`, async () => {
    const previous = globalThis.fetch;
    try {
      globalThis.fetch = async () => Response.json(catalogFixture(1));
      await catalog.refreshCatalog();
      const before = saved();
      const invalid = catalogFixture(4);
      setConversionDifference(invalid, location, -971);
      if (location === 'stats') invalid.stats.totalDonatedUsdCents = -1;
      else if (location === 'token') invalid.tokens[0].donatedUsdCents = -1;
      else invalid.streamers[0].donatedUsdCents = -1;
      globalThis.fetch = async () => Response.json(invalid);
      await catalog.refreshCatalog();
      assertRetained(before);
    } finally {
      globalThis.fetch = previous;
    }
  });
}

test('rate-limited catalog respects Retry-After even for forced refreshes and retains verified rows', async (context) => {
  const oldFetch = globalThis.fetch;
  context.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 16) });
  let calls = 0;
  try {
    globalThis.fetch = async () => Response.json(catalogFixture(14));
    await catalog.refreshCatalog();
    globalThis.fetch = async () => {
      calls++;
      return new Response('', { status: 429, headers: { 'retry-after': '120' } });
    };
    await catalog.refreshCatalog();
    assert.equal(catalog.nextCatalogRefreshMs(), 120000);
    assert.equal(catalog.tokens.length, 14);
    await catalog.refreshCatalog({ force: true });
    assert.equal(calls, 1, 'visibility and launch refreshes must respect the cooldown');
    context.mock.timers.tick(120000);
    globalThis.fetch = async () => {
      calls++;
      return Response.json(catalogFixture(15));
    };
    await catalog.refreshCatalog();
    assert.equal(calls, 2);
    assert.equal(catalog.tokens.length, 15);
    assert.equal(state().error, '');
    assert.equal(catalog.nextCatalogRefreshMs(), 5000);
  } finally {
    context.mock.timers.tick(120000);
    globalThis.fetch = async () => Response.json(catalogFixture());
    await catalog.refreshCatalog();
    globalThis.fetch = oldFetch;
    context.mock.timers.reset();
  }
});

test('a late rate-limit response from an expired request cannot delay a recovered catalog', async (context) => {
  const oldFetch = globalThis.fetch;
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 16) });
  let resolve!: (response: Response) => void;
  try {
    globalThis.fetch = () =>
      new Promise<Response>((done) => {
        resolve = done;
      });
    const expired = catalog.refreshCatalog();
    await flush();
    context.mock.timers.tick(12001);
    await expired;
    globalThis.fetch = async () => Response.json(catalogFixture(40));
    await catalog.refreshCatalog();
    resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    await flush();
    assert.equal(catalog.nextCatalogRefreshMs(), 5000);
    assert.equal(state().error, '');
    assert.equal(catalog.tokens.length, 40);
  } finally {
    context.mock.timers.tick(120000);
    globalThis.fetch = async () => Response.json(catalogFixture());
    await catalog.refreshCatalog();
    globalThis.fetch = oldFetch;
    context.mock.timers.reset();
  }
});
