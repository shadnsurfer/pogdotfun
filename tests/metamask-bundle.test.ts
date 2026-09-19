import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import config from '../vite.config.ts';

test('MetaMask browser protocol entry exposes the named factories required before showing QR', async () => {
  const packageName = '@metamask/mobile-wallet-protocol-core';
  const aliases = config.resolve?.alias;
  assert.ok(Array.isArray(aliases));
  const alias = aliases.find((item) => item.find instanceof RegExp && item.find.test(packageName));
  assert.ok(alias, 'Resolve the published ESM entry instead of Vite’s default-only CJS wrapper.');
  assert.ok(alias.find instanceof RegExp);
  assert.equal(alias.find.test(`${packageName}/unrelated-subpath`), false);

  // Exercise the installed dependency's actual exports, not a mocked namespace.
  const protocol = await import(pathToFileURL(alias.replacement).href);
  assert.equal(typeof protocol.SessionStore?.create, 'function');
  assert.equal(typeof protocol.WebSocketTransport?.create, 'function');
  const values = new Map<string, string>();
  const sessionStore = await protocol.SessionStore.create({
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  });
  assert.deepEqual(await sessionStore.list(), []);
});
