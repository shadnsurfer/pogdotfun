import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import type { VersionedTransactionResponse, Connection } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createBurnCheckedInstruction,
  MintLayout,
} from '@solana/spl-token';
import bs58 from 'bs58';
import {
  verifyTreasuryTransaction,
  PumpTreasuryProvider,
} from '../server/treasury/pump-treasury.ts';
import type { TreasuryTransaction } from '../server/treasury/pump-treasury.ts';

test('public platform verification reads finalized creator state and never accesses signing', async () => {
  const { PUMP_PROGRAM_ID, bondingCurvePda } = createRequire(import.meta.url)(
    '@pump-fun/pump-sdk',
  ) as typeof import('@pump-fun/pump-sdk');
  const mint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const mintBytes = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintBytes,
  );
  const curveBytes = Buffer.alloc(151);
  createHash('sha256').update('account:BondingCurve').digest().copy(curveBytes, 0, 0, 8);
  creator.toBuffer().copy(curveBytes, 49);
  let reads = 0;
  const chain = {
    getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getAccountInfo: async (address: PublicKey, commitment: unknown) => {
      assert.equal(
        commitment,
        'finalized',
        'verification must not replace verified account data with a lower-finality SDK read',
      );
      reads++;
      const account = { executable: false, lamports: 1, rentEpoch: 0 };
      if (address.equals(mint)) return { ...account, owner: TOKEN_PROGRAM_ID, data: mintBytes };
      if (address.equals(bondingCurvePda(mint)))
        return { ...account, owner: PUMP_PROGRAM_ID, data: curveBytes };
      throw new Error('Unexpected account');
    },
  } as unknown as Connection;
  const config = {
    rpcUrl: 'https://unused.invalid',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    mint: mint.toBase58(),
    platformCreator: creator.toBase58(),
    slippageBps: 1,
    minimumWalletReserveLamports: '1',
    signerForCreator: async () => {
      throw new Error('Tracking must never access a signer');
    },
  };
  await new PumpTreasuryProvider(config, chain).verifyPlatform();
  assert.equal(reads, 3);
  await assert.rejects(
    new PumpTreasuryProvider(
      { ...config, platformCreator: Keypair.generate().publicKey.toBase58() },
      chain,
    ).verifyPlatform(),
    /creator/,
  );
});

function proof(kind: 'Buyback' | 'Burn' = 'Buyback') {
  const signer = Keypair.generate(),
    mint = Keypair.generate().publicKey,
    ata = getAssociatedTokenAddressSync(mint, signer.publicKey);
  const instruction =
    kind === 'Buyback'
      ? SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: ata, lamports: 10000 })
      : createBurnCheckedInstruction(ata, mint, signer.publicKey, 100n, 6);
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign([signer]);
  const keys = message.staticAccountKeys;
  const index = keys.findIndex((k) => k.equals(ata));
  const transaction: TreasuryTransaction = {
    id: 'id',
    kind,
    creator: signer.publicKey.toBase58(),
    mint: mint.toBase58(),
    ata: ata.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    signature: bs58.encode(signed.signatures[0]),
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    lastValidBlockHeight: 100,
    maxCostLamports: '20000',
    minimumTokenBaseUnits: '100',
    tokenDecimals: 6,
    createdAt: new Date().toISOString(),
  };
  const amount = (n: string) => ({
    accountIndex: index,
    mint: mint.toBase58(),
    owner: signer.publicKey.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount: n, decimals: 6, uiAmount: null },
  });
  const response: VersionedTransactionResponse = {
    slot: 1,
    blockTime: 1,
    transaction: { message, signatures: [transaction.signature] },
    meta: {
      err: null,
      fee: 5000,
      preBalances: keys.map((_, i) => (i === 0 ? 100000 : 0)),
      postBalances: keys.map((_, i) => (i === 0 ? (kind === 'Buyback' ? 85000 : 95000) : 0)),
      preTokenBalances: [amount(kind === 'Buyback' ? '0' : '100')],
      postTokenBalances: [amount(kind === 'Buyback' ? '100' : '0')],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
  return { transaction, response };
}

test('central transfer proof binds the source debit, destination credit, signatures and gas separately', () => {
  const { transaction: base } = proof();
  const source = Keypair.generate();
  const wallet = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: source.publicKey,
        toPubkey: wallet.publicKey,
        lamports: 200000000,
      }),
    ],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign([source, wallet]);
  const tx: TreasuryTransaction = {
    ...base,
    kind: 'Transfer',
    creator: wallet.publicKey.toBase58(),
    transferFrom: source.publicKey.toBase58(),
    transferLamports: '200000000',
    minimumTokenBaseUnits: '0',
    signature: bs58.encode(signed.signatures[0]),
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
  };
  const sourceIndex = message.staticAccountKeys.findIndex((k) => k.equals(source.publicKey));
  const pre = message.staticAccountKeys.map((_, i) =>
    i === 0 ? 100000000 : i === sourceIndex ? 1000000000 : 0,
  );
  const post = [...pre];
  post[0] += 200000000 - 10000;
  post[sourceIndex] -= 200000000;
  const response = {
    slot: 123,
    transaction: { message, signatures: signed.signatures.map((s) => bs58.encode(s)) },
    meta: {
      err: null,
      fee: 10000,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as VersionedTransactionResponse;
  const actual = verifyTreasuryTransaction(tx, response);
  assert.equal(actual.consumedLamports, '10000');
  assert.equal(actual.transferredLamports, '200000000');
  assert.equal(actual.tokenBaseUnits, '0');
  assert.throws(
    () =>
      verifyTreasuryTransaction(tx, {
        ...response,
        transaction: {
          ...response.transaction,
          signatures: [response.transaction.signatures[0], bs58.encode(new Uint8Array(64).fill(7))],
        },
      }),
    /identity|signature/i,
  );
  for (const index of [0, sourceIndex]) {
    const changed = structuredClone(response.meta!);
    changed.postBalances[index]++;
    assert.throws(() => verifyTreasuryTransaction(tx, { ...response, meta: changed }), /transfer/i);
  }
  assert.throws(
    () => verifyTreasuryTransaction({ ...tx, transferLamports: '199999999' }, response),
    /transfer/i,
  );
  assert.throws(
    () =>
      verifyTreasuryTransaction(
        { ...tx, transferFrom: Keypair.generate().publicKey.toBase58() },
        response,
      ),
    /transfer/i,
  );
  const failed = {
    ...response,
    meta: {
      ...response.meta!,
      err: { InstructionError: [0, 'Custom'] },
      postBalances: pre.map((v, i) => (i === 0 ? v - 10000 : v)),
    },
  } as VersionedTransactionResponse;
  assert.equal(verifyTreasuryTransaction(tx, failed).transferredLamports, '0');
  assert.equal(verifyTreasuryTransaction(tx, failed).consumedLamports, '10000');
});

test('central transfer preparation uses both matching signers and rejects excess transfer gas', async () => {
  const source = Keypair.generate(),
    wallet = Keypair.generate();
  let fee = 10000;
  const connection = {
    getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 10,
    }),
    getBalanceAndContext: async () => ({ context: { slot: 10 }, value: 100000000 }),
    simulateTransaction: async (tx: VersionedTransaction) => {
      assert.equal(tx.signatures.length, 2);
      assert(tx.signatures.every((s) => s.some((byte) => byte !== 0)));
      const keys = tx.message.staticAccountKeys;
      const sourceIndex = keys.findIndex((k) => k.equals(source.publicKey));
      const pre = keys.map((_, i) => (i === 0 ? 100000000 : i === sourceIndex ? 1000000000 : 0));
      const post = [...pre];
      post[0] += 200000000 - fee;
      post[sourceIndex] -= 200000000;
      return {
        context: { slot: 10 },
        value: {
          err: null,
          fee,
          preBalances: pre,
          postBalances: post,
          accounts: [{ lamports: post[0] }],
        },
      };
    },
  } as unknown as Connection;
  const provider = new PumpTreasuryProvider(
    {
      rpcUrl: 'https://unused.invalid',
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      mint: Keypair.generate().publicKey.toBase58(),
      platformCreator: wallet.publicKey.toBase58(),
      slippageBps: 100,
      minimumWalletReserveLamports: '10000000',
      signerForCreator: async (address) =>
        address === source.publicKey.toBase58() ? source : wallet,
    },
    connection,
  );
  const input = {
    id: 'transfer',
    creator: wallet.publicKey.toBase58(),
    sourceCreator: source.publicKey.toBase58(),
    transferLamports: '200000000',
    maxCostLamports: '20000',
  };
  assert.equal((await provider.prepareTransfer(input)).kind, 'Transfer');
  fee = 30000;
  await assert.rejects(provider.prepareTransfer(input), /spending|cost|fee/i);
  await assert.rejects(
    provider.prepareTransfer({ ...input, sourceCreator: wallet.publicKey.toBase58() }),
    /distinct|same|source/i,
  );
});
test('finalized buy and burn proof bind exact bytes, payer, token mint, ATA, owner and decimals', () => {
  const { transaction, response } = proof();
  assert.equal(verifyTreasuryTransaction(transaction, response).tokenBaseUnits, '100');
  for (const field of ['signature', 'mint', 'ata', 'creator', 'tokenProgram'] as const) {
    assert.throws(
      () =>
        verifyTreasuryTransaction(
          {
            ...transaction,
            [field]:
              field === 'signature'
                ? bs58.encode(new Uint8Array(64).fill(1))
                : Keypair.generate().publicKey.toBase58(),
          },
          response,
        ),
      /identity|payer|minimum|receipt/,
    );
  }
  assert.throws(
    () => verifyTreasuryTransaction({ ...transaction, tokenDecimals: 9 }, response),
    /identity/,
  );
  const other = proof();
  assert.throws(
    () =>
      verifyTreasuryTransaction(
        { ...transaction, signedTransactionBase64: other.transaction.signedTransactionBase64 },
        response,
      ),
    /identity/,
  );
  const burn = proof('Burn');
  assert.equal(verifyTreasuryTransaction(burn.transaction, burn.response).tokenBaseUnits, '100');
});
test('minimum bought tokens and exact burned quantity cannot be claimed from partial receipts', () => {
  const buy = proof();
  buy.response.meta!.postTokenBalances![0].uiTokenAmount.amount = '99';
  assert.throws(() => verifyTreasuryTransaction(buy.transaction, buy.response), /minimum/);
  const burn = proof('Burn');
  burn.response.meta!.postTokenBalances![0].uiTokenAmount.amount = '1';
  assert.throws(() => verifyTreasuryTransaction(burn.transaction, burn.response), /exact/);
});
test('finalized failure is only gas and no tokens; incurred overruns remain visible for budget freezing', () => {
  const f = proof();
  f.response.meta!.err = { InstructionError: [0, 'Custom'] };
  f.response.meta!.postBalances[0] = 95000;
  f.response.meta!.postTokenBalances![0].uiTokenAmount.amount = '0';
  assert.deepEqual(verifyTreasuryTransaction(f.transaction, f.response), {
    signature: f.transaction.signature,
    slot: 1,
    failed: true,
    consumedLamports: '5000',
    networkFeeLamports: '5000',
    tokenBaseUnits: '0',
    tokenDecimals: 6,
  });
  f.response.meta!.postBalances[0] = 90000;
  assert.throws(() => verifyTreasuryTransaction(f.transaction, f.response), /inconsistent/);
  const overrun = proof();
  assert.equal(
    verifyTreasuryTransaction(
      { ...overrun.transaction, maxCostLamports: '10000' },
      overrun.response,
    ).consumedLamports,
    '15000',
  );
});
test('wrong network is rejected before any treasury SDK or broadcast action', async () => {
  const signer = Keypair.generate();
  let sends = 0;
  const chain = {
    getGenesisHash: async () => 'wrong-network',
    sendRawTransaction: async () => {
      sends++;
      return 'unexpected';
    },
  } as unknown as Connection;
  const provider = new PumpTreasuryProvider(
    {
      rpcUrl: 'https://unused.invalid',
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      mint: PublicKey.default.toBase58(),
      platformCreator: signer.publicKey.toBase58(),
      slippageBps: 100,
      minimumWalletReserveLamports: '10000',
      signerForCreator: async () => signer,
    },
    chain,
  );
  await assert.rejects(provider.verifyPlatform(), /network identity/);
  await assert.rejects(provider.broadcast(proof().transaction), /network identity/);
  assert.equal(sends, 0);
});

test('the full mainnet genesis returned by Solana RPC reaches mint verification while the truncated value is rejected', async () => {
  const signer = Keypair.generate();
  let accountReads = 0;
  // Observed from api.mainnet-beta.solana.com getGenesisHash, also used by launch fixtures.
  const mainnet = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const chain = {
    getGenesisHash: async () => mainnet,
    getAccountInfo: async () => {
      accountReads++;
      return null;
    },
  } as unknown as Connection;
  const config = {
    rpcUrl: 'https://unused.invalid',
    genesisHash: mainnet,
    mint: Keypair.generate().publicKey.toBase58(),
    platformCreator: signer.publicKey.toBase58(),
    slippageBps: 100,
    minimumWalletReserveLamports: '10000',
    signerForCreator: async () => signer,
  };
  const provider = new PumpTreasuryProvider(config, chain);
  await assert.rejects(provider.verifyPlatform(), /supported SPL token/);
  assert.equal(accountReads, 1, 'the correct network must proceed to actual mint validation');
  assert.throws(
    () => new PumpTreasuryProvider({ ...config, genesisHash: mainnet.slice(0, 29) }, chain),
    /mainnet genesis/,
  );
});
