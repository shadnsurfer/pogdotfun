import assert from 'node:assert/strict';
import test from 'node:test';
import { startCatalogPolling } from '../src/catalog-polling.ts';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('visible polling accelerates warming data and serializes slow reads without a backlog', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let interval = 1000;
  let release: (() => void) | undefined;
  const polling = startCatalogPolling({
    visible: () => true,
    delay: () => interval,
    refresh: async () => {
      calls++;
      if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
    },
  });
  await flush();
  assert.equal(calls, 1, 'initial catalog does not wait for wallet config or a timer');
  context.mock.timers.tick(999);
  assert.equal(calls, 1);
  context.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  for (let i = 0; i < 10; i++) polling.wake();
  context.mock.timers.tick(30000);
  await flush();
  assert.equal(calls, 2, 'focus and timers must not overlap a slow catalog read');
  interval = 5000;
  release!();
  await flush();
  context.mock.timers.tick(4999);
  assert.equal(calls, 2);
  context.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 3);
  polling.stop();
  context.mock.timers.tick(30000);
  assert.equal(calls, 3);
});

test('hidden pages suspend polling; visibility resumes immediately; cleanup cannot resurrect timers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let visible = true;
  let calls = 0;
  let release: (() => void) | undefined;
  const polling = startCatalogPolling({
    visible: () => visible,
    delay: () => 5000,
    refresh: async () => {
      calls++;
      if (calls === 3) await new Promise<void>((resolve) => (release = resolve));
    },
  });
  await flush();
  visible = false;
  polling.wake();
  context.mock.timers.tick(60000);
  assert.equal(calls, 1);
  visible = true;
  polling.wake();
  await flush();
  assert.equal(calls, 2);
  context.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 3);
  polling.stop();
  release!();
  await flush();
  polling.wake();
  context.mock.timers.tick(60000);
  assert.equal(calls, 3);
});
