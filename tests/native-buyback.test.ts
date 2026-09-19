import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBuybackWorker } from '../server/agents/buyback.ts';
import type {
  BuybackOptions,
  NativeTransferRequest,
  PogSwapRequest,
  PogBurnRequest,
} from '../server/agents/buyback.ts';
import type { FeeLot } from '../server/agents/pipeline.ts';
const wallet = `0x${'11'.repeat(20)}` as const;
const token = `0x${'22'.repeat(20)}` as const;
const router = `0x${'33'.repeat(20)}` as const;
const codeHash = `0x${'44'.repeat(32)}` as const;
const tx = `0x${'55'.repeat(32)}` as const;
const lot: FeeLot = {
  id: 'fee:buyback',
  tokenId: 'streamer-token',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '200000000',
  decimals: 9,
  claimReference: 'verified-source-claim',
  recipient: { platform: 'twitch', providerId: 'twitch:123', username: 'streamer' },
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  let transferCalls = 0;
  let swapCalls = 0;
  let burnCalls = 0;
  let lost = false;
  let wrongTransfer = false;
  let fakeBurn = false;
  let transferRequest: NativeTransferRequest | undefined;
  let swapRequest: PogSwapRequest | undefined;
  let burnRequest: PogBurnRequest | undefined;
  const options: BuybackOptions = {
    enabled: true,
    target: {
      chainId: 4663,
      tokenAddress: token,
      devWallet: wallet,
      tokenCodeHash: codeHash,
      tokenDecimals: 18,
    },
    policy: {
      maxSlippageBps: 100,
      maxQuoteAgeMs: 30000,
      maxTargetGasWei: '10',
      minimumBuyWei: '10',
      maximumBuyWei: '1000',
      maxSourceAmountBaseUnits: { solana: '1000000000' },
      maxSourceGasBaseUnits: { solana: '1000' },
      allowedRouters: [router],
      maxJobsPerRun: 2,
    },
    transfers: {
      solana: {
        async quote(request) {
          return {
            id: 'route-quote',
            quotedAt: Date.now(),
            expiresAt: Date.now() + 20000,
            sourceChain: request.lot.chain,
            sourceAsset: request.lot.asset,
            sourceAmountBaseUnits: request.lot.amountBaseUnits,
            destinationChainId: 4663,
            recipient: wallet,
            expectedEthWei: '1000',
          };
        },
        async submit(request) {
          transferCalls++;
          transferRequest = request;
          if (lost) {
            lost = false;
            throw new Error('timeout');
          }
          return { reference: 'source-transfer' };
        },
        async reconcile(request) {
          return {
            operationId: request.operationId,
            finalized: true,
            sourceChain: request.lot.chain,
            sourceAsset: request.lot.asset,
            sourceClaimReference: request.lot.claimReference,
            sourceAmountBaseUnits: request.lot.amountBaseUnits,
            sourceDebitBaseUnits: request.lot.amountBaseUnits,
            sourceGasBaseUnits: '100',
            sourceTransactionHash: 'solana-final-signature',
            destinationChainId: 4663,
            recipient: wrongTransfer ? token : wallet,
            ethAmountWei: '1000',
            destinationTransactionHash: tx,
            evidenceId: 'bridge-final-evidence',
          };
        },
      },
    },
    swap: {
      async verifyTarget(target) {
        return { ...target, verified: true, signerAddress: wallet, observedAt: Date.now() };
      },
      async quote(request) {
        return {
          id: 'swap-quote',
          quotedAt: Date.now(),
          expiresAt: Date.now() + 20000,
          chainId: 4663,
          tokenAddress: token,
          recipient: wallet,
          routerAddress: router,
          inputEthWei: request.inputEthWei,
          expectedTokenBaseUnits: '500',
        };
      },
      async submit(request) {
        swapCalls++;
        swapRequest = request;
        return { reference: 'buy-tx' };
      },
      async reconcile(request) {
        return {
          operationId: request.operationId,
          finalized: true,
          chainId: 4663,
          tokenAddress: token,
          tokenCodeHash: codeHash,
          tokenDecimals: 18,
          from: wallet,
          recipient: wallet,
          routerAddress: router,
          ethSpentWei: request.inputEthWei,
          gasWei: '5',
          tokenAmountBaseUnits: '500',
          transactionHash: `0x${'66'.repeat(32)}`,
          evidenceId: 'swap-final-evidence',
        };
      },
    },
    burn: {
      async submit(request) {
        burnCalls++;
        burnRequest = request;
        return { reference: 'burn-tx' };
      },
      async reconcile(request) {
        return {
          operationId: request.operationId,
          finalized: true,
          chainId: 4663,
          tokenAddress: token,
          tokenCodeHash: codeHash,
          from: wallet,
          amountBaseUnits: request.tokenAmountBaseUnits,
          totalSupplyBefore: '10000',
          totalSupplyAfter: fakeBurn ? '10000' : '9500',
          walletBalanceBefore: '500',
          walletBalanceAfter: '0',
          gasWei: '5',
          transactionHash: `0x${'77'.repeat(32)}`,
          evidenceId: 'burn-final-evidence',
        };
      },
    },
  };
  return {
    db,
    options,
    worker: createBuybackWorker(db, options),
    timeout() {
      lost = true;
    },
    wrongRecipient() {
      wrongTransfer = true;
    },
    fakeBurn() {
      fakeBurn = true;
    },
    get counts() {
      return [transferCalls, swapCalls, burnCalls];
    },
    get requests() {
      return { transferRequest, swapRequest, burnRequest };
    },
  };
}
async function cycle(worker: ReturnType<typeof createBuybackWorker>, n = 6) {
  for (let i = 0; i < n; i++) await worker.runOnce();
}
test('native20% lot is routed into actual ETH, purchased and supply burned with residual retained', async () => {
  const f = fixture();
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  const job = f.worker.list()[0];
  assert.equal(job.phase, 'completed');
  assert.deepEqual(f.counts, [1, 1, 1]);
  assert.equal(job.amountBaseUnits, lot.amountBaseUnits);
  assert.equal(job.receivedEthWei, '1000');
  assert.equal(job.ethSpentWei, '980');
  assert.equal(job.burnedTokenBaseUnits, '500');
  assert.equal(job.residualEthWei, '10');
  assert.equal(job.targetGasSpentWei, '10');
  assert.equal(job.residualTokenBaseUnits, '0');
  assert.equal(f.requests.swapRequest?.minimumTokenBaseUnits, '495');
  f.db.close();
});
test('timeout restarts reconcile the same transfer identity without submitting twice', async () => {
  const f = fixture();
  f.timeout();
  f.worker.recordClaim(lot);
  await f.worker.runOnce();
  const restarted = createBuybackWorker(f.db, f.options);
  await cycle(restarted);
  assert.deepEqual(f.counts, [1, 1, 1]);
  assert.equal(restarted.list()[0].phase, 'completed');
  f.db.close();
});
test('disabled and missing bindings do not transfer any funds', async () => {
  const f = fixture();
  const disabled = createBuybackWorker(f.db, { ...f.options, enabled: false });
  disabled.recordClaim(lot);
  await cycle(disabled);
  assert.deepEqual(f.counts, [0, 0, 0]);
  assert.equal(disabled.ready('solana'), false);
  f.db.close();
  const g = fixture();
  const missing = createBuybackWorker(g.db, { ...g.options, burn: undefined });
  missing.recordClaim(lot);
  await cycle(missing);
  assert.equal(missing.ready('solana'), false);
  assert.deepEqual(g.counts, [0, 0, 0]);
  g.db.close();
});
test('wrong destination and unchanged supply never advance financial state', async () => {
  const f = fixture();
  f.wrongRecipient();
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  assert.equal(f.worker.list()[0].phase, 'transferring');
  assert.equal(f.counts[1], 0);
  f.db.close();
  const g = fixture();
  g.fakeBurn();
  g.worker.recordClaim(lot);
  await cycle(g.worker);
  assert.equal(g.worker.list()[0].phase, 'burning');
  assert.equal(g.worker.list()[0].burnedTokenBaseUnits, undefined);
  g.db.close();
});
test('source allocation replay and repeated claim evidence cannot double fund a buyback', () => {
  const f = fixture();
  f.worker.recordClaim(lot);
  f.worker.recordClaim(lot);
  assert.equal(f.worker.list().length, 1);
  assert.throws(() => f.worker.recordClaim({ ...lot, amountBaseUnits: '200000001' }), /conflict/i);
  assert.throws(() => f.worker.recordClaim({ ...lot, id: 'another:buyback' }), /claim|UNIQUE/i);
  f.db.close();
});
test('unfinalized evidence and low swap output remain held without quote credit', async () => {
  const f = fixture();
  const transfer = f.options.transfers.solana!;
  const original = transfer.reconcile;
  transfer.reconcile = async (request) => ({ ...(await original(request))!, finalized: false });
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  assert.equal(f.worker.list()[0].receivedEthWei, undefined);
  assert.equal(f.counts[1], 0);
  f.db.close();
  const g = fixture();
  const swap = g.options.swap!;
  const reconcile = swap.reconcile;
  swap.reconcile = async (request) => ({
    ...(await reconcile(request))!,
    tokenAmountBaseUnits: '1',
  });
  g.worker.recordClaim(lot);
  await cycle(g.worker);
  assert.equal(g.worker.list()[0].phase, 'buying');
  assert.equal(g.counts[2], 0);
  g.db.close();
});
test('fair bounded queue visits later jobs even when earlier jobs are held', async () => {
  const f = fixture();
  f.options.policy.maxJobsPerRun = 1;
  f.options.transfers.solana = undefined;
  const worker = createBuybackWorker(f.db, f.options);
  worker.recordClaim(lot);
  worker.recordClaim({ ...lot, id: 'second:buyback', claimReference: 'second-claim' });
  await worker.runOnce();
  await worker.runOnce();
  assert.ok(worker.list().every((job) => job.issue));
  f.db.close();
});

test('malformed runtime bindings hold before source submission', async () => {
  const f = fixture();
  const worker = createBuybackWorker(f.db, { ...f.options, burn: {} as BuybackOptions['burn'] });
  worker.recordClaim(lot);
  assert.equal(worker.ready('solana'), false);
  await cycle(worker);
  assert.deepEqual(f.counts, [0, 0, 0]);
  f.db.close();
});
test('case variants of an EVM payout hash cannot credit two native allocations', async () => {
  const f = fixture();
  const transfer = f.options.transfers.solana!;
  const original = transfer.reconcile;
  transfer.reconcile = async (request) => {
    const result = (await original(request))!;
    return {
      ...result,
      evidenceId: request.operationId,
      sourceTransactionHash: request.operationId,
      destinationTransactionHash: `0x${(request.lot.id === lot.id ? 'ab' : 'AB').repeat(32)}`,
    };
  };
  f.worker.recordClaim(lot);
  f.worker.recordClaim({ ...lot, id: 'second:buyback', claimReference: 'second-claim' });
  await cycle(f.worker, 2);
  assert.equal(f.worker.list().filter((job) => job.phase === 'funded').length, 1);
  assert.equal(f.worker.list().filter((job) => job.phase === 'transferring').length, 1);
  f.db.close();
});
test('truthy malformed finality is never financial evidence', async () => {
  const f = fixture();
  const transfer = f.options.transfers.solana!;
  const original = transfer.reconcile;
  transfer.reconcile = async (request) => ({
    ...(await original(request))!,
    finalized: 'false' as unknown as boolean,
  });
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  assert.equal(f.worker.list()[0].receivedEthWei, undefined);
  assert.equal(f.counts[1], 0);
  f.db.close();
});

test('deployment and signer ownership must be verified before any source funds move', async () => {
  const f = fixture();
  f.options.swap!.verifyTarget = async (target) => ({
    ...target,
    verified: true,
    signerAddress: token,
    observedAt: Date.now(),
  });
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  assert.deepEqual(f.counts, [0, 0, 0]);
  assert.equal(f.worker.list()[0].targetVerifiedAt, undefined);
  f.db.close();
});
test('source debit including gas can never consume more than the native20% allocation', async () => {
  const f = fixture();
  const transfer = f.options.transfers.solana!;
  const original = transfer.reconcile;
  transfer.reconcile = async (request) => ({
    ...(await original(request))!,
    sourceDebitBaseUnits: '200000001',
  });
  f.worker.recordClaim(lot);
  await cycle(f.worker);
  assert.equal(f.worker.list()[0].receivedEthWei, undefined);
  assert.equal(f.counts[1], 0);
  f.db.close();
});
test('concurrent workers reserve each irreversible stage exactly once', async () => {
  const f = fixture();
  f.worker.recordClaim(lot);
  const other = createBuybackWorker(f.db, f.options);
  for (let n = 0; n < 6; n++) await Promise.all([f.worker.runOnce(), other.runOnce()]);
  assert.deepEqual(f.counts, [1, 1, 1]);
  assert.equal(f.worker.list()[0].phase, 'completed');
  f.db.close();
});

test('the official POG target is durably pinned across worker restarts', () => {
  const f = fixture();
  f.worker.recordClaim(lot);
  assert.throws(
    () =>
      createBuybackWorker(f.db, {
        ...f.options,
        target: { ...f.options.target, tokenAddress: router },
      }),
    /target.*binding|official.*target/i,
  );
  assert.throws(
    () =>
      createBuybackWorker(f.db, {
        ...f.options,
        target: { ...f.options.target, devWallet: router },
      }),
    /target.*binding|official.*target/i,
  );
  assert.deepEqual(f.counts, [0, 0, 0]);
  f.db.close();
});
