import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { normalizeWalletTransaction } from '../src/wallet-transaction.ts';
function fixture(lamports = 1) {
  const payer = Keypair.generate(),
    mint = Keypair.generate();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports,
          space: 82,
          programId: SystemProgram.programId,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([mint]);
  return { payer, mint, tx };
}
test('sign-only wallet response retains the mint partial signature', () => {
  const { payer, tx } = fixture();
  const original = tx.serialize();
  const mintSignature = tx.signatures[1].slice();
  tx.sign([payer]);
  const result = VersionedTransaction.deserialize(
    normalizeWalletTransaction(original, tx.signatures[0], payer.publicKey.toBase58()),
  );
  assert.deepEqual(result.signatures[0], tx.signatures[0]);
  assert.deepEqual(result.signatures[1], mintSignature);
});
test('rejects a wallet response that changes the approved transaction', () => {
  const { payer, tx } = fixture();
  const original = tx.serialize();
  tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign([payer]);
  assert.throws(
    () => normalizeWalletTransaction(original, tx.serialize(), payer.publicKey.toBase58()),
    /changed launch/,
  );
});
test('recovered launch cannot use a different linked wallet', () => {
  const { tx } = fixture();
  assert.throws(
    () =>
      normalizeWalletTransaction(
        tx.serialize(),
        new Uint8Array(64),
        Keypair.generate().publicKey.toBase58(),
      ),
    /wallet that prepared/,
  );
});
test('restores an omitted mint signature without changing the signed message', () => {
  const { payer, tx } = fixture();
  const original = tx.serialize();
  const mintSignature = tx.signatures[1].slice();
  tx.sign([payer]);
  tx.signatures[1] = new Uint8Array(64);
  const result = VersionedTransaction.deserialize(
    normalizeWalletTransaction(original, tx.serialize(), payer.publicKey.toBase58()),
  );
  assert.deepEqual(result.signatures[1], mintSignature);
  assert.deepEqual(result.message.serialize(), tx.message.serialize());
});
