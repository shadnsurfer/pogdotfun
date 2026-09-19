import { DatabaseSync } from 'node:sqlite';
import type {
  JournalTransaction,
  PreparedTransaction,
  TransactionJournal,
  TransactionState,
} from '../providers/contracts.ts';

/** Store only signed transactions, never wallet secret keys or OAuth tokens. */
export class SqliteTransactionJournal implements TransactionJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_transactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        creator TEXT NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'prepared',
        detail TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS worker_one_unresolved_transaction
      ON worker_transactions(kind, creator)
      WHERE state IN ('prepared','broadcast','unknown','expired_review');
    `);
  }

  get(id: string): JournalTransaction | undefined {
    const row = this.db.prepare('SELECT * FROM worker_transactions WHERE id=?').get(id);
    if (!row) return undefined;
    return {
      ...JSON.parse(String(row.payload)),
      state: row.state as TransactionState,
      ...(row.detail ? { detail: String(row.detail) } : {}),
    };
  }

  insert(transaction: PreparedTransaction): JournalTransaction {
    const old = this.get(transaction.id);
    if (old) {
      const { state: _state, detail: _detail, ...oldPayload } = old;
      if (JSON.stringify(oldPayload) !== JSON.stringify(transaction))
        throw new Error('Transaction ID already exists with different contents.');
      return old;
    }
    this.db
      .prepare(
        `INSERT INTO worker_transactions(id,kind,creator,signature,payload,updated_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        transaction.id,
        transaction.kind,
        transaction.creator,
        transaction.signature,
        JSON.stringify(transaction),
        new Date().toISOString(),
      );
    return this.get(transaction.id)!;
  }

  /** A standalone commit makes this identity reconcile-only before either the
   * budget gate or network can run. Only one dispatcher wins this transition. */
  claimForBroadcast(id: string): JournalTransaction | undefined {
    // BEGIN also rejects an outer uncommitted transaction on Node versions which
    // do not expose DatabaseSync.isTransaction. Never broadcast uncommitted bytes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          "UPDATE worker_transactions SET state='unknown',detail=?,updated_at=? WHERE id=? AND state='prepared'",
        )
        .run(
          'Broadcast permission and outcome require signature reconciliation.',
          new Date().toISOString(),
          id,
        );
      const value = result.changes === 1 ? this.get(id) : undefined;
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  update(id: string, state: TransactionState, detail?: string): void {
    const current = this.get(id);
    if (!current) throw new Error('Unknown transaction.');
    if (['confirmed', 'failed'].includes(current.state) && current.state !== state) {
      throw new Error('A finalized transaction cannot change state.');
    }
    if (
      current.state === 'retired_expired' &&
      !['retired_expired', 'confirmed', 'failed'].includes(state)
    )
      throw new Error('A retired transaction can only accept verified final reconciliation.');
    this.db
      .prepare('UPDATE worker_transactions SET state=?,detail=?,updated_at=? WHERE id=?')
      .run(state, detail ?? null, new Date().toISOString(), id);
  }
}

export interface TransactionTransport {
  broadcast(transaction: PreparedTransaction): Promise<string>;
  reconcile(transaction: PreparedTransaction): Promise<TransactionState>;
}

export interface TransactionBroadcastGate {
  /** Synchronous, durable authorization for this exact persisted signature.
   * No network calls here. false means reconcile only, never retry submission. */
  begin(transaction: Readonly<PreparedTransaction>): { execute: boolean };
}
export interface DispatchTransactionJournal extends TransactionJournal {
  /** Atomic prepared->unknown transition, committed before this method returns. */
  claimForBroadcast?(id: string): JournalTransaction | undefined;
}

export class TransactionDispatcher {
  constructor(
    private readonly journal: DispatchTransactionJournal,
    private readonly transport: TransactionTransport,
    private readonly gate?: TransactionBroadcastGate,
  ) {
    if (gate && !journal.claimForBroadcast)
      throw new Error('A budgeted dispatcher requires an atomic durable broadcast claim.');
  }

  async execute(id: string, prepare: () => Promise<PreparedTransaction>) {
    let stored = this.journal.get(id);
    if (!stored) {
      const prepared = await prepare();
      if (prepared.id !== id) throw new Error('Prepared transaction identity mismatch.');
      stored = this.journal.insert(prepared);
    }
    if (stored.state !== 'prepared') return this.reconcile(id);
    // Mark uncertain BEFORE permission or the network side effect. A crash here
    // reconciles this identity; it never builds a fresh-blockhash replacement.
    if (this.journal.claimForBroadcast) {
      const claimed = this.journal.claimForBroadcast(id);
      if (!claimed) return this.reconcile(id);
      stored = claimed;
    } else {
      // Compatibility for existing custom journals without a budget gate. The
      // production SQLite journal always uses the atomic claim above.
      this.journal.update(id, 'unknown', 'Broadcast outcome requires signature reconciliation.');
    }
    try {
      if (this.gate) {
        const permission = this.gate.begin(Object.freeze({ ...stored }));
        if (typeof permission?.execute !== 'boolean')
          throw new Error('Invalid broadcast permission.');
        if (!permission.execute) return await this.reconcile(id);
      }
      const signature = await this.transport.broadcast(stored);
      if (signature !== stored.signature) throw new Error('RPC signature mismatch.');
      this.journal.update(id, 'broadcast');
    } catch {
      // A gate or network response can be lost after its side effect. Keep the
      // exact identity and never expose raw gate/provider errors or secrets.
      if (!['confirmed', 'failed'].includes(this.journal.get(id)!.state))
        this.journal.update(
          id,
          'unknown',
          'Broadcast permission or result is unknown. Reconcile the existing signature.',
        );
    }
    return this.journal.get(id)!;
  }

  async reconcile(id: string) {
    const transaction = this.journal.get(id);
    if (!transaction) throw new Error('Unknown transaction.');
    if (['confirmed', 'failed', 'retired_expired'].includes(transaction.state)) return transaction;
    try {
      const state = await this.transport.reconcile(transaction);
      if (!['broadcast', 'confirmed', 'failed', 'unknown', 'expired_review'].includes(state))
        throw new Error('Reconciliation cannot authorize another broadcast.');
      this.journal.update(id, state);
    } catch {
      this.journal.update(id, 'unknown', 'RPC unavailable. Reconciliation remains pending.');
    }
    return this.journal.get(id)!;
  }
}
