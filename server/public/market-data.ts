import { PublicKey } from '@solana/web3.js';

/** Display data only. These prices must never determine ledger balances or execution limits. */
export interface MarketToken {
  address: string;
  mcap: number | null;
  volume: number | null;
  change: number | null;
}
export interface MarketValues {
  priceUsd: number | null;
  mcap: number | null;
  volume: number | null;
  change: number | null;
  marketDataUpdatedAt: string | null;
}
export type MarketDataStatus = 'fresh' | 'stale' | 'warming' | 'unavailable';
type DisplayValues = MarketValues & { marketDataStatus: MarketDataStatus };
interface CacheEntry {
  values: MarketValues;
  expires: number;
  staleUntil: number;
  retryAt: number;
  failures: number;
}
export interface MarketDataOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maximumCacheEntries?: number;
}
const EMPTY: Readonly<MarketValues> = Object.freeze({
  priceUsd: null,
  mcap: null,
  volume: null,
  change: null,
  marketDataUpdatedAt: null,
});
const FRESH_MS = 15_000;
const MISSING_MS = 10_000;
const STALE_MS = 120_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_PAIRS = 3000;
const MAX_METRIC = Number.MAX_SAFE_INTEGER / 100;
const QUOTE_MINTS = new Set([
  // Solana's canonical wrapped SOL and Circle-issued mainnet USDC; symbols are not identities.
  // https://solana.com/docs/tokens/basics/sync-native
  // https://developers.circle.com/stablecoins/usdc-contract-addresses
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function address(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
function number(value: unknown, minimum = 0) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= MAX_METRIC
    ? Object.is(value, -0)
      ? 0
      : value
    : null;
}
function selectedValues(rows: unknown[], requested: readonly string[], updatedAt: string) {
  const wanted = new Set(requested);
  const selected = new Map<
    string,
    { liquidity: number; pairAddress: string; values: MarketValues }
  >();
  for (const raw of rows) {
    const pair = object(raw),
      base = object(pair?.baseToken),
      quote = object(pair?.quoteToken);
    if (
      !pair ||
      pair.chainId !== 'solana' ||
      typeof base?.address !== 'string' ||
      !wanted.has(base.address) ||
      typeof quote?.address !== 'string' ||
      !QUOTE_MINTS.has(quote.address) ||
      !address(pair.pairAddress)
    )
      continue;
    const liquidityField = object(pair.liquidity)?.usd;
    // Pump bonding-curve pairs can omit liquidity. They rank below every measured pool.
    const liquidity =
      liquidityField === undefined || liquidityField === null ? 0 : number(liquidityField);
    if (liquidity === null) continue;
    const prior = selected.get(base.address);
    // Stable tie break prevents provider ordering changes from selecting a different equal-depth pool.
    if (
      prior &&
      (prior.liquidity > liquidity ||
        (prior.liquidity === liquidity && prior.pairAddress <= pair.pairAddress))
    )
      continue;
    const values: MarketValues = {
      // The provider documents USD price as a decimal string. Other metrics remain numbers.
      priceUsd: displayPrice(pair.priceUsd),
      mcap: number(pair.marketCap),
      volume: number(object(pair.volume)?.h24),
      change: number(object(pair.priceChange)?.h24, -100),
      marketDataUpdatedAt: updatedAt,
    };
    if (
      values.priceUsd === null &&
      values.mcap === null &&
      values.volume === null &&
      values.change === null
    )
      values.marketDataUpdatedAt = null;
    selected.set(base.address, { liquidity, pairAddress: pair.pairAddress, values });
  }
  return new Map(requested.map((mint) => [mint, selected.get(mint)?.values ?? EMPTY]));
}

function displayPrice(value: unknown): number | null {
  const parsed =
    typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null;
  return parsed !== null && Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_METRIC
    ? parsed
    : null;
}

/**
 * Official public endpoint: https://docs.dexscreener.com/api/reference
 * /tokens/v1/{chainId}/{tokenAddresses}: up to 30 addresses, documented 300 requests/minute.
 * A single server instance uses at most 120 requests per rolling minute and 3 concurrent reads.
 */
export class DexScreenerMarketData {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maximumCacheEntries: number;
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<Map<string, DisplayValues>>>();
  private requestTimes: number[] = [];
  private cooldownUntil = 0;
  private active = 0;
  private queue: Array<{ start: () => void; abort: () => void }> = [];
  private controllers = new Set<AbortController>();
  private stopped = false;
  private lastAdmitted: string | undefined;
  constructor(options: MarketDataOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.maximumCacheEntries = options.maximumCacheEntries ?? 2000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10_000)
      throw new Error('Market request timeout must be 1–10000 milliseconds.');
    if (
      !Number.isSafeInteger(this.maximumCacheEntries) ||
      this.maximumCacheEntries < 1 ||
      this.maximumCacheEntries > 10_000
    )
      throw new Error('Market cache must hold 1–10000 entries.');
  }
  private slot(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Market request expired.'));
        return;
      }
      const waiter = {
        start: () => {
          signal.removeEventListener('abort', waiter.abort);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.queue.shift()?.start();
          });
        },
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Error('Market request expired.'));
        },
      };
      if (this.active < 3) waiter.start();
      else {
        this.queue.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
    });
  }
  private remember(mint: string, values: MarketValues | null) {
    if (this.stopped) return;
    const now = this.now();
    const prior = this.cache.get(mint);
    const failures = values ? 0 : Math.min(3, (prior?.failures ?? 0) + 1);
    const freshMs = values?.marketDataUpdatedAt ? FRESH_MS : MISSING_MS;
    const entry: CacheEntry = values
      ? {
          values,
          expires: now + freshMs,
          staleUntil: now + STALE_MS,
          retryAt: now + freshMs,
          failures,
        }
      : {
          values: prior && prior.staleUntil > now ? prior.values : EMPTY,
          expires: prior?.expires ?? 0,
          staleUntil: prior?.staleUntil ?? 0,
          retryAt: now + 30_000 * 2 ** (failures - 1),
          failures,
        };
    this.cache.delete(mint);
    this.cache.set(mint, entry);
    while (this.cache.size > this.maximumCacheEntries)
      this.cache.delete(this.cache.keys().next().value!);
  }
  private async readBody(response: Response, signal: AbortSignal): Promise<unknown[]> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BODY_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Market response is oversized or empty.');
    }
    const reader = response.body.getReader();
    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) throw new Error('Market response is oversized.');
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data) || data.length > MAX_PAIRS)
      throw new Error('Unexpected market response.');
    return data;
  }
  private async batch(mints: readonly string[]): Promise<Map<string, MarketValues> | null> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Market read stopped.'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const work = (async () => {
      release = await this.slot(controller.signal);
      controller.signal.throwIfAborted();
      // Waiting batches have no live transport. Each active read gets its own full deadline.
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const now = this.now();
      this.requestTimes = this.requestTimes.filter((time) => time > now - 60_000);
      if (this.stopped || now < this.cooldownUntil || this.requestTimes.length >= 120)
        throw new Error('Market request budget exhausted.');
      this.requestTimes.push(now);
      const response = await this.request(
        `https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || this.stopped) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Market read stopped.');
      }
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const wait = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(header ?? '') - this.now();
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          this.now() +
            Math.max(60_000, Math.min(86_400_000, Number.isFinite(wait) ? wait : 60_000)),
        );
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Market provider unavailable.');
      }
      const rows = await this.readBody(response, controller.signal);
      controller.signal.throwIfAborted();
      return selectedValues(rows, mints, new Date(this.now()).toISOString());
    })();
    try {
      return await Promise.race([work, cancelled]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
      release?.();
    }
  }
  private display(mint: string): DisplayValues {
    const cached = this.cache.get(mint);
    const now = this.now();
    if (cached?.values.marketDataUpdatedAt && cached.staleUntil > now)
      return { ...cached.values, marketDataStatus: cached.expires > now ? 'fresh' : 'stale' };
    return { ...EMPTY, marketDataStatus: this.pending.has(mint) ? 'warming' : 'unavailable' };
  }
  private schedule(tokens: readonly MarketToken[]) {
    const jobs = new Set<Promise<Map<string, DisplayValues>>>();
    if (this.stopped) return jobs;
    const requested = [...new Set(tokens.map((token) => token.address))].filter(address);
    for (const mint of requested) {
      const existing = this.pending.get(mint);
      if (existing) jobs.add(existing);
    }
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((time) => time > now - 60_000);
    if (now < this.cooldownUntil || this.requestTimes.length >= 120) return jobs;
    // A fixed-size admission window advances through large catalogs, including after eviction.
    const previous = this.lastAdmitted === undefined ? -1 : requested.indexOf(this.lastAdmitted);
    const ordered = [...requested.slice(previous + 1), ...requested.slice(0, previous + 1)];
    let capacity = Math.max(30, this.maximumCacheEntries) - this.pending.size;
    const missing: string[] = [];
    for (const mint of ordered) {
      if (capacity <= 0) break;
      if (this.pending.has(mint) || (this.cache.get(mint)?.retryAt ?? 0) > now) continue;
      missing.push(mint);
      this.lastAdmitted = mint;
      capacity--;
    }
    for (let i = 0; i < missing.length; i += 30) {
      const mints = missing.slice(i, i + 30);
      const job = this.batch(mints)
        .then((result) => {
          const values = new Map<string, DisplayValues>();
          for (const mint of mints) {
            this.remember(mint, result?.get(mint) ?? null);
            values.set(mint, this.display(mint));
          }
          return values;
        })
        .finally(() => {
          for (const mint of mints) if (this.pending.get(mint) === job) this.pending.delete(mint);
        });
      for (const mint of mints) this.pending.set(mint, job);
      jobs.add(job);
    }
    return jobs;
  }
  /** Identity and financial fields return synchronously; only validated display prices are cached. */
  snapshot<T extends MarketToken>(tokens: readonly T[]) {
    this.schedule(tokens);
    const now = this.now();
    const refreshing = tokens.some((token) => this.pending.has(token.address));
    let next = FRESH_MS;
    for (const token of tokens) {
      const retryAt = this.cache.get(token.address)?.retryAt ?? now;
      next = Math.min(next, Math.max(retryAt, this.cooldownUntil) - now);
    }
    return {
      tokens: tokens.map((token) => ({ ...token, ...this.display(token.address) })),
      marketData: { refreshing, retryAfterMs: refreshing ? 1000 : Math.max(1000, next) },
    };
  }
  /** Awaitable bounded refresh for non-HTTP callers; public catalog reads use snapshot(). */
  async enrich<T extends MarketToken>(
    tokens: readonly T[],
  ): Promise<Array<Omit<T, keyof DisplayValues> & DisplayValues>> {
    const values = new Map<string, DisplayValues>();
    for (const result of await Promise.all(this.schedule(tokens)))
      for (const [mint, entry] of result) values.set(mint, entry);
    return tokens.map((token) => {
      const value = values.get(token.address);
      const age = value?.marketDataUpdatedAt
        ? this.now() - Date.parse(value.marketDataUpdatedAt)
        : Infinity;
      return {
        ...token,
        ...(value && age < STALE_MS
          ? { ...value, marketDataStatus: age < FRESH_MS ? ('fresh' as const) : ('stale' as const) }
          : this.display(token.address)),
      };
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(new Set(this.pending.values()));
  }
}
