import assert from 'node:assert/strict';
import test from 'node:test';
import * as data from '../src/data.ts';

test('completed creator gifts remain sent when the next payout is in progress', () => {
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 4751,
      completedPaymentCount: 1,
      pendingUsdCents: 30052,
      pendingPaymentCount: 1,
      payoutStatus: 'in_progress',
    }),
    'Sent from creator fees: $47.51 · Next payout: Gift in progress',
  );
  assert.equal(
    data.payoutStatusLabel('in_progress'),
    'Gift in progress',
    'individual payment labels stay specific to that payment',
  );
});

test('unused card credit and accumulating balances cannot erase completed gifts', () => {
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 4751,
      completedPaymentCount: 1,
      pendingUsdCents: 735,
      payoutStatus: 'accumulating',
    }),
    'Sent from creator fees: $47.51 · Next payout: Accumulating funds',
  );
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 4751,
      completedPaymentCount: 1,
      pendingUsdCents: 0,
      payoutStatus: 'paid',
    }),
    'Sent from creator fees: $47.51',
  );
});

test('recipient history includes manual gifts without calling them creator-fee payments', () => {
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 0,
      totalGiftSpendingUsdCents: 4751,
      manualGiftCount: 1,
      pendingUsdCents: 4409,
      payoutStatus: 'accumulating',
    }),
    'Gifts sent: $47.51 · Next creator-fee payout: Accumulating funds',
  );
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 4751,
      totalGiftSpendingUsdCents: 11883,
      manualGiftCount: 2,
      payoutStatus: 'paid',
    }),
    'Gifts sent: $118.83',
  );
});

test('claims and card funding without completed gifts remain pending', () => {
  for (const payoutStatus of ['funding_pending', 'ready', 'in_progress', 'uncertain']) {
    assert.equal(
      data.payoutProgressLabel({
        donatedUsdCents: 0,
        completedPaymentCount: 0,
        pendingUsdCents: 5500,
        payoutStatus,
      }),
      data.payoutStatusLabel(payoutStatus),
    );
  }
  assert.equal(data.payoutProgressLabel({}), 'Status unavailable');
});

test('a manual receipt count with an unavailable total does not invent creator-funded spending', () => {
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 0,
      manualGiftCount: 1,
      payoutStatus: 'awaiting_fees',
    }),
    'Gifts sent',
  );
  assert.equal(
    data.payoutProgressLabel({
      donatedUsdCents: 4751,
      completedPaymentCount: 1,
      manualGiftCount: 1,
      payoutStatus: 'paid',
    }),
    'Gifts sent',
  );
});
