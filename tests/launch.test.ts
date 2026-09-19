import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { createOperations } from '../server/operations.ts';
import { createPumpLaunchService } from '../server/launch/service.ts';
import { PumpLaunchChain, transactionSignature } from '../server/launch/pump-chain.ts';
import type {
  LaunchChain,
  LaunchChainResult,
  LaunchPlan,
  LaunchPrincipal,
  VerifiedLaunchInput,
} from '../server/launch/types.ts';

const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const now = Date.parse('2026-09-16T02:00:00Z');
function fakeConnection(changes: Record<string, unknown> = {}) {
  return {
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfo: async () => [null, null],
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500,
    }),
    getBalance: async () => 1_000_000_000,
    simulateTransaction: async () => ({
      value: { err: null, accounts: [{ lamports: 980_000_000 }] },
    }),
    getFeeForMessage: async () => ({ value: 10_300 }),
    getBlockHeight: async () => 400,
    ...changes,
  } as unknown as Connection;
}
function fixture(
  options: {
    enabled?: boolean;
    transactions?: boolean;
    key?: Uint8Array;
    chainResult?: LaunchChainResult;
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  const operations = createOperations(db, { streamerBps: 8000 });
  const payer = Keypair.generate();
  const principal: LaunchPrincipal = {
    userId: 'did:privy:test-user',
    walletAddress: payer.publicKey.toBase58(),
  };
  const input: VerifiedLaunchInput = {
    requestId: 'launch-request-00001',
    name: 'Pog Stream',
    symbol: 'STREAM',
    description: 'Stream support',
    walletAddress: payer.publicKey.toBase58(),
    metadataUri: 'https://example.test/ipfs/metadata',
    imageUri: 'https://example.test/ipfs/image',
    recipient: {
      id: 'twitch:123',
      platform: 'twitch',
      username: 'test_streamer',
      channelUrl: 'https://www.twitch.tv/test_streamer',
      verified: true,
      verifiedAt: new Date(now).toISOString(),
    },
  };
  const actualBuilder = new PumpLaunchChain(
    {
      rpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: genesis,
      transactionsEnabled: false,
    },
    fakeConnection(),
  );
  const state = {
    builds: 0,
    broadcasts: 0,
    result: options.chainResult ?? ({ status: 'pending' } as LaunchChainResult),
    uncertain: false,
  };
  const chain: LaunchChain = {
    prepare: async (plan, mint) => {
      state.builds++;
      return actualBuilder.prepare(plan, mint);
    },
    broadcast: async (encoded, signature) => {
      const row = db
        .prepare('SELECT signature,status,payload FROM launch_intents WHERE signature = ?')
        .get(signature);
      assert.ok(row, 'signed identity must be durable before broadcast');
      assert.equal(row.status, 'submitted');
      assert.equal(JSON.parse(row.payload as string).signedTransaction, encoded);
      state.broadcasts++;
      if (state.uncertain) throw new Error('private RPC token and timeout details');
    },
    reconcile: async (record) => (record.signature ? state.result : { status: 'pending' }),
  };
  const config = {
    launchesEnabled: options.enabled ?? true,
    transactionsEnabled: options.transactions ?? true,
    encryptionKey: options.key ?? new Uint8Array(32).fill(7),
    chain,
    now: () => now,
  };
  const service = createPumpLaunchService(db, operations, config);
  const sign = (transaction: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    tx.sign([payer]);
    return Buffer.from(tx.serialize()).toString('base64');
  };
  return { db, operations, payer, principal, input, service, state, config, sign };
}

test('launch preparation uses official Pump create_v2, distinct encrypted keys, exact wallet ownership and idempotency', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.prepare(
        { userId: f.principal.userId, walletAddress: Keypair.generate().publicKey.toBase58() },
        f.input,
      ),
      /not linked/,
    );
    const prepared = await f.service.prepare(f.principal, f.input);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.walletAddress, f.input.walletAddress);
    assert.notEqual(prepared.summary.mint, prepared.summary.creatorAddress);
    assert.notEqual(prepared.summary.creatorAddress, f.input.walletAddress);
    assert.equal(prepared.summary.creatorReserveLamports, '2000000');
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction!, 'base64'));
    assert.equal(tx.message.header.numRequiredSignatures, 2);
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), f.input.walletAddress);
    assert.ok(tx.signatures[0].every((x) => x === 0));
    assert.ok(tx.signatures[1].some((x) => x !== 0));
    const again = await f.service.prepare(f.principal, {
      ...f.input,
      recipient: { ...f.input.recipient, verifiedAt: new Date(now - 1000).toISOString() },
    });
    assert.equal(again.transaction, prepared.transaction);
    assert.equal(f.state.builds, 1);
    const secrets = f.db.prepare('SELECT encrypted FROM launch_secrets').all();
    assert.equal(secrets.length, 2);
    assert.ok(
      secrets.every((x) =>
        /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(x.encrypted as string),
      ),
    );
    assert.doesNotMatch(JSON.stringify(prepared), /encrypted|secretKey|signedTransaction|userId/);
    await assert.rejects(
      f.service.prepare(f.principal, { ...f.input, symbol: 'OTHER' }),
      /already belongs/,
    );
    await assert.rejects(
      f.service.prepare(f.principal, {
        ...f.input,
        recipient: { ...f.input.recipient, id: 'twitch:456' },
      }),
      /already belongs/,
    );
    await assert.rejects(
      f.service.get(
        { userId: 'another-user', walletAddress: f.input.walletAddress },
        prepared.launchId,
      ),
      /not found/,
    );
    assert.equal(f.service.catalog().tokens.length, 0);
  } finally {
    f.db.close();
  }
});

test('launch and broadcast activation gates remain independent and fail closed', async () => {
  const disabled = fixture({ enabled: false });
  const noBroadcast = fixture({ transactions: false });
  try {
    await assert.rejects(
      disabled.service.prepare(disabled.principal, disabled.input),
      /not enabled/,
    );
    assert.equal(disabled.state.builds, 0);
    const prepared = await noBroadcast.service.prepare(noBroadcast.principal, noBroadcast.input);
    await assert.rejects(
      noBroadcast.service.submit(
        noBroadcast.principal,
        prepared.launchId,
        noBroadcast.sign(prepared.transaction!),
      ),
      /broadcasting is disabled/,
    );
    assert.equal(noBroadcast.state.broadcasts, 0);
  } finally {
    disabled.db.close();
    noBroadcast.db.close();
  }
});

test('Kick launch preparation and signed submission retain recipient binding and wallet safety', async () => {
  const f = fixture();
  const recipient = {
    ...f.input.recipient,
    platform: 'kick' as const,
    id: 'kick:123',
    channelUrl: 'https://kick.com/test_streamer',
  };
  try {
    const prepared = await f.service.prepare(f.principal, { ...f.input, recipient });
    assert.equal(prepared.status, 'prepared');
    assert.equal(f.state.builds, 1);
    const again = await f.service.prepare(f.principal, { ...f.input, recipient });
    assert.equal(again.launchId, prepared.launchId);
    assert.equal(again.transaction, prepared.transaction);
    assert.equal(f.state.builds, 1);
    await assert.rejects(
      f.service.prepare(f.principal, { ...f.input, recipient: { ...recipient, id: 'kick:999' } }),
      /already belongs/,
    );
    await assert.rejects(
      f.service.submit(f.principal, prepared.launchId, prepared.transaction!),
      /signature must be valid/,
    );
    await assert.rejects(
      f.service.submit(
        { ...f.principal, userId: 'another-user' },
        prepared.launchId,
        f.sign(prepared.transaction!),
      ),
      /not found/,
    );
    assert.equal(f.state.broadcasts, 0);
    const submitted = await f.service.submit(
      f.principal,
      prepared.launchId,
      f.sign(prepared.transaction!),
    );
    assert.equal(submitted.status, 'submitted');
    assert.equal(f.state.broadcasts, 1);
    const stored = JSON.parse(
      String(
        f.db.prepare('SELECT payload FROM launch_intents WHERE id=?').get(prepared.launchId)!
          .payload,
      ),
    );
    assert.equal(stored.recipient.id, recipient.id);
    assert.equal(stored.recipient.platform, 'kick');
    assert.equal((await f.service.get(f.principal, prepared.launchId)).launchId, prepared.launchId);
  } finally {
    f.db.close();
  }
});

test('cancel preserves unsigned transaction records and releases the active-attempt limit immediately', async () => {
  const f = fixture();
  try {
    const attempts = [];
    for (let index = 0; index < 3; index++)
      attempts.push(
        await f.service.prepare(f.principal, {
          ...f.input,
          requestId: `cancel-attempt-${index}-0001`,
        }),
      );
    await assert.rejects(
      f.service.prepare(f.principal, { ...f.input, requestId: 'cancel-attempt-next-0001' }),
      { status: 409 },
    );
    await assert.rejects(
      f.service.cancel({ ...f.principal, userId: 'another-user' }, attempts[0].launchId),
      { status: 404 },
    );
    const cancelled = await f.service.cancel(f.principal, attempts[0].launchId);
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.transaction, null);
    assert.equal((await f.service.cancel(f.principal, attempts[0].launchId)).status, 'failed');
    await assert.rejects(
      f.service.submit(f.principal, attempts[0].launchId, f.sign(attempts[0].transaction!)),
      /not ready for signing/,
    );
    const next = await f.service.prepare(f.principal, {
      ...f.input,
      requestId: 'cancel-attempt-next-0001',
    });
    assert.equal(next.status, 'prepared');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_intents').get()!.n, 4);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_secrets').get()!.n, 8);
    assert.equal(f.state.broadcasts, 0);
  } finally {
    f.db.close();
  }
});

test('cancel refuses in-flight preparation, review and signed records', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const original = JSON.parse(
      String(f.db.prepare('SELECT payload FROM launch_intents').get()!.payload),
    );
    for (const change of [
      { status: 'preparing' },
      { status: 'review' },
      { status: 'prepared', signature: 'existing-signature' },
      { status: 'prepared', signedTransaction: 'existing-signed-bytes' },
      { status: 'failed', signedTransaction: 'existing-signed-bytes' },
      { status: 'review', signature: 'existing-signature' },
      { status: 'review', signedTransaction: 'existing-signed-bytes' },
      { status: 'confirmed' },
    ]) {
      const record = { ...original, ...change };
      f.db
        .prepare('UPDATE launch_intents SET status=?,payload=? WHERE id=?')
        .run(record.status, JSON.stringify(record), prepared.launchId);
      await assert.rejects(f.service.cancel(f.principal, prepared.launchId), { status: 409 });
      assert.deepEqual(
        JSON.parse(String(f.db.prepare('SELECT payload FROM launch_intents').get()!.payload)),
        record,
      );
    }
    assert.equal(f.state.broadcasts, 0);
  } finally {
    f.db.close();
  }
});

test('late unsigned reconciliation cannot resurrect a cancelled launch', async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    f.config.chain.reconcile = async () => {
      entered();
      await paused;
      return { status: 'pending' };
    };
    const stale = f.service.get(f.principal, prepared.launchId);
    await started;
    assert.equal((await f.service.cancel(f.principal, prepared.launchId)).status, 'failed');
    release();
    assert.equal((await stale).status, 'failed');
    assert.equal(f.db.prepare('SELECT status FROM launch_intents').get()!.status, 'failed');
    assert.equal(f.state.broadcasts, 0);
  } finally {
    release();
    await f.service.close();
    f.db.close();
  }
});

test('background expiry releases abandoned unsigned attempts only after their signing window and finalized mint check', async () => {
  const f = fixture();
  let height = 400;
  const liveMint = new Set<string>();
  const inspector = new PumpLaunchChain(
    {
      rpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: genesis,
      transactionsEnabled: false,
    },
    fakeConnection({
      getBlockHeight: async () => height,
      getAccountInfo: async (key: PublicKey) => (liveMint.has(key.toBase58()) ? {} : null),
    }),
  );
  f.config.chain.reconcile = (record, signal) => inspector.reconcile(record, signal);
  try {
    const attempts = [];
    for (let index = 0; index < 3; index++)
      attempts.push(
        await f.service.prepare(f.principal, {
          ...f.input,
          requestId: `expiry-attempt-${index}-0001`,
        }),
      );
    assert.deepEqual(await f.service.reconcilePending(), { checked: 3, confirmed: 0 });
    await assert.rejects(
      f.service.prepare(f.principal, { ...f.input, requestId: 'expiry-attempt-next-0001' }),
      { status: 409 },
    );
    height = 501;
    liveMint.add(attempts[0].summary.mint);
    assert.deepEqual(await f.service.reconcilePending(), { checked: 3, confirmed: 0 });
    const states = f.db
      .prepare('SELECT status FROM launch_intents ORDER BY id')
      .all()
      .map((row) => row.status)
      .sort();
    assert.deepEqual(states, ['failed', 'failed', 'review']);
    assert.deepEqual(await f.service.reconcilePending(), { checked: 1, confirmed: 0 });
    assert.equal(
      f.db.prepare('SELECT status FROM launch_intents WHERE id=?').get(attempts[0].launchId)!
        .status,
      'review',
      'an unsigned on-chain mint remains under internal review without a history page',
    );
    assert.equal(
      (await f.service.prepare(f.principal, { ...f.input, requestId: 'expiry-attempt-next-0001' }))
        .status,
      'prepared',
    );
    assert.equal(f.state.broadcasts, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM launch_intents').get()!.n, 4);
  } finally {
    f.db.close();
  }
});

test('a client cannot replace approved instruction bytes or omit the payer signature', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    await assert.rejects(
      f.service.submit(f.principal, prepared.launchId, prepared.transaction!),
      /signature must be valid/,
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction!, 'base64'));
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign([f.payer]);
    await assert.rejects(
      f.service.submit(
        f.principal,
        prepared.launchId,
        Buffer.from(tx.serialize()).toString('base64'),
      ),
      /changes the approved launch/,
    );
    assert.equal(f.state.broadcasts, 0);
    assert.equal(f.db.prepare('SELECT signature FROM launch_intents').get()!.signature, null);
  } finally {
    f.db.close();
  }
});

test('durable signed transaction is broadcast once; finalized verification registers the actual ledger mapping', async () => {
  const f = fixture();
  try {
    f.input.twitter = 'https://x.com/i/communities/123456789';
    const prepared = await f.service.prepare(f.principal, f.input);
    const signed = f.sign(prepared.transaction!);
    const pending = await f.service.submit(f.principal, prepared.launchId, signed);
    assert.equal(pending.status, 'submitted');
    assert.equal(f.operations.snapshot().tokens.length, 0);
    f.state.result = { status: 'confirmed', slot: 777 };
    const confirmed = await f.service.get(f.principal, prepared.launchId);
    assert.equal(confirmed.status, 'confirmed');
    const token = f.operations.snapshot().tokens[0];
    assert.equal(token.mint, prepared.summary.mint);
    assert.equal(token.creatorAddress, prepared.summary.creatorAddress);
    assert.equal(token.recipientUsername, f.input.recipient.username);
    assert.equal(f.service.recipientForToken(token.id)?.id, 'twitch:123');
    const creator = await f.service.signerForCreator(token.creatorAddress);
    assert.equal(creator.publicKey.toBase58(), token.creatorAddress);
    assert.equal(
      (await f.service.submit(f.principal, prepared.launchId, signed)).status,
      'confirmed',
    );
    assert.equal(f.state.broadcasts, 1);
    assert.equal(
      f.operations.snapshot().audit.filter((x) => x.action === 'token_registered').length,
      1,
    );
    const catalog = f.service.catalog();
    assert.equal(catalog.tokens[0].recipientId, 'twitch:123');
    assert.equal(catalog.tokens[0].marketCapUsd, null);
    assert.equal(catalog.tokens[0].donatedUsdCents, 0);
    assert.equal(catalog.tokens[0].website, 'https://pog.fun');
    assert.equal(catalog.tokens[0].twitter, f.input.twitter);
    const persistedMetadata = f.service.allConfirmedMetadata()[0];
    assert.equal(persistedMetadata.website, 'https://pog.fun');
    assert.equal(persistedMetadata.twitter, f.input.twitter);
  } finally {
    f.db.close();
  }
});

test('unknown broadcasts remain held and recover across service restart without a new signature or send', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const signed = f.sign(prepared.transaction!);
    f.state.uncertain = true;
    const result = await f.service.submit(f.principal, prepared.launchId, signed);
    assert.equal(result.status, 'review');
    assert.doesNotMatch(JSON.stringify(result), /private RPC token/);
    const restarted = createPumpLaunchService(f.db, f.operations, f.config);
    f.state.result = { status: 'confirmed', slot: 888 };
    assert.equal(
      (await restarted.submit(f.principal, prepared.launchId, signed)).status,
      'confirmed',
    );
    assert.equal(f.state.broadcasts, 1);
    assert.equal(f.operations.snapshot().tokens.length, 1);
  } finally {
    f.db.close();
  }
});

test('conflicting existing ledger mapping leaves finalized launch in review instead of claiming success', async () => {
  const f = fixture({ chainResult: { status: 'confirmed', slot: 900 } });
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    f.operations.registerToken(
      {
        name: f.input.name,
        symbol: f.input.symbol,
        mint: prepared.summary.mint,
        creatorAddress: prepared.summary.creatorAddress,
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: 'different_streamer',
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      'test-operator',
    );
    const result = await f.service.submit(
      f.principal,
      prepared.launchId,
      f.sign(prepared.transaction!),
    );
    assert.equal(result.status, 'review');
    assert.equal(f.service.catalog().tokens.length, 0);
    assert.equal(f.operations.snapshot().tokens[0].recipientUsername, 'different_streamer');
    await assert.rejects(
      f.service.signerForCreator(prepared.summary.creatorAddress),
      /No finalized launch/,
    );
  } finally {
    f.db.close();
  }
});

test('ledger commit recovered after process gap is idempotent, and wrong encryption keys cannot recover a creator signer', async () => {
  const f = fixture({ chainResult: { status: 'confirmed', slot: 901 } });
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const prior = f.operations.registerToken(
      {
        name: f.input.name,
        symbol: f.input.symbol,
        mint: prepared.summary.mint,
        creatorAddress: prepared.summary.creatorAddress,
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: f.input.recipient.username,
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      'launch:test-user',
    );
    const result = await f.service.submit(
      f.principal,
      prepared.launchId,
      f.sign(prepared.transaction!),
    );
    assert.equal(result.tokenId, prior.id);
    assert.equal(f.operations.snapshot().tokens.length, 1);
    const wrongKey = createPumpLaunchService(f.db, f.operations, {
      ...f.config,
      encryptionKey: new Uint8Array(32).fill(9),
    });
    await assert.rejects(
      wrongKey.signerForCreator(prepared.summary.creatorAddress),
      /could not be decrypted/,
    );
  } finally {
    f.db.close();
  }
});

test('finalized failures never enter catalog or register fees, and old recipient checks cannot prepare', async () => {
  const f = fixture({ chainResult: { status: 'failed', error: 'Finalized execution error' } });
  try {
    await assert.rejects(
      f.service.prepare(f.principal, {
        ...f.input,
        recipient: { ...f.input.recipient, verifiedAt: new Date(now - 301_000).toISOString() },
      }),
      /verification expired/,
    );
    const prepared = await f.service.prepare(f.principal, f.input);
    const result = await f.service.submit(
      f.principal,
      prepared.launchId,
      f.sign(prepared.transaction!),
    );
    assert.equal(result.status, 'failed');
    assert.equal(f.service.catalog().total, 0);
    assert.equal(f.operations.snapshot().tokens.length, 0);
  } finally {
    f.db.close();
  }
});

test('actual Pump adapter refuses network mismatch, unexpected addresses, simulation errors and expensive launches', async () => {
  const mint = Keypair.generate();
  const f = fixture();
  const plan: LaunchPlan = {
    ...f.input,
    launchId: 'test-plan',
    mint: mint.publicKey.toBase58(),
    creatorAddress: Keypair.generate().publicKey.toBase58(),
  };
  try {
    for (const [changes, error] of [
      [{ getGenesisHash: async () => 'different-chain' }, /configured Solana network/],
      [{ getMultipleAccountsInfo: async () => [null, {}] }, /addresses already exist/],
      [
        {
          simulateTransaction: async () => ({
            value: { err: { InstructionError: [0, 'InsufficientFunds'] } },
          }),
        },
        /simulation failed/,
      ],
      [
        {
          simulateTransaction: async () => ({
            value: { err: null, accounts: [{ lamports: 100 }] },
          }),
        },
        /exceeds the configured limit/,
      ],
    ] as const) {
      const chain = new PumpLaunchChain(
        {
          rpcUrl: 'https://rpc.example.test',
          expectedGenesisHash: genesis,
          transactionsEnabled: false,
        },
        fakeConnection(changes),
      );
      await assert.rejects(chain.prepare(plan, mint), error);
      await assert.rejects(chain.broadcast('unused', 'unused'), /broadcasting is disabled/);
    }
  } finally {
    f.db.close();
  }
});

test('actual Pump adapter rejects a finalized transaction with different message bytes', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const signed = f.sign(prepared.transaction!);
    await f.service.submit(f.principal, prepared.launchId, signed);
    const row = JSON.parse(
      f.db.prepare('SELECT payload FROM launch_intents').get()!.payload as string,
    );
    const different = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
    different.message.recentBlockhash = PublicKey.default.toBase58();
    const chain = new PumpLaunchChain(
      {
        rpcUrl: 'https://rpc.example.test',
        expectedGenesisHash: genesis,
        transactionsEnabled: false,
      },
      fakeConnection({
        getSignatureStatuses: async () => ({
          value: [{ confirmationStatus: 'finalized', err: null }],
        }),
        getTransaction: async () => ({
          meta: { err: null },
          transaction: { message: different.message, signatures: [row.signature] },
        }),
      }),
    );
    assert.equal((await chain.reconcile(row)).status, 'review');
    const expired = new PumpLaunchChain(
      {
        rpcUrl: 'https://rpc.example.test',
        expectedGenesisHash: genesis,
        transactionsEnabled: false,
      },
      fakeConnection({ getBlockHeight: async () => 501, getAccountInfo: async () => null }),
    );
    assert.equal((await expired.reconcile({ ...row, signature: undefined })).status, 'failed');
  } finally {
    f.db.close();
  }
});

test('an overlapping unsigned status read cannot erase a submitted transaction identity', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.config.chain.reconcile;
    f.config.chain.reconcile = async (record) => {
      if (!record.signature) {
        entered();
        await paused;
        return { status: 'pending' };
      }
      return original(record);
    };
    const staleRead = f.service.get(f.principal, prepared.launchId);
    await started;
    const signed = f.sign(prepared.transaction!);
    const submitted = await f.service.submit(f.principal, prepared.launchId, signed);
    assert.equal(submitted.status, 'submitted');
    resume();
    await staleRead;
    const row = JSON.parse(
      f.db.prepare('SELECT payload FROM launch_intents').get()!.payload as string,
    );
    assert.equal(row.status, 'submitted');
    assert.equal(row.signature, submitted.signature);
    assert.equal(row.signedTransaction, signed);
    assert.equal(f.state.broadcasts, 1);
  } finally {
    f.db.close();
  }
});

test('unsigned preparation becomes signable again after a temporary status RPC failure', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const original = f.config.chain.reconcile;
    f.config.chain.reconcile = async () => {
      throw new Error('temporary provider outage');
    };
    assert.equal((await f.service.get(f.principal, prepared.launchId)).status, 'review');
    f.config.chain.reconcile = original;
    const recovered = await f.service.get(f.principal, prepared.launchId);
    assert.equal(recovered.status, 'prepared');
    assert.equal(recovered.transaction, prepared.transaction);
    assert.equal(recovered.error, undefined);
    assert.equal(f.state.broadcasts, 0);
  } finally {
    f.db.close();
  }
});

test('an explicit submission recovers a crash before broadcast using the exact durable signed bytes', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const signed = f.sign(prepared.transaction!);
    const signature = transactionSignature(
      VersionedTransaction.deserialize(Buffer.from(signed, 'base64')),
    );
    const row = JSON.parse(
      f.db.prepare('SELECT payload FROM launch_intents').get()!.payload as string,
    );
    Object.assign(row, { signedTransaction: signed, signature, status: 'submitted' });
    f.db
      .prepare('UPDATE launch_intents SET signature=?,status=?,payload=? WHERE id=?')
      .run(signature, 'submitted', JSON.stringify(row), prepared.launchId);
    const restarted = createPumpLaunchService(f.db, f.operations, f.config);
    await restarted.get(f.principal, prepared.launchId);
    assert.equal(f.state.broadcasts, 0, 'GET must not broadcast a saved transaction');
    const result = await restarted.submit(f.principal, prepared.launchId, signed);
    assert.equal(result.signature, signature);
    assert.equal(result.status, 'submitted');
    assert.equal(f.state.broadcasts, 1);
    assert.equal(f.state.builds, 1, 'recovery must never rebuild a transaction');
  } finally {
    f.db.close();
  }
});

test('explicit retry after uncertain broadcast reuses the stored signature and refuses expired or unverifiable attempts', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    await assert.rejects(f.service.retry(f.principal, prepared.launchId), /No signed transaction/);
    const signed = f.sign(prepared.transaction!);
    f.state.uncertain = true;
    const initial = await f.service.submit(f.principal, prepared.launchId, signed);
    assert.equal(initial.status, 'review');
    f.state.uncertain = false;
    const restarted = createPumpLaunchService(f.db, f.operations, f.config);
    const recovered = await restarted.retry(f.principal, prepared.launchId);
    assert.equal(recovered.signature, initial.signature);
    assert.equal(recovered.status, 'submitted');
    assert.equal(recovered.error, undefined);
    assert.equal(f.state.broadcasts, 2);
    f.state.result = { status: 'review', error: 'Original signing window expired' };
    assert.equal((await restarted.retry(f.principal, prepared.launchId)).status, 'review');
    assert.equal(f.state.broadcasts, 2);
    f.config.chain.reconcile = async () => {
      throw new Error('RPC unavailable');
    };
    await restarted.retry(f.principal, prepared.launchId);
    assert.equal(f.state.broadcasts, 2);
    assert.equal(f.state.builds, 1);
    await assert.rejects(
      restarted.retry({ ...f.principal, userId: 'another-user' }, prepared.launchId),
      /not found/,
    );
  } finally {
    f.db.close();
  }
});

test('internal catalog metadata preserves immutable recipient identity beyond the public page limit', async () => {
  const f = fixture({ chainResult: { status: 'confirmed', slot: 42 } });
  try {
    const prepared = await f.service.prepare(f.principal, f.input);
    const confirmed = await f.service.submit(
      f.principal,
      prepared.launchId,
      f.sign(prepared.transaction!),
    );
    const row = f.db.prepare('SELECT * FROM launch_intents').get()!;
    for (let i = 0; i < 101; i++) {
      const value = JSON.parse(row.payload as string);
      Object.assign(value, {
        launchId: `newer-${i}`,
        tokenId: `token-${i}`,
        createdAt: '2026-09-17T00:00:00Z',
      });
      f.db
        .prepare(
          'INSERT INTO launch_intents(id,user_id,request_id,fingerprint,mint,creator,signature,status,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          value.launchId,
          row.user_id,
          `request-${i}`,
          row.fingerprint,
          `mint-${i}`,
          `creator-${i}`,
          `signature-${i}`,
          'confirmed',
          value.createdAt,
          JSON.stringify(value),
        );
    }
    assert.equal(
      f.service.catalog({ limit: 100 }).tokens.some((x) => x.id === confirmed.tokenId),
      false,
    );
    const metadata = f.service.allConfirmedMetadata();
    const original = metadata.find((x) => x.id === confirmed.tokenId);
    assert.equal(metadata.length, 102);
    assert.equal(original?.recipientId, 'twitch:123');
    assert.equal(original?.imageUri, f.input.imageUri);
    assert.doesNotMatch(JSON.stringify(metadata), /userId|signedTransaction|encrypted|secretKey/);
  } finally {
    f.db.close();
  }
});

test(
  'shutdown cancels stalled preparation and ignores its late result before closing the database',
  { timeout: 5_000 },
  async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalPrepare = f.config.chain.prepare;
    f.config.chain.prepare = async (plan, mint, currentSignal) => {
      signal = currentSignal;
      const prepared = await originalPrepare(plan, mint);
      entered();
      await blocked; // Deliberately ignores cancellation, like a broken injected transport.
      return prepared;
    };
    try {
      const pending = f.service.prepare(f.principal, f.input);
      const rejected = assert.rejects(pending, /preparation could not be completed/);
      await started;
      await f.service.close();
      await rejected;
      assert.equal(signal?.aborted, true);
      const afterClose = f.db.prepare('SELECT status,payload FROM launch_intents').get()!;
      assert.equal(afterClose.status, 'failed');
      assert.equal(JSON.parse(afterClose.payload as string).prepared, undefined);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.db.prepare('SELECT status,payload FROM launch_intents').get(), afterClose);
      assert.equal(f.operations.snapshot().tokens.length, 0);
      assert.equal(f.state.broadcasts, 0);
    } finally {
      release();
      await f.service.close();
      f.db.close();
    }
  },
);

test(
  'shutdown retains an interrupted broadcast for read-only finality recovery without another send',
  { timeout: 5_000 },
  async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    let signal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalBroadcast = f.config.chain.broadcast;
    f.config.chain.broadcast = async (encoded, signature, currentSignal) => {
      signal = currentSignal;
      await originalBroadcast(encoded, signature);
      entered();
      await blocked;
    };
    try {
      const prepared = await f.service.prepare(f.principal, f.input);
      const signed = f.sign(prepared.transaction!);
      const pending = f.service.submit(f.principal, prepared.launchId, signed);
      const rejected = assert.rejects(pending, /service is stopping/);
      await started;
      await f.service.close();
      await rejected;
      assert.equal(signal?.aborted, true);
      const afterClose = f.db.prepare('SELECT status,signature,payload FROM launch_intents').get()!;
      const saved = JSON.parse(afterClose.payload as string);
      assert.equal(afterClose.status, 'review');
      assert.equal(saved.signedTransaction, signed);
      assert.equal(saved.signature, afterClose.signature);
      assert.equal(f.state.broadcasts, 1);
      assert.equal(f.operations.snapshot().tokens.length, 0);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        f.db.prepare('SELECT status,signature,payload FROM launch_intents').get(),
        afterClose,
      );
      assert.deepEqual(await f.service.reconcilePending(), { checked: 0, confirmed: 0 });

      f.state.result = { status: 'confirmed', slot: 42 };
      const restarted = createPumpLaunchService(f.db, f.operations, {
        ...f.config,
        launchesEnabled: false,
        transactionsEnabled: false,
      });
      try {
        assert.deepEqual(await restarted.reconcilePending(), { checked: 1, confirmed: 1 });
        assert.equal(f.operations.snapshot().tokens.length, 1);
        assert.equal(f.state.broadcasts, 1, 'background recovery must never resend');
        assert.equal(f.state.builds, 1, 'background recovery must never rebuild');
      } finally {
        await restarted.close();
      }
    } finally {
      release();
      await f.service.close();
      f.db.close();
    }
  },
);
