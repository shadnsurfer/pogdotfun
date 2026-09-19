import assert from 'node:assert/strict';
import test from 'node:test';
import { retryAfterSeconds } from '../server/retry-after.ts';

test('retry timing accepts seconds and HTTP dates, defaults invalid values, and keeps timers usable', () => {
  const now = Date.UTC(2026, 8, 16, 22);
  assert.equal(retryAfterSeconds('120', now), 120);
  assert.equal(retryAfterSeconds('Wed, 16 Sep 2026 22:02:00 GMT', now), 120);
  assert.equal(retryAfterSeconds(null, now), 30);
  assert.equal(retryAfterSeconds('not-a-date', now), 30);
  assert.equal(retryAfterSeconds('0', now), 1);
  assert.equal(retryAfterSeconds('Wed, 16 Sep 2026 21:00:00 GMT', now), 1);
  assert.equal(retryAfterSeconds('99999999999', now), 2_147_483);
});
