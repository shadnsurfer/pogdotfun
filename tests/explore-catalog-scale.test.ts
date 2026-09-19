/** Durable registry/catalog stress only; no RPC calls, wallet signing, or broadcasts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import test from 'node:test';
import { createOperations } from '../server/operations.ts';
import { createPumpLaunchService } from '../server/launch/service.ts';
import type { LaunchChain, LaunchChainResult, LaunchRecord } from '../server/launch/types.ts';
import { publicCatalog } from '../server/public/catalog.ts';
import { DexScreenerMarketData } from '../server/public/market-data.ts';
import { PumpLaunchChain } from '../server/launch/pump-chain.ts';

const time = Date.parse('2026-09-16T20:00:00.000Z');
const iso = new Date(time).toISOString();
const SOL = 'So11111111111111111111111111111111111111112';
function publicKey(index: number, domain: number) {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(index, 24);
  seed.writeUInt32BE(domain, 28);
  return Keypair.fromSeed(seed).publicKey.toBase58();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: { reconcile?: LaunchChain['reconcile']; timeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pog-explore-scale-'));
  const path = join(directory, 'catalog.sqlite');
  let db: DatabaseSync;
  let operations: ReturnType<typeof createOperations>;
  let launches: ReturnType<typeof createPumpLaunchService>;
  const receipts = new Map<string, ReturnType<typeof deferred<LaunchChainResult>>>();
  const records: LaunchRecord[] = [];
  const who = { userId: 'scale-fixture-owner', walletAddress: publicKey(0, 3) };
  const chain: LaunchChain = {
    prepare: async () => {
      throw new Error('Scale fixture never prepares or signs transactions.');
    },
    broadcast: async () => {
      throw new Error('Scale fixture never broadcasts transactions.');
    },
    reconcile: async (record, signal) => {
      if (options.reconcile) return options.reconcile(record, signal);
      const receipt = receipts.get(record.launchId);
      assert.ok(receipt, 'Only the explicitly staged receipt may finalize a fixture launch.');
      return receipt.promise;
    },
  };
  function open() {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL');
    operations = createOperations(db, { streamerBps: 8000 });
    launches = createPumpLaunchService(db, operations, {
      launchesEnabled: false,
      transactionsEnabled: false,
      chain,
      now: () => time,
      reconciliationTimeoutMs: options.timeoutMs,
    });
  }
  open();
  function stage(index: number) {
    const recipient = index % 5;
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32BE(index + 1, 60);
    const record: LaunchRecord = {
      launchId: randomUUID(),
      userId: who.userId,
      requestId: `scale-request-${String(index).padStart(8, '0')}`,
      // Repeated symbols and recipients must never collapse distinct registered mints.
      name: `Scale Token ${index}`,
      symbol: 'SCALE',
      description: `Persisted token ${index}`,
      walletAddress: who.walletAddress,
      mint: publicKey(index, 1),
      creatorAddress: publicKey(index, 2),
      metadataUri: `https://fixture.invalid/metadata/${index}`,
      imageUri: `https://fixture.invalid/image/${index}`,
      recipient: {
        id: `twitch:scale-${recipient}`,
        platform: 'twitch',
        username: `scale_streamer${recipient}`,
        channelUrl: `https://www.twitch.tv/scale_streamer${recipient}`,
        verified: true,
        verifiedAt: iso,
      },
      status: 'submitted',
      createdAt: iso,
      updatedAt: iso,
      signature: bs58.encode(bytes),
      signedTransaction: 'fixture-signed-transaction',
      // These are synthetic stored inputs to the trusted fake receipt boundary, not a transaction.
      prepared: {
        transaction: 'fixture-not-a-transaction',
        message: 'fixture-not-a-message',
        blockhash: publicKey(0, 4),
        lastValidBlockHeight: 10,
        networkFeeLamports: '0',
        creatorReserveLamports: '0',
        estimatedTotalLamports: '0',
      },
    };
    db.prepare(
      `INSERT INTO launch_intents(id,user_id,request_id,fingerprint,mint,creator,signature,status,created_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      record.launchId,
      record.userId,
      record.requestId,
      `fixture-${index}`,
      record.mint,
      record.creatorAddress,
      record.signature!,
      record.status,
      record.createdAt,
      JSON.stringify(record),
    );
    records.push(record);
    receipts.set(record.launchId, deferred<LaunchChainResult>());
    return record;
  }
  async function finalize(batch: LaunchRecord[]) {
    const pending = batch.flatMap((record) => [
      launches.get(who, record.launchId),
      launches.get(who, record.launchId),
    ]);
    // Simultaneous receipts return out of registration/creation order.
    for (const record of [...batch].reverse())
      receipts.get(record.launchId)!.resolve({ status: 'confirmed', slot: 500 });
    const completed = await Promise.all(pending);
    assert.ok(completed.every((record) => record.status === 'confirmed'));
  }
  const catalog = () => publicCatalog(operations, launches, [], { now: time });
  return {
    stage,
    finalize,
    catalog,
    records,
    manual(record: LaunchRecord) {
      return launches.get(who, record.launchId);
    },
    patch(record: LaunchRecord, patch: Partial<LaunchRecord>) {
      Object.assign(record, patch);
      db.prepare('UPDATE launch_intents SET signature=?,status=?,payload=? WHERE id=?').run(
        record.signature ?? null,
        record.status,
        JSON.stringify(record),
        record.launchId,
      );
    },
    saved(record: LaunchRecord) {
      return String(
        db.prepare('SELECT payload FROM launch_intents WHERE id=?').get(record.launchId)!.payload,
      );
    },
    markFinalized(record: LaunchRecord) {
      receipts.get(record.launchId)!.resolve({ status: 'confirmed', slot: 500 });
    },
    get operations() {
      return operations;
    },
    get launches() {
      return launches;
    },
    restart() {
      db.close();
      open();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function identities(tokens: readonly { id: string; address: string }[]) {
  return tokens.map((token) => `${token.id}:${token.address}`).sort();
}
function pair(address: string, index: number) {
  return {
    chainId: 'solana',
    pairAddress: publicKey(index, 9),
    baseToken: { address, name: 'Provider cannot replace registered identity' },
    quoteToken: { address: SOL },
    marketCap: 1000 + index,
    volume: { h24: index },
    priceChange: { h24: 0 },
    liquidity: { usd: 100 },
  };
}

// These checkpoints cross the reported UI limits, the provider's30-mint batches,
// the old launch helper's50/default100 bound, and the200-entry activity feed.
test('14,20,128 and205 rapid confirmed mints all survive registration, catalog rendering and restart', async () => {
  const f = fixture();
  try {
    let count = 0;
    let previous: string[] = [];
    for (const target of [14, 20, 128, 205]) {
      const staged = Array.from({ length: target - count }, (_, offset) => f.stage(count + offset));
      assert.equal(
        f.catalog().tokens.length,
        count,
        'pending receipts are not presented as confirmed tokens',
      );
      await f.finalize(staged);
      const catalog = f.catalog();
      assert.equal(catalog.tokens.length, target);
      assert.equal(catalog.stats.tokenCount, target);
      assert.equal(f.launches.allConfirmedMetadata().length, target);
      assert.equal(new Set(catalog.tokens.map((token) => token.id)).size, target);
      assert.equal(new Set(catalog.tokens.map((token) => token.address)).size, target);
      assert.deepEqual(
        catalog.tokens.map((token) => token.address).sort(),
        f.records.map((record) => record.mint).sort(),
      );
      for (const old of previous)
        assert.ok(
          identities(catalog.tokens).includes(old),
          'a newer launch must never evict an older token',
        );
      assert.equal(
        catalog.streamers.reduce((sum, streamer) => sum + streamer.tokenCount, 0),
        target,
      );
      assert.ok(catalog.tokens.every((token) => token.image && token.description));
      assert.equal(
        catalog.activity.length,
        0,
        'token visibility does not require fees or activity',
      );
      previous = identities(catalog.tokens);
      count = target;
    }
    f.restart();
    assert.deepEqual(identities(f.catalog().tokens), previous);
    assert.equal(f.launches.allConfirmedMetadata().length, 205);
  } finally {
    f.close();
  }
});

test('successful market enrichment batches205 registered tokens without dropping or replacing any identity', async () => {
  const f = fixture();
  try {
    await f.finalize(Array.from({ length: 205 }, (_, index) => f.stage(index)));
    const catalog = f.catalog();
    const batches: string[][] = [];
    const adapter = new DexScreenerMarketData({
      now: () => time,
      fetch: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://api.dexscreener.com');
        const mints = url.pathname.split('/').at(-1)!.split(',');
        batches.push(mints);
        return Response.json(mints.map((mint, index) => pair(mint, index)));
      },
    });
    const result = await adapter.enrich(catalog.tokens);
    assert.equal(result.length, 205);
    assert.deepEqual(identities(result), identities(catalog.tokens));
    assert.equal(batches.length, 7);
    assert.ok(batches.every((batch) => batch.length <= 30));
    assert.equal(new Set(batches.flat()).size, 205);
    assert.ok(result.every((token) => token.mcap !== null && token.name.startsWith('Scale Token')));
  } finally {
    f.close();
  }
});

test('provider failure, rate limiting, malformed data and bounded admission preserve all128 registered token rows', async () => {
  const f = fixture();
  try {
    await f.finalize(Array.from({ length: 128 }, (_, index) => f.stage(index)));
    const catalog = f.catalog();
    for (const mode of ['throw', 'rate-limit', 'malformed', 'admission', 'timeout'] as const) {
      let calls = 0;
      const adapter = new DexScreenerMarketData({
        maximumCacheEntries: 30,
        timeoutMs: 20,
        now: () => time,
        fetch: async () => {
          calls++;
          if (mode === 'throw') throw new Error('fixture provider unavailable');
          if (mode === 'timeout') return new Promise<Response>(() => {});
          if (mode === 'rate-limit') return new Response('', { status: 429 });
          if (mode === 'malformed') return Response.json({ unexpected: true });
          return Response.json([]);
        },
      });
      const result = await adapter.enrich(catalog.tokens);
      assert.equal(calls, 1, 'provider admission is bounded independently from token visibility');
      assert.deepEqual(identities(result), identities(catalog.tokens), mode);
      assert.ok(result.every((token) => token.mcap === null && token.marketDataUpdatedAt === null));
    }
  } finally {
    f.close();
  }
});

test('overlapping refreshes and a rapid launch wave preserve each complete captured snapshot', async () => {
  const f = fixture();
  try {
    await f.finalize(Array.from({ length: 20 }, (_, index) => f.stage(index)));
    const first = f.catalog();
    const gate = deferred<void>();
    const requested: string[] = [];
    const adapter = new DexScreenerMarketData({
      now: () => time,
      fetch: async (input) => {
        const mints = new URL(String(input)).pathname.split('/').at(-1)!.split(',');
        requested.push(...mints);
        await gate.promise;
        return Response.json([]);
      },
    });
    const oldRefresh = adapter.enrich(first.tokens);
    await f.finalize(Array.from({ length: 108 }, (_, offset) => f.stage(offset + 20)));
    const latest = f.catalog();
    const newRefresh = adapter.enrich(latest.tokens);
    gate.resolve();
    const [before, after] = await Promise.all([oldRefresh, newRefresh]);
    assert.equal(before.length, 20);
    assert.equal(after.length, 128);
    assert.deepEqual(identities(after), identities(latest.tokens));
    assert.deepEqual(identities(before), identities(first.tokens));
    assert.equal(
      requested.length,
      128,
      'overlapping mint requests are coalesced, not duplicate or dropped',
    );
    assert.equal(new Set(requested).size, 128);
  } finally {
    f.close();
  }
});

test('legacy registrations and a missing optional metadata/profile cache remain visible alongside205 finalized launches', async () => {
  const f = fixture();
  try {
    await f.finalize(Array.from({ length: 205 }, (_, index) => f.stage(index)));
    const legacy = f.operations.registerToken(
      {
        name: 'Legacy visible token',
        symbol: 'SCALE',
        mint: publicKey(999, 1),
        creatorAddress: publicKey(999, 2),
        chain: 'solana',
        launchpad: 'pump',
        recipientPlatform: 'twitch',
        recipientUsername: 'legacy_streamer',
        recipientVerified: true,
        dedicatedCreatorVerified: true,
      },
      'fixture-owner',
    );
    const catalog = f.catalog();
    assert.equal(catalog.tokens.length, 206);
    assert.equal(catalog.tokens.find((token) => token.id === legacy.id)?.image, '');
    const metadataAbsent = publicCatalog(f.operations, { allConfirmedMetadata: () => [] }, []);
    assert.deepEqual(identities(metadataAbsent.tokens), identities(catalog.tokens));
    assert.equal(metadataAbsent.stats.tokenCount, 206);
    assert.ok(
      metadataAbsent.tokens.every(
        (token) => token.image === '' && token.streamerId.startsWith('legacy:'),
      ),
    );
  } finally {
    f.close();
  }
});

test('background finality publishes all128 saved signed launches after their owners leave, without sending transactions', async () => {
  const f = fixture();
  try {
    const records = Array.from({ length: 128 }, (_, index) => f.stage(index));
    records.forEach(f.markFinalized);
    assert.equal(f.catalog().tokens.length, 0);
    for (let tick = 0; tick < 6; tick++) await f.launches.reconcilePending();
    assert.equal(f.catalog().tokens.length, 128);
    f.restart();
    assert.equal(f.catalog().tokens.length, 128);
  } finally {
    f.close();
  }
});

test('durable fair scheduling gets beyond100 pending older rows and resumes fairly after restart', async () => {
  const seen = new Set<string>();
  const f = fixture({
    reconcile: async (record) => {
      seen.add(record.launchId);
      return Number(record.requestId.slice(-8)) < 110
        ? { status: 'pending' }
        : { status: 'confirmed', slot: 800 };
    },
  });
  try {
    Array.from({ length: 130 }, (_, index) => f.stage(index));
    for (let tick = 0; tick < 3; tick++) {
      const result = await f.launches.reconcilePending();
      assert.equal(result.checked, 24);
    }
    assert.equal(seen.size, 72);
    f.restart();
    for (let tick = 0; tick < 3; tick++) await f.launches.reconcilePending();
    assert.equal(seen.size, 130);
    assert.equal(f.catalog().tokens.length, 20);
  } finally {
    await f.launches.close();
    f.close();
  }
});

test('manual status and concurrent ticks share one signed receipt check and one registration', async () => {
  const started = deferred<void>();
  const gate = deferred<LaunchChainResult>();
  let calls = 0;
  const f = fixture({
    reconcile: async () => {
      calls++;
      started.resolve();
      return gate.promise;
    },
  });
  try {
    const record = f.stage(0);
    const manual = f.manual(record);
    await started.promise;
    const one = f.launches.reconcilePending();
    const two = f.launches.reconcilePending();
    assert.equal(one, two);
    gate.resolve({ status: 'confirmed', slot: 900 });
    await Promise.all([manual, one, two]);
    assert.equal(calls, 1);
    assert.equal(f.catalog().tokens.length, 1);
    assert.equal(
      f.operations.snapshot().audit.filter((row) => row.action === 'token_registered').length,
      1,
    );
  } finally {
    await f.launches.close();
    f.close();
  }
});

test('background selection excludes unsigned, unprepared and terminal records', async () => {
  const seen: string[] = [];
  const f = fixture({
    reconcile: async (record) => {
      seen.push(record.launchId);
      return { status: 'confirmed', slot: 900 };
    },
  });
  try {
    const good = f.stage(0);
    const missingBytes = f.stage(1);
    f.patch(missingBytes, { signedTransaction: undefined });
    const missingSignature = f.stage(2);
    f.patch(missingSignature, { signature: undefined });
    const missingPlan = f.stage(3);
    f.patch(missingPlan, { prepared: undefined });
    const unsignedReview = f.stage(4);
    f.patch(unsignedReview, { status: 'review', signedTransaction: undefined });
    const failed = f.stage(5);
    f.patch(failed, { status: 'failed' });
    const prepared = f.stage(6);
    f.patch(prepared, { status: 'prepared' });
    await f.launches.reconcilePending();
    assert.deepEqual(seen, [good.launchId]);
    assert.equal(f.catalog().tokens.length, 1);
  } finally {
    await f.launches.close();
    f.close();
  }
});

test('expired provider reads release the bounded worker and late finality cannot write or publish', async () => {
  let active = 0,
    maximum = 0;
  const late: Array<ReturnType<typeof deferred<LaunchChainResult>>> = [];
  const signals: AbortSignal[] = [];
  const f = fixture({
    timeoutMs: 15,
    reconcile: async (record, signal) => {
      assert.ok(signal);
      active++;
      maximum = Math.max(maximum, active);
      signal.addEventListener(
        'abort',
        () => {
          active--;
        },
        { once: true },
      );
      if (Number(record.requestId.slice(-8)) < 3) {
        signals.push(signal);
        const result = deferred<LaunchChainResult>();
        late.push(result);
        return result.promise;
      }
      active--;
      return { status: 'confirmed', slot: 900 };
    },
  });
  try {
    const records = Array.from({ length: 30 }, (_, index) => f.stage(index));
    const before = records.slice(0, 3).map(f.saved);
    await f.launches.reconcilePending();
    await f.launches.reconcilePending();
    assert.ok(maximum <= 3);
    assert.equal(f.catalog().tokens.length, 27);
    assert.ok(signals.every((signal) => signal.aborted));
    late.forEach((result) => result.resolve({ status: 'confirmed', slot: 999 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(records.slice(0, 3).map(f.saved), before);
    assert.equal(f.catalog().tokens.length, 27);
  } finally {
    await f.launches.close();
    f.close();
  }
});

test('close aborts active checks without waiting on an uncooperative transport and late results cannot access closed DB', async () => {
  const started = deferred<void>();
  const late = deferred<LaunchChainResult>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const f = fixture({
    reconcile: async (_record, supplied) => {
      calls++;
      signal = supplied;
      started.resolve();
      return late.promise;
    },
  });
  try {
    const record = f.stage(0);
    const before = f.saved(record);
    const running = f.launches.reconcilePending();
    await started.promise;
    await f.launches.close();
    await running;
    assert.equal(signal?.aborted, true);
    assert.deepEqual(await f.launches.reconcilePending(), { checked: 0, confirmed: 0 });
    f.restart();
    late.resolve({ status: 'confirmed', slot: 999 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.saved(record), before);
    assert.equal(f.catalog().tokens.length, 0);
    assert.equal(calls, 1);
  } finally {
    await f.launches.close();
    f.close();
  }
});

for (const stage of ['headers', 'body'] as const) {
  test(`real RPC transport aborts stalled ${stage} during finalized verification`, async () => {
    const opened = deferred<void>();
    const detached = deferred<void>();
    const server = createServer((_request, response) => {
      response.on('close', () => detached.resolve());
      if (stage === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"jsonrpc":"2.0",');
      }
      opened.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const f = fixture();
    try {
      const record = f.stage(0);
      const abort = new AbortController();
      let calls = 0;
      const chain = new PumpLaunchChain({
        rpcUrl: 'https://fixture.invalid',
        expectedGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        transactionsEnabled: false,
        fetch: (input, init) => {
          assert.equal(String(input), 'https://fixture.invalid');
          assert.equal(init?.redirect, 'error');
          assert.ok(init?.signal);
          calls++;
          // Real native fetch, confined to this local server; no external provider traffic.
          return fetch(origin, init);
        },
      });
      const pending = chain.reconcile(record, abort.signal);
      await opened.promise;
      abort.abort(new Error('fixture shutdown'));
      await assert.rejects(pending, /fixture shutdown/);
      await detached.promise;
      assert.equal(calls, 1);
    } finally {
      f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
