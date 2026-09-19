import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { solanaSettlementTransfer } from '../server/agents/solana-transfer.ts';
import type { PumpSolanaProvider } from '../server/providers/pump-solana.ts';
import type { PipelineJob } from '../server/agents/pipeline.ts';
const job: PipelineJob = {
  id: 'fee-1',
  tokenId: 'one',
  chain: 'solana',
  asset: 'SOL',
  amountBaseUnits: '123',
  decimals: 9,
  claimReference: 'claim',
  recipient: { platform: 'kick', providerId: 'kick:1', username: 'creator' },
  phase: 'depositing',
};
const destination = {
  accountId: 'account',
  asset: 'SOL',
  network: 'solana',
  address: 'deposit',
  addressId: 'address',
  verifiedAt: Date.now(),
};
test('concurrent normal send and safe recovery cannot prepare or broadcast twice', async () => {
  const db = new DatabaseSync(':memory:');
  let preparations = 0,
    broadcasts = 0;
  const provider = {
    prepareTopUp: async (id: string) => {
      preparations++;
      await new Promise((r) => setTimeout(r, 5));
      return {
        id,
        kind: 'topup',
        tokenId: 'one',
        mint: 'mint',
        creator: 'creator',
        signature: 'signature',
        signedTransactionBase64: 'bytes',
        blockhash: 'block',
        lastValidBlockHeight: 1,
        createdAt: new Date().toISOString(),
        amountLamports: '123',
        destination: 'deposit',
      };
    },
    broadcast: async () => {
      broadcasts++;
      return 'signature';
    },
    reconcile: async () => 'confirmed',
    finalizedProof: async () => ({ signature: 'signature', amountLamports: '123' }),
  } as unknown as PumpSolanaProvider;
  const transfer = solanaSettlementTransfer(db, () => provider);
  const results = await Promise.allSettled([
    transfer.send(job, destination),
    transfer.resumeUnsubmitted!(job, destination),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(preparations, 1);
  assert.equal(broadcasts, 1);
  assert.equal(await transfer.resumeUnsubmitted!(job, destination), null);
  assert.deepEqual(await transfer.reconcile(job), {
    hash: 'signature',
    amountBaseUnits: '123',
    chain: 'solana',
    asset: 'SOL',
  });
  await assert.rejects(transfer.send({ ...job, amountBaseUnits: '124' }, destination));
  db.close();
});
test('interrupted preparation stays reserved and unsupported networks never sign', async () => {
  const db = new DatabaseSync(':memory:');
  let preparations = 0;
  const transfer = solanaSettlementTransfer(
    db,
    () =>
      ({
        prepareTopUp: async () => {
          preparations++;
          throw new Error('unavailable');
        },
      }) as unknown as PumpSolanaProvider,
  );
  await assert.rejects(transfer.send(job, destination));
  assert.equal(await transfer.resumeUnsubmitted!(job, destination), null);
  assert.equal(preparations, 1);
  await assert.rejects(
    transfer.send({ ...job, id: 'other', chain: 'bnb', asset: 'BNB' }, destination),
  );
  assert.equal(preparations, 1);
  db.close();
});
