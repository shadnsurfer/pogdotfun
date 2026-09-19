import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createFlapAdapter,
  createPonsAdapter,
  FLAP_ABI,
  PONS_ABI,
  EIP1967_IMPLEMENTATION_SLOT,
  FLAP_PORTAL,
  PONS_FACTORY,
  PONS_ESCROW,
  validateSettlementRoute,
} from '../server/chains/index.ts';
import type { ChainRpc, ExecutionJournal, JournalRecord } from '../server/chains/index.ts';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = `0x${'22'.repeat(20)}` as const;
const token = `0x${'33'.repeat(18)}8888` as const;
const hash = `0x${'44'.repeat(32)}` as const;
const code = '0x60016000' as const;
const codeHash = keccak256(code);
const salt = `0x${'55'.repeat(32)}` as const;
function fixture(chainId = 4663) {
  let signs = 0;
  let broadcasts = 0;
  let currentChainId = chainId;
  let head = 110n;
  let receipt: unknown = null;
  let canLaunch = true;
  let feeRecipient = account.address;
  const entries = new Map<string, JournalRecord>();
  const rpc: ChainRpc = {
    async request(method, params = []) {
      switch (method) {
        case 'eth_chainId':
          return `0x${currentChainId.toString(16)}`;
        case 'eth_getCode':
          return code;
        case 'eth_getStorageAt':
          return `0x${'00'.repeat(12)}${other.slice(2)}`;
        case 'eth_getTransactionCount':
          return '0x0';
        case 'eth_gasPrice':
          return '0x1';
        case 'eth_estimateGas':
          return '0x5208';
        case 'eth_sendRawTransaction':
          broadcasts++;
          return keccak256(params[0] as `0x${string}`);
        case 'eth_getTransactionReceipt':
          return receipt;
        case 'eth_blockNumber':
          return `0x${head.toString(16)}`;
        case 'eth_getBlockByNumber':
          return { hash };
        case 'eth_call': {
          const call = params[0] as { data: `0x${string}` };
          let decoded;
          try {
            decoded = decodeFunctionData({ abi: PONS_ABI, data: call.data });
          } catch {
            return '0x';
          }
          if (decoded.functionName === 'canLaunch')
            return encodeAbiParameters([{ type: 'bool' }], [canLaunch]);
          if (decoded.functionName === 'launchFee')
            return encodeAbiParameters([{ type: 'uint256' }], [100n]);
          if (decoded.functionName === 'previewLaunchEconomics') return salt;
          if (decoded.functionName === 'getLaunchedToken')
            return encodeAbiParameters(
              PONS_ABI.find((x) => x.type === 'function' && x.name === 'getLaunchedToken')!
                .outputs as never,
              [
                {
                  token,
                  curve: other,
                  deployer: account.address,
                  creatorFeeRecipient: feeRecipient,
                  pairToken: zeroAddress,
                  graduationThreshold: 1000n,
                  poolFee: 0,
                  tickSpacing: 1,
                  creatorTaxBps: 0,
                  buybackEnabled: false,
                  phase: 0,
                  sweptQuote: 0n,
                  sweptTokens: 0n,
                  sweptAt: 0n,
                  exists: true,
                },
              ] as never,
            );
          return '0x';
        }
        default:
          throw new Error(`Unexpected RPC ${method}`);
      }
    },
  };
  const journal: ExecutionJournal = {
    async exclusive(_scope, run) {
      return run();
    },
    async get(id) {
      return entries.get(id);
    },
    async put(id, entry) {
      entries.set(id, entry);
    },
  };
  const config = {
    rpc,
    journal,
    signer: {
      address: account.address,
      async signTransaction(tx: Parameters<typeof account.signTransaction>[0]) {
        signs++;
        return account.signTransaction(tx);
      },
    },
    feeRecipient: account.address,
    confirmations: 5,
    maxValueWei: 1000n,
    maxGas: 100000n,
    maxGasPriceWei: 10n,
    storagePins: [
      {
        address: FLAP_PORTAL,
        slot: EIP1967_IMPLEMENTATION_SLOT,
        value: `0x${'00'.repeat(12)}${other.slice(2)}` as `0x${string}`,
      },
    ],
    deploymentCodeHashes: {
      [other]: codeHash,
      [FLAP_PORTAL.toLowerCase()]: codeHash,
      [PONS_FACTORY.toLowerCase()]: codeHash,
      [PONS_ESCROW.toLowerCase()]: codeHash,
    },
  };
  return {
    config,
    entries,
    setChain: (n: number) => {
      currentChainId = n;
    },
    setHead: (n: bigint) => {
      head = n;
    },
    setReceipt: (r: unknown) => {
      receipt = r;
    },
    setGate: (v: boolean) => {
      canLaunch = v;
    },
    setRecipient: (v: typeof feeRecipient) => {
      feeRecipient = v;
    },
    get signs() {
      return signs;
    },
    get broadcasts() {
      return broadcasts;
    },
  };
}
const launch = {
  name: 'POG fixture',
  symbol: 'POG',
  logo: 'ipfs://fixture',
  description: 'fixture',
  salt,
  launchConfigId: 0n,
};
test('PONs encodes a pinned native launch with the configured fee recipient', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildLaunch('launch-1', launch);
  const d = decodeFunctionData({ abi: PONS_ABI, data: i.data });
  assert.equal(d.functionName, 'launchToken');
  assert.equal(
    (d.args![0] as { creatorFeeRecipient: string }).creatorFeeRecipient.toLowerCase(),
    account.address.toLowerCase(),
  );
  assert.equal((d.args![0] as { expectedEconomics: string }).expectedEconomics, salt);
  assert.equal(i.value, 100n);
  assert.equal(i.chainId, 4663);
});
test('chain mismatch and closed launch gate fail before signing', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  f.setChain(56);
  await assert.rejects(a.buildLaunch('x', launch), /chain/i);
  f.setChain(4663);
  f.setGate(false);
  await assert.rejects(a.buildLaunch('x', launch), /launch.*closed|not allowed/i);
  assert.equal(f.signs, 0);
});
test('tampered fee destination and value are rejected before signing', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildLaunch('x', launch);
  await assert.rejects(a.execute({ ...i, feeRecipient: other }), /recipient/i);
  await assert.rejects(a.execute({ ...i, value: 1001n }), /value|amount/i);
  assert.equal(f.signs, 0);
});
test('signed transaction is journaled before broadcast and replay never signs again', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildLaunch('x', launch);
  const first = await a.execute(i);
  const second = await a.execute(i);
  assert.equal(first.hash, second.hash);
  assert.equal(f.signs, 1);
  assert.ok(f.entries.get('4663:x')?.rawTransaction);
  await assert.rejects(a.execute({ ...i, data: '0x' }), /intent|calldata|function/i);
  assert.equal(f.signs, 1);
});
test('reserved intent without signed bytes fails closed after interrupted signing', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildLaunch('x', launch);
  await a.execute(i);
  const r = f.entries.get('4663:x')!;
  f.entries.set('4663:x', { ...r, rawTransaction: undefined, hash: undefined, status: 'reserved' });
  await assert.rejects(a.execute(i), /interrupted|reserved|manual/i);
  assert.equal(f.signs, 1);
});
test('PONs reconciliation requires finality, canonical block, event emitter and fee recipient', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildLaunch('x', launch);
  const submitted = await a.execute(i);
  const topics = encodeEventTopics({
    abi: PONS_ABI,
    eventName: 'TokenLaunched',
    args: { token, curve: other, deployer: account.address },
  });
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [zeroAddress, 0n, 1000n],
  );
  const receipt = {
    transactionHash: submitted.hash,
    blockNumber: '0x64',
    blockHash: hash,
    status: '0x1',
    from: account.address,
    to: PONS_FACTORY,
    logs: [{ address: PONS_FACTORY, topics, data, logIndex: '0x0' }],
  };
  f.setReceipt(receipt);
  f.setHead(102n);
  assert.equal((await a.reconcile(i)).status, 'pending');
  f.setHead(110n);
  f.setReceipt({ ...receipt, blockHash: salt });
  await assert.rejects(a.reconcile(i), /canonical|reorg/i);
  f.setReceipt({ ...receipt, logs: [{ ...receipt.logs[0], address: other }] });
  await assert.rejects(a.reconcile(i), /event/i);
  f.setReceipt(receipt);
  f.setRecipient(other);
  await assert.rejects(a.reconcile(i), /recipient/i);
  f.setRecipient(account.address);
  const result = await a.reconcile(i);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.token?.toLowerCase(), token.toLowerCase());
});
test('deployment code hash mismatch is rejected', async () => {
  const f = fixture();
  f.config.deploymentCodeHashes[PONS_FACTORY.toLowerCase()] = salt;
  await assert.rejects(createPonsAdapter(f.config).buildLaunch('x', launch), /bytecode|code hash/i);
});
test('Flap uses documented V6 standard token with explicit beneficiary', async () => {
  const f = fixture(56);
  const a = createFlapAdapter(f.config);
  const i = await a.buildLaunch('f', {
    name: 'POG',
    symbol: 'POG',
    meta: 'bafyfixture',
    salt,
    quoteAmountWei: 100n,
  });
  const decoded = decodeFunctionData({ abi: FLAP_ABI, data: i.data });
  assert.equal(decoded.functionName, 'newTokenV6');
  const params = decoded.args![0] as { beneficiary: string; tokenVersion: number };
  assert.equal(params.beneficiary.toLowerCase(), account.address.toLowerCase());
  assert.equal(params.tokenVersion, 2);
});
test('claim requires beneficiary signer and does not assume a PONs claim amount', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  const i = await a.buildClaim('c');
  assert.equal(i.kind, 'claim');
  assert.equal(i.to.toLowerCase(), PONS_ESCROW.toLowerCase());
  const submitted = await a.execute(i);
  f.setReceipt({
    transactionHash: submitted.hash,
    blockNumber: '0x64',
    blockHash: hash,
    status: '0x1',
    from: account.address,
    to: PONS_ESCROW,
    logs: [],
  });
  const result = await a.reconcile(i);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.feeAmountWei, undefined);
  assert.equal(result.requiresPayoutEvidence, true);
  assert.throws(() => createPonsAdapter({ ...f.config, feeRecipient: other }), /recipient|signer/i);
});
test('settlement rejects chain-incompatible direct deposits and missing bridge bindings', () => {
  assert.throws(
    () =>
      validateSettlementRoute({
        sourceChainId: 56,
        sourceAsset: 'BNB',
        destinationChainId: 1,
        destinationAsset: 'ETH',
        depositAddress: other,
        mode: 'direct',
      }),
    /network|asset|route/i,
  );
  assert.throws(
    () =>
      validateSettlementRoute({
        sourceChainId: 4663,
        sourceAsset: 'ETH',
        destinationChainId: 1,
        destinationAsset: 'ETH',
        depositAddress: other,
        mode: 'bridge',
      }),
    /bridge/i,
  );
});

test('an unacknowledged signed nonce cannot be reused by a different intent', async () => {
  const f = fixture();
  const a = createPonsAdapter(f.config);
  await a.execute(await a.buildLaunch('first', launch));
  await assert.rejects(a.execute(await a.buildLaunch('second', launch)), /nonce|pending/i);
  assert.equal(f.signs, 1);
});

test('signer cannot substitute a different destination in signed bytes', async () => {
  const f = fixture();
  f.config.signer.signTransaction = async (tx) => account.signTransaction({ ...tx, to: other });
  const a = createPonsAdapter(f.config);
  await assert.rejects(a.execute(await a.buildLaunch('x', launch)), /signed transaction/i);
  assert.equal(f.broadcasts, 0);
});

test('Flap requires a pinned proxy implementation and rejects unknown claim tokens', async () => {
  const f = fixture(56);
  await assert.rejects(
    createFlapAdapter({ ...f.config, storagePins: [] }).buildLaunch('f', {
      name: 'POG',
      symbol: 'POG',
      meta: 'bafyfixture',
      salt,
      quoteAmountWei: 0n,
    }),
    /implementation/i,
  );
  await assert.rejects(
    createFlapAdapter(f.config).buildClaim('c', token),
    /verified.*launch|unknown.*token/i,
  );
});

test('Flap reconciles the native launch before claiming and matches payout identity', async () => {
  const f = fixture(56);
  const a = createFlapAdapter(f.config);
  const launchIntent = await a.buildLaunch('flap-launch', {
    name: 'POG',
    symbol: 'POG',
    meta: 'bafyfixture',
    salt,
    quoteAmountWei: 0n,
  });
  const launched = await a.execute(launchIntent);
  f.setReceipt({
    transactionHash: launched.hash,
    blockNumber: '0x64',
    blockHash: hash,
    status: '0x1',
    from: account.address,
    to: FLAP_PORTAL,
    logs: [
      {
        address: FLAP_PORTAL,
        topics: encodeEventTopics({ abi: FLAP_ABI, eventName: 'VanityTokenCreated' }),
        data: encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
          [token, account.address, account.address],
        ),
        logIndex: '0x0',
      },
    ],
  });
  assert.equal((await a.reconcile(launchIntent)).status, 'confirmed');
  const beforeProbe = f.config.rpc.request;
  f.config.rpc.request = async (method, params) =>
    method === 'eth_call'
      ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 19n])
      : beforeProbe(method, params);
  assert.equal(await a.claimableNative(token), 19n);
  f.config.rpc.request = beforeProbe;
  const claim = await a.buildClaim('flap-claim', token);
  // Fixture advances the node pending nonce after the launch has landed.
  const request = f.config.rpc.request;
  f.config.rpc.request = async (method, params) =>
    method === 'eth_getTransactionCount' ? '0x1' : request(method, params);
  const submitted = await a.execute(claim);
  const log = {
    address: FLAP_PORTAL,
    topics: encodeEventTopics({ abi: FLAP_ABI, eventName: 'BeneficiaryClaimed' }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [token, account.address, 7n, 19n],
    ),
    logIndex: '0x1',
  };
  const receipt = {
    transactionHash: submitted.hash,
    blockNumber: '0x64',
    blockHash: hash,
    status: '0x1',
    from: account.address,
    to: FLAP_PORTAL,
    logs: [log],
  };
  f.setReceipt(receipt);
  const result = await a.reconcile(claim);
  assert.equal(result.feeAmountWei, 19n);
  assert.equal(result.feeTokenAmount, 7n);
  assert.equal(result.evidenceId, `56:${submitted.hash}:0x1`);
  f.setReceipt({ ...receipt, logs: [log, log] });
  await assert.rejects(a.reconcile(claim), /ambiguous/i);
});

test('signer cannot substitute a different nonce in signed bytes', async () => {
  const f = fixture();
  f.config.signer.signTransaction = async (tx) => account.signTransaction({ ...tx, nonce: 42 });
  const a = createPonsAdapter(f.config);
  await assert.rejects(
    a.execute(await a.buildLaunch('nonce-check', launch)),
    /nonce|signed transaction/i,
  );
  assert.equal(f.broadcasts, 0);
});
