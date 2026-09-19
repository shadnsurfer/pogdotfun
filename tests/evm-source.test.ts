import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createEvmFeeSource } from '../server/agents/evm-source.ts';
import type { EvmFeeSourceAdapter } from '../server/agents/evm-source.ts';
import type { TransactionIntent, Reconciliation } from '../server/chains/index.ts';
const account = `0x${'11'.repeat(20)}` as const;
const token = `0x${'22'.repeat(20)}` as const;
const hash = `0x${'33'.repeat(32)}` as const;
const claimHash = `0x${'44'.repeat(32)}` as const;
const recipient = { platform: 'twitch' as const, providerId: 'twitch:123', username: 'streamer' };
const launch: TransactionIntent = {
  id: 'launch-1',
  chainId: 56,
  kind: 'launch',
  account,
  to: account,
  data: '0x',
  value: 0n,
  feeRecipient: account,
};
const confirmed: Reconciliation = {
  status: 'confirmed',
  hash,
  token,
  evidenceId: `56:${hash}:0x0`,
};
function setup(chainId: 56 | 4663 = 56) {
  const db = new DatabaseSync(':memory:');
  let failOnce = false;
  let claims = 0;
  let claimPending = false;
  let claimable = 100n;
  const ids: string[] = [];
  const adapter: EvmFeeSourceAdapter = {
    chainId,
    async buildClaim(id: string, t?: `0x${string}`) {
      claims++;
      ids.push(id);
      return { ...launch, chainId, kind: 'claim', id, token: t };
    },
    async execute(i) {
      if (i.kind === 'claim' && failOnce) {
        failOnce = false;
        throw new Error('timeout');
      }
      return { hash: i.kind === 'claim' ? claimHash : hash };
    },
    async reconcile(i) {
      if (i.kind === 'launch') return { ...confirmed, evidenceId: `${chainId}:${hash}:0x0` };
      return {
        status: claimPending ? 'pending' : 'confirmed',
        hash: claimHash,
        token,
        feeAmountWei: chainId === 56 ? 100n : undefined,
        evidenceId: chainId === 56 ? `56:${claimHash}:0x1` : undefined,
        requiresPayoutEvidence: chainId === 4663,
      };
    },
    async claimableNative() {
      return claimable;
    },
  };
  const options = {
    db,
    adapters: [adapter],
    identityVerifier: {
      async resolve() {
        return recipient;
      },
    },
    minimumClaimWei: 1n,
  };
  return {
    db,
    adapter,
    options,
    source: createEvmFeeSource(options),
    ids,
    get claims() {
      return claims;
    },
    timeout() {
      failOnce = true;
    },
    pending(value: boolean) {
      claimPending = value;
    },
    empty() {
      claimable = 0n;
    },
  };
}
test('registry rechecks confirmed launch and resolves durable streamer identity', async () => {
  const f = setup();
  await assert.rejects(
    f.source.registerConfirmedLaunch({ ...launch, kind: 'claim' }, confirmed, recipient),
    /launch/i,
  );
  await assert.rejects(
    f.source.registerConfirmedLaunch(launch, { ...confirmed, token: account }, recipient),
    /reconciliation|token|evidence/i,
  );
  await assert.rejects(
    f.source.registerConfirmedLaunch(launch, confirmed, { ...recipient, providerId: 'twitch:999' }),
    /identity/i,
  );
  await f.source.registerConfirmedLaunch(launch, confirmed, recipient);
  const lots = await f.source.scan();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].amountBaseUnits, '100');
  assert.equal(lots[0].recipient.providerId, 'twitch:123');
  assert.equal(lots[0].claimReference, `56:${claimHash}:0x1`);
  f.db.close();
});
test('timeout and restart recover the same claim intent without allocating another id', async () => {
  const f = setup();
  await f.source.registerConfirmedLaunch(launch, confirmed, recipient);
  f.timeout();
  assert.deepEqual(await f.source.scan(), []);
  const recovered = createEvmFeeSource(f.options);
  const lots = await recovered.scan();
  assert.equal(lots.length, 1);
  assert.equal(f.claims, 1);
  assert.equal(new Set(f.ids).size, 1);
  f.db.close();
});
test('unfinalized and zero claims produce no fee lots', async () => {
  const f = setup();
  await f.source.registerConfirmedLaunch(launch, confirmed, recipient);
  f.empty();
  assert.deepEqual(await f.source.scan(), []);
  assert.equal(f.claims, 0);
  f.db.close();
  const g = setup();
  await g.source.registerConfirmedLaunch(launch, confirmed, recipient);
  g.pending(true);
  assert.deepEqual(await g.source.scan(), []);
  assert.deepEqual(await g.source.scan(), []);
  assert.equal(g.claims, 1);
  g.db.close();
});
test('PONs amount-unverified receipts never become fee lots', async () => {
  const f = setup(4663);
  await f.source.registerConfirmedLaunch(
    { ...launch, chainId: 4663 },
    { ...confirmed, evidenceId: `4663:${hash}:0x0` },
    recipient,
  );
  assert.deepEqual(await f.source.scan(), []);
  assert.equal(f.claims, 0);
  f.db.close();
});
test('PONs verifier must bind chain, claim tx, fee recipient, token and positive amount', async () => {
  const f = setup(4663);
  const source = createEvmFeeSource({
    ...f.options,
    ponsFeeEvidence: {
      async verify() {
        return {
          chainId: 4663 as const,
          transactionHash: claimHash,
          recipient: account,
          token,
          amountWei: 100n,
          evidenceId: `4663:${claimHash}:0x2`,
        };
      },
    },
  });
  await source.registerConfirmedLaunch(
    { ...launch, chainId: 4663 },
    { ...confirmed, evidenceId: `4663:${hash}:0x0` },
    recipient,
  );
  const lots = await source.scan();
  assert.equal(lots[0]?.asset, 'ETH');
  assert.equal(lots[0]?.amountBaseUnits, '100');
  f.db.close();
});
test('outbox acknowledgment and event uniqueness prevent duplicate funding', async () => {
  const f = setup();
  await f.source.registerConfirmedLaunch(launch, confirmed, recipient);
  const first = await f.source.scan();
  f.source.acknowledge(first[0].id);
  assert.deepEqual(await f.source.scan(), []);
  f.db.close();
});

test('launch service persists the recipient before execution and recovers registration', async () => {
  const f = setup();
  const result = await f.source.executeLaunch(launch, recipient);
  assert.equal(result.status, 'confirmed');
  await createEvmFeeSource(f.options).recoverLaunches();
  assert.equal((await f.source.scan()).length, 1);
  await assert.rejects(
    f.source.executeLaunch({ ...launch, value: 1n }, recipient),
    /conflicting.*launch/i,
  );
  f.db.close();
});

test('PONs incorrect payout recipient cannot fund a streamer', async () => {
  const f = setup(4663);
  const source = createEvmFeeSource({
    ...f.options,
    ponsFeeEvidence: {
      async verify() {
        return {
          chainId: 4663 as const,
          transactionHash: claimHash,
          recipient: token,
          token,
          amountWei: 100n,
          evidenceId: `4663:${claimHash}:0x2`,
        };
      },
    },
  });
  await source.registerConfirmedLaunch(
    { ...launch, chainId: 4663 },
    { ...confirmed, evidenceId: `4663:${hash}:0x0` },
    recipient,
  );
  assert.deepEqual(await source.scan(), []);
  assert.match(source.issues()[0].issue, /evidence identity mismatch/);
  f.db.close();
});

test('worker route policy prevents a new EVM claim before signing', async () => {
  const f = setup();
  await f.source.registerConfirmedLaunch(launch, confirmed, recipient);
  assert.deepEqual(await f.source.scan({ canClaim: () => false }), []);
  assert.equal(f.claims, 0);
  f.db.close();
});
