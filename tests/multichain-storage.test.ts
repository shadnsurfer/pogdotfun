import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import {
  SqliteExecutionJournal,
  createVaultEvmSigner,
  createHttpChainRpc,
} from '../server/chains/index.ts';

test('SQLite journal coordinates account locks and preserves signed identity', async () => {
  const db = new DatabaseSync(':memory:');
  const first = new SqliteExecutionJournal(db);
  const second = new SqliteExecutionJournal(db);
  await first.exclusive('account', async () => {
    await assert.rejects(
      second.exclusive('account', async () => true),
      /lock/i,
    );
    await first.put('intent', { fingerprint: `0x${'11'.repeat(32)}`, status: 'reserved' });
  });
  assert.equal((await second.get('intent'))?.status, 'reserved');
  assert.equal(await second.exclusive('account', async () => true), true);
  db.close();
});
test('vault signer binds the decrypted key to the configured address', async () => {
  const key = `0x${'11'.repeat(32)}` as const;
  const expected = privateKeyToAccount(key).address;
  const signer = createVaultEvmSigner({ read: () => key }, 'evm-key', expected);
  const raw = await signer.signTransaction({
    type: 'legacy',
    chainId: 56,
    nonce: 0,
    to: expected,
    value: 0n,
    gas: 21000n,
    gasPrice: 1n,
  });
  assert.ok(raw.startsWith('0x'));
  const wrong = createVaultEvmSigner({ read: () => `0x${'22'.repeat(32)}` }, 'evm-key', expected);
  await assert.rejects(
    wrong.signTransaction({
      type: 'legacy',
      chainId: 56,
      nonce: 0,
      to: expected,
      value: 0n,
      gas: 21000n,
      gasPrice: 1n,
    }),
    /address|signer/i,
  );
});
test('HTTP RPC rejects mismatched response identity and credentials stay off errors', async () => {
  const rpc = createHttpChainRpc(
    'https://example.test/private-token',
    async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x38' })),
  );
  await assert.rejects(rpc.request('eth_chainId'), /identity/);
});

test('RPC transport failures redact endpoint credentials', async () => {
  const rpc = createHttpChainRpc('https://example.test/private-token', async () => {
    throw new Error('Fetch failed at https://example.test/private-token');
  });
  await assert.rejects(
    rpc.request('eth_chainId'),
    (error: Error) => !error.message.includes('private-token'),
  );
});
