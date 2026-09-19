import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AccountInfo, Connection, SimulateTransactionConfig } from '@solana/web3.js';
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PumpTreasuryProvider } from '../server/treasury/pump-treasury.ts';
import type { Idl } from '@coral-xyz/anchor';

const require = createRequire(import.meta.url);
const { PUMP_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPda, pumpIdl } =
  require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { BorshInstructionCoder, BN } =
  require('@coral-xyz/anchor') as typeof import('@coral-xyz/anchor');
const { GLOBAL_CONFIG_PDA, OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_PROGRAM_ID, pumpAmmJson } =
  require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');
const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/pump-launch-accounts.json', import.meta.url), 'utf8'),
);

function fixture({
  balances = [{ slot: 10, value: 100_000 }],
  simulations = [{ slot: 10, value: 95_000 }],
  metadata,
}: {
  balances?: { slot: number; value: number }[];
  simulations?: { slot: number; value: number }[];
  metadata?: (tx: VersionedTransaction) => Record<string, unknown>;
} = {}) {
  const signer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const mintBytes = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintBytes,
  );
  const curveBytes = Buffer.alloc(151);
  createHash('sha256').update('account:BondingCurve').digest().copy(curveBytes, 0, 0, 8);
  curveBytes.writeBigUInt64LE(1_073_000_000_000_000n, 8);
  curveBytes.writeBigUInt64LE(30_000_000_000n, 16);
  curveBytes.writeBigUInt64LE(793_100_000_000_000n, 24);
  curveBytes.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  signer.publicKey.toBuffer().copy(curveBytes, 49);
  const account = { executable: false, lamports: 1, rentEpoch: 0 };
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const readAccount = async (key: PublicKey) => {
    if (key.equals(mint)) return { ...account, owner: TOKEN_PROGRAM_ID, data: mintBytes };
    if (key.equals(bondingCurvePda(mint)))
      return { ...account, owner: PUMP_PROGRAM_ID, data: curveBytes };
    if (accounts.has(key.toBase58())) return accounts.get(key.toBase58())!;
    const recorded = Object.values(snapshot.accounts).find(
      (value: any) => value.address === key.toBase58(),
    ) as any;
    return recorded
      ? {
          ...recorded,
          owner: new PublicKey(recorded.owner),
          data: Buffer.from(recorded.data, 'base64'),
        }
      : null;
  };
  let balanceReads = 0;
  let simulated = 0;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getAccountInfo: readAccount,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => Promise.all(keys.map(readAccount)),
    getLatestBlockhash: async () => ({
      blockhash,
      lastValidBlockHeight: 100,
    }),
    getBalance: async () => balances[0].value,
    getBalanceAndContext: async () => {
      const balance = balances[Math.min(balanceReads++, balances.length - 1)];
      return { context: { slot: balance.slot }, value: balance.value };
    },
    simulateTransaction: async (tx: VersionedTransaction, config: SimulateTransactionConfig) => {
      const simulation = simulations[Math.min(simulated++, simulations.length - 1)];
      assert.equal(config.sigVerify, true);
      assert.equal(config.commitment, 'confirmed');
      return {
        context: { slot: simulation.slot },
        value: {
          err: null,
          logs: [],
          accounts: [
            {
              ...account,
              owner: signer.publicKey.toBase58(),
              data: ['', 'base64'],
              lamports: simulation.value,
            },
          ],
          ...metadata?.(tx),
        },
      };
    },
  } as unknown as Connection;
  const provider = new PumpTreasuryProvider(
    {
      rpcUrl: 'https://unused.invalid',
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      mint: mint.toBase58(),
      platformCreator: signer.publicKey.toBase58(),
      slippageBps: 100,
      minimumWalletReserveLamports: '10000',
      signerForCreator: async () => signer,
    },
    connection,
  );
  return {
    provider,
    mint,
    signer,
    accounts,
    curveBytes,
    counts: () => ({ simulated, balanceReads }),
    burn: (maxCostLamports = '5000') =>
      provider.prepareBurn({
        id: 'audit:burn',
        creator: signer.publicKey.toBase58(),
        tokenBaseUnits: '100',
        maxCostLamports,
      }),
  };
}

test('equal burns for separate central jobs cannot collide under one recent blockhash', async () => {
  const f = fixture();
  const input = {
    creator: f.signer.publicKey.toBase58(),
    tokenBaseUnits: '100',
    maxCostLamports: '5000',
  };
  const first = await f.provider.prepareBurn({ ...input, id: 'central-job-1:burn' });
  const second = await f.provider.prepareBurn({ ...input, id: 'central-job-2:burn' });
  assert.notEqual(first.signature, second.signature);
  const retry = await f.provider.prepareBurn({ ...input, id: 'central-job-1:burn' });
  assert.equal(first.signature, retry.signature);
});

test('a credit between balance and simulation cannot hide a burn fee above its bound', async () => {
  const f = fixture({
    balances: [
      { slot: 10, value: 100_000 },
      { slot: 11, value: 110_000 },
    ],
    simulations: [{ slot: 11, value: 105_000 }],
  });
  await assert.rejects(f.burn('1000'), /spending exceeds/);
});

test('a debit between balance and simulation cannot hide the required wallet reserve', async () => {
  const f = fixture({
    balances: [
      { slot: 10, value: 25_000 },
      { slot: 11, value: 14_000 },
    ],
    simulations: [{ slot: 11, value: 9_000 }],
  });
  await assert.rejects(f.burn('5000'), /operating reserve/);
});

test('ordinary slot advancement still prepares a bounded burn using the matching balance', async () => {
  const f = fixture({
    balances: [
      { slot: 10, value: 100_000 },
      { slot: 11, value: 80_000 },
    ],
    simulations: [{ slot: 11, value: 75_000 }],
  });
  const result = await f.burn();
  assert.equal(result.kind, 'Burn');
  assert.equal(result.minimumTokenBaseUnits, '100');
  assert.equal(f.counts().simulated, 1);
});

test('advancing slots retry only a bounded number of times without accepting an unmatched cost', async () => {
  const f = fixture({
    balances: Array.from({ length: 20 }, (_, i) => ({ slot: 10 + i * 2, value: 100_000 })),
    simulations: Array.from({ length: 20 }, (_, i) => ({ slot: 11 + i * 4, value: 95_000 })),
  });
  await assert.rejects(f.burn(), /same confirmed slot/);
  assert.ok(f.counts().simulated > 1 && f.counts().simulated <= 3);
});

test('a slot that advances past the follow-up balance succeeds on a later bounded retry', async () => {
  const f = fixture({
    balances: [
      { slot: 10, value: 100_000 },
      { slot: 12, value: 80_000 },
      { slot: 12, value: 80_000 },
    ],
    simulations: [
      { slot: 11, value: 95_000 },
      { slot: 12, value: 75_000 },
    ],
  });
  assert.equal((await f.burn()).kind, 'Burn');
  assert.equal(f.counts().simulated, 2);
});

function bankMetadata(tx: VersionedTransaction, before = 100_000, after = 95_000) {
  return {
    preBalances: tx.message.staticAccountKeys.map((_, i) => (i === 0 ? before : 0)),
    postBalances: tx.message.staticAccountKeys.map((_, i) => (i === 0 ? after : 0)),
    fee: 5000,
  };
}

test('native simulation balances enforce the actual fee despite an unrelated earlier wallet credit', async () => {
  const f = fixture({
    balances: [{ slot: 10, value: 100_000 }],
    simulations: [{ slot: 11, value: 105_000 }],
    metadata: (tx) => bankMetadata(tx, 110_000, 105_000),
  });
  await assert.rejects(f.burn('1000'), /spending exceeds/);
});

test('native simulation balances prepare a bounded burn without needing a matching external slot', async () => {
  const f = fixture({
    balances: [{ slot: 10, value: 100_000 }],
    simulations: [{ slot: 11, value: 105_000 }],
    metadata: (tx) => bankMetadata(tx, 110_000, 105_000),
  });
  assert.equal((await f.burn()).kind, 'Burn');
  assert.equal(f.counts().simulated, 1);
});

test('partial, inconsistent or unsafe native simulation cost metadata cannot fall back to approval', async () => {
  for (const change of [
    () => ({ preBalances: undefined }),
    () => ({ preBalances: [] }),
    (data: ReturnType<typeof bankMetadata>) => ({
      preBalances: [-1, ...data.preBalances.slice(1)],
    }),
    (data: ReturnType<typeof bankMetadata>) => ({
      preBalances: [Number.MAX_SAFE_INTEGER + 1, ...data.preBalances.slice(1)],
    }),
    (data: ReturnType<typeof bankMetadata>) => ({
      postBalances: [94_000, ...data.postBalances.slice(1)],
    }),
    () => ({ fee: 5001 }),
    () => ({ fee: undefined }),
  ]) {
    const f = fixture({
      metadata: (tx) => {
        const data = bankMetadata(tx);
        return { ...data, ...change(data) };
      },
    });
    await assert.rejects(f.burn(), /simulation cost/);
  }
});

test('the installed Pump SDK builds a signed curve buy with the exact input ceiling and token minimum', async () => {
  const f = fixture({
    balances: [{ slot: 10, value: 1_000_000_000 }],
    simulations: [{ slot: 10, value: 897_000_000 }],
  });
  const result = await f.provider.prepareBuy({
    id: 'audit:buy',
    creator: f.signer.publicKey.toBase58(),
    buyLamports: '100000000',
    maxCostLamports: '105000000',
  });
  const tx = VersionedTransaction.deserialize(
    Buffer.from(result.signedTransactionBase64, 'base64'),
  );
  const instructions = TransactionMessage.decompile(tx.message).instructions;
  const buy = instructions.find((ix) => ix.programId.equals(PUMP_PROGRAM_ID));
  assert.ok(buy);
  const decoded = new BorshInstructionCoder(pumpIdl as Idl).decode(buy.data)!;
  assert.equal(decoded.name, 'buy_v2');
  assert.equal(
    (decoded.data as any).max_sol_cost?.toString() ??
      (decoded.data as any).max_quote_amount?.toString(),
    '100000000',
  );
  assert.equal((decoded.data as any).amount.toString(), result.minimumTokenBaseUnits);
  assert.ok(BigInt(result.minimumTokenBaseUnits) > 0n);
  assert.equal(result.mint, f.mint.toBase58());
});

test('the installed canonical PumpSwap SDK builds a bounded native SOL buy and unwraps remaining SOL', async () => {
  const f = fixture({
    balances: [{ slot: 10, value: 1_000_000_000 }],
    simulations: [{ slot: 10, value: 897_000_000 }],
  });
  f.curveBytes[48] = 1;
  const feeRecipient = Keypair.generate().publicKey;
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const coder = OFFLINE_PUMP_AMM_PROGRAM.coder.accounts;
  const global = await coder.encode('globalConfig', {
    admin: feeRecipient,
    lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5),
    disableFlags: 0,
    protocolFeeRecipients: Array(8).fill(feeRecipient),
    coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: feeRecipient,
    whitelistPda: PublicKey.default,
    reservedFeeRecipient: feeRecipient,
    mayhemModeEnabled: false,
    reservedFeeRecipients: Array(7).fill(feeRecipient),
    isCashbackEnabled: false,
    buybackFeeRecipients: Array(8).fill(feeRecipient),
    buybackBasisPoints: new BN(0),
    boostAuthority: feeRecipient,
    boostEnabled: false,
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
  });
  const pool = await coder.encode('pool', {
    poolBump: 1,
    index: 0,
    creator: bondingCurvePda(f.mint),
    baseMint: f.mint,
    quoteMint: NATIVE_MINT,
    lpMint: Keypair.generate().publicKey,
    poolBaseTokenAccount: baseVault,
    poolQuoteTokenAccount: quoteVault,
    lpSupply: new BN(1000),
    coinCreator: f.signer.publicKey,
    isMayhemMode: false,
    isCashbackCoin: false,
    virtualQuoteReserves: new BN(0),
    creatorFeeBps: new BN(0),
    canEditCreatorFee: false,
  });
  const store = (key: PublicKey, owner: PublicKey, data: Buffer) =>
    f.accounts.set(key.toBase58(), {
      owner,
      data,
      executable: false,
      lamports: 2_039_280,
      rentEpoch: 0,
    });
  store(GLOBAL_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, global);
  store(canonicalPumpPoolPda(f.mint), PUMP_AMM_PROGRAM_ID, pool);
  const nativeMint = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    nativeMint,
  );
  store(NATIVE_MINT, TOKEN_PROGRAM_ID, nativeMint);
  for (const [key, mint, amount] of [
    [baseVault, f.mint, 800_000_000_000_000n],
    [quoteVault, NATIVE_MINT, 100_000_000_000n],
  ] as const) {
    const bytes = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint,
        owner: canonicalPumpPoolPda(f.mint),
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      bytes,
    );
    store(key, TOKEN_PROGRAM_ID, bytes);
  }
  const result = await f.provider.prepareBuy({
    id: 'audit:amm-buy',
    creator: f.signer.publicKey.toBase58(),
    buyLamports: '100000000',
    maxCostLamports: '105000000',
  });
  const bytes = Buffer.from(result.signedTransactionBase64, 'base64');
  assert.ok(bytes.length <= 1232, 'the signed route must fit a Solana transaction packet');
  const instructions = TransactionMessage.decompile(
    VersionedTransaction.deserialize(bytes).message,
  ).instructions;
  const swap = instructions.find(
    (ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) &&
      new BorshInstructionCoder(pumpAmmJson as Idl).decode(ix.data)?.name === 'buy',
  );
  assert.ok(swap);
  const decoded = new BorshInstructionCoder(pumpAmmJson as Idl).decode(swap.data)!.data as any;
  assert.equal(decoded.max_quote_amount_in.toString(), '100000000');
  assert.equal(decoded.base_amount_out.toString(), result.minimumTokenBaseUnits);
  const transfer = instructions.find((ix) => ix.programId.equals(SystemProgram.programId));
  assert.ok(transfer);
  assert.equal(SystemInstruction.decodeTransfer(transfer).lamports, 100_000_000n);
  const wrappedSol = getAssociatedTokenAddressSync(NATIVE_MINT, f.signer.publicKey);
  assert.ok(
    instructions.some(
      (ix) =>
        ix.programId.equals(TOKEN_PROGRAM_ID) &&
        ix.data[0] === 9 &&
        ix.keys[0].pubkey.equals(wrappedSol),
    ),
  );
});
