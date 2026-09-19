import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInitialBuySol } from '../src/launch-amount.ts';

test('an empty or zero optional SOL purchase becomes zero lamports', () => {
  for (const value of ['', '  ', '0', '0.000000000', ' 00.0 '])
    assert.equal(parseInitialBuySol(value), '0', value);
});

test('SOL purchases retain exact lamport precision without floating point rounding', () => {
  for (const [value, expected] of [
    ['0.000000001', '1'],
    ['0.100000001', '100000001'],
    [' 001.2300 ', '1230000000'],
    ['.5', '500000000'],
    ['1.', '1000000000'],
    ['9007199.254740991', '9007199254740991'],
  ])
    assert.equal(parseInitialBuySol(value), expected, value);
});

test('invalid SOL purchase notation is rejected before transaction preparation', () => {
  for (const value of ['-1', '+1', '1e-9', 'NaN', 'Infinity', '1,000', '.', '0.0000000001'])
    assert.throws(() => parseInitialBuySol(value), /SOL.*9 decimal places/i, value);
});

test('SOL purchases exceeding safe lamport arithmetic are rejected', () => {
  for (const value of ['9007199.254740992', '9007200', '999999999999999999999999999'])
    assert.throws(() => parseInitialBuySol(value), /too large/i, value);
});
