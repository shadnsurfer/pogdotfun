import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PumpLaunchChain } from '../server/launch/pump-chain.ts';
import type { LaunchPlan } from '../server/launch/types.ts';
import type { Idl } from '@coral-xyz/anchor';

const require = createRequire(import.meta.url);
const { pumpIdl, PUMP_PROGRAM_ID, creatorVaultPda } =
  require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { BorshInstructionCoder } =
  require('@coral-xyz/anchor') as typeof import('@coral-xyz/anchor');
const instructionCoder = new BorshInstructionCoder(pumpIdl as Idl);
const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/pump-launch-accounts.json', import.meta.url), 'utf8'),
);
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function fixture(initialBuyLamports = '500000000', changes: Record<string, unknown> = {}) {
  const mint = Keypair.generate();
  const payer = Keypair.generate();
  const creator = Keypair.generate().publicKey;
  const lookup = new AddressLookupTableAccount({
    key: new PublicKey(snapshot.accounts.lookup.address),
    state: AddressLookupTableAccount.deserialize(
      Buffer.from(snapshot.accounts.lookup.data, 'base64'),
    ),
  });
  const plan: LaunchPlan = {
    requestId: 'dev-buy-request-0001',
    launchId: 'dev-buy-launch',
    name: 'N'.repeat(32),
    symbol: 'S'.repeat(10),
    description: '',
    walletAddress: payer.publicKey.toBase58(),
    creatorAddress: creator.toBase58(),
    mint: mint.publicKey.toBase58(),
    metadataUri: 'https://example.test/' + 'm'.repeat(179),
    imageUri: 'https://example.test/image',
    initialBuyLamports,
    recipient: {
      id: 'twitch:1',
      platform: 'twitch',
      username: 'streamer',
      channelUrl: 'https://www.twitch.tv/streamer',
      verified: true,
      verifiedAt: new Date().toISOString(),
    },
  };
  const state = { simulated: 0 };
  const connection = {
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async () => [null, null],
    getAccountInfo: async (key: PublicKey) => {
      const account = Object.values(snapshot.accounts).find(
        (a: any) => a.address === key.toBase58(),
      ) as any;
      if (!account) throw Error('Unexpected account read');
      return {
        ...account,
        owner: new PublicKey(account.owner),
        data: Buffer.from(account.data, 'base64'),
      };
    },
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500,
    }),
    getBalance: async () => 2_000_000_000,
    simulateTransaction: async () => {
      state.simulated++;
      return {
        value: {
          err: null,
          accounts: [{ lamports: 2_000_000_000 - Number(initialBuyLamports) - 20_000_000 }],
        },
      };
    },
    getFeeForMessage: async () => ({ value: 10_500 }),
    ...changes,
  } as unknown as Connection;
  const chain = new PumpLaunchChain(
    {
      rpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: genesis,
      transactionsEnabled: false,
    },
    connection,
  );
  return { chain, mint, payer, creator, plan, lookup, state };
}

test('dev buy creates and purchases atomically within the exact SOL cap while preserving fee routing and packet size', async () => {
  const f = fixture();
  const prepared = await f.chain.prepare(f.plan, f.mint);
  const bytes = Buffer.from(prepared.transaction, 'base64');
  assert.ok(bytes.length <= 1232);
  const tx = VersionedTransaction.deserialize(bytes);
  const message = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: [f.lookup],
  });
  const pump = message.instructions.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID));
  assert.equal(pump.length, 2, 'same signed message must contain creation and buy');
  const create = instructionCoder.decode(pump[0].data)!;
  const buy = instructionCoder.decode(pump[1].data)!;
  assert.equal(create.name, 'create_v2');
  assert.equal((create.data as any).creator.toBase58(), f.creator.toBase58());
  assert.equal(buy.name, 'buy');
  assert.equal(
    (buy.data as any).max_sol_cost.toString(),
    '500000000',
    'must not silently add 1% slippage',
  );
  assert.ok((buy.data as any).amount.gtn(0));
  const ata = getAssociatedTokenAddressSync(
    f.mint.publicKey,
    f.payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  assert.ok(pump[1].keys.some((k) => k.pubkey.equals(ata)));
  assert.ok(pump[1].keys.some((k) => k.pubkey.equals(creatorVaultPda(f.creator))));
  assert.equal(
    message.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length,
    1,
  );
  const transfer = SystemInstruction.decodeTransfer(message.instructions.at(-1)!);
  assert.equal(transfer.toPubkey.toBase58(), f.creator.toBase58());
  assert.equal(transfer.lamports, 2_000_000n);
  assert.equal(
    prepared.estimatedTotalLamports,
    '520000000',
    'buy must not be constrained by the 0.1 SOL overhead ceiling',
  );
  assert.equal(tx.message.header.numRequiredSignatures, 2);
  assert.ok(tx.signatures[1].some(Boolean));
  tx.sign([f.payer]);
  assert.equal(f.state.simulated, 1);
});

test('zero buy retains a create-only launch and needs no quote accounts or lookup table', async () => {
  const f = fixture('0', {
    getAccountInfo: async () => {
      throw Error('should not read buy dependencies');
    },
  });
  const prepared = await f.chain.prepare(f.plan, f.mint);
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
  assert.equal(tx.message.addressTableLookups.length, 0);
  const decoded = TransactionMessage.decompile(tx.message);
  assert.equal(decoded.instructions.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID)).length, 1);
});

test('a missing or foreign lookup table blocks the dev buy before simulation', async () => {
  for (const account of [null, { owner: PublicKey.default, data: Buffer.alloc(0) }]) {
    const f = fixture('500000000', { getAccountInfo: async () => account });
    await assert.rejects(f.chain.prepare(f.plan, f.mint), /lookup table|Pump.*accounts/i);
    assert.equal(f.state.simulated, 0);
  }
});

test('inactive and malformed lookup tables cannot prepare an initial buy', async () => {
  const deactivated = Buffer.from(snapshot.accounts.lookup.data, 'base64');
  deactivated.writeBigUInt64LE(1n, 4);
  for (const data of [Buffer.alloc(8), deactivated]) {
    const f = fixture('500000000', {
      getAccountInfo: async () => ({ owner: new PublicKey(snapshot.accounts.lookup.owner), data }),
    });
    await assert.rejects(
      f.chain.prepare(f.plan, f.mint),
      /lookup table.*invalid|lookup table.*inactive/i,
    );
    assert.equal(f.state.simulated, 0);
  }
});

test('one lamport cannot produce a meaningful initial buy', async () => {
  const f = fixture('1');
  await assert.rejects(f.chain.prepare(f.plan, f.mint), /too small/i);
  assert.equal(f.state.simulated, 0);
});

test('dev buy still rejects excess launch overhead and insufficient total wallet balance', async () => {
  const f = fixture('500000000', {
    simulateTransaction: async () => ({
      value: { err: null, accounts: [{ lamports: 1_300_000_000 }] },
    }),
  });
  await assert.rejects(f.chain.prepare(f.plan, f.mint), /limit|balance/);
  const low = fixture('2000000000');
  await assert.rejects(low.chain.prepare(low.plan, low.mint), /balance/);
});

test('an initial buy cannot complete the curve and strand launch registration before migration', async () => {
  const f = fixture('100000000000', {
    getBalance: async () => 200_000_000_000,
    simulateTransaction: async () => ({
      value: { err: null, accounts: [{ lamports: 99_980_000_000 }] },
    }),
  });
  await assert.rejects(f.chain.prepare(f.plan, f.mint), /initial buy.*too large/i);
  assert.equal(f.state.simulated, 0);
});

test('a lagging RPC simulation retries BlockhashNotFound without replacing the transaction approved by the wallet', async () => {
  const transactions: string[] = [];
  const f = fixture('500000000', {
    simulateTransaction: async (
      tx: VersionedTransaction,
      options: { replaceRecentBlockhash?: boolean; sigVerify: boolean },
    ) => {
      transactions.push(Buffer.from(tx.serialize()).toString('base64'));
      assert.equal(options.sigVerify, false);
      if (transactions.length === 1) return { value: { err: 'BlockhashNotFound' } };
      assert.equal(options.replaceRecentBlockhash, true);
      return { value: { err: null, accounts: [{ lamports: 1_480_000_000 }] } };
    },
  });
  const prepared = await f.chain.prepare(f.plan, f.mint);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0], transactions[1]);
  assert.equal(prepared.transaction, transactions[0]);
});
