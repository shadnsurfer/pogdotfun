import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BudgetedBrowserProvider } from '../server/providers/budgeted-browserbase.ts';
import { TestingBudget } from '../server/workers/testing-budget.ts';
import type { BrowserSession, BrowserSessionProvider } from '../server/providers/browserbase.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const budget = new TestingBudget(db);
  const sessions: BrowserSession[] = [];
  let creations = 0;
  let views = 0;
  let releases = 0;
  const underlying: BrowserSessionProvider = {
    async createSession(contextId, attemptId) {
      assert.equal(budget.get(`browser:${attemptId}`)?.state, 'unresolved');
      creations++;
      const session: BrowserSession = {
        id: `session-${creations}`,
        contextId,
        attemptId,
        projectId: 'project-1',
        status: 'RUNNING',
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      };
      sessions.push(session);
      return session;
    },
    async getSession(id) {
      return sessions.find((s) => s.id === id)!;
    },
    async findSessions(attemptId) {
      return sessions.filter((s) => s.attemptId === attemptId);
    },
    async liveView() {
      views++;
      return 'https://browserbase.com/private-fixture';
    },
    async releaseSession(id) {
      releases++;
      const item = sessions.find((s) => s.id === id)!;
      item.status = 'COMPLETED';
      return item;
    },
  };
  const provider = new BudgetedBrowserProvider(underlying, budget, { maxSessionCostUsdCents: 10 });
  return {
    db,
    budget,
    underlying,
    provider,
    sessions,
    creations: () => creations,
    views: () => views,
    releases: () => releases,
  };
}

test('browser create commits its maximum cost before the provider call and closure does not settle billing', async () => {
  const t = fixture();
  try {
    const session = await t.provider.createSession('context-1', 'attempt-1');
    assert.equal(t.budget.snapshot().unresolvedUsdCents, 10);
    assert.equal(t.budget.snapshot().committedUsdCents, 0);
    assert.deepEqual(await t.provider.getSession(session.id), session);
    assert.equal((await t.provider.findSessions('attempt-1')).length, 1);
    assert.equal(await t.provider.liveView(session.id), 'https://browserbase.com/private-fixture');
    assert.equal((await t.provider.releaseSession(session.id)).status, 'COMPLETED');
    assert.equal(t.budget.snapshot().unresolvedUsdCents, 10);
    assert.equal(t.views(), 1);
    assert.equal(t.releases(), 1);
  } finally {
    t.db.close();
  }
});

test('an exhausted aggregate budget prevents any billable browser create', async () => {
  const t = fixture();
  try {
    t.budget.reserve({ operationId: 'gifts', kind: 'gift', maxUsdCents: 29991 }, 'test');
    await assert.rejects(() => t.provider.createSession('context-1', 'attempt-1'), /cap/);
    assert.equal(t.creations(), 0);
    assert.equal(t.budget.get('browser:attempt-1'), undefined);
  } finally {
    t.db.close();
  }
});

test('an ambiguous create is looked up after a decorator restart and never repeated', async () => {
  const t = fixture();
  try {
    const create = t.underlying.createSession.bind(t.underlying);
    t.underlying.createSession = async (...args) => {
      await create(...args);
      throw Error('secret-response');
    };
    await assert.rejects(
      () => t.provider.createSession('context-1', 'attempt-1'),
      (error) => error instanceof Error && !error.message.includes('secret-response'),
    );
    const restarted = new BudgetedBrowserProvider(t.underlying, t.budget, {
      maxSessionCostUsdCents: 10,
    });
    assert.equal((await restarted.createSession('context-1', 'attempt-1')).id, 'session-1');
    assert.equal(t.creations(), 1);
    assert.equal(t.budget.snapshot().unresolvedUsdCents, 10);
  } finally {
    t.db.close();
  }
});

test('empty, duplicate, and wrong-context lookups never authorize replacement sessions', async () => {
  const t = fixture();
  try {
    t.underlying.createSession = async () => {
      throw Error('unknown');
    };
    await assert.rejects(() => t.provider.createSession('context-1', 'attempt-1'));
    await assert.rejects(() => t.provider.createSession('context-1', 'attempt-1'), /reconcile/i);
    const remote: BrowserSession = {
      id: 'original',
      contextId: 'wrong-context',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      status: 'RUNNING',
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    };
    t.sessions.push(remote);
    await assert.rejects(() => t.provider.createSession('context-1', 'attempt-1'), /reconcile/i);
    remote.contextId = 'context-1';
    t.sessions.push({ ...remote, id: 'duplicate' });
    await assert.rejects(() => t.provider.createSession('context-1', 'attempt-1'), /reconcile/i);
    assert.equal(t.budget.snapshot().unresolvedUsdCents, 10);
  } finally {
    t.db.close();
  }
});

test('concurrent requests for one attempt issue at most one provider create', async () => {
  const t = fixture();
  try {
    const values = await Promise.all([
      t.provider.createSession('context-1', 'attempt-1'),
      t.provider.createSession('context-1', 'attempt-1'),
    ]);
    assert.equal(values[0].id, values[1].id);
    assert.equal(t.creations(), 1);
    assert.equal(t.budget.list().length, 1);
    await assert.rejects(
      () => t.provider.createSession('other-context', 'attempt-1'),
      /reconcile/i,
    );
  } finally {
    t.db.close();
  }
});

test('the browser ceiling is explicit and a changed ceiling cannot rewrite an existing reservation', async () => {
  const t = fixture();
  try {
    for (const maxSessionCostUsdCents of [0, -1, NaN, 1.1, 30001])
      assert.throws(
        () => new BudgetedBrowserProvider(t.underlying, t.budget, { maxSessionCostUsdCents }),
        /ceiling/,
      );
    await t.provider.createSession('context-1', 'attempt-1');
    const changed = new BudgetedBrowserProvider(t.underlying, t.budget, {
      maxSessionCostUsdCents: 20,
    });
    await assert.rejects(() => changed.createSession('context-1', 'attempt-1'), /different/);
    assert.equal(t.creations(), 1);
  } finally {
    t.db.close();
  }
});
