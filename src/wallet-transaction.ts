import { PublicKey, VersionedTransaction } from '@solana/web3.js';

/** Wallet adapters may return a full wire transaction or only a 64-byte signature. */
export function normalizeWalletTransaction(
  original: Uint8Array,
  signed: Uint8Array,
  address: string,
) {
  const expected = VersionedTransaction.deserialize(original);
  if (expected.message.staticAccountKeys[0].toBase58() !== address)
    throw new Error('Reconnect the wallet that prepared this launch.');
  if (signed.length === 64) {
    expected.addSignature(new PublicKey(address), signed);
    return expected.serialize();
  }
  const result = VersionedTransaction.deserialize(signed);
  const before = expected.message.serialize();
  const after = result.message.serialize();
  if (before.length !== after.length || before.some((byte, i) => byte !== after[i]))
    throw new Error('The wallet returned a changed launch transaction. Nothing was submitted.');
  // Preserve the server's mint signature if an adapter returns only its own signature.
  for (let i = 1; i < expected.signatures.length; i++) {
    if (!result.signatures[i]?.some(Boolean)) result.signatures[i] = expected.signatures[i];
  }
  return result.serialize();
}
