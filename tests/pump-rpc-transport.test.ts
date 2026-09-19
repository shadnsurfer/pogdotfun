import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PumpSolanaProvider, type PumpSolanaConfig } from '../server/providers/pump-solana.ts';
import type { PreparedTransaction } from '../server/providers/contracts.ts';
import {
  SqliteTransactionJournal,
  TransactionDispatcher,
} from '../server/workers/transaction-journal.ts';
import { TestingBudget } from '../server/workers/testing-budget.ts';
import { boundedRpcFetch } from '../server/providers/bounded-rpc-fetch.ts';

const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function rpc(
  handler: (
    request: { id: string; method: string; params: unknown[] },
    response: ServerResponse,
  ) => void,
) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    handler(JSON.parse(Buffer.concat(chunks).toString()), response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function config(rpcUrl: string, changes: Partial<PumpSolanaConfig> = {}): PumpSolanaConfig {
  return {
    rpcUrl,
    expectedGenesisHash: genesis,
    mappings: [],
    transactionsEnabled: true,
    signerForCreator: async () => {
      throw new Error('Transport fixtures never load a live signer');
    },
    coinbaseAccountId: '',
    allowedCoinbaseAddresses: [],
    maxTopUpLamports: 1n,
    minimumWalletReserveLamports: 10_000n,
    rpcTimeoutMs: 60,
    ...changes,
  };
}
async function beforeDeadline<T>(promise: Promise<T>, ms = 700) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Transport exceeded its configured deadline')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function json(response: ServerResponse, id: string, result: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

test('Pump RPC deadline aborts both a stalled request and a stalled response body', async () => {
  for (const mode of ['headers', 'body']) {
    const closed = deferred<void>();
    const server = await rpc((_request, response) => {
      response.on('close', () => closed.resolve());
      if (mode === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"jsonrpc":"2.0",');
      }
    });
    const provider = new PumpSolanaProvider(config(server.url));
    const read = provider.connection.getGenesisHash();
    try {
      await beforeDeadline(assert.rejects(read, /RPC.*timed out/));
      await beforeDeadline(closed.promise);
    } finally {
      await server.close();
      await read.catch(() => {});
    }
  }
});

test('a timed-out send retains exact journal bytes and budget hold, then reconciles without another send', async () => {
  // Synthetic signed bytes go only to the local fake RPC, never to a chain.
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message(),
  );
  transaction.sign([signer]);
  const prepared: PreparedTransaction = {
    id: 'fixture-claim',
    kind: 'claim',
    tokenId: 'fixture-token',
    mint: Keypair.generate().publicKey.toBase58(),
    creator: signer.publicKey.toBase58(),
    signature: bs58.encode(transaction.signatures[0]),
    signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    blockhash: transaction.message.recentBlockhash,
    lastValidBlockHeight: 500,
    createdAt: new Date().toISOString(),
    networkFeeLamports: '5000',
  };
  let sends = 0,
    reads = 0,
    finalized = false;
  const server = await rpc((request, response) => {
    if (request.method === 'getGenesisHash') return json(response, request.id, genesis);
    if (request.method === 'sendTransaction') {
      sends++;
      assert.equal(request.params[0], prepared.signedTransactionBase64);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"jsonrpc":"2.0",');
      return;
    }
    if (request.method === 'getSignatureStatuses') {
      reads++;
      assert.deepEqual(request.params[0], [prepared.signature]);
      return json(response, request.id, {
        context: { slot: 30 },
        value: [
          finalized
            ? { slot: 30, confirmations: null, err: null, confirmationStatus: 'finalized' }
            : null,
        ],
      });
    }
    if (request.method === 'getBlockHeight') return json(response, request.id, 400);
    throw new Error(`Unexpected RPC ${request.method}`);
  });
  const db = new DatabaseSync(':memory:');
  const journal = new SqliteTransactionJournal(db),
    budget = new TestingBudget(db);
  journal.insert(prepared);
  budget.reserve({ operationId: 'fixture-gas', kind: 'chain_fee', maxUsdCents: 1 }, 'test');
  const gate = {
    begin: () => budget.begin('fixture-gas', `attempt:${prepared.signature}`, 'test'),
  };
  const noPrepare = async (): Promise<PreparedTransaction> => {
    throw new Error('Replacement preparation forbidden');
  };
  try {
    const first = new TransactionDispatcher(
      journal,
      new PumpSolanaProvider(config(server.url)),
      gate,
    );
    const unknown = await beforeDeadline(first.execute(prepared.id, noPrepare));
    assert.equal(unknown.state, 'unknown');
    assert.equal(budget.get('fixture-gas')?.state, 'unresolved');
    const restarted = new TransactionDispatcher(
      new SqliteTransactionJournal(db),
      new PumpSolanaProvider(config(server.url)),
      gate,
    );
    assert.equal((await restarted.execute(prepared.id, noPrepare)).state, 'unknown');
    finalized = true;
    assert.equal((await restarted.execute(prepared.id, noPrepare)).state, 'confirmed');
    assert.equal(sends, 1);
    assert.equal(reads, 2);
    assert.equal(
      journal.get(prepared.id)?.signedTransactionBase64,
      prepared.signedTransactionBase64,
    );
    assert.equal(journal.get(prepared.id)?.signature, prepared.signature);
    assert.equal(
      budget.get('fixture-gas')?.state,
      'unresolved',
      'only actual fee evidence can settle the hold',
    );
  } finally {
    await server.close();
    db.close();
  }
});

test('an uncooperative late fetch cannot defeat the deadline or poison the next RPC request', async () => {
  const late = deferred<Response>();
  let calls = 0,
    aborted: AbortSignal | null | undefined;
  let lateId = '';
  const provider = new PumpSolanaProvider(
    config('https://rpc.invalid', {
      fetch: async (_input, init) => {
        calls++;
        assert.equal(init?.redirect, 'error');
        const request = JSON.parse(String(init?.body));
        if (calls === 1) {
          aborted = init?.signal;
          lateId = request.id;
          return late.promise;
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: genesis }));
      },
    }),
  );
  await beforeDeadline(assert.rejects(provider.connection.getGenesisHash(), /RPC.*timed out/));
  assert.equal(aborted?.aborted, true);
  assert.equal(await provider.connection.getGenesisHash(), genesis);
  let cancelled = false;
  late.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            Buffer.from(
              JSON.stringify({ jsonrpc: '2.0', id: lateId, result: 'wrong-late-network' }),
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, 'a late unconsumed response must be released');
  assert.equal(await provider.connection.getGenesisHash(), genesis);
});

test('RPC response buffering enforces its limit and caller cancellation even if a body ignores abort', async () => {
  for (const headers of [new Headers(), new Headers({ 'content-length': '33' })]) {
    let cancelled = false;
    const fetcher = boundedRpcFetch({
      maximumResponseBytes: 32,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(33));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers },
        ),
    });
    await assert.rejects(fetcher('https://rpc.invalid'), /size limit/);
    assert.equal(cancelled, true);
  }
  const controller = new AbortController();
  const bodyStarted = deferred<void>();
  let cancelled = false;
  const fetcher = boundedRpcFetch({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            bodyStarted.resolve();
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  const request = fetcher('https://rpc.invalid', { signal: controller.signal });
  const rejection = beforeDeadline(assert.rejects(request, /RPC.*aborted/));
  await bodyStarted.promise;
  controller.abort();
  await rejection;
  assert.equal(cancelled, true);
});

test('a rate-limited Pump RPC request is reported without hidden transport retries', async () => {
  let requests = 0;
  const server = await rpc((_request, response) => {
    requests++;
    response.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '120' });
    response.end('Rate limited');
  });
  try {
    const provider = new PumpSolanaProvider(config(server.url));
    await beforeDeadline(assert.rejects(provider.connection.getGenesisHash(), /429/));
    assert.equal(requests, 1);
  } finally {
    await server.close();
  }
});
