import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  coinbaseClientOrderId,
  type CoinbaseProvider,
  type CoinbaseDepositAddress,
  type CoinbaseSellRequest,
} from '../providers/coinbase.ts';
import type { CoinbaseCardReadiness } from '../providers/coinbase-card.ts';
import type { AgentBrowserRunner } from './browser.ts';
import type { FeeLot, PipelineJob, PipelineAdapters } from './pipeline.ts';

type VerifiedAddress = CoinbaseDepositAddress & { addressId: string; verifiedAt: number };
export interface SettlementBridgeOutput {
  asset: string;
  network: string;
  amountBaseUnits: string;
  decimals: number;
}
export interface SettlementTransferAdapter {
  /** Owns a durable transaction journal keyed by lot.id, persisted before broadcasting. */
  send(lot: FeeLot, destination: VerifiedAddress): Promise<{ reference: string }>;
  /** Optional crash recovery. The adapter MUST atomically exclude any existing or
   * in-flight preparing/signed/broadcast intent before reserving the original ID
   * and resuming. Checking a missing journal row outside that reservation is unsafe.
   * Return null whenever absence cannot be proved. Never replace an uncertain ID. */
  resumeUnsubmitted?(
    job: PipelineJob,
    destination: VerifiedAddress,
  ): Promise<{ reference: string } | null>;
  /** Must verify finalized transfer destination against the persisted binding before returning. */
  reconcile(job: PipelineJob): Promise<{
    /** Final destination-chain deposit hash; source attribution remains below. */
    hash: string;
    amountBaseUnits: string;
    chain: FeeLot['chain'];
    asset: FeeLot['asset'];
    /** Required for explicit EVM bridges; verified final output, never a quote. */
    settlement?: SettlementBridgeOutput;
  } | null>;
}
export interface CoinbaseSettlementRoute extends CoinbaseDepositAddress {
  /** Required for EVM fee rails: independently implemented, verified bridge/transfer evidence. */
  bridgeTransfer?: SettlementTransferAdapter;
}
export interface CoinbaseSettlementOptions {
  coinbase: Pick<
    CoinbaseProvider,
    | 'verifyDepositAddress'
    | 'listTransactionIds'
    | 'reconcileDeposit'
    | 'createMarketSell'
    | 'findMarketSell'
    | 'reconcileMarketSell'
  >;
  routes: Partial<Record<FeeLot['chain'], CoinbaseSettlementRoute>>;
  transfer: SettlementTransferAdapter;
  card: Pick<CoinbaseCardReadiness, 'check'>;
  cardAccounts: Partial<Record<FeeLot['recipient']['platform'], string>>;
  browser: Pick<AgentBrowserRunner, 'submit' | 'reconcile'>;
  live: (lot: FeeLot) => Promise<boolean>;
  maxDepositPages?: number;
  timeoutMs?: number;
}
interface Settlement {
  digest: string;
  destination: VerifiedAddress;
  amount: string;
  transferReference?: string;
  transactionId?: string;
  depositHash?: string;
  settlement?: SettlementBridgeOutput;
  sale?: CoinbaseSellRequest;
  orderId?: string;
}
export class SettlementHeldError extends Error {
  constructor() {
    super('Settlement held pending verified evidence for the original operation.');
    this.name = 'SettlementHeldError';
  }
}
function hold(): never {
  throw new SettlementHeldError();
}
function digest(lot: FeeLot): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        lot.id,
        lot.tokenId,
        lot.chain,
        lot.asset,
        lot.amountBaseUnits,
        lot.decimals,
        lot.claimReference,
        lot.recipient.platform,
        lot.recipient.providerId,
        lot.recipient.username,
      ]),
    )
    .digest('hex');
}
function amount(lot: FeeLot): string {
  if (
    typeof lot.amountBaseUnits !== 'string' ||
    !/^[1-9]\d{0,39}$/.test(lot.amountBaseUnits) ||
    lot.decimals !== (lot.chain === 'solana' ? 9 : 18)
  )
    hold();
  return decimalAmount(lot.amountBaseUnits, lot.decimals);
}
function decimalAmount(units: string, decimals: number): string {
  if (
    typeof units !== 'string' ||
    !/^[1-9]\d{0,39}$/.test(units) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  )
    hold();
  if (decimals === 0) return units;
  const digits = units.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '');
}
function safeCents(value: string): number {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) hold();
  const units = BigInt(value);
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) hold();
  return Number(units);
}
/** Trusted worker composition; no API accepts synthetic funding or card evidence. */
export function createCoinbaseSettlement(
  db: DatabaseSync,
  options: CoinbaseSettlementOptions,
): PipelineAdapters {
  const timeout = options.timeoutMs ?? 15_000,
    pages = options.maxDepositPages ?? 5;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000 ||
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 10
  )
    hold();
  db.exec(
    'CREATE TABLE IF NOT EXISTS agent_settlements(job_id TEXT PRIMARY KEY, deposit_identity TEXT UNIQUE, order_id TEXT UNIQUE, payload TEXT NOT NULL)',
  );
  const bounded = async <T>(operation: Promise<T>, budgetMs = timeout): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SettlementHeldError()), budgetMs);
        }),
      ]);
    } catch {
      hold();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  function read(job: FeeLot): Settlement | undefined {
    const row = db.prepare('SELECT payload FROM agent_settlements WHERE job_id=?').get(job.id);
    if (!row) return;
    const value = JSON.parse(String(row.payload)) as Settlement;
    if (value.digest !== digest(job)) hold();
    return value;
  }
  function save(job: FeeLot, old: Settlement, next: Settlement) {
    if (
      db
        .prepare(
          'UPDATE agent_settlements SET deposit_identity=?,order_id=?,payload=? WHERE job_id=? AND payload=?',
        )
        .run(
          next.transactionId ? `${next.destination.accountId}:${next.transactionId}` : null,
          next.orderId ?? null,
          JSON.stringify(next),
          job.id,
          JSON.stringify(old),
        ).changes !== 1
    )
      hold();
  }
  function route(job: FeeLot) {
    const config = options.routes[job.chain];
    if (
      !config ||
      !/^[A-Z0-9]{2,16}$/.test(config.asset) ||
      (job.chain === 'solana' && (config.asset !== job.asset || config.network !== 'solana')) ||
      !config.accountId ||
      !config.address ||
      !config.network ||
      (job.chain !== 'solana' && !config.bridgeTransfer)
    )
      hold();
    return {
      destination: {
        accountId: config.accountId,
        address: config.address,
        network: config.network,
        asset: config.asset,
      },
      transfer: job.chain === 'solana' ? options.transfer : config.bridgeTransfer!,
    };
  }
  function binding(job: FeeLot, stored: Settlement) {
    const config = route(job);
    if (
      Object.entries(config.destination).some(
        ([key, value]) => stored.destination[key as keyof CoinbaseDepositAddress] !== value,
      )
    )
      hold();
    return config;
  }
  const adapters: PipelineAdapters = {
    async deposit(lot) {
      const config = route(lot),
        old = read(lot);
      if (old) {
        binding(lot, old);
        if (old.transferReference) return { reference: old.transferReference };
        hold();
      }
      const expectedAmount = amount(lot);
      const destination = await bounded(options.coinbase.verifyDepositAddress(config.destination));
      if (
        Object.entries(config.destination).some(
          ([key, value]) => destination[key as keyof CoinbaseDepositAddress] !== value,
        ) ||
        !destination.addressId
      )
        hold();
      const stored: Settlement = { digest: digest(lot), destination, amount: expectedAmount };
      // This insert is also the cross-process submission reservation. Only the winner sends.
      db.prepare('INSERT INTO agent_settlements VALUES(?,NULL,NULL,?)').run(
        lot.id,
        JSON.stringify(stored),
      );
      const result = await bounded(config.transfer.send(lot, destination));
      if (!result.reference) hold();
      save(lot, stored, { ...stored, transferReference: result.reference });
      return result;
    },
    async reconcileDeposit(job) {
      const deadline = Date.now() + timeout;
      const within = <T>(operation: () => Promise<T>): Promise<T> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) hold();
        return bounded(operation(), remaining);
      };
      let stored = read(job);
      if (!stored) {
        // Every send is preceded by the unique row insertion. No row means this
        // adapter has not called send; retry authenticated preflight and let the
        // atomic insertion choose the sole sender across competing workers.
        await adapters.deposit(job);
        return null;
      }
      const config = binding(job, stored);
      const transfer = await within(() => config.transfer.reconcile(job));
      if (!transfer) {
        if (
          !stored.transferReference &&
          !stored.transactionId &&
          config.transfer.resumeUnsubmitted
        ) {
          const destination = await within(() =>
            options.coinbase.verifyDepositAddress(config.destination),
          );
          if (
            Object.entries(config.destination).some(
              ([key, value]) => destination[key as keyof CoinbaseDepositAddress] !== value,
            ) ||
            !destination.addressId
          )
            hold();
          const refreshed = { ...stored, destination };
          save(job, stored, refreshed);
          stored = refreshed;
          // This capability belongs to the transfer adapter because only its
          // transaction journal can prove no signer or broadcaster is in flight.
          const resumed = await within(() => config.transfer.resumeUnsubmitted!(job, destination));
          if (resumed) {
            if (!resumed.reference) hold();
            save(job, stored, { ...stored, transferReference: resumed.reference });
          }
        }
        return null;
      }
      if (
        transfer.chain !== job.chain ||
        transfer.asset !== job.asset ||
        transfer.amountBaseUnits !== job.amountBaseUnits ||
        !transfer.hash
      )
        hold();
      if (stored.depositHash && stored.depositHash !== transfer.hash) hold();
      if (job.chain !== 'solana') {
        const output = transfer.settlement;
        if (
          !output ||
          output.asset !== stored.destination.asset ||
          output.network !== stored.destination.network
        )
          hold();
        const targetAmount = decimalAmount(output.amountBaseUnits, output.decimals);
        const settlement: SettlementBridgeOutput = {
          asset: output.asset,
          network: output.network,
          amountBaseUnits: output.amountBaseUnits,
          decimals: output.decimals,
        };
        if (stored.settlement) {
          if (
            JSON.stringify(stored.settlement) !== JSON.stringify(settlement) ||
            stored.amount !== targetAmount
          )
            hold();
        } else {
          // Persist final bridge output attribution before asking Coinbase to
          // match its receipt. A bridge quote cannot become a sale amount.
          if (stored.transactionId || stored.sale) hold();
          const bound = { ...stored, settlement, amount: targetAmount, depositHash: transfer.hash };
          save(job, stored, bound);
          stored = bound;
        }
      } else if (
        transfer.settlement &&
        (transfer.settlement.asset !== job.asset ||
          transfer.settlement.network !== 'solana' ||
          transfer.settlement.amountBaseUnits !== job.amountBaseUnits ||
          transfer.settlement.decimals !== job.decimals)
      )
        hold();
      const expected = {
        accountId: stored.destination.accountId,
        network: stored.destination.network,
        transactionHash: transfer.hash,
        asset: stored.destination.asset,
        amount: stored.amount,
      };
      if (stored.transactionId) {
        await within(() => options.coinbase.reconcileDeposit(stored.transactionId!, expected));
        return { reference: `${expected.accountId}:${stored.transactionId}`, jobId: job.id };
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < pages; page++) {
        const list = await within(() =>
          options.coinbase.listTransactionIds(expected.accountId, cursor),
        );
        for (const id of list.transactionIds) {
          if (seen.has(id)) hold();
          seen.add(id);
          try {
            await within(() => options.coinbase.reconcileDeposit(id, expected));
          } catch {
            if (Date.now() >= deadline) hold();
            continue;
          }
          save(job, stored, { ...stored, transactionId: id, depositHash: transfer.hash });
          return { reference: `${expected.accountId}:${id}`, jobId: job.id };
        }
        if (!list.nextStartingAfter) return null;
        if (list.nextStartingAfter === cursor) hold();
        cursor = list.nextStartingAfter;
      }
      return null;
    },
    async convert(job) {
      const stored = read(job);
      if (!stored?.transactionId || !stored.depositHash) hold();
      binding(job, stored);
      if (stored.orderId) return { reference: stored.orderId };
      if (stored.sale) hold();
      const sale: CoinbaseSellRequest = {
        clientOrderId: coinbaseClientOrderId(job.id),
        productId: `${stored.destination.asset}-USD`,
        baseSize: stored.amount,
      };
      const pending = { ...stored, sale };
      save(job, stored, pending);
      const created = await bounded(options.coinbase.createMarketSell(sale));
      if (created.clientOrderId !== sale.clientOrderId || !created.orderId) hold();
      save(job, pending, { ...pending, orderId: created.orderId });
      return { reference: created.orderId };
    },
    async reconcileConversion(job) {
      let stored = read(job);
      if (!stored?.transactionId) return null;
      binding(job, stored);
      if (!stored.sale) {
        // Sale submission always follows a CAS-persisted immutable sale intent.
        // Its absence proves createMarketSell has not been invoked for this lot.
        await adapters.convert(job);
        return null;
      }
      if (!stored.orderId) {
        const found = await bounded(options.coinbase.findMarketSell(stored.sale.clientOrderId));
        if (!found) return null;
        if (found.clientOrderId !== stored.sale.clientOrderId || !found.orderId) hold();
        const next = { ...stored, orderId: found.orderId };
        save(job, stored, next);
        stored = next;
      }
      const result = await bounded(
        options.coinbase.reconcileMarketSell(stored.orderId!, stored.sale!),
      );
      if (
        result.orderId !== stored.orderId ||
        result.clientOrderId !== stored.sale!.clientOrderId ||
        result.baseSize !== stored.amount ||
        result.productId !== `${stored.destination.asset}-USD`
      )
        hold();
      return {
        reference: result.orderId,
        jobId: job.id,
        netUsdCents: safeCents(result.spendableUsdCents),
      };
    },
    live: (lot) => bounded(options.live(lot)),
    async cardReady(job) {
      const account = options.cardAccounts[job.recipient.platform];
      if (
        !account ||
        !Number.isSafeInteger(job.netUsdCents) ||
        job.netUsdCents! <= 0 ||
        !Number.isSafeInteger(job.streamerBudgetUsdCents) ||
        job.streamerBudgetUsdCents! <= 0 ||
        !Number.isSafeInteger(job.platformReserveUsdCents) ||
        job.platformReserveUsdCents! < 0 ||
        BigInt(job.streamerBudgetUsdCents!) + BigInt(job.platformReserveUsdCents!) !==
          BigInt(job.netUsdCents!)
      )
        return null;
      const result = await bounded(
        options.card.check({
          cardAccountId: account,
          requiredUsdCents: String(job.streamerBudgetUsdCents),
        }),
      );
      if (!result.ready) return null;
      if (result.evidence.cardAccountId !== account) return null;
      return {
        cardAccountId: account,
        availableCreditCents: safeCents(result.evidence.availableCreditCents),
        observedAt: result.evidence.observedAt,
      };
    },
    async gift(job) {
      if (!job.cardAccountId || job.cardAccountId !== options.cardAccounts[job.recipient.platform])
        hold();
      return bounded(options.browser.submit(job));
    },
    async reconcileGift(job) {
      if (!job.cardAccountId || job.cardAccountId !== options.cardAccounts[job.recipient.platform])
        return null;
      const proof = await bounded(options.browser.reconcile(job));
      if (!proof) return null;
      if (
        proof.jobId !== job.id ||
        proof.cardAccountId !== job.cardAccountId ||
        proof.chargeStatus !== 'POSTED' ||
        proof.currency !== 'USD' ||
        proof.recipientProviderId !== job.recipient.providerId ||
        proof.recipientUsername !== job.recipient.username ||
        proof.platform !== job.recipient.platform ||
        (job.giftReference && proof.purchaseReference !== job.giftReference)
      )
        hold();
      return proof;
    },
  };
  return adapters;
}
