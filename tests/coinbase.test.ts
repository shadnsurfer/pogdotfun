import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { CoinbaseProvider, coinbaseClientOrderId } from '../server/providers/coinbase.ts';
import { CoinbaseCardReadiness } from '../server/providers/coinbase-card.ts';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const secret = {
  keyName: 'organizations/test/apiKeys/test',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const sell = { clientOrderId: 'pog-test-event', productId: 'SOL-USD', baseSize: '1.000000001' };
const deposit = {
  accountId: 'account-1',
  network: 'solana',
  transactionHash: 'chain-hash-1',
  asset: 'SOL',
  amount: '1.000000001',
};
const tx = {
  id: 'tx-1',
  resource: 'transaction',
  resource_path: '/v2/accounts/account-1/transactions/tx-1',
  type: 'receive',
  status: 'completed',
  amount: { amount: '1.000000001', currency: 'SOL' },
  network: { status: 'confirmed', hash: 'chain-hash-1', network_name: 'solana' },
};
const order = {
  order_id: 'order-1',
  client_order_id: sell.clientOrderId,
  product_id: 'SOL-USD',
  side: 'SELL',
  product_type: 'SPOT',
  status: 'FILLED',
  settled: true,
  filled_size: '1.000000001',
  filled_value: '123.123456789',
  total_fees: '0.123456790',
  total_value_after_fees: '122.999999999',
  order_configuration: { market_market_ioc: { base_size: sell.baseSize } },
};
function provider(response: unknown, inspect?: (url: string, init: RequestInit) => void) {
  return new CoinbaseProvider({
    getCredentials: async () => secret,
    now: () => 1_800_000_000_000,
    fetch: async (url, init) => {
      inspect?.(String(url), init!);
      return Response.json(response);
    },
  });
}

test('sell request is signed ES256, bounded to Coinbase, and preserves replay id and exact base amount', async () => {
  const response = {
    success: true,
    success_response: {
      order_id: 'order-1',
      client_order_id: sell.clientOrderId,
      product_id: sell.productId,
      side: 'SELL',
    },
  };
  const client = provider(response, (url, init) => {
    assert.equal(url, 'https://api.coinbase.com/api/v3/brokerage/orders');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.deepEqual(JSON.parse(String(init.body)), {
      client_order_id: sell.clientOrderId,
      product_id: sell.productId,
      side: 'SELL',
      order_configuration: { market_market_ioc: { base_size: '1.000000001' } },
    });
    const token = new Headers(init.headers).get('authorization')!.slice(7);
    const [header, payload, signature] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
    assert.equal(
      JSON.parse(Buffer.from(payload, 'base64url').toString()).uri,
      'POST api.coinbase.com/api/v3/brokerage/orders',
    );
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).exp, 1_800_000_120);
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    );
  });
  assert.equal((await client.createMarketSell(sell)).orderId, 'order-1');
  assert.equal((await client.createMarketSell(sell)).orderId, 'order-1');
  assert.equal(coinbaseClientOrderId('event-1'), coinbaseClientOrderId('event-1'));
  assert.notEqual(coinbaseClientOrderId('event-1'), coinbaseClientOrderId('event-2'));
});

test('settled sell reconciliation calculates exact net fees without rounding up spendable cents', async () => {
  const result = await provider({ order }).reconcileMarketSell('order-1', sell);
  assert.equal(result.netQuoteAmount, '122.999999999');
  assert.equal(result.spendableUsdCents, '12299');
});

test('reconciliation rejects partial, unsettled, wrong-side and mismatched orders', async () => {
  for (const patch of [
    { status: 'CANCELLED' },
    { settled: false },
    { side: 'BUY' },
    { client_order_id: 'someone-else' },
    { product_id: 'SOL-USDC' },
    { filled_size: '1' },
    { total_fees: '999' },
    { total_value_after_fees: '999' },
  ]) {
    await assert.rejects(
      provider({ order: { ...order, ...patch } }).reconcileMarketSell('order-1', sell),
    );
  }
});

test('deposit reconciliation requires exact account, network, hash, asset and decimal amount', async () => {
  assert.equal(
    (await provider({ data: tx }).reconcileDeposit('tx-1', deposit)).transactionId,
    'tx-1',
  );
  for (const patch of [
    { resource_path: '/v2/accounts/other/transactions/tx-1' },
    { network: undefined },
    { network: { ...tx.network, hash: 'other' } },
    { network: { ...tx.network, network_name: 'ethereum' } },
    { amount: { amount: '1.000000002', currency: 'SOL' } },
    { amount: { amount: '1.000000001', currency: 'BTC' } },
    { status: 'pending' },
    { type: 'send' },
  ]) {
    await assert.rejects(provider({ data: { ...tx, ...patch } }).reconcileDeposit('tx-1', deposit));
  }
});

test('invalid precision, unsafe paths and crypto quote products cannot cause outbound calls', async () => {
  const client = provider({}, () => assert.fail('invalid input reached network'));
  for (const patch of [
    { baseSize: '1e-9' },
    { baseSize: '0' },
    { productId: 'SOL-USDC' },
    { clientOrderId: '../bad' },
  ])
    await assert.rejects(client.createMarketSell({ ...sell, ...patch }));
  await assert.rejects(client.reconcileDeposit('../other', deposit));
});

test('HTTP and credential failures never disclose provider body or secrets', async () => {
  for (const options of [
    {
      getCredentials: async () => secret,
      fetch: async () => new Response('private-api-secret', { status: 401 }),
    },
    {
      getCredentials: async () => {
        throw new Error('private-api-secret');
      },
    },
  ]) {
    const client = new CoinbaseProvider(options);
    await assert.rejects(
      client.createMarketSell(sell),
      (error: Error) => !error.message.includes('private-api-secret'),
    );
  }
});

test('missing card evidence source cannot release gifts against exchange cash', async () => {
  const gate = new CoinbaseCardReadiness();
  assert.deepEqual(await gate.check({ cardAccountId: 'card-1', requiredUsdCents: '500' }), {
    ready: false,
    reason: 'card_evidence_source_unavailable',
  });
});

test('card credit readiness rejects stale, mismatched and insufficient independent evidence', async () => {
  const evidence = {
    cardAccountId: 'card-1',
    currency: 'USD' as const,
    availableCreditCents: '1000',
    observedAt: 1_800_000_000_000,
    active: true,
    evidenceId: 'observation-1',
  };
  for (const patch of [
    { observedAt: 0 },
    { cardAccountId: 'card-2' },
    { availableCreditCents: '499' },
    { active: false },
  ]) {
    const gate = new CoinbaseCardReadiness(
      { readBalance: async () => ({ ...evidence, ...patch }), readCharge: async () => null },
      { now: () => 1_800_000_000_000 },
    );
    assert.equal(
      (await gate.check({ cardAccountId: 'card-1', requiredUsdCents: '500' })).ready,
      false,
    );
  }
  const gate = new CoinbaseCardReadiness(
    { readBalance: async () => evidence, readCharge: async () => null },
    { now: () => 1_800_000_000_000 },
  );
  assert.equal(
    (await gate.check({ cardAccountId: 'card-1', requiredUsdCents: '500' })).ready,
    true,
  );
});

test('timeout bounds hung requests and late credentials cannot submit a sell', async () => {
  let release!: (value: typeof secret) => void;
  let calls = 0;
  const client = new CoinbaseProvider({
    getCredentials: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    timeoutMs: 5,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(client.createMarketSell(sell), /timeout/);
  release(secret);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 0);
  const hung = new CoinbaseProvider({
    getCredentials: async () => secret,
    timeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(hung.createMarketSell(sell), /timeout/);
});

test('transaction discovery uses fixed account path and validates page membership', async () => {
  const client = provider(
    {
      data: [tx],
      pagination: { next_uri: '/v2/accounts/account-1/transactions?starting_after=tx-1' },
    },
    (url) =>
      assert.equal(url, 'https://api.coinbase.com/v2/accounts/account-1/transactions?limit=100'),
  );
  assert.deepEqual(await client.listTransactionIds('account-1'), {
    transactionIds: ['tx-1'],
    nextStartingAfter: 'tx-1',
  });
  await assert.rejects(
    provider({
      data: [{ ...tx, resource_path: '/v2/accounts/other/transactions/tx-1' }],
    }).listTransactionIds('account-1'),
  );
});

test('deposit address is authenticated against account asset and exact address network', async () => {
  const expected = {
    accountId: 'account-1',
    asset: 'SOL',
    address: 'solana-address-1',
    network: 'solana',
  };
  const account = {
    id: 'account-1',
    resource: 'account',
    resource_path: '/v2/accounts/account-1',
    type: 'wallet',
    currency: { code: 'SOL' },
  };
  const address = {
    id: 'address-1',
    resource: 'address',
    resource_path: '/v2/accounts/account-1/addresses/address-1',
    address: 'solana-address-1',
    network: 'solana',
  };
  const client = (
    patch: Record<string, unknown> = {},
    accountPatch: Record<string, unknown> = {},
  ) =>
    new CoinbaseProvider({
      getCredentials: async () => secret,
      fetch: async (url) =>
        Response.json(
          String(url).includes('/addresses')
            ? { data: [{ ...address, ...patch }], pagination: { next_uri: null } }
            : { data: { ...account, ...accountPatch } },
        ),
    });
  assert.equal((await client().verifyDepositAddress(expected)).addressId, 'address-1');
  for (const patch of [
    { network: 'ethereum' },
    { address: 'attacker' },
    { resource_path: '/v2/accounts/other/addresses/address-1' },
  ])
    await assert.rejects(client(patch).verifyDepositAddress(expected));
  await assert.rejects(client({}, { currency: { code: 'ETH' } }).verifyDepositAddress(expected));
});

test('lost sell response is recovered by read-only bounded client id pagination', async () => {
  const urls: string[] = [];
  const client = new CoinbaseProvider({
    getCredentials: async () => secret,
    fetch: async (url, init) => {
      assert.equal(init?.method, 'GET');
      urls.push(String(url));
      return Response.json(
        urls.length === 1
          ? {
              orders: [{ ...order, client_order_id: 'unrelated', order_id: 'other' }],
              has_next: true,
              cursor: 'page/2',
            }
          : { orders: [order], has_next: false, cursor: '' },
      );
    },
  });
  assert.deepEqual(await client.findMarketSell(sell.clientOrderId), {
    orderId: 'order-1',
    clientOrderId: sell.clientOrderId,
  });
  assert.ok(urls[1].endsWith('&cursor=page%2F2'));
  await assert.rejects(
    provider({ orders: [], has_next: true, cursor: 'next' }).findMarketSell(sell.clientOrderId, 1),
    /scan_limit/,
  );
  await assert.rejects(
    provider({ orders: [], has_next: true, cursor: 'next' }).findMarketSell(sell.clientOrderId, 3),
    /pagination_replay/,
  );
  assert.equal(
    await provider({ orders: [], has_next: false }).findMarketSell(sell.clientOrderId),
    null,
  );
  await assert.rejects(
    provider({ orders: [order], has_next: false, proof_token_required: true }).findMarketSell(
      sell.clientOrderId,
    ),
  );
});
