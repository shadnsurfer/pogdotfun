import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { createServices } from '../server/services.ts';
import { publicAddresses } from '../server/treasury/public-addresses.ts';
import { createOperations } from '../server/operations.ts';
import { autonomousRuntime } from '../server/agents/runtime.ts';
import type { FeeLot, PipelineAdapters } from '../server/agents/pipeline.ts';
import type { StreamerLiveGate } from '../server/workers/streamer-live.ts';
const lot: FeeLot = {
  id: 'fee-1',
  tokenId: 'token-1',
  chain: 'bnb',
  asset: 'BNB',
  amountBaseUnits: '100',
  decimals: 18,
  claimReference: 'chain-event-1',
  recipient: { platform: 'twitch', providerId: 'twitch:123', username: 'streamer' },
};
function adapters(counter: { deposits: number }): PipelineAdapters {
  return {
    async deposit() {
      counter.deposits++;
      return { reference: 'deposit-1' };
    },
    async reconcileDeposit() {
      return null;
    },
    async convert() {
      throw new Error('unused');
    },
    async reconcileConversion() {
      return null;
    },
    async live() {
      return false;
    },
    async cardReady() {
      return null;
    },
    async gift() {
      throw new Error('unused');
    },
    async reconcileGift() {
      return null;
    },
  };
}
test('disabled automation never scans, acknowledges or deposits fees', async () => {
  const db = new DatabaseSync(':memory:');
  const counter = { deposits: 0 };
  let scans = 0;
  const services = createServices(db, createOperations(db), {
    env: { POG_AUTOMATION_ENABLED: 'true', POG_TRANSACTIONS_ENABLED: 'false' },
    pipelineAdapters: adapters(counter),
    feeSources: [
      {
        async scan() {
          scans++;
          return [lot];
        },
      },
    ],
  });
  await services.runOnce();
  assert.equal(scans, 0);
  assert.equal(counter.deposits, 0);
  await services.close();
  db.close();
});
test('one failed fee source cannot stop healthy sources or funded pipeline jobs', async () => {
  const db = new DatabaseSync(':memory:');
  const counter = { deposits: 0 };
  let acknowledged = false;
  const services = createServices(db, createOperations(db), {
    env: { POG_AUTOMATION_ENABLED: 'true', POG_TRANSACTIONS_ENABLED: 'true' },
    pipelineAdapters: adapters(counter),
    feeSources: [
      {
        async scan() {
          throw new Error('source unavailable');
        },
      },
      {
        async scan() {
          return [lot];
        },
        acknowledge(id: string) {
          assert.ok(db.prepare('SELECT id FROM agent_fee_jobs WHERE id=?').get(`${id}:streamer`));
          acknowledged = true;
        },
      },
    ],
  });
  await services.runOnce();
  assert.equal(counter.deposits, 1);
  assert.equal(acknowledged, true);
  const child = JSON.parse(String(db.prepare('SELECT payload FROM agent_fee_jobs').get()!.payload));
  assert.equal(child.amountBaseUnits, '80');
  const reserve = JSON.parse(
    String(db.prepare('SELECT payload FROM agent_native_buyback_outbox').get()!.payload),
  );
  assert.equal(reserve.amountBaseUnits, '20');
  assert.equal(reserve.id, 'fee-1:buyback');
  await services.close();
  db.close();
});
test('fee source receives route readiness and cannot deposit a held platform lot', async () => {
  const db = new DatabaseSync(':memory:');
  const counter = { deposits: 0 };
  let ready: boolean | undefined;
  const services = createServices(db, createOperations(db), {
    env: { POG_AUTOMATION_ENABLED: 'true', POG_TRANSACTIONS_ENABLED: 'true' },
    pipelineAdapters: adapters(counter),
    feeRouteReady: () => false,
    feeSources: [
      {
        async scan(policy) {
          ready = policy?.canClaim(lot);
          return [lot];
        },
      },
    ],
  });
  await services.runOnce();
  assert.equal(ready, false);
  assert.equal(counter.deposits, 0);
  await services.close();
  db.close();
});
test('runtime route readiness requires platform browser/card binding and Kick contract', () => {
  const db = new DatabaseSync(':memory:');
  const env = {
    POG_COINBASE_KEY_NAME: 'key',
    POG_COINBASE_PRIVATE_KEY: 'private',
    BROWSERBASE_API_KEY: 'key',
    BROWSERBASE_PROJECT_ID: 'project',
    POG_COINBASE_ACCOUNT_ID: 'coinbase',
    POG_COINBASE_SOL_ADDRESS: 'address',
    POG_TWITCH_ACCOUNT_ID: 'buyer',
    POG_TWITCH_CONTEXT_ID: 'context',
    POG_KICK_ACCOUNT_ID: 'buyer',
    POG_KICK_CONTEXT_ID: 'context-kick',
    POG_CARD_ACCOUNT_ID: 'card',
    POG_CARD_LAST4: '1234',
  };
  const integration = {
    cardEvidence: {
      async readBalance() {
        return null;
      },
      async readCharge() {
        return null;
      },
    },
    async readGiftEvidence() {
      return null;
    },
  };
  const liveGate = {
    async requireLive() {
      return {};
    },
    assertFreshLive() {},
  } as unknown as StreamerLiveGate;
  const provider = () => {
    throw new Error('No network calls expected');
  };
  const runtime = autonomousRuntime(db, env, provider, liveGate, integration)!;
  const sol = { chain: 'solana' as const, recipient: lot.recipient };
  assert.equal(runtime.feeRouteReady(sol), true);
  assert.equal(
    runtime.feeRouteReady({
      ...sol,
      recipient: { platform: 'kick', providerId: 'kick:123', username: 'streamer' },
    }),
    false,
  );
  assert.equal(runtime.feeRouteReady(lot), false);
  const bridged = autonomousRuntime(db, env, provider, liveGate, {
    ...integration,
    routes: {
      bnb: {
        accountId: 'coinbase-eth',
        address: 'verified-destination',
        asset: 'ETH',
        network: 'ethereum',
        bridgeTransfer: {
          async send() {
            throw new Error('Readiness must not transfer');
          },
          async reconcile() {
            return null;
          },
        },
      },
    },
  })!;
  assert.equal(
    bridged.feeRouteReady(lot),
    true,
    'an explicit BNB-to-ETH route is eligible for later authenticated verification',
  );
  const missing = autonomousRuntime(
    db,
    { ...env, POG_TWITCH_CONTEXT_ID: '' },
    provider,
    liveGate,
    integration,
  )!;
  assert.equal(missing.feeRouteReady(sol), false);
  db.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function buybackFixture() {
  const wallet = publicAddresses.devWallet,
    token = bs58.encode(new Uint8Array(32).fill(22)),
    router = bs58.encode(new Uint8Array(32).fill(33)),
    tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const transferTx = `0x${'55'.repeat(32)}` as const,
    destinationTx = bs58.encode(new Uint8Array(64).fill(55)),
    buyTx = bs58.encode(new Uint8Array(64).fill(66)),
    burnTx = bs58.encode(new Uint8Array(64).fill(77));
  const count = { transfer: 0, buy: 0, burn: 0 };
  const binding: NonNullable<import('../server/services.ts').ServiceOptions['buyback']> = {
    target: {
      chain: 'solana',
      mintAddress: token,
      devWallet: wallet,
      tokenProgramId: tokenProgram,
      tokenDecimals: 9,
    },
    policy: {
      maxSlippageBps: 100,
      maxQuoteAgeMs: 30000,
      maxTargetFeeLamports: '10',
      minimumBuyLamports: '10',
      maximumBuyLamports: '1000',
      maxSourceAmountBaseUnits: { bnb: '1000' },
      maxSourceGasBaseUnits: { bnb: '1' },
      allowedRouterPrograms: [router],
    },
    transfers: {
      bnb: {
        async quote(r) {
          return {
            id: 'transfer-quote',
            quotedAt: Date.now(),
            expiresAt: Date.now() + 20000,
            sourceChain: r.lot.chain,
            sourceAsset: r.lot.asset,
            sourceAmountBaseUnits: r.lot.amountBaseUnits,
            destinationChain: 'solana',
            recipient: wallet,
            expectedSolLamports: '1000',
          };
        },
        async submit() {
          count.transfer++;
          return { reference: 'transfer' };
        },
        async reconcile(r) {
          return {
            operationId: r.operationId,
            finalized: true,
            sourceChain: r.lot.chain,
            sourceAsset: r.lot.asset,
            sourceClaimReference: r.lot.claimReference,
            sourceAmountBaseUnits: r.lot.amountBaseUnits,
            sourceDebitBaseUnits: r.lot.amountBaseUnits,
            sourceGasBaseUnits: '1',
            sourceTransactionId: transferTx,
            destinationChain: 'solana',
            recipient: wallet,
            solAmountLamports: '1000',
            destinationSignature: destinationTx,
            evidenceId: 'transfer-evidence',
          };
        },
      },
    },
    swap: {
      async verifyTarget(target) {
        return { ...target, verified: true, signerAddress: wallet, observedAt: Date.now() };
      },
      async quote(r) {
        return {
          id: 'buy-quote',
          quotedAt: Date.now(),
          expiresAt: Date.now() + 20000,
          chain: 'solana',
          mintAddress: token,
          recipient: wallet,
          routerProgramId: router,
          inputSolLamports: r.inputSolLamports,
          expectedTokenBaseUnits: '500',
        };
      },
      async submit() {
        count.buy++;
        return { reference: 'buy' };
      },
      async reconcile(r) {
        return {
          operationId: r.operationId,
          finalized: true,
          chain: 'solana',
          mintAddress: token,
          tokenProgramId: tokenProgram,
          tokenDecimals: 9,
          from: wallet,
          recipient: wallet,
          routerProgramId: router,
          solSpentLamports: r.inputSolLamports,
          feeLamports: '5',
          tokenAmountBaseUnits: '500',
          signature: buyTx,
          evidenceId: 'buy-evidence',
        };
      },
    },
    burn: {
      async submit() {
        count.burn++;
        return { reference: 'burn' };
      },
      async reconcile(r) {
        return {
          operationId: r.operationId,
          finalized: true,
          chain: 'solana',
          mintAddress: token,
          tokenProgramId: tokenProgram,
          instruction: 'BurnChecked',
          from: wallet,
          amountBaseUnits: r.tokenAmountBaseUnits,
          totalSupplyBefore: '10000',
          totalSupplyAfter: '9500',
          walletBalanceBefore: '500',
          walletBalanceAfter: '0',
          feeLamports: '5',
          signature: burnTx,
          evidenceId: 'burn-evidence',
        };
      },
    },
  };
  return { binding, count };
}
test(
  'pending intake and streamer submission cannot block later buyback phases or release their own locks',
  { timeout: 5000 },
  async () => {
    const db = new DatabaseSync(':memory:');
    const counter = { deposits: 0 };
    const buyback = buybackFixture();
    const deposit = deferred<{ reference: string }>(),
      scan = deferred<FeeLot[]>();
    let scans = 0;
    const api = adapters(counter);
    api.deposit = () => {
      counter.deposits++;
      return deposit.promise;
    };
    const services = createServices(db, createOperations(db), {
      env: { POG_AUTOMATION_ENABLED: 'true', POG_TRANSACTIONS_ENABLED: 'true' },
      workerObservationMs: 5,
      pipelineAdapters: api,
      buyback: buyback.binding,
      feeSources: [
        {
          scan() {
            scans++;
            return scans === 1 ? Promise.resolve([lot]) : scan.promise;
          },
        },
      ],
    });
    try {
      for (let i = 0; i < 8; i++) await services.runOnce();
      assert.equal(counter.deposits, 1, 'pending submission retains worker single-flight lock');
      assert.equal(scans, 2, 'pending source scan is observed again, never restarted');
      assert.deepEqual(buyback.count, { transfer: 1, buy: 1, burn: 1 });
      const saved = JSON.parse(
        String(db.prepare('SELECT payload FROM agent_buyback_jobs').get()!.payload),
      );
      assert.equal(saved.phase, 'completed');
      const ledger = services.publicNativeBuybacks();
      assert.equal(ledger.burnedTokenBaseUnits, '500');
      assert.equal(ledger.buybackCount, 1);
      assert.equal(ledger.burnCount, 1);
      assert.equal(ledger.sources[0].claimedBaseUnits, '100');
      assert.equal(ledger.sources[0].streamerBaseUnits, '80');
      assert.equal(ledger.sources[0].buybackBaseUnits, '20');
      const publicJson = JSON.stringify(ledger);
      for (const field of [
        'transferRequest',
        'swapRequest',
        'burnRequest',
        'devWallet',
        'claimReference',
        'evidenceId',
      ])
        assert.equal(publicJson.includes(field), false, field);

      let closed = false;
      const closing = services.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(
        closed,
        false,
        'close waits for underlying financial operations, not observation timers',
      );
      scan.reject(Error('late source failure'));
      deposit.reject(Error('late deposit timeout'));
      await closing;
      const readOnly = createServices(db, createOperations(db), { env: {} });
      assert.deepEqual(
        readOnly.publicNativeBuybacks(),
        ledger,
        'persisted ledger stays readable without any spending bindings',
      );
      await readOnly.close();
      assert.equal(counter.deposits, 1);
      assert.equal(((await services.runOnce()) as { state: string }).state, 'disabled');
    } finally {
      scan.resolve([]);
      deposit.resolve({ reference: 'late' });
      await services.close();
      db.close();
    }
  },
);

test(
  'a pending buyback transfer retains its lock while streamer settlement finishes',
  { timeout: 5000 },
  async () => {
    const db = new DatabaseSync(':memory:');
    const count = { deposits: 0 };
    const buyback = buybackFixture();
    const transfer = deferred<{ reference: string }>();
    buyback.binding.transfers.bnb!.submit = () => {
      buyback.count.transfer++;
      return transfer.promise;
    };
    const api = adapters(count);
    api.reconcileDeposit = async (job) => ({ reference: 'deposit-proof', jobId: job.id });
    api.convert = async () => ({ reference: 'order' });
    api.reconcileConversion = async (job) => ({
      reference: 'order',
      jobId: job.id,
      netUsdCents: 6000,
    });
    api.live = async () => true;
    api.cardReady = async () => ({
      cardAccountId: 'card',
      availableCreditCents: 6000,
      observedAt: Date.now(),
    });
    let gifts = 0;
    api.gift = async () => {
      gifts++;
      return { reference: 'purchase' };
    };
    api.reconcileGift = async (job) => ({
      jobId: job.id,
      cardAccountId: 'card',
      chargeStatus: 'POSTED',
      purchaseReference: 'purchase',
      reference: 'receipt',
      chargeReference: 'charge',
      spentUsdCents: 5999,
      recipientProviderId: job.recipient.providerId,
      currency: 'USD',
    });
    const services = createServices(db, createOperations(db), {
      env: { POG_AUTOMATION_ENABLED: 'true', POG_TRANSACTIONS_ENABLED: 'true' },
      workerObservationMs: 5,
      pipelineAdapters: api,
      buyback: buyback.binding,
      feeSources: [{ scan: async () => [lot] }],
    });
    try {
      for (let i = 0; i < 8; i++) await services.runOnce();
      assert.equal(count.deposits, 1);
      assert.equal(gifts, 1);
      assert.equal(buyback.count.transfer, 1);
      assert.equal(services.publicPayments()[0].phase, 'completed');
      assert.equal(
        JSON.parse(String(db.prepare('SELECT payload FROM agent_buyback_jobs').get()!.payload))
          .phase,
        'transferring',
      );
    } finally {
      transfer.reject(Error('late transfer failure'));
      await services.close();
      db.close();
    }
  },
);
