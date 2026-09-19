import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedTransaction } from '../server/providers/contracts.ts';
import {
  SqliteTransactionJournal,
  TransactionDispatcher,
} from '../server/workers/transaction-journal.ts';
import { TestingBudget } from '../server/workers/testing-budget.ts';

const tx: PreparedTransaction = {
  id: 'claim-1',
  kind: 'claim',
  tokenId: 'token',
  mint: 'mint',
  creator: 'creator',
  signature: 'signature',
  signedTransactionBase64: 'fixture-bytes',
  blockhash: 'blockhash',
  lastValidBlockHeight: 100,
  createdAt: '2026-09-15T00:00:00Z',
  networkFeeLamports: '5000',
};

test('the exact transaction and unknown state commit before budget authority and broadcast', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db);
  const budget = new TestingBudget(db);
  let broadcasts = 0;
  const dispatcher = new TransactionDispatcher(
    journal,
    {
      async broadcast(stored) {
        broadcasts++;
        assert.equal(budget.get('gas:claim-1')?.state, 'unresolved');
        assert.equal(stored.signature, tx.signature);
        return stored.signature;
      },
      async reconcile() {
        return 'confirmed';
      },
    },
    {
      begin(stored) {
        assert.equal(journal.get(stored.id)?.signedTransactionBase64, tx.signedTransactionBase64);
        assert.equal(journal.get(stored.id)?.state, 'unknown');
        db.exec('BEGIN IMMEDIATE; COMMIT');
        budget.reserve({ operationId: 'gas:claim-1', kind: 'chain_fee', maxUsdCents: 1 }, 'test');
        return budget.begin('gas:claim-1', `gas:${stored.signature}`, 'test');
      },
    },
  );
  try {
    assert.equal((await dispatcher.execute(tx.id, async () => tx)).state, 'broadcast');
    assert.equal(broadcasts, 1);
  } finally {
    db.close();
  }
});

test('execute false reconciles only the stored bytes and signature and never rebuilds', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db);
  let gates = 0,
    prepares = 0,
    broadcasts = 0,
    reconciles = 0;
  const dispatcher = new TransactionDispatcher(
    journal,
    {
      async broadcast(stored) {
        broadcasts++;
        return stored.signature;
      },
      async reconcile(stored) {
        reconciles++;
        assert.equal(stored.signature, tx.signature);
        assert.equal(stored.signedTransactionBase64, tx.signedTransactionBase64);
        return 'unknown';
      },
    },
    {
      begin() {
        gates++;
        return { execute: false };
      },
    },
  );
  try {
    await dispatcher.execute(tx.id, async () => {
      prepares++;
      return tx;
    });
    await dispatcher.execute(tx.id, async () => {
      prepares++;
      return { ...tx, signature: 'replacement' };
    });
    assert.equal(gates, 1);
    assert.equal(prepares, 1);
    assert.equal(broadcasts, 0);
    assert.equal(reconciles, 2);
  } finally {
    db.close();
  }
});

test('a lost gate result after durable budget begin survives restart without broadcast or new signing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pog-chain-budget-'));
  const path = join(dir, 'worker.sqlite');
  let db = new DatabaseSync(path);
  let broadcasts = 0;
  const transport = {
    async broadcast(stored: PreparedTransaction) {
      broadcasts++;
      return stored.signature;
    },
    async reconcile() {
      return 'unknown' as const;
    },
  };
  try {
    let journal = new SqliteTransactionJournal(db);
    const budget = new TestingBudget(db);
    const initial = new TransactionDispatcher(journal, transport, {
      begin(stored) {
        budget.reserve({ operationId: 'gas:claim-1', kind: 'chain_fee', maxUsdCents: 1 }, 'test');
        budget.begin('gas:claim-1', `gas:${stored.signature}`, 'test');
        throw Error('secret-gate-error');
      },
    });
    assert.equal((await initial.execute(tx.id, async () => tx)).state, 'unknown');
    assert.equal(journal.get(tx.id)?.detail?.includes('secret-gate-error'), false);
    db.close();
    db = new DatabaseSync(path);
    journal = new SqliteTransactionJournal(db);
    const restarted = new TransactionDispatcher(journal, transport);
    await restarted.execute(tx.id, async () => {
      throw Error('Must never prepare another transaction');
    });
    assert.equal(new TestingBudget(db).snapshot().unresolvedUsdCents, 1);
    assert.equal(broadcasts, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('competing dispatchers can claim a prepared transaction only once', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db);
  journal.insert(tx);
  let gates = 0,
    broadcasts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = {
    async broadcast(stored: PreparedTransaction) {
      broadcasts++;
      await pending;
      return stored.signature;
    },
    async reconcile() {
      return 'unknown' as const;
    },
  };
  const gate = {
    begin() {
      gates++;
      return { execute: true };
    },
  };
  try {
    const first = new TransactionDispatcher(journal, transport, gate).execute(
      tx.id,
      async () => tx,
    );
    await new TransactionDispatcher(new SqliteTransactionJournal(db), transport, gate).execute(
      tx.id,
      async () => {
        throw Error('no replacement');
      },
    );
    release();
    await first;
    assert.equal(gates, 1);
    assert.equal(broadcasts, 1);
  } finally {
    release();
    db.close();
  }
});

test('an outer transaction cannot invoke the budget gate or broadcast uncommitted bytes', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db);
  let gates = 0,
    broadcasts = 0;
  const dispatcher = new TransactionDispatcher(
    journal,
    {
      async broadcast(stored) {
        broadcasts++;
        return stored.signature;
      },
      async reconcile() {
        return 'unknown';
      },
    },
    {
      begin() {
        gates++;
        return { execute: true };
      },
    },
  );
  try {
    db.exec('BEGIN');
    await assert.rejects(() => dispatcher.execute(tx.id, async () => tx));
    assert.equal(gates, 0);
    assert.equal(broadcasts, 0);
    db.exec('ROLLBACK');
    assert.equal(journal.get(tx.id), undefined);
  } finally {
    db.close();
  }
});

test('a reconciliation result cannot re-arm a transaction for another broadcast', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db);
  let broadcasts = 0;
  let gates = 0;
  const dispatcher = new TransactionDispatcher(
    journal,
    {
      async broadcast(stored) {
        broadcasts++;
        return stored.signature;
      },
      async reconcile() {
        return 'prepared';
      },
    },
    {
      begin() {
        gates++;
        return { execute: false };
      },
    },
  );
  try {
    assert.equal((await dispatcher.execute(tx.id, async () => tx)).state, 'unknown');
    assert.equal(
      (
        await dispatcher.execute(tx.id, async () => {
          throw Error('no replacement');
        })
      ).state,
      'unknown',
    );
    assert.equal(gates, 1);
    assert.equal(broadcasts, 0);
  } finally {
    db.close();
  }
});
