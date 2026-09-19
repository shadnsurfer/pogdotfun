import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createCoinbaseSettlement,
  type CoinbaseSettlementOptions,
} from '../server/agents/settlement.ts';
import { CoinbaseCardReadiness } from '../server/providers/coinbase-card.ts';
import type { PipelineJob } from '../server/agents/pipeline.ts';
const job: PipelineJob = {
  id: 'fee-1',
  tokenId: 'token-1',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '1234567891',
  decimals: 9,
  claimReference: 'claim-1',
  recipient: { platform: 'twitch', providerId: 'twitch:1', username: 'alice' },
  phase: 'depositing',
};
function fixture(db: DatabaseSync) {
  const state = {
    sends: 0,
    sells: 0,
    baseSize: '',
    addressVerified: false,
    depositMatch: true,
    orderFound: true,
    receivedAmount: '',
    orderId: 'order-1',
  };
  const options: CoinbaseSettlementOptions = {
    routes: {
      solana: { accountId: 'account-1', address: 'address-1', network: 'solana', asset: 'SOL' },
    },
    transfer: {
      send: async (_lot, address) => {
        assert.equal(address.address, 'address-1');
        assert.ok(state.addressVerified);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_settlements').get()!.n, 1);
        state.sends++;
        return { reference: 'chain-1' };
      },
      reconcile: async () => ({
        hash: 'chain-1',
        amountBaseUnits: job.amountBaseUnits,
        chain: 'solana',
        asset: 'SOL',
      }),
    },
    coinbase: {
      verifyDepositAddress: async (input) => {
        state.addressVerified = true;
        return { ...input, addressId: 'address-id', verifiedAt: Date.now() };
      },
      listTransactionIds: async () => ({ transactionIds: ['tx-1'], nextStartingAfter: null }),
      reconcileDeposit: async (id, expected) => {
        state.receivedAmount = expected.amount;
        if (!state.depositMatch) throw new Error('missing evidence');
        return { ...expected, transactionId: id, verifiedAt: Date.now() };
      },
      createMarketSell: async (input) => {
        state.sells++;
        state.baseSize = input.baseSize;
        return { orderId: state.orderId, clientOrderId: input.clientOrderId };
      },
      findMarketSell: async (id) =>
        state.orderFound ? { orderId: state.orderId, clientOrderId: id } : null,
      reconcileMarketSell: async (id, input) => ({
        ...input,
        orderId: id,
        grossQuoteAmount: '123.45',
        feesQuoteAmount: '0.01',
        netQuoteAmount: '123.44',
        spendableUsdCents: '12344',
      }),
    },
    card: new CoinbaseCardReadiness(),
    cardAccounts: { twitch: 'card-1' },
    live: async () => true,
    browser: { submit: async () => ({ reference: 'purchase-1' }), reconcile: async () => null },
  };
  return { state, options };
}
test('settlement authenticates destination and converts only exact attributed deposit amount', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const adapters = createCoinbaseSettlement(db, options);
  assert.deepEqual(await adapters.deposit(job), { reference: 'chain-1' });
  assert.deepEqual(await adapters.reconcileDeposit(job), {
    reference: 'account-1:tx-1',
    jobId: job.id,
  });
  await adapters.convert(job);
  assert.equal(state.baseSize, '1.234567891');
  assert.equal(state.receivedAmount, '1.234567891');
  const proof = await adapters.reconcileConversion(job);
  assert.equal(proof?.netUsdCents, 12344);
  assert.equal(await adapters.cardReady({ ...job, netUsdCents: 12344 }), null);
  assert.equal(state.sells, 1);
  db.close();
});
test('missing receive hash evidence prevents sale and unverified destination prevents send', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  state.depositMatch = false;
  const adapters = createCoinbaseSettlement(db, options);
  await adapters.deposit(job);
  assert.equal(await adapters.reconcileDeposit(job), null);
  await assert.rejects(adapters.convert(job));
  assert.equal(state.sells, 0);
  options.coinbase.verifyDepositAddress = async () => {
    throw new Error('wrong destination');
  };
  await assert.rejects(adapters.deposit({ ...job, id: 'fee-2' }));
  assert.equal(state.sends, 1);
  db.close();
});
test('lost sell response recovers read-only after restart and never submits twice', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  let id = '';
  options.coinbase.createMarketSell = async (input) => {
    state.sells++;
    id = input.clientOrderId;
    throw new Error('timeout');
  };
  const first = createCoinbaseSettlement(db, options);
  await first.deposit(job);
  await first.reconcileDeposit(job);
  await assert.rejects(first.convert(job));
  const next = createCoinbaseSettlement(db, options);
  await assert.rejects(next.convert(job));
  assert.ok(id.startsWith('pog-'));
  assert.equal((await next.reconcileConversion(job))?.reference, 'order-1');
  assert.equal(state.sells, 1);
  db.close();
});
test('conflicting amount, missing EVM bridge and chain mismatch fail closed', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const adapters = createCoinbaseSettlement(db, options);
  await adapters.deposit(job);
  await assert.rejects(adapters.deposit({ ...job, amountBaseUnits: '1000000000' }));
  options.transfer.reconcile = async () => ({
    hash: 'chain-1',
    amountBaseUnits: job.amountBaseUnits,
    chain: 'bnb',
    asset: 'BNB',
  });
  await assert.rejects(adapters.reconcileDeposit(job));
  await assert.rejects(
    adapters.deposit({ ...job, id: 'bnb-1', chain: 'bnb', asset: 'BNB', decimals: 18 }),
  );
  assert.equal(state.sends, 1);
  db.close();
});
test('timeout before destination validation cannot later send funds', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  options.timeoutMs = 5;
  options.coinbase.verifyDepositAddress = async (input) => {
    await new Promise((r) => setTimeout(r, 15));
    return { ...input, addressId: 'address-id', verifiedAt: Date.now() };
  };
  await assert.rejects(createCoinbaseSettlement(db, options).deposit(job));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(state.sends, 0);
  db.close();
});

test('deposit discovery has a total deadline and does not issue another read after timeout', async () => {
  const db = new DatabaseSync(':memory:');
  const { options } = fixture(db);
  options.timeoutMs = 5;
  const api = createCoinbaseSettlement(db, options);
  await api.deposit(job);
  let reads = 0;
  options.coinbase.listTransactionIds = async () => ({
    transactionIds: ['tx-1', 'tx-2'],
    nextStartingAfter: null,
  });
  options.coinbase.reconcileDeposit = async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 15));
    throw new Error('unavailable');
  };
  await assert.rejects(api.reconcileDeposit(job));
  assert.equal(reads, 1);
  db.close();
});

test('read-only preflight failure recovers from missing settlement row without duplicate sends', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const verify = options.coinbase.verifyDepositAddress;
  options.coinbase.verifyDepositAddress = async () => {
    throw new Error('temporary address read failure');
  };
  const first = createCoinbaseSettlement(db, options);
  await assert.rejects(first.deposit(job));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_settlements').get()!.n, 0);
  assert.equal(state.sends, 0);
  options.coinbase.verifyDepositAddress = verify;
  const restarted = createCoinbaseSettlement(db, options);
  await restarted.reconcileDeposit(job);
  assert.equal(state.sends, 1);
  assert.equal((await restarted.reconcileDeposit(job))?.reference, 'account-1:tx-1');
  await restarted.reconcileDeposit(job);
  assert.equal(state.sends, 1);
  db.close();
});

test('conversion crash before sale journal recovers once but stored uncertain sale stays read-only', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const api = createCoinbaseSettlement(db, options);
  await api.deposit(job);
  await api.reconcileDeposit(job);
  // Pipeline committed converting, but died before calling convert.
  const restarted = createCoinbaseSettlement(db, options);
  await restarted.reconcileConversion({ ...job, phase: 'converting' });
  assert.equal(state.sells, 1);
  assert.equal(
    (await restarted.reconcileConversion({ ...job, phase: 'converting' }))?.reference,
    'order-1',
  );
  assert.equal(state.sells, 1);
  db.close();
});

test('reserved transfer with uncertain send remains held without an explicit safe-resume adapter', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  options.transfer.send = async () => {
    state.sends++;
    throw new Error('broadcast response lost');
  };
  options.transfer.reconcile = async () => null;
  const api = createCoinbaseSettlement(db, options);
  await assert.rejects(api.deposit(job));
  const restarted = createCoinbaseSettlement(db, options);
  assert.equal(await restarted.reconcileDeposit(job), null);
  assert.equal(await restarted.reconcileDeposit(job), null);
  assert.equal(state.sends, 1);
  db.close();
});

test('explicit safe-resume capability is used only while transfer evidence is absent', async () => {
  const db = new DatabaseSync(':memory:');
  const { options } = fixture(db);
  let resumes = 0;
  options.transfer.send = async () => {
    throw new Error('failed before underlying intent');
  };
  options.transfer.reconcile = async () => null;
  options.transfer.resumeUnsubmitted = async (_job, destination) => {
    resumes++;
    assert.equal(destination.address, 'address-1');
    return { reference: 'resumed-chain-1' };
  };
  const api = createCoinbaseSettlement(db, options);
  await assert.rejects(api.deposit(job));
  assert.equal(await api.reconcileDeposit(job), null);
  assert.equal(resumes, 1);
  assert.equal(await api.reconcileDeposit(job), null);
  assert.equal(resumes, 1);
  db.close();
});

test('concurrent recovery workers cannot duplicate an unstarted transfer or sale', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const first = createCoinbaseSettlement(db, options),
    second = createCoinbaseSettlement(db, options);
  await Promise.allSettled([first.reconcileDeposit(job), second.reconcileDeposit(job)]);
  assert.equal(state.sends, 1);
  await first.reconcileDeposit(job);
  await Promise.allSettled([first.reconcileConversion(job), second.reconcileConversion(job)]);
  assert.equal(state.sells, 1);
  db.close();
});

test('explicit EVM bridge output binds and sells only the verified target asset amount', async () => {
  const db = new DatabaseSync(':memory:');
  const { options, state } = fixture(db);
  const evmJob: PipelineJob = {
    ...job,
    chain: 'bnb',
    asset: 'BNB',
    amountBaseUnits: '1000000000000000000',
    decimals: 18,
  };
  let targetUnits = '1550000001';
  options.routes.bnb = {
    accountId: 'account-1',
    address: 'address-1',
    network: 'solana',
    asset: 'SOL',
    bridgeTransfer: {
      send: options.transfer.send,
      reconcile: async () => ({
        hash: 'target-chain-hash',
        chain: 'bnb',
        asset: 'BNB',
        amountBaseUnits: evmJob.amountBaseUnits,
        settlement: { asset: 'SOL', network: 'solana', amountBaseUnits: targetUnits, decimals: 9 },
      }),
    },
  };
  const receive = options.coinbase.reconcileDeposit;
  options.coinbase.reconcileDeposit = async (id, expected) => {
    assert.equal(expected.asset, 'SOL');
    assert.equal(expected.amount, '1.550000001');
    assert.equal(expected.transactionHash, 'target-chain-hash');
    const stored = JSON.parse(
      String(db.prepare('SELECT payload FROM agent_settlements').get()!.payload),
    );
    assert.equal(stored.settlement.asset, 'SOL');
    assert.equal(stored.amount, '1.550000001');
    return receive(id, expected);
  };
  const create = options.coinbase.createMarketSell;
  options.coinbase.createMarketSell = async (input) => {
    assert.equal(input.productId, 'SOL-USD');
    return create(input);
  };
  const api = createCoinbaseSettlement(db, options);
  await api.deposit(evmJob);
  await api.reconcileDeposit(evmJob);
  await api.convert(evmJob);
  assert.equal(state.baseSize, '1.550000001');
  assert.equal((await api.reconcileConversion(evmJob))?.netUsdCents, 12344);
  targetUnits = '1550000002';
  await assert.rejects(api.reconcileDeposit(evmJob));
  db.close();
});

test('EVM bridge without exact positive target output cannot authorize a sale', async () => {
  for (const output of [
    undefined,
    { asset: 'ETH', network: 'solana', amountBaseUnits: '1', decimals: 9 },
    { asset: 'SOL', network: 'ethereum', amountBaseUnits: '1', decimals: 9 },
    { asset: 'SOL', network: 'solana', amountBaseUnits: '0', decimals: 9 },
    { asset: 'SOL', network: 'solana', amountBaseUnits: '1e9', decimals: 9 },
  ]) {
    const db = new DatabaseSync(':memory:');
    const { options, state } = fixture(db);
    const evmJob: PipelineJob = {
      ...job,
      chain: 'bnb',
      asset: 'BNB',
      amountBaseUnits: '1000000000000000000',
      decimals: 18,
    };
    options.routes.bnb = {
      accountId: 'account-1',
      address: 'address-1',
      network: 'solana',
      asset: 'SOL',
      bridgeTransfer: {
        send: options.transfer.send,
        reconcile: async () => ({
          hash: 'target-hash',
          chain: 'bnb',
          asset: 'BNB',
          amountBaseUnits: evmJob.amountBaseUnits,
          settlement: output,
        }),
      },
    };
    const api = createCoinbaseSettlement(db, options);
    await api.deposit(evmJob);
    await assert.rejects(api.reconcileDeposit(evmJob));
    await assert.rejects(api.convert(evmJob));
    assert.equal(state.sells, 0);
    db.close();
  }
});

test('card readiness uses only the explicit streamer allocation and never platform reserve', async () => {
  const db = new DatabaseSync(':memory:');
  const { options } = fixture(db);
  let reads = 0;
  options.card = {
    check: async (input) => {
      reads++;
      assert.equal(input.requiredUsdCents, '8000');
      return {
        ready: true,
        evidence: {
          cardAccountId: 'card-1',
          currency: 'USD',
          availableCreditCents: '8000',
          observedAt: Date.now(),
          active: true,
          evidenceId: 'credit-observation',
        },
      };
    },
  };
  const api = createCoinbaseSettlement(db, options);
  assert.equal(await api.cardReady({ ...job, netUsdCents: 10000 }), null);
  assert.equal(reads, 0);
  const proof = await api.cardReady({
    ...job,
    netUsdCents: 10000,
    streamerBudgetUsdCents: 8000,
    platformReserveUsdCents: 2000,
  });
  assert.equal(proof?.availableCreditCents, 8000);
  assert.equal(reads, 1);
  db.close();
});
