import {
  autonomousRuntime,
  type WorkerIntegrations,
  type FeeRouteCandidate,
} from './agents/runtime.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Keypair } from '@solana/web3.js';
import type { OperationsService } from './operations.ts';
import { PumpSolanaProvider, type PumpSolanaConfig } from './providers/pump-solana.ts';
import { valueLamportsInUsdCents, type SolUsdQuote } from './providers/contracts.ts';
import { SqliteTransactionJournal, TransactionDispatcher } from './workers/transaction-journal.ts';
import type { StreamerLiveGate, LiveRecipient } from './workers/streamer-live.ts';
import { AutonomousPipeline, type PipelineAdapters, type FeeLot } from './agents/pipeline.ts';
import { createNativeFeeRouter } from './agents/fee-router.ts';
import { createBuybackWorker, listBuybackJobs, type BuybackOptions } from './agents/buyback.ts';
import { projectNativeBuybacks } from './public/native-buybacks.ts';
import {
  projectAutonomousCatalog,
  publicAutonomousDonations,
  publicAutonomousLedger,
} from './public/autonomous-catalog.ts';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface ServiceOptions {
  env?: NodeJS.ProcessEnv;
  /** Bounds observation only; never cancels or unlocks an in-flight financial operation. */
  workerObservationMs?: number;
  integrations?: WorkerIntegrations;
  /** Trusted Solana treasury bindings; spending authority still comes from both runtime flags. */
  buyback?: Omit<BuybackOptions, 'enabled'>;
  launchSigner?: (creator: string) => Promise<Keypair>;
  liveGate?: Pick<StreamerLiveGate, 'watch' | 'requireLive' | 'assertFreshLive'>;
  recipientForToken?: (id: string) => LiveRecipient | null;
  quote?: () => Promise<SolUsdQuote>;
  providerFactory?: (config: PumpSolanaConfig) => PumpSolanaProvider;
  pipelineAdapters?: PipelineAdapters;
  /** Additional finalized fee sources, e.g. configured Flap/PONs adapters. Each source journals before broadcasting. */
  feeSources?: Array<{
    scan(policy?: { canClaim(candidate: FeeRouteCandidate): boolean }): Promise<FeeLot[]>;
    acknowledge?(id: string): void | Promise<void>;
  }>;
  /** Trusted custom pipeline bindings may supply an explicit per-platform route policy. */
  feeRouteReady?: (candidate: FeeRouteCandidate) => boolean;
}
export async function fetchSolUsdQuote(): Promise<SolUsdQuote> {
  const response = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new ServiceError(503, 'Price evidence unavailable.');
  const value = await response.json();
  if (
    value?.data?.base !== 'SOL' ||
    value?.data?.currency !== 'USD' ||
    typeof value.data.amount !== 'string' ||
    !/^\d{1,8}(\.\d{1,12})?$/.test(value.data.amount)
  )
    throw new ServiceError(503, 'Invalid price evidence.');
  const [whole, fraction = ''] = value.data.amount.split('.');
  const centsPerSol = String(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
  const observed = response.headers.get('date');
  if (!observed || !Number.isFinite(Date.parse(observed)))
    throw new ServiceError(503, 'Missing price observation time.');
  const quote = {
    centsPerSol,
    observedAt: new Date(observed).toISOString(),
    source: 'coinbase_spot',
  };
  valueLamportsInUsdCents(1_000_000_000n, quote);
  return quote;
}
/** Composition entry for workers; no login, manual evidence override, or HTTP actions. */
export function createServices(
  db: DatabaseSync,
  operations: OperationsService,
  options: ServiceOptions = {},
) {
  const env = options.env ?? process.env;
  const journal = new SqliteTransactionJournal(db);
  const enabled = env.POG_AUTOMATION_ENABLED === 'true' && env.POG_TRANSACTIONS_ENABLED === 'true';
  const unavailable = async (): Promise<never> => {
    throw new ServiceError(503, 'Provider bindings are not configured.');
  };
  const signerForCreator = options.launchSigner ?? unavailable;
  const quote = options.quote ?? fetchSolUsdQuote;
  let running: Promise<unknown> | undefined;
  let sourceRun: Promise<number> | undefined;
  const activeWorkers = new Set<Promise<void>>();
  const observationMs = options.workerObservationMs ?? 2000;
  if (!Number.isSafeInteger(observationMs) || observationMs < 1 || observationMs > 10000)
    throw new Error('Invalid worker observation interval.');
  function observe<T>(
    work: Promise<T>,
  ): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected' } | { status: 'pending' }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'pending' }), observationMs);
      // Attach both handlers even after observation expires: late failures stay handled.
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve({ status: 'fulfilled', value });
        },
        () => {
          clearTimeout(timer);
          resolve({ status: 'rejected' });
        },
      );
    });
  }
  function track(work: Promise<void>): Promise<void> {
    activeWorkers.add(work);
    void work.then(
      () => activeWorkers.delete(work),
      () => activeWorkers.delete(work),
    );
    return work;
  }
  let closed = false;
  const provider = () => {
    if (!env.POG_SOLANA_RPC_URL || !env.POG_SOLANA_GENESIS_HASH)
      throw new ServiceError(503, 'Solana network is not configured.');
    return (options.providerFactory ?? ((config) => new PumpSolanaProvider(config)))({
      rpcUrl: env.POG_SOLANA_RPC_URL,
      expectedGenesisHash: env.POG_SOLANA_GENESIS_HASH,
      mappings: operations.snapshot().tokens.map((t) => ({
        tokenId: t.id,
        mint: t.mint,
        creator: t.creatorAddress,
        dedicatedCreatorVerified: true,
      })),
      signerForCreator,
      transactionsEnabled: enabled,
      coinbaseAccountId: env.POG_COINBASE_ACCOUNT_ID ?? '',
      allowedCoinbaseAddresses: env.POG_COINBASE_SOL_ADDRESS ? [env.POG_COINBASE_SOL_ADDRESS] : [],
      maxTopUpLamports: BigInt(env.POG_MAX_DEPOSIT_LAMPORTS ?? '1000000000'),
      minimumWalletReserveLamports: BigInt(env.POG_GAS_RESERVE_LAMPORTS ?? '1000000'),
    });
  };
  const composed =
    options.pipelineAdapters ??
    (options.liveGate
      ? autonomousRuntime(
          db,
          env,
          provider,
          options.liveGate as StreamerLiveGate,
          options.integrations,
        )
      : undefined);
  const feeRouteReady =
    options.feeRouteReady ??
    (composed && 'feeRouteReady' in composed
      ? (composed.feeRouteReady as (candidate: FeeRouteCandidate) => boolean)
      : () => Boolean(options.pipelineAdapters));
  const adapters: PipelineAdapters = composed
    ? {
        ...composed,
        async deposit(lot) {
          if (!feeRouteReady(lot))
            throw new ServiceError(503, 'Recipient funding route is not configured.');
          return composed.deposit(lot);
        },
      }
    : {
        deposit: unavailable,
        reconcileDeposit: async () => null,
        convert: unavailable,
        reconcileConversion: async () => null,
        live: async () => false,
        cardReady: async () => null,
        gift: unavailable,
        reconcileGift: async () => null,
      };
  const pipeline = new AutonomousPipeline(db, adapters, {
    enabled,
    minimumGiftUsdCents: 5000,
    maximumGiftUsdCents: Number(env.POG_MAX_GIFT_USD_CENTS ?? 50000),
  });
  const feeRouter = createNativeFeeRouter(db, pipeline);
  const buyback = options.buyback
    ? createBuybackWorker(db, { ...options.buyback, enabled })
    : undefined;
  const canClaim = (candidate: FeeRouteCandidate) =>
    feeRouteReady(candidate) && Boolean(buyback?.ready(candidate.chain));
  async function ingest(source: PumpSolanaProvider, id: string) {
    const transaction = journal.get(id);
    if (!transaction || transaction.state !== 'confirmed') return;
    const token = operations.snapshot().tokens.find((t) => t.id === transaction.tokenId);
    const recipient = options.recipientForToken?.(transaction.tokenId);
    if (!token || !recipient) return;
    const proof = await source.finalizedProof(transaction);
    // Store the first verified valuation once, never recompute a conflicting claim on restart.
    const existing = operations.snapshot().claims.find((c) => c.signature === proof.signature);
    if (!existing) {
      const price = await quote();
      operations.recordClaim(
        {
          tokenId: token.id,
          signature: proof.signature,
          amountLamports: proof.amountLamports,
          grossUsdCents: valueLamportsInUsdCents(BigInt(proof.amountLamports), price),
          networkFeeCents: valueLamportsInUsdCents(BigInt(proof.networkFeeLamports), price),
          valuationAt: price.observedAt,
          slot: proof.slot,
          confirmation: 'finalized',
        },
        'agent:claims',
      );
    }
    feeRouter.recordClaim({
      id: `solana:${proof.signature}`,
      tokenId: token.id,
      chain: 'solana',
      asset: 'SOL',
      amountBaseUnits: proof.amountLamports,
      decimals: 9,
      claimReference: proof.signature,
      recipient,
    });
  }
  async function scanSources() {
    let sourceFailures = 0;
    for (const extra of options.feeSources ?? []) {
      try {
        for (const lot of await extra.scan({ canClaim })) {
          // Finalized lots remain accountable even when route configuration
          // changes after a claim. New claims require both branches to be ready.
          feeRouter.recordClaim(lot);
          await extra.acknowledge?.(lot.id);
        }
      } catch {
        sourceFailures++;
      }
    }
    if (env.POG_SOLANA_RPC_URL && env.POG_SOLANA_GENESIS_HASH && options.launchSigner) {
      try {
        const source = provider();
        const dispatcher = new TransactionDispatcher(journal, source);
        const pending = db
          .prepare(
            "SELECT id FROM worker_transactions WHERE kind='claim' AND state NOT IN ('failed','retired_expired')",
          )
          .all();
        for (const row of pending) {
          try {
            await dispatcher.reconcile(String(row.id));
            await ingest(source, String(row.id));
          } catch {
            sourceFailures++;
          }
        }
        for (const token of operations.snapshot().tokens) {
          try {
            const recipient = options.recipientForToken?.(token.id);
            if (!recipient || !canClaim({ chain: 'solana', recipient })) continue;
            const unresolved = db
              .prepare(
                "SELECT id FROM worker_transactions WHERE kind='claim' AND creator=? AND state IN ('prepared','broadcast','unknown','expired_review')",
              )
              .get(token.creatorAddress);
            if (unresolved) continue;
            const price = await quote();
            const fees = await source.inspectFees(token.id, price);
            if (!fees.eligible) continue;
            const id = randomUUID();
            await dispatcher.execute(id, () => source.prepareClaim(id, token.id, price));
            await dispatcher.reconcile(id);
            await ingest(source, id);
          } catch {
            sourceFailures++;
          }
        }
      } catch {
        sourceFailures++;
      }
    }
    return sourceFailures;
  }
  async function run() {
    if (closed || !enabled) return { state: 'disabled' };
    // A pending source retains its own lock even after this service cycle returns.
    const intake = await observe(
      (sourceRun ??= scanSources().finally(() => {
        sourceRun = undefined;
      })),
    );
    if (closed) return { state: 'disabled' };
    let sourceFailures =
      intake.status === 'fulfilled' ? intake.value : intake.status === 'rejected' ? 1 : 0;
    let buybackFailures = 0;
    if (buyback) {
      for (const lot of feeRouter.buybackLots()) {
        try {
          buyback.recordClaim(lot);
          feeRouter.acknowledgeBuyback(lot.id);
        } catch {
          buybackFailures++;
        }
      }
    }
    // Branch failures are isolated: no failed exchange/checkout can prevent
    // already allocated buybacks from reconciling, and vice versa.
    const results = await Promise.all([
      observe(track(pipeline.runOnce())),
      observe(track(buyback?.runOnce() ?? Promise.resolve())),
    ]);
    if (results[0].status === 'rejected') sourceFailures++;
    if (results[1].status === 'rejected') buybackFailures++;
    return {
      state: 'checked',
      sourceFailures,
      buybackFailures,
      sourcePending: intake.status === 'pending',
      streamerPending: results[0].status === 'pending',
      buybackPending: results[1].status === 'pending',
    };
  }
  const nativeContext = () => ({
    target: options.buyback?.target,
    jobs: buyback?.list() ?? listBuybackJobs(db),
    splits: feeRouter.splits(),
  });
  return {
    signerForCreator,
    projectCatalog: (catalog: Parameters<typeof projectAutonomousCatalog>[0]) =>
      projectNativeBuybacks(projectAutonomousCatalog(catalog, pipeline.list()), nativeContext()),
    publicDonations: () => publicAutonomousDonations(pipeline.list()),
    publicLedger: () => publicAutonomousLedger(pipeline.list()),
    publicNativeBuybacks: () => projectNativeBuybacks({}, nativeContext()).nativeBuybackLedger,
    readFeesForDisplay: async (tokenId: string) => provider().inspectFees(tokenId, await quote()),
    runOnce: () =>
      (running ??= run().finally(() => {
        running = undefined;
      })),
    close: async () => {
      closed = true;
      await Promise.allSettled([running]);
      // Shutdown waits for real work; expiring an observation must never permit
      // database closure while a previously submitted operation is still active.
      await Promise.allSettled([sourceRun, ...activeWorkers]);
    },
    status: () => ({
      autonomous: true,
      enabled,
      settlementConfigured: Boolean(composed),
      buybackConfigured: Boolean(buyback),
      platformToken: { symbol: 'POG', chain: 'solana' },
      allocation: { unit: 'native', streamerPercent: 80, buybackPercent: 20, beforeUsdSale: true },
      fundingProvider: 'coinbase',
      card: 'Coinbase One',
      humanAccess: false,
    }),
    publicPayments: () =>
      pipeline
        .list()
        .map(
          ({ id, tokenId, chain, phase, spentUsdCents, residualUsdCents, receiptReference }) => ({
            id,
            tokenId,
            chain,
            phase,
            spentUsdCents,
            residualUsdCents,
            receiptReference,
          }),
        ),
  };
}
