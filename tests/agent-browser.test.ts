import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AgentBrowserRunner, type BrowserGiftEvidence } from '../server/agents/browser.ts';
import type { PipelineJob } from '../server/agents/pipeline.ts';
import type { AutomaticDriver } from '../server/acceptance/automatic.ts';
import type { OwnedPage, OwnedBrowserLease } from '../server/providers/browserbase-cdp.ts';
const job: PipelineJob = {
  id: 'fee:42',
  tokenId: 'token',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '100',
  decimals: 9,
  claimReference: 'claim',
  recipient: { platform: 'kick', providerId: 'kick:42', username: 'streamer' },
  phase: 'gifting',
  netUsdCents: 750,
  streamerBudgetUsdCents: 600,
  platformReserveUsdCents: 150,
  cardAccountId: 'card',
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  const counts = { creates: 0, purchases: 0, live: 0, releases: 0 };
  let throwSubmit = false;
  let evidence: BrowserGiftEvidence | null = null;
  let request: any;
  let session: any;
  const provider: any = {
    createSession: async (contextId: string, attemptId: string) => {
      counts.creates++;
      session = {
        id: 'session',
        projectId: 'project',
        contextId,
        attemptId,
        status: 'RUNNING',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      return session;
    },
    findSessions: async () => (session ? [session] : []),
    getSession: async () => session,
    releaseSession: async () => {
      counts.releases++;
      session = { ...session, status: 'COMPLETED' };
      return session;
    },
  };
  const driver: AutomaticDriver = {
    prepare: async (_scope, intent) => ({
      accountId: intent.accountId,
      recipientPlatform: 'kick',
      recipientUsername: intent.username,
      recipientProviderId: intent.providerId,
      kind: 'gift_sub',
      giftUnits: intent.giftUnits,
      nativeCurrency: 'USD',
      nativeTotalMinorUnits: 500,
      totalUsdCents: 500,
      observedAt: new Date().toISOString(),
    }),
    readQuote: async () => {
      throw Error('unused');
    },
    submit: async (_scope, _intent, _quote, before) => {
      before();
      counts.purchases++;
      if (throwSubmit) throw Error('timeout');
      return { completedAt: new Date().toISOString(), evidenceDigest: 'a'.repeat(64) };
    },
    inspect: async () => ({}),
  };
  const options = {
    browserbase: { apiKey: 'fixture', projectId: 'project' },
    accounts: {
      kick: {
        accountId: 'pogdotfun',
        contextId: 'context',
        cardAccountId: 'card',
        cardLast4: '1234',
        giftUnits: 1,
        maxSpendUsdCents: 600,
      },
    },
    liveGate: {
      requireLive: async () => {
        counts.live++;
      },
      assertFreshLive: () => {},
    },
    provider,
    connectorFactory: (ownsLease: (lease: Readonly<OwnedBrowserLease>) => boolean) => ({
      hasActiveConnection: () => false,
      withOwnedPage: async <T>(
        lease: OwnedBrowserLease,
        work: (scope: OwnedPage) => Promise<T>,
      ) => {
        const scope = {
          page: {},
          context: {},
          assertOwned: () => {
            assert.ok(ownsLease(lease));
          },
        } as OwnedPage;
        return work(scope);
      },
    }),
    drivers: { kick: driver },
    readEvidence: async (input: any) => {
      request = input;
      return evidence;
    },
  };
  return {
    db,
    counts,
    options,
    runner: new AgentBrowserRunner(db, options),
    setThrow: () => {
      throwSubmit = true;
    },
    setEvidence: (value: BrowserGiftEvidence | null) => {
      evidence = value;
    },
    request: () => request,
  };
}
test('agent browser fails before provisioning without independent issuer evidence', async () => {
  const f = fixture();
  try {
    const runner = new AgentBrowserRunner(f.db, { ...f.options, readEvidence: undefined });
    await assert.rejects(runner.submit(job));
    assert.equal(f.counts.creates, 0);
  } finally {
    f.db.close();
  }
});
test('agent browser never spends the platform reserve or accepts missing allocation evidence', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runner.submit({ ...job, streamerBudgetUsdCents: undefined }));
    await assert.rejects(f.runner.submit({ ...job, platformReserveUsdCents: 151 }));
    assert.equal(f.counts.creates, 0);
    await assert.rejects(
      f.runner.submit({ ...job, streamerBudgetUsdCents: 400, platformReserveUsdCents: 350 }),
    );
    assert.equal(f.counts.purchases, 0);
  } finally {
    f.db.close();
  }
});
test('agent browser commits one submission and duplicate calls never purchase again', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.runner.submit(job), f.runner.submit(job)]);
    assert.equal(results[0].reference, results[1].reference);
    assert.equal(f.counts.creates, 1);
    assert.equal(f.counts.purchases, 1);
    assert.equal(f.counts.live, 1);
    const restarted = new AgentBrowserRunner(f.db, f.options);
    await restarted.submit(job);
    assert.equal(f.counts.purchases, 1);
    assert.equal(await restarted.reconcile(job), null);
  } finally {
    f.db.close();
  }
});
test('agent browser timeout retains context lock and original operation across restart', async () => {
  const f = fixture();
  f.setThrow();
  try {
    await assert.rejects(f.runner.submit(job));
    const restarted = new AgentBrowserRunner(f.db, f.options);
    await restarted.submit(job);
    await assert.rejects(restarted.submit({ ...job, id: 'second-fee' }));
    assert.equal(f.counts.creates, 1);
    assert.equal(f.counts.purchases, 1);
    assert.equal(await restarted.reconcile(job), null);
  } finally {
    f.db.close();
  }
});
test('agent browser requires exact posted charge and receipt evidence before releasing context', async () => {
  const f = fixture();
  try {
    const result = await f.runner.submit(job);
    assert.equal(await f.runner.reconcile(job), null);
    const evidence: BrowserGiftEvidence = {
      jobId: job.id,
      cardAccountId: 'card',
      purchaseReference: result.reference,
      reference: 'receipt-1',
      chargeReference: 'charge-1',
      spentUsdCents: 500,
      currency: 'USD',
      recipientProviderId: 'kick:42',
      recipientUsername: 'streamer',
      platform: 'kick',
      giftUnits: 1,
      cardLast4: '1234',
      chargeStatus: 'POSTED',
      receiptDigest: 'b'.repeat(64),
      chargeDigest: 'c'.repeat(64),
      postedAt: new Date().toISOString(),
    };
    f.setEvidence({ ...evidence, spentUsdCents: 501 });
    await assert.rejects(f.runner.reconcile(job));
    assert.equal(f.counts.releases, 0);
    f.setEvidence(evidence);
    assert.deepEqual(await f.runner.reconcile(job), evidence);
    assert.equal(f.counts.releases, 1);
    assert.equal(f.request().quote.totalUsdCents, 500);
  } finally {
    f.db.close();
  }
});
test('agent browser does not provision with an invalid default Kick contract', async () => {
  const f = fixture();
  try {
    const runner = new AgentBrowserRunner(f.db, {
      ...f.options,
      drivers: undefined,
      kickContract: { version: 1 } as any,
    });
    await assert.rejects(runner.submit(job));
    assert.equal(f.counts.creates, 0);
  } finally {
    f.db.close();
  }
});
test('agent browser stale live evidence and lost lease stop the final click', async () => {
  for (const mode of ['live', 'lease']) {
    const f = fixture();
    try {
      if (mode === 'live')
        f.options.liveGate.assertFreshLive = () => {
          throw Error('offline');
        };
      else {
        const prepare = f.options.drivers.kick.prepare;
        f.options.drivers.kick.prepare = async (...args) => {
          const quote = await prepare(...args);
          f.db.exec('DELETE FROM agent_browser_context_locks');
          return quote;
        };
      }
      await assert.rejects(f.runner.submit(job));
      assert.equal(f.counts.purchases, 0);
    } finally {
      f.db.close();
    }
  }
});
test('agent browser reconciles uncertain provisioning identity without creating another session', async () => {
  const f = fixture();
  try {
    const create = f.options.provider.createSession;
    f.options.provider.createSession = async (...args: any[]) => {
      await create(...args);
      throw Error('timeout');
    };
    await assert.rejects(f.runner.submit(job));
    const restarted = new AgentBrowserRunner(f.db, f.options);
    await restarted.submit(job);
    assert.equal(await restarted.reconcile(job), null);
    assert.equal(f.counts.creates, 1);
    assert.equal(f.counts.purchases, 0);
    await assert.rejects(restarted.submit({ ...job, netUsdCents: 601 }));
  } finally {
    f.db.close();
  }
});
test('agent browser rejects future or pre-submission posted charges and unrelated evidence', async () => {
  const f = fixture();
  try {
    const result = await f.runner.submit(job);
    await f.runner.reconcile(job);
    const submittedAt = f.request().submittedAt;
    const evidence: BrowserGiftEvidence = {
      jobId: job.id,
      cardAccountId: 'card',
      purchaseReference: result.reference,
      reference: 'receipt-1',
      chargeReference: 'charge-1',
      spentUsdCents: 500,
      currency: 'USD',
      recipientProviderId: 'kick:42',
      recipientUsername: 'streamer',
      platform: 'kick',
      giftUnits: 1,
      cardLast4: '1234',
      chargeStatus: 'POSTED',
      postedAt: new Date().toISOString(),
      receiptDigest: 'b'.repeat(64),
      chargeDigest: 'c'.repeat(64),
    };
    for (const patch of [
      { postedAt: new Date(Date.now() + 4000).toISOString() },
      { postedAt: new Date(Date.parse(submittedAt) - 1).toISOString() },
      { postedAt: 'invalid' },
      { jobId: 'other' },
      { cardAccountId: 'other' },
      { purchaseReference: 'other' },
      { recipientProviderId: 'kick:99' },
      { recipientUsername: 'other' },
      { giftUnits: 2 },
      { cardLast4: '9999' },
      { chargeStatus: 'AUTHORIZED' as const },
      { currency: 'CAD' as const },
    ]) {
      f.setEvidence({ ...evidence, ...patch } as BrowserGiftEvidence);
      await assert.rejects(f.runner.reconcile(job));
      assert.equal(f.counts.releases, 0);
    }
  } finally {
    f.db.close();
  }
});
test('agent browser pins original funding references when reconciling a saved job', async () => {
  const f = fixture();
  try {
    const original = { ...job, depositReference: 'deposit-1', conversionReference: 'conversion-1' };
    await f.runner.submit(original);
    await assert.rejects(f.runner.reconcile({ ...original, depositReference: 'deposit-2' }));
    await assert.rejects(f.runner.submit({ ...original, conversionReference: 'conversion-2' }));
    assert.equal(f.counts.purchases, 1);
  } finally {
    f.db.close();
  }
});
test('agent browser requires the pipeline-reserved card before any browser actions', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runner.submit({ ...job, cardAccountId: 'other-card' }));
    await assert.rejects(f.runner.submit({ ...job, cardAccountId: undefined }));
    assert.equal(f.counts.creates, 0);
    assert.equal(f.counts.purchases, 0);
    await f.runner.submit(job);
    await assert.rejects(f.runner.submit({ ...job, cardAccountId: 'other-card' }));
  } finally {
    f.db.close();
  }
});
test('agent browser snapshots trusted evidence before asynchronous session release', async () => {
  const f = fixture();
  try {
    const result = await f.runner.submit(job);
    const evidence: BrowserGiftEvidence = {
      jobId: job.id,
      cardAccountId: 'card',
      purchaseReference: result.reference,
      reference: 'receipt-1',
      chargeReference: 'charge-1',
      spentUsdCents: 500,
      currency: 'USD',
      recipientProviderId: 'kick:42',
      recipientUsername: 'streamer',
      platform: 'kick',
      giftUnits: 1,
      cardLast4: '1234',
      chargeStatus: 'POSTED',
      postedAt: new Date().toISOString(),
      receiptDigest: 'b'.repeat(64),
      chargeDigest: 'c'.repeat(64),
    };
    f.setEvidence(evidence);
    const get = f.options.provider.getSession;
    f.options.provider.getSession = async () => {
      evidence.spentUsdCents = 501;
      return get();
    };
    assert.equal((await f.runner.reconcile(job))?.spentUsdCents, 500);
  } finally {
    f.db.close();
  }
});
