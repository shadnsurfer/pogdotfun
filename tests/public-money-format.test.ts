import assert from 'node:assert/strict';
import test from 'node:test';
import * as data from '../src/data.ts';
const { decimalMoney, displayMoney, eventAmount, metricMoney, money, wholePercent } = data;

test('public dollar summaries round only their presentation and preserve positive amounts below one dollar', () => {
  for (const [cents, expected] of [
    [0, '$0'],
    [1, '<$1'],
    [49, '<$1'],
    [99, '<$1'],
    [100, '$1'],
    [2449, '$24'],
    [2450, '$25'],
    [2499, '$25'],
  ] as const) {
    assert.equal(metricMoney(cents), expected);
    assert.equal(displayMoney(cents / 100), expected);
    assert.equal(money(cents / 100), expected);
  }
  assert.equal(money(1500, true), '$2K');
  assert.equal(money(1500000, true), '$2M');
  assert.equal(money(0.49, true), '<$1');
  assert.equal(displayMoney(undefined), '—');
  assert.equal(displayMoney(null), '—');
  assert.equal(displayMoney(Number.NaN), '—');
  assert.equal(metricMoney(undefined), '—');
  assert.equal(metricMoney(-1), '—');
  assert.equal(data.tokenDonations('unknown-token'), null);
  assert.equal(data.streamerDonations('unknown-streamer'), null);
});

test('feed dollars use whole presentation while exact receipt values retain cents and burn units retain precision', () => {
  const event = {
    id: 'gift',
    tokenId: 'community',
    kind: 'Donation' as const,
    amount: 24.99,
    status: 'Confirmed' as const,
    age: 'today',
    date: '2026-09-16T12:00:00Z',
    reference: 'gift',
  };
  assert.equal(eventAmount(event), '$25');
  assert.equal(event.amount, 24.99);
  assert.equal(decimalMoney(event.amount), '$24.99');
  assert.equal(decimalMoney(0.49), '$0.49');
  assert.equal(decimalMoney(null), '—');
  assert.equal(
    eventAmount({ ...event, kind: 'Burn', tokenBaseUnits: '123456789', tokenDecimals: 6 }),
    '123.456789 POG',
  );
});

test('whole percentage labels retain direction without decimal or negative-zero display', () => {
  assert.equal(wholePercent(12.6, true), '+13%');
  assert.equal(wholePercent(-12.6, true), '-13%');
  assert.equal(wholePercent(12.6), '13%');
  assert.equal(wholePercent(-0.1, true), '0%');
  assert.equal(wholePercent(null, true), '—');
});
