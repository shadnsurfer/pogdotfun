import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateClaimedFees, createPayout, transitionPayout } from '../server/fee-engine.ts';

test('allocates 80/20 from claimed fees without losing base units to rounding', () => {
  assert.deepEqual(allocateClaimedFees(100n), {
    claimedBaseUnits: 100n,
    streamerBaseUnits: 80n,
    buybackBaseUnits: 20n,
  });
  assert.deepEqual(allocateClaimedFees(7n), {
    claimedBaseUnits: 7n,
    streamerBaseUnits: 6n,
    buybackBaseUnits: 1n,
  });
  assert.deepEqual(allocateClaimedFees(1n), {
    claimedBaseUnits: 1n,
    streamerBaseUnits: 1n,
    buybackBaseUnits: 0n,
  });
});

test('fee allocation remains exact above Number.MAX_SAFE_INTEGER', () => {
  const result = allocateClaimedFees(100000000000000000003n);
  assert.equal(result.streamerBaseUnits, 80000000000000000003n);
  assert.equal(result.buybackBaseUnits, 20000000000000000000n);
  assert.equal(result.streamerBaseUnits + result.buybackBaseUnits, result.claimedBaseUnits);
});

test('fee allocation rejects non-positive and non-bigint claimed amounts', () => {
  for (const invalid of [0n, -1n, 100, '100', NaN, null]) {
    assert.throws(() => allocateClaimedFees(invalid as bigint));
  }
});

function submittedPayout() {
  let payout = createPayout({ id: 'payout-1', amountMinor: 2500n, currency: 'USD' });
  payout = transitionPayout(payout, {
    id: 'event-1',
    payoutId: 'payout-1',
    type: 'claim_confirmed',
  });
  payout = transitionPayout(payout, {
    id: 'event-2',
    payoutId: 'payout-1',
    type: 'conversion_settled',
  });
  return transitionPayout(payout, {
    id: 'event-3',
    payoutId: 'payout-1',
    type: 'payout_submitted',
  });
}

test('submission and stream alerts never count as a settled payout', () => {
  const submitted = submittedPayout();
  assert.equal(submitted.status, 'submitted');
  const afterAlert = transitionPayout(submitted, {
    id: 'alert-1',
    payoutId: 'payout-1',
    type: 'alert_observed',
  });
  assert.equal(afterAlert.status, 'submitted');
  assert.equal(afterAlert.settlementReference, undefined);
});

test('verified matching settlement advances once and duplicate delivery is idempotent', () => {
  const submitted = submittedPayout();
  const settlement = {
    id: 'settlement-1',
    payoutId: 'payout-1',
    type: 'payout_settled' as const,
    amountMinor: 2500n,
    currency: 'USD',
    providerReference: 'provider-payment-1',
  };
  const settled = transitionPayout(submitted, settlement);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.settlementReference, 'provider-payment-1');
  assert.strictEqual(transitionPayout(settled, settlement), settled);
  assert.equal(submitted.status, 'submitted', 'transition does not mutate its input');
});

test('illegal transition, conflicting duplicate and mismatched settlement are rejected', () => {
  const pending = createPayout({ id: 'payout-1', amountMinor: 2500n, currency: 'USD' });
  const settlement = {
    id: 'settlement-1',
    payoutId: 'payout-1',
    type: 'payout_settled' as const,
    amountMinor: 2500n,
    currency: 'USD',
    providerReference: 'provider-payment-1',
  };
  assert.throws(() => transitionPayout(pending, settlement));
  const submitted = submittedPayout();
  assert.throws(() => transitionPayout(submitted, { ...settlement, amountMinor: 2400n }));
  assert.throws(() => transitionPayout(submitted, { ...settlement, currency: 'CAD' }));
  assert.throws(() => transitionPayout(submitted, { ...settlement, payoutId: 'someone-else' }));
  assert.throws(() => transitionPayout(submitted, { ...settlement, providerReference: '' }));
  const settled = transitionPayout(submitted, settlement);
  assert.throws(() => transitionPayout(settled, { ...settlement, providerReference: 'changed' }));
  assert.throws(() =>
    transitionPayout(settled, { id: 'failed', payoutId: 'payout-1', type: 'payout_failed' }),
  );
});

test('failed payouts require reconciliation and cannot become settled from an alert', () => {
  const failed = transitionPayout(submittedPayout(), {
    id: 'fail-1',
    payoutId: 'payout-1',
    type: 'payout_failed',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(
    transitionPayout(failed, { id: 'alert', payoutId: 'payout-1', type: 'alert_observed' }).status,
    'failed',
  );
  assert.throws(() =>
    transitionPayout(failed, { id: 'resubmit', payoutId: 'payout-1', type: 'payout_submitted' }),
  );
});

test('payout creation rejects invalid amounts, currency and identifiers', () => {
  assert.throws(() => createPayout({ id: '', amountMinor: 2500n, currency: 'USD' }));
  assert.throws(() => createPayout({ id: 'a', amountMinor: 0n, currency: 'USD' }));
  assert.throws(() =>
    createPayout({ id: 'a', amountMinor: 25 as unknown as bigint, currency: 'USD' }),
  );
  assert.throws(() => createPayout({ id: 'a', amountMinor: 2500n, currency: 'usd' }));
});
