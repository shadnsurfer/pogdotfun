import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PumpSolanaProvider } from '../providers/pump-solana.ts';
import { SqliteTransactionJournal, TransactionDispatcher } from '../workers/transaction-journal.ts';
import type { SettlementTransferAdapter } from './settlement.ts';
const transferId = (id: string) => createHash('sha256').update(`pog:deposit:${id}`).digest('hex');
/** Reuses the same finalized-chain proof and before-broadcast journal as fee claims. */
export function solanaSettlementTransfer(
  db: DatabaseSync,
  provider: () => PumpSolanaProvider,
): SettlementTransferAdapter {
  const journal = new SqliteTransactionJournal(db);
  db.exec(
    'CREATE TABLE IF NOT EXISTS agent_solana_preparations(job_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS agent_solana_destinations(job_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,address TEXT NOT NULL,amount TEXT NOT NULL)',
  );
  const transfer: SettlementTransferAdapter = {
    async send(lot, destination) {
      if (
        lot.chain !== 'solana' ||
        lot.asset !== 'SOL' ||
        destination.asset !== 'SOL' ||
        destination.network !== 'solana'
      )
        throw new Error('Unsupported deposit network.');
      const old = db.prepare('SELECT * FROM agent_solana_destinations WHERE job_id=?').get(lot.id);
      if (
        old &&
        (old.account_id !== destination.accountId ||
          old.address !== destination.address ||
          old.amount !== lot.amountBaseUnits)
      )
        throw new Error('Conflicting deposit binding.');
      if (!old)
        db.prepare('INSERT INTO agent_solana_destinations VALUES(?,?,?,?)').run(
          lot.id,
          destination.accountId,
          destination.address,
          lot.amountBaseUnits,
        );
      const preparing = db
        .prepare('INSERT OR IGNORE INTO agent_solana_preparations VALUES(?)')
        .run(lot.id);
      if (preparing.changes !== 1) {
        const existing = journal.get(transferId(lot.id));
        if (existing) return { reference: existing.signature };
        throw new Error('Transfer preparation is already reserved; evidence pending.');
      }
      const source = provider(),
        dispatcher = new TransactionDispatcher(journal, source);
      const tx = await dispatcher.execute(transferId(lot.id), () =>
        source.prepareTopUp(
          transferId(lot.id),
          lot.tokenId,
          {
            address: destination.address,
            network: 'solana',
            asset: 'SOL',
            accountId: destination.accountId,
            reference: destination.addressId,
            verifiedAt: new Date(destination.verifiedAt).toISOString(),
            expiresAt: new Date(destination.verifiedAt + 300000).toISOString(),
          },
          BigInt(lot.amountBaseUnits),
        ),
      );
      return { reference: tx.signature };
    },
    async resumeUnsubmitted(job, destination) {
      // send atomically inserts the preparation reservation. A competing or interrupted
      // preparer prevents another signing attempt even if no transaction exists yet.
      if (db.prepare('SELECT 1 FROM agent_solana_preparations WHERE job_id=?').get(job.id))
        return null;
      return transfer.send(job, destination);
    },
    async reconcile(job) {
      const source = provider(),
        id = transferId(job.id),
        binding = db.prepare('SELECT * FROM agent_solana_destinations WHERE job_id=?').get(job.id);
      if (!binding || !journal.get(id)) return null;
      const tx = await new TransactionDispatcher(journal, source).reconcile(id);
      if (tx.state !== 'confirmed') return null;
      if (
        tx.tokenId !== job.tokenId ||
        tx.destination !== binding.address ||
        tx.amountLamports !== binding.amount ||
        binding.amount !== job.amountBaseUnits
      )
        throw new Error('Deposit identity mismatch.');
      const proof = await source.finalizedProof(tx);
      if (proof.amountLamports !== job.amountBaseUnits) throw new Error('Deposit amount mismatch.');
      return {
        hash: proof.signature,
        amountBaseUnits: proof.amountLamports,
        chain: 'solana',
        asset: 'SOL',
      };
    },
  };
  return transfer;
}
