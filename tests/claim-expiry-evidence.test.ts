import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { inspectExpiredClaimBatch } from '../server/providers/claim-expiry-evidence.ts';

const key = Keypair.generate();
const message = new TransactionMessage({
  payerKey: key.publicKey,
  recentBlockhash: Keypair.generate().publicKey.toBase58(),
  instructions: [],
}).compileToV0Message();
const signed = new VersionedTransaction(message);
signed.sign([key]);
const transaction = {
  id: 'claim:test',
  kind: 'claim' as const,
  tokenId: 'token',
  mint: key.publicKey.toBase58(),
  creator: key.publicKey.toBase58(),
  signature: bs58.encode(signed.signatures[0]),
  signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
  blockhash: message.recentBlockhash,
  lastValidBlockHeight: 100,
  createdAt: new Date().toISOString(),
};
function source(name: string, overrides: object = {}) {
  return {
    name,
    connection: {
      getGenesisHash: async () => 'mainnet',
      getBlockHeight: async () => 200,
      getSignatureStatuses: async () => ({ value: [null] }),
      getTransaction: async () => null,
      ...overrides,
    } as any,
  };
}
test('two matching finalized archive reads retain expiry evidence without claiming zero cost', async () => {
  const result = await inspectExpiredClaimBatch([transaction], 'mainnet', [
    source('configured'),
    source('independent'),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].signature, transaction.signature);
  assert.equal(result[0].sources.length, 2);
  assert.equal(result[0].lastValidBlockHeight, 100);
  assert.equal('actualUsdCents' in result[0], false);
});
test('expiry review rejects receipt, status, stale height, wrong network and unavailable RPC', async () => {
  for (const overrides of [
    { getTransaction: async () => ({ meta: { err: null } }) },
    { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'processed' }] }) },
    { getBlockHeight: async () => 100 },
    { getGenesisHash: async () => 'other' },
    {
      getTransaction: async () => {
        throw new Error('secret RPC URL');
      },
    },
  ])
    await assert.rejects(
      inspectExpiredClaimBatch([transaction], 'mainnet', [
        source('configured'),
        source('independent', overrides),
      ]),
      /review|expiry|network|unavailable/i,
    );
});
test('invalid signed identity or duplicate RPC source cannot establish recovery evidence', async () => {
  await assert.rejects(
    inspectExpiredClaimBatch([{ ...transaction, signature: 'wrong' }], 'mainnet', [
      source('configured'),
      source('independent'),
    ]),
    /identity/i,
  );
  await assert.rejects(
    inspectExpiredClaimBatch([{ ...transaction, kind: 'topup' }], 'mainnet', [
      source('configured'),
      source('independent'),
    ]),
    /claim/i,
  );
  await assert.rejects(
    inspectExpiredClaimBatch([transaction], 'mainnet', [source('same'), source('same')]),
    /independent/i,
  );
});

test('a stalled archive read reaches the batch deadline without scheduling further calls', async () => {
  let receipts = 0;
  const slow = source('slow', {
    getTransaction: async () => {
      receipts++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    inspectExpiredClaimBatch([transaction], 'mainnet', [source('configured'), slow], 15),
    /unavailable/,
  );
  assert.equal(receipts, 1);
});
