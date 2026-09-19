import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { createOperations, paymentSpendableUsdCents } from '../server/operations.ts';

const actor = 'native-payout-test';
const address = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 1)));
const signature = (n: number) =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i === 63 ? n : 1)));
function fixture() {
  const db = new DatabaseSync(':memory:');
  const ops = createOperations(db, { streamerBps: 8000 });
  const at = new Date().toISOString();
  const token = ops.registerToken(
    {
      name: 'Creator community',
      symbol: 'COMM',
      mint: address(1),
      creatorAddress: address(2),
      chain: 'solana',
      launchpad: 'pump',
      recipientPlatform: 'twitch',
      recipientUsername: 'streamer',
      recipientVerified: true,
      dedicatedCreatorVerified: true,
    },
    actor,
  );
  ops.recordClaim(
    {
      tokenId: token.id,
      signature: signature(1),
      amountLamports: '1000000000',
      grossUsdCents: 10000,
      networkFeeCents: 1,
      valuationAt: at,
      slot: 10,
      confirmation: 'finalized',
    },
    actor,
  );
  const payment = ops.reservePayment(
    { tokenId: token.id, budgetCents: 7000, idempotencyKey: 'reserve' },
    actor,
  );
  const plan = {
    amountLamports: '600000000',
    maxNetworkFeeLamports: '100000',
    sourceQuote: { centsPerSol: '9715', observedAt: at, source: 'fixture' },
    cardId: 'operating-card',
    slotNumber: 1,
    giftMaxUsdCents: 6500,
    conversionMaxUsdCents: 200,
    gasMaxUsdCents: 10,
  };
  const funding = {
    invoiceId: 'native-invoice',
    depositAddress: address(3),
    signature: signature(2),
    amountLamports: plan.amountLamports,
    networkFeeLamports: '5000',
    sourceValueUsdCents: 5829,
    networkFeeCents: 1,
    sourceQuote: plan.sourceQuote,
    slotNumber: 1,
    cardId: plan.cardId,
    confirmation: 'finalized' as const,
    slot: 20,
  };
  const credit = {
    invoiceId: funding.invoiceId,
    activityId: 'native-activity',
    cardId: plan.cardId,
    slotNumber: 1,
    creditedUsdCents: 5429,
    activityCreatedAt: at,
    source: 'coinbase_get_card_activity' as const,
  };
  const reserve = () => ops.reserveNativeFunding(payment.id, plan, actor);
  const fund = () => ops.recordNativeFunding(payment.id, funding, actor);
  const creditCard = () => ops.recordNativeCredit(payment.id, credit, actor);
  return { db, ops, token, payment, plan, funding, credit, reserve, fund, creditCard };
}

test('native funding preserves actual credit, unresolved conversion and the original token residual', () => {
  const f = fixture();
  try {
    f.reserve();
    const funded = f.fund();
    assert.equal(funded.funding?.sourceCostBasisCents, 6000);
    assert.equal(funded.funding?.networkSourceCostBasisCents, 0);
    assert.equal(funded.funding?.fxAdjustmentCents, -170);
    const ready = f.creditCard();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.funding?.credit?.creditedUsdCents, 5429);
    assert.equal(ready.funding?.credit?.providerFeeCents, null);
    assert.equal(ready.funding?.credit?.providerFeeBooked, false);
    let snapshot = f.ops.snapshot();
    assert.equal(snapshot.totals.costCents, 1, 'source-to-credit difference is not a provider fee');
    assert.equal(snapshot.totals.conversionPendingCents, 400);
    assert.equal(snapshot.totals.reservedCents, 6429, 'actual card credit plus unfunded basis');
    assert.equal(snapshot.tokens[0].assetBalances.streamerAvailableLamports, '199995000');
    assert.equal(snapshot.tokens[0].assetBalances.streamerAvailableCostBasisCents, 2000);
    f.ops.startPayment(f.payment.id, { idempotencyKey: 'start' }, actor);
    const done = f.ops.completePayment(
      f.payment.id,
      {
        spentUsdCents: 5000,
        kind: 'gift_sub',
        giftUnits: 12,
        paymentReference: 'twitch-native-invoice',
        completionAttested: true,
        idempotencyKey: 'complete',
      },
      actor,
    );
    assert.equal(done.completion?.verification, 'operator_confirmed');
    snapshot = f.ops.snapshot();
    assert.equal(snapshot.totals.spentCents, 5000);
    assert.equal(snapshot.totals.cardResidualCents, 429);
    assert.equal(snapshot.totals.availableCents, 2000);
    assert.equal(snapshot.totals.reservedCents, 0);
    assert.equal(snapshot.totals.buybackCents, 2000);
    assert.equal(snapshot.totals.costCents, 1);
    assert.equal(snapshot.totals.conversionPendingCents, 400);
    assert.equal(
      snapshot.totals.claimedCents + snapshot.totals.fxAdjustmentCents,
      snapshot.totals.availableCents +
        snapshot.totals.spentCents +
        snapshot.totals.cardResidualCents +
        snapshot.totals.costCents +
        snapshot.totals.buybackCents +
        snapshot.totals.conversionPendingCents,
    );
    assert.equal(
      f.db.prepare('SELECT SUM(amount_cents) AS total FROM ops_journal').get()!.total,
      0,
    );
    assert.equal(f.ops.publicDonations().length, 1);
  } finally {
    f.db.close();
  }
});

test('native source intent excludes locked SOL and basis before any invoice and blocks legacy substitution', () => {
  const f = fixture();
  try {
    const reserved = f.reserve();
    assert.equal(reserved.status, 'funding_pending');
    assert.equal(reserved.nativeFundingIntent?.amountLamports, '600000000');
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableLamports, '199900000');
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableCostBasisCents, 1999);
    assert.equal(f.ops.snapshot().totals.availableCents, 1000);
    assert.equal(f.ops.snapshot().totals.reservedCents, 7000);
    assert.deepEqual(f.reserve(), reserved);
    assert.throws(
      () =>
        f.ops.reserveNativeFunding(f.payment.id, { ...f.plan, amountLamports: '610000000' }, actor),
      /conflict|immutable/i,
    );
    assert.throws(
      () =>
        f.ops.cancelPayment(f.payment.id, { reason: 'cancel', idempotencyKey: 'cancel' }, actor),
      /unfunded|native|pending/i,
    );
    assert.throws(
      () =>
        f.ops.recordFunding(
          f.payment.id,
          { ...f.funding, amountUsdCents: 5829, valuationAt: f.plan.sourceQuote.observedAt },
          actor,
        ),
      /native/i,
    );
    assert.throws(
      () => f.db.prepare('UPDATE ops_native_funding_intents SET payload=payload').run(),
      /immutable/i,
    );
    assert.throws(() => f.db.prepare('DELETE FROM ops_native_funding_intents').run(), /immutable/i);
  } finally {
    f.db.close();
  }
});

test('new claims do not reprice an already reserved native principal or silently enlarge its budget', () => {
  const f = fixture();
  try {
    f.reserve();
    f.ops.recordClaim(
      {
        tokenId: f.token.id,
        signature: signature(8),
        amountLamports: '1000000000',
        grossUsdCents: 20000,
        networkFeeCents: 1,
        valuationAt: f.plan.sourceQuote.observedAt,
        slot: 11,
        confirmation: 'finalized',
      },
      actor,
    );
    assert.equal(
      f.fund().funding?.sourceCostBasisCents,
      6000,
      'reservation retains original basis despite new claims',
    );
    f.creditCard();
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableCostBasisCents, 18000);
    assert.equal(f.ops.snapshot().payments[0].budgetCents, 7000);
  } finally {
    f.db.close();
  }
});

test('native proof replay survives restart and conflicting amounts or evidence ownership cannot book twice', () => {
  const f = fixture();
  try {
    f.reserve();
    f.fund();
    f.creditCard();
    const before = f.ops.snapshot();
    const reopened = createOperations(f.db, { streamerBps: 8000 });
    assert.deepEqual(
      reopened.recordNativeFunding(f.payment.id, f.funding, actor),
      before.payments[0] && f.ops.recordNativeFunding(f.payment.id, f.funding, actor),
    );
    reopened.recordNativeCredit(f.payment.id, f.credit, actor);
    assert.deepEqual(reopened.snapshot(), before);
    assert.throws(
      () =>
        reopened.recordNativeCredit(f.payment.id, { ...f.credit, creditedUsdCents: 5430 }, actor),
      /conflict/i,
    );
    assert.throws(
      () =>
        reopened.recordNativeFunding(
          f.payment.id,
          { ...f.funding, invoiceId: 'replacement' },
          actor,
        ),
      /conflict/i,
    );
    assert.throws(
      () =>
        reopened.confirmFunding(
          f.payment.id,
          {
            creditedUsdCents: 5429,
            providerFeeCents: 400,
            reference: 'fake',
            evidenceUrl: 'https://example.test',
            idempotencyKey: 'fake-credit',
          },
          actor,
        ),
      /native/i,
    );
    assert.deepEqual(reopened.snapshot(), before);
  } finally {
    f.db.close();
  }
});

test('actual net below fifty stays held and an increased net is not fabricated fee income', () => {
  for (const amount of [4999, 6800]) {
    const f = fixture();
    try {
      f.reserve();
      f.fund();
      const credited = f.ops.recordNativeCredit(
        f.payment.id,
        { ...f.credit, creditedUsdCents: amount },
        actor,
      );
      assert.equal(credited.status, amount < 5000 ? 'awaiting_threshold' : 'ready');
      assert.equal(f.ops.snapshot().totals.conversionPendingCents, 5829 - amount);
      assert.equal(f.ops.snapshot().totals.costCents, 1);
      assert.equal(f.ops.snapshot().totals.claimedCents, 10000);
      assert.throws(
        () =>
          f.ops.completePayment(
            f.payment.id,
            {
              spentUsdCents: amount < 5000 ? amount : 6600,
              kind: 'gift_sub',
              paymentReference: 'over-limit',
              completionAttested: true,
              idempotencyKey: 'bad-complete',
            },
            actor,
          ),
        amount < 5000 ? /50/ : /limit|ceiling|allowance|budget/i,
      );
      assert.equal(f.ops.publicDonations().length, 0);
    } finally {
      f.db.close();
    }
  }
});

test('native booking rejects mismatched evidence without changing balances or releasing source reservation', () => {
  const f = fixture();
  try {
    f.reserve();
    const before = f.ops.snapshot();
    for (const patch of [
      { amountLamports: '610000000' },
      { cardId: 'other' },
      { slotNumber: 2 },
      { sourceValueUsdCents: 6000 },
      { networkFeeLamports: '100001' },
      { confirmation: 'confirmed' },
    ]) {
      assert.throws(() =>
        f.ops.recordNativeFunding(
          f.payment.id,
          { ...f.funding, ...patch } as typeof f.funding,
          actor,
        ),
      );
      assert.deepEqual(f.ops.snapshot(), before);
    }
    f.fund();
    const afterFunding = f.ops.snapshot();
    for (const patch of [
      { invoiceId: 'other' },
      { slotNumber: 2 },
      { cardId: 'other' },
      { source: 'operator_reported' },
      { activityCreatedAt: '2099-01-01T00:00:00.000Z' },
    ]) {
      assert.throws(() =>
        f.ops.recordNativeCredit(f.payment.id, { ...f.credit, ...patch } as typeof f.credit, actor),
      );
      assert.deepEqual(f.ops.snapshot(), afterFunding);
    }
  } finally {
    f.db.close();
  }
});

test('a failed atomic credit commit cannot leave money or evidence half booked', () => {
  const f = fixture();
  try {
    f.reserve();
    f.fund();
    const before = f.ops.snapshot();
    f.db.exec(
      "CREATE TRIGGER fail_native_credit BEFORE INSERT ON ops_audit WHEN NEW.action='native_card_credit_confirmed' BEGIN SELECT RAISE(ABORT,'injected crash'); END;",
    );
    assert.throws(() => f.creditCard(), /injected crash/);
    assert.deepEqual(f.ops.snapshot(), before);
    f.db.exec('DROP TRIGGER fail_native_credit');
    f.creditCard();
    assert.equal(f.ops.snapshot().totals.conversionPendingCents, 400);
  } finally {
    f.db.close();
  }
});

test('a finalized failed native transfer uses pinned gas basis and cannot renew the original reservation', () => {
  const f = fixture();
  try {
    f.reserve();
    f.ops.recordClaim(
      {
        tokenId: f.token.id,
        signature: signature(8),
        amountLamports: '1000000000',
        grossUsdCents: 100000,
        networkFeeCents: 1,
        valuationAt: f.plan.sourceQuote.observedAt,
        slot: 11,
        confirmation: 'finalized',
      },
      actor,
    );
    const input = {
      signature: f.funding.signature,
      networkFeeLamports: '100000',
      networkFeeCents: 1,
      valuationAt: f.plan.sourceQuote.observedAt,
      confirmation: 'finalized_failure',
      idempotencyKey: 'failed-native',
    };
    const failed = f.ops.resolveFailedFunding(f.payment.id, input, actor);
    assert.equal(failed.status, 'cancelled');
    assert.equal(
      failed.failedFunding?.sourceCostBasisCents,
      1,
      'gas keeps the original reservation basis, not the later claim price',
    );
    assert.equal(failed.failedFunding?.releasedCents, 6999);
    assert.equal(f.ops.snapshot().totals.costCents, 1);
    assert.equal(f.ops.snapshot().totals.availableCents, 87999);
    assert.equal(f.ops.snapshot().totals.reservedCents, 0);
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableLamports, '1599900000');
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableCostBasisCents, 87999);
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.buybackLamports, '400000000');
    const before = f.ops.snapshot();
    assert.deepEqual(f.ops.resolveFailedFunding(f.payment.id, input, actor), failed);
    const reopened = createOperations(f.db, { streamerBps: 8000 });
    assert.deepEqual(
      reopened.resolveFailedFunding(
        f.payment.id,
        { ...input, idempotencyKey: 'native-failure-replay-new-request' },
        actor,
      ),
      failed,
    );
    assert.throws(() => f.reserve(), /failed|cancel|resolved/i);
    assert.throws(() => f.fund(), /awaiting|original|failed/i);
    assert.deepEqual(f.ops.snapshot(), before);
    assert.equal(f.ops.publicDonations().length, 0);
  } finally {
    f.db.close();
  }
});

test('same-invoice authenticated credit does not rely on provider activity creation time for ownership', () => {
  const f = fixture();
  try {
    f.reserve();
    f.fund();
    const actual = f.ops.recordNativeCredit(
      f.payment.id,
      { ...f.credit, activityCreatedAt: '2020-01-01T00:00:00.000Z' },
      actor,
    );
    assert.equal(actual.status, 'ready');
    assert.equal(actual.funding?.credit?.creditedUsdCents, 5429);
  } finally {
    f.db.close();
  }
});

test('native source locks isolate concurrent reservations and cannot borrow buyback or another token assets', () => {
  const f = fixture();
  try {
    f.ops.recordClaim(
      {
        tokenId: f.token.id,
        signature: signature(8),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 1,
        valuationAt: f.plan.sourceQuote.observedAt,
        slot: 11,
        confirmation: 'finalized',
      },
      actor,
    );
    const second = f.ops.reservePayment(
      { tokenId: f.token.id, budgetCents: 7000, idempotencyKey: 'reserve-second' },
      actor,
    );
    f.reserve();
    f.ops.reserveNativeFunding(second.id, f.plan, actor);
    const assets = f.ops.snapshot().tokens[0].assetBalances;
    assert.equal(assets.streamerReservedLamports, '1200200000');
    assert.equal(assets.streamerAvailableLamports, '399800000');
    assert.equal(assets.buybackLamports, '400000000');
    const other = f.ops.registerToken(
      {
        name: 'Other creator',
        symbol: 'OTHER',
        mint: address(10),
        creatorAddress: address(11),
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: 'other_streamer',
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      actor,
    );
    f.ops.recordClaim(
      {
        tokenId: other.id,
        signature: signature(10),
        amountLamports: '100000000',
        grossUsdCents: 10000,
        networkFeeCents: 1,
        valuationAt: f.plan.sourceQuote.observedAt,
        slot: 12,
        confirmation: 'finalized',
      },
      actor,
    );
    const otherPayment = f.ops.reservePayment(
      { tokenId: other.id, budgetCents: 7000, idempotencyKey: 'reserve-other' },
      actor,
    );
    const before = f.ops.snapshot();
    assert.throws(
      () => f.ops.reserveNativeFunding(otherPayment.id, f.plan, actor),
      /unreserved streamer SOL/,
    );
    assert.deepEqual(f.ops.snapshot(), before);
    f.fund();
    f.creditCard();
    f.ops.recordNativeFunding(
      second.id,
      { ...f.funding, invoiceId: 'second-native-invoice', signature: signature(12) },
      actor,
    );
    const beforeDuplicate = f.ops.snapshot();
    assert.throws(
      () =>
        f.ops.recordNativeCredit(
          second.id,
          { ...f.credit, invoiceId: 'second-native-invoice' },
          actor,
        ),
      /assigned/,
    );
    assert.deepEqual(f.ops.snapshot(), beforeDuplicate);
    f.ops.recordNativeCredit(
      second.id,
      { ...f.credit, invoiceId: 'second-native-invoice', activityId: 'second-activity' },
      actor,
    );
    assert.equal(f.ops.snapshot().totals.conversionPendingCents, 800);
    assert.equal(f.ops.snapshot().tokens[0].assetBalances.streamerAvailableLamports, '399990000');
  } finally {
    f.db.close();
  }
});

test('duplicate native invoice or signature and a failed funding commit cannot partially spend a source', () => {
  const f = fixture();
  try {
    f.ops.recordClaim(
      {
        tokenId: f.token.id,
        signature: signature(8),
        amountLamports: '1000000000',
        grossUsdCents: 10000,
        networkFeeCents: 1,
        valuationAt: f.plan.sourceQuote.observedAt,
        slot: 11,
        confirmation: 'finalized',
      },
      actor,
    );
    const second = f.ops.reservePayment(
      { tokenId: f.token.id, budgetCents: 7000, idempotencyKey: 'reserve-second' },
      actor,
    );
    f.reserve();
    f.ops.reserveNativeFunding(second.id, f.plan, actor);
    f.fund();
    const before = f.ops.snapshot();
    for (const patch of [{ signature: signature(12) }, { invoiceId: 'second-native-invoice' }]) {
      assert.throws(
        () =>
          f.ops.recordNativeFunding(
            second.id,
            { ...f.funding, ...patch } as typeof f.funding,
            actor,
          ),
        /assigned/,
      );
      assert.deepEqual(f.ops.snapshot(), before);
    }
    f.db.exec(
      "CREATE TRIGGER fail_native_funding BEFORE INSERT ON ops_audit WHEN NEW.action='native_funding_recorded' BEGIN SELECT RAISE(ABORT,'injected funding crash'); END;",
    );
    const secondProof = {
      ...f.funding,
      invoiceId: 'second-native-invoice',
      signature: signature(12),
    };
    assert.throws(
      () => f.ops.recordNativeFunding(second.id, secondProof, actor),
      /injected funding crash/,
    );
    assert.deepEqual(f.ops.snapshot(), before);
    f.db.exec('DROP TRIGGER fail_native_funding');
    f.ops.recordNativeFunding(second.id, secondProof, actor);
    f.creditCard();
    for (const table of ['ops_native_funding_proofs', 'ops_native_credit_proofs']) {
      assert.throws(() => f.db.exec(`UPDATE ${table} SET payload=payload`), /immutable/);
      assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
    }
  } finally {
    f.db.close();
  }
});

test('verified native gas overrun is recorded as incurred cost without granting purchase authority', () => {
  for (const failure of [false, true]) {
    const f = fixture();
    try {
      f.reserve();
      const gas = { networkFeeLamports: '2000000', networkFeeCents: 20 };
      if (failure) {
        const failed = f.ops.resolveFailedFunding(
          f.payment.id,
          {
            ...gas,
            signature: f.funding.signature,
            valuationAt: f.plan.sourceQuote.observedAt,
            confirmation: 'finalized_failure',
            idempotencyKey: 'native-failure-overrun',
          },
          actor,
          { verifiedOverrun: true },
        );
        assert.equal(failed.status, 'cancelled');
        assert.equal(failed.failedFunding?.costOverrun, true);
        assert.equal(failed.failedFunding?.sourceCostBasisCents, 20);
        assert.equal(f.ops.snapshot().totals.availableCents, 7980);
        assert.throws(() => f.reserve(), /resolved|failed|cancel/);
      } else {
        const actual = { ...f.funding, ...gas };
        const funded = f.ops.recordNativeFunding(f.payment.id, actual, actor, {
          verifiedOverrun: true,
        });
        assert.equal(funded.status, 'uncertain');
        assert.equal(funded.funding?.native?.costOverrun, true);
        assert.equal(funded.funding?.networkSourceCostBasisCents, 20);
        const credited = f.creditCard();
        assert.equal(credited.status, 'uncertain');
        assert.equal(paymentSpendableUsdCents(credited), 0);
        assert.throws(
          () =>
            f.ops.completePayment(
              f.payment.id,
              {
                spentUsdCents: 5000,
                kind: 'gift_sub',
                paymentReference: 'overrun-purchase',
                completionAttested: true,
                idempotencyKey: 'overrun-complete',
              },
              actor,
            ),
          /allowance/,
        );
        const before = f.ops.snapshot();
        f.ops.recordNativeFunding(f.payment.id, actual, actor, { verifiedOverrun: true });
        assert.deepEqual(f.ops.snapshot(), before);
      }
      assert.equal(f.ops.snapshot().totals.costCents, 20);
      assert.equal(f.ops.snapshot().tokens[0].assetBalances.fundingGasLamports, '2000000');
      assert.equal(f.ops.snapshot().tokens[0].assetBalances.buybackLamports, '200000000');
      assert.equal(
        f.db.prepare('SELECT SUM(amount_cents) AS total FROM ops_journal').get()!.total,
        0,
      );
      assert.equal(f.ops.publicDonations().length, 0);
    } finally {
      f.db.close();
    }
  }
});

test('reconciling an attested native gift below fifty preserves the exact unspent credit and creator allocations', () => {
  const f = fixture();
  try {
    f.reserve();
    f.fund();
    f.creditCard();
    const before = f.ops.snapshot();
    const done = f.ops.completePayment(
      f.payment.id,
      {
        spentUsdCents: 4751,
        kind: 'gift_sub',
        giftUnits: 10,
        paymentReference: 'native-receipt-real-cost',
        completionAttested: true,
        idempotencyKey: 'native-actual-spend',
      },
      actor,
    );
    assert.equal(done.status, 'completed');
    const after = f.ops.snapshot();
    assert.equal(after.totals.spentCents, 4751);
    assert.equal(after.totals.cardResidualCents, 678);
    assert.equal(after.totals.reservedCents, 0);
    assert.equal(after.totals.buybackCents, before.totals.buybackCents);
    assert.equal(after.totals.conversionPendingCents, before.totals.conversionPendingCents);
    assert.equal(
      after.tokens[0].assetBalances.streamerAvailableLamports,
      before.tokens[0].assetBalances.streamerAvailableLamports,
    );
    assert.equal(f.ops.publicDonations()[0].spentUsdCents, 4751);
    assert.equal(
      f.db.prepare('SELECT SUM(amount_cents) AS total FROM ops_journal').get()!.total,
      0,
    );
  } finally {
    f.db.close();
  }
});
