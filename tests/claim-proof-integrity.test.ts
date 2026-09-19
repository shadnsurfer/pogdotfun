import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { VersionedTransactionResponse } from '@solana/web3.js';
import { PumpSolanaProvider } from '../server/providers/pump-solana.ts';
import type { PreparedTransaction } from '../server/providers/contracts.ts';

const require = createRequire(import.meta.url);
const { creatorVaultPda, PUMP_PROGRAM_ID } =
  require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

function fixture(otherPayer = false) {
  const creator = Keypair.generate();
  const payer = otherPayer ? Keypair.generate() : creator;
  const mint = Keypair.generate().publicKey.toBase58();
  const vault = creatorVaultPda(creator.publicKey);
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: creator.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]),
      }),
    ],
  }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  signed.sign(otherPayer ? [payer, creator] : [creator]);
  const signature = bs58.encode(signed.signatures[0]);
  const preBalances = message.staticAccountKeys.map(() => 0);
  const postBalances = [...preBalances];
  const vaultIndex = message.staticAccountKeys.findIndex((key) => key.equals(vault));
  const creatorIndex = message.staticAccountKeys.findIndex((key) => key.equals(creator.publicKey));
  preBalances[0] = 2_000_000_000;
  postBalances[0] = 1_999_995_000;
  preBalances[vaultIndex] = 1_000_890_880;
  postBalances[vaultIndex] = 890_880;
  postBalances[creatorIndex] += 1_000_000_000;
  const receipt: VersionedTransactionResponse = {
    slot: 123,
    blockTime: 1_800_000_000,
    version: 0,
    transaction: { message, signatures: signed.signatures.map((value) => bs58.encode(value)) },
    meta: { err: null, fee: 5000, preBalances, postBalances },
  };
  const prepared: PreparedTransaction = {
    id: 'claim:one',
    kind: 'claim',
    tokenId: 'one',
    mint,
    creator: creator.publicKey.toBase58(),
    signature,
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    blockhash: message.recentBlockhash,
    lastValidBlockHeight: 200,
    createdAt: new Date().toISOString(),
  };
  const connection = new Connection('https://rpc.invalid');
  connection.getGenesisHash = async () => 'fixture';
  connection.getSignatureStatuses = async () => ({
    context: { slot: 123 },
    value: [{ slot: 123, confirmations: null, err: null, confirmationStatus: 'finalized' }],
  });
  connection.getTransaction = (async () => receipt) as typeof connection.getTransaction;
  const provider = new PumpSolanaProvider(
    {
      rpcUrl: 'https://rpc.invalid',
      expectedGenesisHash: 'fixture',
      mappings: [
        { tokenId: 'one', mint, creator: prepared.creator, dedicatedCreatorVerified: true },
      ],
      signerForCreator: async () => {
        throw new Error('Proof reads cannot request a signer.');
      },
      transactionsEnabled: false,
      coinbaseAccountId: '',
      allowedCoinbaseAddresses: [],
      maxTopUpLamports: 1_000_000_000n,
      minimumWalletReserveLamports: 10_000n,
    },
    connection,
  );
  return { provider, connection, prepared, receipt };
}

test('a matching finalized signed claim proves its exact received amount and gas', async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.finalizedProof(f.prepared), {
    signature: f.prepared.signature,
    slot: 123,
    confirmation: 'finalized',
    amountLamports: '1000000000',
    networkFeeLamports: '5000',
  });
});

test('returned ATA rent remains separate from claimed fee revenue', async () => {
  const f = fixture();
  f.receipt.meta!.postBalances[0] += 2_039_280;
  const proof = await f.provider.finalizedProof(f.prepared);
  assert.equal(proof.amountLamports, '1000000000');
  assert.equal(proof.networkFeeLamports, '5000');
});

test('successful claim proof rejects an unrelated receipt signature', async () => {
  const f = fixture();
  f.receipt.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(7));
  await assert.rejects(f.provider.finalizedProof(f.prepared), /identity|signature/i);
});

test('successful claim proof rejects a changed receipt message under the expected signature', async () => {
  const f = fixture();
  f.receipt.transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  await assert.rejects(f.provider.finalizedProof(f.prepared), /identity|message/i);
});

for (const bytes of ['', 'fixture']) {
  test(`successful claim proof rejects ${bytes ? 'malformed' : 'missing'} persisted signed bytes`, async () => {
    const f = fixture();
    f.prepared.signedTransactionBase64 = bytes;
    await assert.rejects(f.provider.finalizedProof(f.prepared), /identity|signed transaction/i);
  });
}

test('successful claim proof rejects a persisted signature that differs from its signed bytes', async () => {
  const f = fixture();
  f.prepared.signature = bs58.encode(new Uint8Array(64).fill(7));
  f.receipt.transaction.signatures[0] = f.prepared.signature;
  await assert.rejects(f.provider.finalizedProof(f.prepared), /identity|signature/i);
});

test('successful claim proof requires the dedicated creator to pay and sign', async () => {
  const f = fixture(true);
  await assert.rejects(f.provider.finalizedProof(f.prepared), /creator|payer/i);
});

test('vault debits without matching creator SOL credit cannot become claim revenue', async () => {
  const f = fixture();
  f.receipt.meta!.postBalances[0] = f.receipt.meta!.preBalances[0] - 5000;
  await assert.rejects(f.provider.finalizedProof(f.prepared), /not received as SOL/i);
});

test('verified manual claims still import without a locally provisioned signer', async () => {
  const f = fixture();
  const proof = await f.provider.verifyExternalClaim({
    tokenId: 'one',
    signature: f.prepared.signature,
  });
  assert.equal(proof.amountLamports, '1000000000');
  assert.equal(proof.networkFeeLamports, '5000');
  assert.equal(proof.blockTime, 1_800_000_000);
});

test('manual claim proof rejects a receipt that changes after its instructions were verified', async () => {
  const f = fixture();
  let reads = 0;
  f.connection.getTransaction = (async () => {
    if (reads++ === 0) return f.receipt;
    const changed = VersionedTransaction.deserialize(
      Buffer.from(f.prepared.signedTransactionBase64, 'base64'),
    );
    changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    return { ...f.receipt, transaction: { ...f.receipt.transaction, message: changed.message } };
  }) as typeof f.connection.getTransaction;
  await assert.rejects(
    f.provider.verifyExternalClaim({ tokenId: 'one', signature: f.prepared.signature }),
    /identity|message/i,
  );
});
