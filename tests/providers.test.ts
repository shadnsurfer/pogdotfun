import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { DatabaseSync } from 'node:sqlite';
import { valueLamportsInUsdCents } from '../server/providers/contracts.ts';
import { PumpSolanaProvider, validateMappings } from '../server/providers/pump-solana.ts';
import type { PumpSolanaConfig } from '../server/providers/pump-solana.ts';
import type { PreparedTransaction } from '../server/providers/contracts.ts';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { StreamerLiveGate } from '../server/workers/streamer-live.ts';

const require = createRequire(import.meta.url);
const { creatorVaultPda, PUMP_PROGRAM_ID } =
  require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda } =
  require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');

test('SOL quote values exact base units and rejects stale, future or unidentified prices', () => {
  const now = Date.now();
  const quote = {
    centsPerSol: '15000',
    observedAt: new Date(now).toISOString(),
    source: 'fixture',
  };
  assert.equal(valueLamportsInUsdCents(333_333_333n, quote, now), 4999);
  assert.equal(valueLamportsInUsdCents(333_333_334n, quote, now), 5000);
  assert.throws(() => valueLamportsInUsdCents(1n, { ...quote, source: '' }, now));
  assert.throws(() => valueLamportsInUsdCents(1n, quote, now + 60_001));
  assert.throws(() => valueLamportsInUsdCents(1n, quote, now - 10_000));
  assert.throws(() => valueLamportsInUsdCents(1n, { ...quote, centsPerSol: '15000.1' }, now));
});

test('a creator shared across two mints cannot be attributed to a single token', () => {
  const first = {
    tokenId: 'one',
    mint: Keypair.generate().publicKey.toBase58(),
    creator: Keypair.generate().publicKey.toBase58(),
    dedicatedCreatorVerified: true,
  };
  validateMappings([first]);
  assert.throws(
    () =>
      validateMappings([
        first,
        { ...first, tokenId: 'two', mint: Keypair.generate().publicKey.toBase58() },
      ]),
    /unique/,
  );
  assert.throws(
    () => validateMappings([{ ...first, dedicatedCreatorVerified: false }]),
    /dedicated/,
  );
});

function solanaFixture() {
  const signer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const config: PumpSolanaConfig = {
    rpcUrl: 'https://rpc.example.com',
    expectedGenesisHash: 'expected-genesis',
    mappings: [
      {
        tokenId: 'one',
        mint: mint.toBase58(),
        creator: signer.publicKey.toBase58(),
        dedicatedCreatorVerified: true,
      },
    ],
    signerForCreator: async () => signer,
    transactionsEnabled: false,
    coinbaseAccountId: 'card-1',
    allowedCoinbaseAddresses: [],
    maxTopUpLamports: 1_000_000_000n,
    minimumWalletReserveLamports: 100_000n,
  };
  const connection = new Connection(config.rpcUrl);
  connection.getGenesisHash = async () => config.expectedGenesisHash;
  return { signer, mint, config, connection };
}

test('Solana adapter refuses an RPC on the wrong network before inspecting funds', async () => {
  const fixture = solanaFixture();
  fixture.connection.getGenesisHash = async () => 'wrong-network';
  const provider = new PumpSolanaProvider(fixture.config, fixture.connection);
  await assert.rejects(
    () =>
      provider.inspectFees('one', {
        centsPerSol: '10000',
        observedAt: new Date().toISOString(),
        source: 'fixture',
      }),
    /unexpected Solana network/,
  );
});

test('finalized claim proof counts only fee vault movements and reports gas separately', async () => {
  const { config, connection, signer, mint } = solanaFixture();
  const vault = creatorVaultPda(signer.publicKey);
  const ata = coinCreatorVaultAtaPda(
    coinCreatorVaultAuthorityPda(signer.publicKey),
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  );
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: ata, isSigner: false, isWritable: true },
        ],
        data: Buffer.alloc(0),
      }),
    ],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign([signer]);
  const signature = bs58.encode(signed.signatures[0]);
  const vaultIndex = message.staticAccountKeys.findIndex((key) => key.equals(vault));
  const ataIndex = message.staticAccountKeys.findIndex((key) => key.equals(ata));
  const pre = message.staticAccountKeys.map(() => 0);
  const post = [...pre];
  pre[0] = 1_000_000_000;
  post[0] = 2_199_995_000;
  pre[vaultIndex] = 1_000_890_880;
  post[vaultIndex] = 890_880;
  connection.getSignatureStatuses = async () => ({
    context: { slot: 123 },
    value: [{ slot: 123, confirmations: null, err: null, confirmationStatus: 'finalized' }],
  });
  connection.getTransaction = (async () => ({
    slot: 123,
    transaction: { message, signatures: [signature] },
    meta: {
      err: null,
      fee: 5000,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: [
        {
          accountIndex: ataIndex,
          mint: NATIVE_MINT.toBase58(),
          uiTokenAmount: { amount: '200000000', decimals: 9, uiAmount: 0.2 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: ataIndex,
          mint: NATIVE_MINT.toBase58(),
          uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0 },
        },
      ],
    },
  })) as unknown as typeof connection.getTransaction;
  const prepared: PreparedTransaction = {
    id: 'one',
    kind: 'claim',
    tokenId: 'one',
    mint: mint.toBase58(),
    creator: signer.publicKey.toBase58(),
    signature,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    blockhash: message.recentBlockhash,
    lastValidBlockHeight: 200,
    createdAt: new Date().toISOString(),
  };
  const proof = await new PumpSolanaProvider(config, connection).finalizedProof(prepared);
  assert.equal(proof.amountLamports, '1200000000');
  assert.equal(proof.networkFeeLamports, '5000');
  assert.equal(proof.confirmation, 'finalized');
});

test('manual Pump claim verification requires the real collection instruction and actual creator SOL credit', async () => {
  const { config, connection, signer } = solanaFixture();
  const vault = creatorVaultPda(signer.publicKey);
  const signature = bs58.encode(Buffer.alloc(64, 5));
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]),
      }),
    ],
  }).compileToV0Message();
  const vaultIndex = message.staticAccountKeys.findIndex((key) => key.equals(vault));
  const before = message.staticAccountKeys.map(() => 0);
  const after = [...before];
  before[0] = 1_000_000_000;
  after[0] = 1_999_995_000;
  before[vaultIndex] = 1_000_890_880;
  after[vaultIndex] = 890_880;
  connection.getSignatureStatuses = async () => ({
    context: { slot: 100 },
    value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: 'finalized' }],
  });
  connection.getTransaction = (async () => ({
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message, signatures: [signature] },
    meta: { err: null, fee: 5000, preBalances: before, postBalances: after },
  })) as unknown as typeof connection.getTransaction;
  const provider = new PumpSolanaProvider(config, connection);
  assert.equal(
    (await provider.verifyExternalClaim({ tokenId: 'one', signature })).amountLamports,
    '1000000000',
  );
  after[0] = before[0] - 5000;
  await assert.rejects(
    () => provider.verifyExternalClaim({ tokenId: 'one', signature }),
    /not received as SOL/,
  );
  after[0] = 1_999_995_000;
  message.compiledInstructions[0].data = Buffer.alloc(8);
  await assert.rejects(
    () => provider.verifyExternalClaim({ tokenId: 'one', signature }),
    /unsupported or unrelated/,
  );
});

test('only finalized failed transfers can release a reserved budget', async () => {
  const { config, connection, signer, mint } = solanaFixture();
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign([signer]);
  const signature = bs58.encode(signed.signatures[0]);
  const transaction: PreparedTransaction = {
    id: 'failed',
    kind: 'topup',
    tokenId: 'one',
    mint: mint.toBase58(),
    creator: signer.publicKey.toBase58(),
    signature,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    blockhash: 'fixture',
    lastValidBlockHeight: 100,
    createdAt: new Date().toISOString(),
  };
  connection.getSignatureStatuses = async () => ({
    context: { slot: 100 },
    value: [
      {
        slot: 100,
        confirmations: null,
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'confirmed',
      },
    ],
  });
  const provider = new PumpSolanaProvider(config, connection);
  assert.equal(await provider.reconcile(transaction), 'broadcast');
  await assert.rejects(() => provider.finalizedFailureProof(transaction), /definitively finalized/);
  connection.getSignatureStatuses = async () => ({
    context: { slot: 100 },
    value: [
      {
        slot: 100,
        confirmations: null,
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'finalized',
      },
    ],
  });
  connection.getTransaction = (async () => ({
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message, signatures: [signature] },
    meta: {
      err: { InstructionError: [0, 'Custom'] },
      fee: 5000,
      preBalances: [100000],
      postBalances: [95000],
    },
  })) as unknown as typeof connection.getTransaction;
  assert.equal((await provider.finalizedFailureProof(transaction)).networkFeeLamports, '5000');
});

function signedBroadcastFixture() {
  const f = solanaFixture();
  f.config.transactionsEnabled = true;
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: f.signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: f.signer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      ],
    }).compileToV0Message(),
  );
  transaction.sign([f.signer]);
  const prepared: PreparedTransaction = {
    id: 'funding:fixture',
    kind: 'topup',
    tokenId: 'one',
    mint: f.mint.toBase58(),
    creator: f.signer.publicKey.toBase58(),
    signature: bs58.encode(transaction.signatures[0]),
    signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    blockhash: transaction.message.recentBlockhash,
    lastValidBlockHeight: 123,
    createdAt: new Date().toISOString(),
  };
  let sends = 0;
  f.connection.sendRawTransaction = async () => {
    sends++;
    return prepared.signature;
  };
  return { ...f, prepared, sends: () => sends };
}

for (const changed of ['offline', 'expired'] as const) {
  test(`an ${changed} live observation during the final genesis read prevents chain broadcast`, async () => {
    const f = signedBroadcastFixture();
    const db = new DatabaseSync(':memory:');
    let now = Date.parse('2026-09-16T18:00:00Z');
    let live = true;
    const recipient = {
      platform: 'twitch' as const,
      providerId: 'twitch:123',
      username: 'fixture_streamer',
    };
    const gate = new StreamerLiveGate(db, {
      now: () => now,
      lookup: async (r) => ({
        ...r,
        checkedAt: new Date(now).toISOString(),
        isLive: live,
        streamId: live ? '12345' : null,
      }),
    });
    let release!: (hash: string) => void;
    f.connection.getGenesisHash = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    try {
      await gate.requireLive(recipient);
      const provider = new PumpSolanaProvider(f.config, f.connection);
      const pending = provider.broadcast(f.prepared, () => gate.assertFreshLive(recipient));
      if (changed === 'offline') {
        live = false;
        await assert.rejects(gate.requireLive(recipient));
      } else now += 15001;
      release(f.config.expectedGenesisHash);
      await assert.rejects(pending);
      assert.equal(f.sends(), 0);
    } finally {
      await gate.close();
      db.close();
    }
  });
}

test('a final spending guard runs synchronously after genesis and rejects Promise authority', async () => {
  const f = signedBroadcastFixture();
  const events: string[] = [];
  f.connection.getGenesisHash = async () => {
    events.push('genesis');
    return f.config.expectedGenesisHash;
  };
  f.connection.sendRawTransaction = async () => {
    events.push('send');
    return f.prepared.signature;
  };
  const provider = new PumpSolanaProvider(f.config, f.connection);
  assert.equal(
    await provider.broadcast(f.prepared, () => {
      events.push('guard');
    }),
    f.prepared.signature,
  );
  assert.deepEqual(events, ['genesis', 'guard', 'send']);
  events.length = 0;
  await assert.rejects(
    provider.broadcast(f.prepared, async () => {}),
    /synchronous/,
  );
  assert.deepEqual(events, ['genesis']);
});

test('unguarded claim broadcasts retain the existing provider behavior', async () => {
  const f = signedBroadcastFixture();
  const provider = new PumpSolanaProvider(f.config, f.connection);
  assert.equal(await provider.broadcast({ ...f.prepared, kind: 'claim' }), f.prepared.signature);
  assert.equal(f.sends(), 1);
});

test('failed claim gas requires the exact stored signed transaction and finalized fee-only movement', async () => {
  const { config, connection, signer, mint } = solanaFixture();
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign([signer]);
  const signature = bs58.encode(signed.signatures[0]);
  const transaction: PreparedTransaction = {
    id: 'failed-claim',
    kind: 'claim',
    tokenId: 'one',
    mint: mint.toBase58(),
    creator: signer.publicKey.toBase58(),
    signature,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    blockhash: message.recentBlockhash,
    lastValidBlockHeight: 100,
    createdAt: new Date().toISOString(),
  };
  const receipt = {
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { message, signatures: [signature] },
    meta: {
      err: { InstructionError: [0, 'Custom'] },
      fee: 5000,
      preBalances: [100000],
      postBalances: [95000],
    },
  };
  connection.getSignatureStatuses = async () => ({
    context: { slot: 100 },
    value: [
      {
        slot: 100,
        confirmations: null,
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'finalized',
      },
    ],
  });
  connection.getTransaction = (async () => receipt) as unknown as typeof connection.getTransaction;
  const provider = new PumpSolanaProvider(config, connection);
  const proof = await provider.finalizedFailureProof(transaction);
  assert.equal(proof.signature, signature);
  assert.equal(proof.networkFeeLamports, '5000');
  assert.equal(proof.confirmation, 'finalized_failure');
  receipt.transaction.signatures[0] = bs58.encode(Buffer.alloc(64, 8));
  await assert.rejects(provider.finalizedFailureProof(transaction), /identity|stored|match/);
  receipt.transaction.signatures[0] = signature;
  receipt.transaction.message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  await assert.rejects(provider.finalizedFailureProof(transaction), /identity|stored|match/);
  receipt.transaction.message = message;
  receipt.meta.postBalances[0] = 94000;
  await assert.rejects(provider.finalizedFailureProof(transaction), /balance/);
  receipt.meta.postBalances[0] = 95000;
  await assert.rejects(
    provider.finalizedFailureProof({ ...transaction, signedTransactionBase64: 'invalid' }),
    /identity|stored|match/,
  );
  connection.getSignatureStatuses = async () => ({ context: { slot: 100 }, value: [null] });
  connection.getBlockHeight = async () => 101;
  await assert.rejects(provider.finalizedFailureProof(transaction), /definitively finalized/);
});
