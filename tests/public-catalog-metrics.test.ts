import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import bs58 from 'bs58';
import { createOperations } from '../server/operations.ts';
import { publicCatalog } from '../server/public/catalog.ts';

const actor = 'catalog-test';
const valuationAt = '2026-09-16T12:00:00.000Z';
function signature(index: number) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(index, 60);
  return bs58.encode(bytes);
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  const operations = createOperations(db, { streamerBps: 8000 });
  let counter = 0;
  const register = (suffix: number) =>
    operations.registerToken(
      {
        name: `Community ${suffix}`,
        symbol: `COM${suffix}`,
        mint: bs58.encode(Buffer.alloc(32, suffix)),
        creatorAddress: bs58.encode(Buffer.alloc(32, suffix + 20)),
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: 'same_streamer',
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      actor,
    );
  const token = register(1);
  function fund(tokenId = token.id, credited = 7500) {
    const index = ++counter;
    operations.recordClaim(
      {
        tokenId,
        signature: signature(index * 2),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 2,
        valuationAt,
        slot: index,
        confirmation: 'finalized',
      },
      actor,
    );
    const payment = operations.reservePayment(
      { tokenId, budgetCents: 8000, idempotencyKey: `reserve-${index}` },
      actor,
    );
    operations.recordFunding(
      payment.id,
      {
        invoiceId: `private-invoice-${index}`,
        depositAddress: bs58.encode(Buffer.alloc(32, 42)),
        signature: signature(index * 2 + 1),
        amountLamports: '790000000',
        amountUsdCents: 7900,
        networkFeeCents: 10,
        valuationAt,
      },
      actor,
    );
    operations.confirmFunding(
      payment.id,
      {
        creditedUsdCents: credited,
        providerFeeCents: 7900 - credited,
        reference: `private-credit-${index}`,
        evidenceUrl: 'https://coinbase.cc/private',
        idempotencyKey: `credit-${index}`,
      },
      actor,
    );
    return payment;
  }
  function complete(tokenId = token.id) {
    const payment = fund(tokenId);
    operations.completePayment(
      payment.id,
      {
        spentUsdCents: 7300,
        confirmationUrl: `https://www.twitch.tv/receipt/${payment.id}`,
        kind: 'gift_sub',
        giftUnits: 10,
        idempotencyKey: `complete-${payment.id}`,
      },
      actor,
    );
    return payment;
  }
  const catalog = () =>
    publicCatalog(
      operations,
      { allConfirmedMetadata: () => [] } as Parameters<typeof publicCatalog>[1],
      [],
    );
  return { db, operations, token, register, fund, complete, catalog };
}

test('lifetime totals and per-recipient counts remain complete beyond the 200-event feed', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 205; i++) f.complete();
    const result = f.catalog();
    assert.equal(result.stats.totalDonatedUsdCents, 205 * 7300);
    assert.equal(result.stats.completedPaymentCount, 205);
    assert.equal(result.stats.claimCount, 205);
    assert.equal(result.tokens[0].completedPaymentCount, 205);
    assert.equal(result.streamers[0].completedPaymentCount, 205);
    assert.equal(result.activity.length, 200);
    assert.equal(result.activitySummary.totalCount, 205 * 3);
    assert.equal(result.activitySummary.truncated, true);
    assert.equal(result.stats.convertedUsdCents, 205 * 7500);
    assert.equal(result.stats.paymentCostsUsdCents, 205 * 410);
    assert.equal(result.stats.claimNetworkFeesUsdCents, 205 * 2);
    assert.ok(
      result.activity
        .filter((event) => event.kind === 'Donation')
        .every((event) => event.status === 'Confirmed'),
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-invoice|private-credit|coinbase\.cc\/private|catalog-test/,
    );
  } finally {
    f.db.close();
  }
});

test('pending funds include separate retained SOL, active reservation and card residual exactly once', () => {
  const f = fixture();
  try {
    f.complete();
    const second = f.register(2);
    f.fund(second.id, 4900);
    const result = f.catalog();
    const totals = f.operations.snapshot().totals;
    assert.equal(
      result.stats.streamerPendingUsdCents,
      totals.availableCents + totals.reservedCents + totals.cardResidualCents,
    );
    assert.equal(result.stats.streamerAllocatedUsdCents, 16000);
    assert.equal(result.stats.pendingPaymentCount, 1);
    assert.equal(
      result.tokens.find((token) => token.id === second.id)!.payoutStatus,
      'awaiting_threshold',
    );
    assert.equal(
      result.streamers.length,
      1,
      'legacy tokens for the same platform/handle form one recipient group',
    );
    assert.equal(result.streamers[0].tokenCount, 2);
    assert.equal(result.streamers[0].completedPaymentCount, 1);
    assert.equal(result.streamers[0].pendingPaymentCount, 1);
    assert.equal(result.streamers[0].pendingUsdCents, result.stats.streamerPendingUsdCents);
    const pending = result.activity.find((event) => event.kind === 'Payout');
    assert.equal(pending?.status, 'Pending');
    assert.equal(pending?.amountMeaning, 'budget');
    assert.equal(result.stats.totalDonatedUsdCents, 7300);
  } finally {
    f.db.close();
  }
});

test('native payout metrics use actual card credit and keep unresolved conversion separate from gifts and costs', () => {
  const f = fixture();
  try {
    const at = new Date().toISOString();
    const sourceQuote = { centsPerSol: '9715', observedAt: at, source: 'fixture' };
    f.operations.recordClaim(
      {
        tokenId: f.token.id,
        signature: signature(300),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 1,
        valuationAt: at,
        slot: 300,
        confirmation: 'finalized',
      },
      actor,
    );
    const payment = f.operations.reservePayment(
      {
        tokenId: f.token.id,
        budgetCents: 7000,
        idempotencyKey: 'native-catalog-reserve',
      },
      actor,
    );
    f.operations.reserveNativeFunding(
      payment.id,
      {
        amountLamports: '600000000',
        maxNetworkFeeLamports: '100000',
        sourceQuote,
        cardId: 'private-native-card',
        slotNumber: 1,
        giftMaxUsdCents: 6500,
        conversionMaxUsdCents: 200,
        gasMaxUsdCents: 10,
      },
      actor,
    );
    f.operations.recordNativeFunding(
      payment.id,
      {
        invoiceId: 'private-native-invoice',
        depositAddress: bs58.encode(Buffer.alloc(32, 42)),
        signature: signature(301),
        amountLamports: '600000000',
        networkFeeLamports: '5000',
        sourceValueUsdCents: 5829,
        networkFeeCents: 1,
        sourceQuote,
        slotNumber: 1,
        cardId: 'private-native-card',
        confirmation: 'finalized',
        slot: 301,
      },
      actor,
    );
    f.operations.recordNativeCredit(
      payment.id,
      {
        invoiceId: 'private-native-invoice',
        activityId: 'private-native-credit',
        cardId: 'private-native-card',
        slotNumber: 1,
        creditedUsdCents: 5429,
        activityCreatedAt: at,
        source: 'coinbase_get_card_activity',
      },
      actor,
    );
    let result = f.catalog();
    assert.equal(result.stats.totalDonatedUsdCents, 0);
    assert.equal(result.stats.convertedUsdCents, 5429);
    assert.equal(result.stats.paymentCostsUsdCents, 1);
    assert.equal(result.stats.conversionPendingUsdCents, 400);
    assert.equal(result.tokens[0].conversionPendingUsdCents, 400);
    assert.equal(result.streamers[0].conversionPendingUsdCents, 400);
    assert.equal(result.stats.streamerPendingUsdCents, 7429);
    assert.equal(result.activity.find((event) => event.kind === 'Payout')?.amountUsdCents, 5429);
    f.operations.completePayment(
      payment.id,
      {
        spentUsdCents: 5000,
        kind: 'gift_sub',
        giftUnits: 10,
        paymentReference: 'private-native-purchase',
        completionAttested: true,
        idempotencyKey: 'native-catalog-complete',
      },
      actor,
    );
    result = f.catalog();
    assert.equal(result.stats.totalDonatedUsdCents, 5000);
    assert.equal(result.stats.cardResidualUsdCents, 429);
    assert.equal(result.stats.streamerPendingUsdCents, 2429);
    assert.equal(result.stats.conversionPendingUsdCents, 400);
    assert.equal(result.stats.paymentCostsUsdCents, 1);
    assert.equal(result.stats.heldUsdCents, 4429);
    assert.doesNotMatch(JSON.stringify(result), /private-native/);
  } finally {
    f.db.close();
  }
});

test('two tokens sharing one recipient retain distinct paid and awaiting-payout balances beyond the recent feed', async () => {
  const f = fixture();
  const previousFetch = globalThis.fetch;
  try {
    // Token A: 205 gifts at $73, each funded from $80 with $4.10 costs and $2.90 left.
    for (let i = 0; i < 205; i++) f.complete();
    f.operations.reservePayment(
      { tokenId: f.token.id, budgetCents: 10000, idempotencyKey: 'separate-pending-reservation' },
      actor,
    );
    // Token B shares the recipient, but has a different paid amount, card residual and costs.
    const second = f.register(2);
    const paid = f.fund(second.id, 6249);
    f.operations.completePayment(
      paid.id,
      {
        spentUsdCents: 5501,
        confirmationUrl: `https://www.twitch.tv/receipt/${paid.id}`,
        kind: 'gift_sub',
        giftUnits: 10,
        idempotencyKey: `complete-${paid.id}`,
      },
      actor,
    );
    f.fund(second.id, 4900);

    const result = f.catalog();
    const a = result.tokens.find((token) => token.id === f.token.id)!;
    const b = result.tokens.find((token) => token.id === second.id)!;
    assert.equal(a.streamerId, b.streamerId);
    assert.deepEqual(
      {
        paid: a.donatedUsdCents,
        pending: a.pendingUsdCents,
        available: a.availableUsdCents,
        reserved: a.reservedUsdCents,
        card: a.cardResidualUsdCents,
        costs: a.paymentCostsUsdCents,
        completed: a.completedPaymentCount,
        state: a.payoutStatus,
      },
      {
        paid: 1496500,
        pending: 59450,
        available: 8450,
        reserved: 10000,
        card: 41000,
        costs: 84050,
        completed: 205,
        state: 'reserved',
      },
    );
    assert.deepEqual(
      {
        paid: b.donatedUsdCents,
        pending: b.pendingUsdCents,
        available: b.availableUsdCents,
        reserved: b.reservedUsdCents,
        card: b.cardResidualUsdCents,
        costs: b.paymentCostsUsdCents,
        completed: b.completedPaymentCount,
        state: b.payoutStatus,
      },
      {
        paid: 5501,
        pending: 5828,
        available: 90,
        reserved: 4990,
        card: 748,
        costs: 4671,
        completed: 1,
        state: 'awaiting_threshold',
      },
    );
    assert.equal(result.streamers.length, 1);
    assert.equal(result.streamers[0].donatedUsdCents, 1502001);
    assert.equal(result.streamers[0].pendingUsdCents, 65278);
    assert.equal(result.stats.totalDonatedUsdCents, 1502001);
    assert.equal(result.stats.streamerPendingUsdCents, 65278);
    assert.equal(result.stats.streamerAllocatedUsdCents, 1656000);
    assert.equal(result.stats.paymentCostsUsdCents, 88721);
    assert.equal(result.stats.completedPaymentCount, 206);
    assert.equal(result.stats.pendingPaymentCount, 2);
    assert.equal(result.stats.claimCount, 207);
    assert.deepEqual(result.activitySummary, {
      totalCount: 622,
      returnedCount: 200,
      truncated: true,
    });
    assert.ok(
      result.activity
        .filter((event) => event.kind === 'Donation' && event.tokenId === a.id)
        .reduce((sum, event) => sum + (event.amountUsdCents ?? 0), 0) < 1496500,
    );

    const client = await import('../src/data.ts');
    globalThis.fetch = async () => Response.json(result);
    await client.refreshCatalog();
    assert.equal(client.tokenDonations(a.id), 14965);
    assert.equal(client.tokenDonations(b.id), 55.01);
    assert.equal(client.tokens.find((token) => token.id === b.id)?.pendingUsdCents, 5828);
    assert.equal(client.metricMoney(b.donatedUsdCents), '$55');
    assert.equal(client.metricMoney(b.pendingUsdCents), '$58');
    assert.equal(client.treasury.payoutPending, 652.78);
    assert.equal(client.totalDonations, 15020.01);
    assert.equal(f.catalog().tokens.find((token) => token.id === b.id)?.pendingUsdCents, 5828);
  } finally {
    globalThis.fetch = previousFetch;
    f.db.close();
  }
});

test('empty live ledger has zero historical activity and excludes owner-funded proof and testing budget', () => {
  const f = fixture();
  try {
    const result = f.catalog();
    assert.equal(result.stats.completedPaymentCount, 0);
    assert.equal(result.stats.totalDonatedUsdCents, 0);
    assert.equal(result.stats.totalClaimedUsdCents, 0);
    assert.equal(result.stats.streamerPendingUsdCents, 0);
    assert.equal(result.tokens[0].payoutStatus, 'awaiting_fees');
    assert.deepEqual(result.activity, []);
    assert.equal(result.activitySummary.truncated, false);
    assert.equal(result.stats.tokenCount, 1);
    assert.equal(result.stats.streamerCount, 1);
    assert.equal(result.stats.convertedUsdCents, 0);
  } finally {
    f.db.close();
  }
});

test('confirmed buyback and burn totals preserve reserve basis and separate network costs', () => {
  const f = fixture();
  try {
    f.complete();
    const mint = bs58.encode(Buffer.alloc(32, 50));
    f.operations.recordTreasuryReceipt(
      {
        id: 'buy-proof',
        tokenId: f.token.id,
        kind: 'Buyback',
        mint,
        signature: signature(10000),
        consumedLamports: '100000000',
        networkFeeLamports: '5000',
        amountUsdCents: 990,
        networkFeeUsdCents: 1,
        tokenBaseUnits: '1234567890123456789',
        tokenDecimals: 6,
        slot: 10000,
      },
      actor,
    );
    f.operations.recordTreasuryReceipt(
      {
        id: 'burn-proof',
        tokenId: f.token.id,
        kind: 'Burn',
        mint,
        signature: signature(10001),
        consumedLamports: '5000',
        networkFeeLamports: '5000',
        amountUsdCents: null,
        networkFeeUsdCents: 1,
        tokenBaseUnits: '1234567890123456789',
        tokenDecimals: 6,
        slot: 10001,
        parentBuyId: 'buy-proof',
      },
      actor,
    );
    const result = f.catalog();
    assert.equal(result.stats.buybackSpentUsdCents, 990);
    assert.equal(result.stats.buybackReserveUsdCents, f.operations.snapshot().totals.buybackCents);
    assert.equal(result.stats.buybackNetworkFeesUsdCents, 2);
    assert.equal(result.stats.paymentCostsUsdCents, 410);
    assert.equal(result.tokens[0].paymentCostsUsdCents, 410);
    assert.equal(result.stats.totalRecordedCostsUsdCents, 414);
    assert.equal(result.stats.burnedTokenBaseUnits, '1234567890123456789');
    assert.equal(result.stats.burnedTokenDecimals, 6);
    assert.equal(result.stats.buybackCount, 1);
    assert.equal(result.stats.burnCount, 1);
    const burn = result.activity.find((event) => event.kind === 'Burn');
    assert.equal(burn?.amountUsdCents, null, 'no invented USD value for burned units');
    assert.equal(burn?.tokenBaseUnits, '1234567890123456789');
    assert.equal(burn?.route, 'treasury');
  } finally {
    f.db.close();
  }
});

test('official platform fee reserves stay separate from streamer allocations and have no fake recipient', () => {
  const f = fixture();
  try {
    const platform = f.operations.registerPlatformToken(
      {
        name: 'Pog',
        symbol: 'POG',
        mint: bs58.encode(Buffer.alloc(32, 90)),
        creatorAddress: bs58.encode(Buffer.alloc(32, 91)),
        buybackBps: 2000,
        dedicatedCreatorVerified: true,
      },
      actor,
    );
    f.operations.recordClaim(
      {
        tokenId: platform.id,
        signature: signature(50000),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 3,
        valuationAt,
        slot: 50000,
        confirmation: 'finalized',
      },
      actor,
    );
    const result = f.catalog();
    assert.equal(result.stats.totalClaimedUsdCents, 10000);
    assert.equal(result.stats.streamerAllocatedUsdCents, 0);
    assert.equal(result.stats.streamerPendingUsdCents, 0);
    assert.equal(result.stats.buybackAllocatedUsdCents, 2000);
    assert.equal(result.stats.platformReserveUsdCents, 8000);
    assert.equal(result.stats.heldUsdCents, 10000);
    assert.equal(result.stats.tokenCount, 1, 'platform token does not invent a community token');
    const event = result.activity.find((event) => event.tokenId === platform.id);
    assert.equal(event?.route, 'treasury');
    assert.equal(event?.tokenName, 'Pog');
    assert.equal(event?.recipientId, undefined);
  } finally {
    f.db.close();
  }
});

test('public live observations require matching stable identity and an unexpired check schedule', () => {
  const f = fixture();
  const now = Date.parse('2026-09-16T12:00:00Z');
  const launches = {
    allConfirmedMetadata: () => [{ id: f.token.id, recipientId: 'twitch:123' }],
  } as Parameters<typeof publicCatalog>[1];
  const status = {
    platform: 'twitch' as const,
    providerId: 'twitch:123',
    username: 'same_streamer',
    status: 'live' as const,
    checkedAt: '2026-09-16T11:59:00Z',
    nextCheckAt: '2026-09-16T12:29:00Z',
    streamId: 'public-stream',
  };
  try {
    const read = (override = {}) =>
      publicCatalog(f.operations, launches, [], {
        now,
        streamerStatuses: [{ ...status, ...override }],
      }).streamers[0];
    assert.equal(read().liveStatus, 'live');
    assert.equal(read({ providerId: 'twitch:999' }).liveStatus, 'unknown');
    assert.equal(read({ username: 'renamed_streamer' }).liveStatus, 'unknown');
    assert.equal(read({ nextCheckAt: '2026-09-16T11:59:59Z' }).liveStatus, 'unknown');
    assert.equal(read({ checkedAt: '2026-09-17T12:00:00Z' }).liveStatus, 'unknown');
    assert.equal(read({ status: 'offline' }).liveStatus, 'offline');
    assert.equal('streamId' in read(), false);
  } finally {
    f.db.close();
  }
});

test('zero pending balance without a completed gift never reports a paid recipient', () => {
  const f = fixture();
  try {
    const snapshot = f.operations.snapshot();
    snapshot.tokens[0].balances.claimedCents = 10000;
    snapshot.tokens[0].balances.costCents = 8000;
    const result = publicCatalog(
      { snapshot: () => snapshot },
      { allConfirmedMetadata: () => [] },
      [],
    );
    assert.equal(result.tokens[0].payoutStatus, 'no_payout_due');
    assert.equal(result.streamers[0].payoutStatus, 'no_payout_due');
    assert.equal(result.tokens[0].completedPaymentCount, 0);
  } finally {
    f.db.close();
  }
});

test('a completed purchase without an invoice contributes to public paid totals and activity without exposing its private reference', () => {
  const f = fixture();
  try {
    const p = f.fund();
    f.operations.completePayment(
      p.id,
      {
        spentUsdCents: 7300,
        kind: 'gift_sub',
        giftUnits: 10,
        paymentReference: 'private-card-reference',
        completionAttested: true,
        idempotencyKey: 'without-invoice',
      },
      actor,
    );
    const c = f.catalog();
    const activity = c.activity.find((a) => a.id === p.id)!;
    assert.equal(activity.kind, 'Donation');
    assert.equal(activity.amountUsdCents, 7300);
    assert.equal(activity.status, 'Confirmed');
    assert.equal(activity.confirmationUrl, undefined);
    assert.equal(JSON.stringify(c).includes('private-card-reference'), false);
    assert.equal(f.operations.publicDonations()[0].recipientUsername, 'same_streamer');
  } finally {
    f.db.close();
  }
});
