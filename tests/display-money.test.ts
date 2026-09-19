import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdCents } from '../src/money.ts';

test('fee calculator parses entered cents exactly without floating point rounding', () => {
  assert.equal(parseUsdCents('1.01'), 101);
  assert.equal(parseUsdCents('0.29'), 29);
  assert.equal(parseUsdCents('1000000000.00'), 100000000000);
  assert.equal(parseUsdCents('0'), 0);
  assert.equal(parseUsdCents('1.2'), 120);
});
test('fee calculator rejects fractional cents and unsupported numeric formats', () => {
  for (const value of ['0.049', '1.005', '-1', '1e3', '', 'NaN', '1000000000.01', ' 1']) {
    assert.equal(parseUsdCents(value), null, value);
  }
});
