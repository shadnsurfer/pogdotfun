import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TestingBudget } from '../server/workers/testing-budget.ts';

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(
      new URL('./fixtures/testing-budget-before-creator-ceiling.sql', import.meta.url),
      'utf8',
    ),
  );
  db.exec(`
    INSERT INTO worker_testing_budget_costs
      (rowid,operation_id,kind,max_cents,state,attempt_id,actual_cents,evidence_kind,evidence_id,created_at,updated_at)
      VALUES(17,'old-gift','gift',6000,'settled','old-attempt',10000,'twitch_receipt','old-receipt','old-date','old-date');
    UPDATE worker_testing_budget_config SET frozen=1,freeze_reason='confirmed_cost_exceeded_reservation';
    INSERT INTO worker_creator_funding_authorizations
      VALUES('gift:historical','historical','old-token',6610,'gift',6000,'original-source','old-actor','old-date');
  `);
  return db;
}

test('ceiling migration preserves the $100 overrun, old $60 allowances, freeze and immutable history', () => {
  const db = legacyDatabase();
  try {
    const before = db.prepare('SELECT rowid,* FROM worker_testing_budget_costs').all();
    const authorizations = db.prepare('SELECT * FROM worker_creator_funding_authorizations').all();
    const budget = new TestingBudget(db);
    assert.deepEqual(db.prepare('SELECT rowid,* FROM worker_testing_budget_costs').all(), before);
    assert.deepEqual(
      db.prepare('SELECT * FROM worker_creator_funding_authorizations').all(),
      authorizations,
    );
    assert.equal(budget.snapshot().capUsdCents, 30000);
    assert.equal(budget.snapshot().frozen, true);
    assert.equal(budget.get('old-gift')?.actualUsdCents, 10000);
    assert.equal(budget.get('old-gift')?.maxUsdCents, 6000);
    assert.throws(
      () =>
        db.exec(
          "UPDATE worker_testing_budget_costs SET max_cents=500000 WHERE operation_id='old-gift'",
        ),
      /immutable/,
    );
    assert.throws(
      () => db.exec('UPDATE worker_creator_funding_authorizations SET max_cents=500000'),
      /immutable/,
    );
    assert.throws(() => db.exec('UPDATE worker_testing_budget_config SET frozen=0'), /immutable/);
    assert.throws(() => db.exec('DELETE FROM worker_testing_budget_costs'), /immutable/);
    assert.throws(
      () =>
        db.exec(`INSERT INTO worker_testing_budget_costs(operation_id,kind,max_cents,state,created_at,updated_at)
      VALUES('unbacked','gift',500000,'reserved','now','now')`),
      /creator funding authorization/,
    );
    new TestingBudget(db);
    assert.deepEqual(db.prepare('SELECT rowid,* FROM worker_testing_budget_costs').all(), before);
  } finally {
    db.close();
  }
});

test('interrupted ceiling migration rolls back schema, history and protections together', () => {
  const db = legacyDatabase();
  try {
    db.exec('CREATE TABLE worker_testing_budget_costs_ceiling_v2 (collision TEXT)');
    assert.throws(() => new TestingBudget(db), /already exists/);
    assert.equal(
      db
        .prepare(
          "SELECT actual_cents FROM worker_testing_budget_costs WHERE operation_id='old-gift'",
        )
        .get()?.actual_cents,
      10000,
    );
    assert.throws(() => db.exec('DELETE FROM worker_testing_budget_costs'), /immutable/);
    assert.match(
      String(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='worker_testing_budget_costs'").get()
          ?.sql,
      ),
      /max_cents<=30000/,
    );
    assert.equal(db.prepare('SELECT frozen FROM worker_testing_budget_config').get()?.frozen, 1);
  } finally {
    db.close();
  }
});
