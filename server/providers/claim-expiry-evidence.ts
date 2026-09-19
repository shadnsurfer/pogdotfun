import { VersionedTransaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import type { PreparedTransaction } from './contracts.ts';
import type { ClaimExpiryEvidence } from '../workers/claim-recovery.ts';

type ExpiryRpc = Pick<
  Connection,
  'getGenesisHash' | 'getBlockHeight' | 'getSignatureStatuses' | 'getTransaction'
>;
/** Negative history reads support an explicit operator review only. They are not
 * evidence of zero cost, and must never release an old gas reservation. */
export async function inspectExpiredClaimBatch(
  transactions: readonly PreparedTransaction[],
  expectedGenesisHash: string,
  sources: readonly { name: string; connection: ExpiryRpc }[],
  timeoutMs = 45_000,
): Promise<ClaimExpiryEvidence[]> {
  const startedAt = Date.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45_000)
    throw new Error('Expiry review requires a bounded deadline.');
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error('Expiry review deadline exceeded.');
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Expiry review deadline exceeded.')),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  if (sources.length !== 2 || new Set(sources.map((s) => s.name)).size !== 2)
    throw new Error('Two independent RPC sources are required for expiry review.');
  if (
    !transactions.length ||
    transactions.length > 50 ||
    new Set(transactions.map((t) => t.signature)).size !== transactions.length
  )
    throw new Error('A bounded, unique claim batch is required for expiry review.');
  for (const transaction of transactions) {
    if (transaction.kind !== 'claim') throw new Error('Only creator claims support expiry review.');
    try {
      const signed = VersionedTransaction.deserialize(
        Buffer.from(transaction.signedTransactionBase64, 'base64'),
      );
      if (
        bs58.encode(signed.signatures[0]) !== transaction.signature ||
        signed.message.recentBlockhash !== transaction.blockhash ||
        signed.message.staticAccountKeys[0].toBase58() !== transaction.creator ||
        !Number.isSafeInteger(transaction.lastValidBlockHeight) ||
        transaction.lastValidBlockHeight <= 0
      )
        throw new Error();
    } catch {
      throw new Error('Stored claim identity could not be verified for expiry review.');
    }
  }
  const observations = await Promise.all(
    sources.map(async ({ name, connection }) => {
      try {
        const genesisHash = await read(() => connection.getGenesisHash());
        if (genesisHash !== expectedGenesisHash) throw new Error();
        const finalizedBlockHeight = await read(() => connection.getBlockHeight('finalized'));
        const statuses = await read(() =>
          connection.getSignatureStatuses(
            transactions.map((t) => t.signature),
            { searchTransactionHistory: true },
          ),
        );
        if (
          !Number.isSafeInteger(finalizedBlockHeight) ||
          statuses.value.length !== transactions.length
        )
          throw new Error();
        for (const [index, transaction] of transactions.entries()) {
          if (
            finalizedBlockHeight <= transaction.lastValidBlockHeight ||
            statuses.value[index] !== null
          )
            throw new Error();
          const receipt = await read(() =>
            connection.getTransaction(transaction.signature, {
              commitment: 'finalized',
              maxSupportedTransactionVersion: 0,
            }),
          );
          if (receipt !== null) throw new Error();
        }
        return { source: name, genesisHash, finalizedBlockHeight, status: null, transaction: null };
      } catch {
        throw new Error(
          'Expiry review unavailable: both RPC sources must agree on expired claims with no recorded transaction.',
        );
      }
    }),
  );
  if (Date.now() - startedAt > 45_000)
    throw new Error('Expiry review took too long; fresh observations are required.');
  return transactions.map((transaction) => ({
    signature: transaction.signature,
    lastValidBlockHeight: transaction.lastValidBlockHeight,
    checkedAt: new Date().toISOString(),
    sources: observations,
  }));
}
