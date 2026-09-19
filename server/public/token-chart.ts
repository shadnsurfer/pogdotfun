import { PublicKey } from '@solana/web3.js';

export type TokenChartRange = '24h' | '7d' | '30d';
export interface TokenChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface TokenChartResult {
  tokenId: string;
  mint: string;
  range: TokenChartRange;
  currency: 'USD';
  provider: 'GeckoTerminal';
  status: 'ready' | 'empty' | 'unavailable';
  updatedAt: string | null;
  poolAddress: string | null;
  sourceUrl: string | null;
  candles: TokenChartCandle[];
}
export interface TokenChartOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maximumCacheEntries?: number;
}
interface Pool {
  address: string;
  quote: string;
  liquidity: number;
}
type ChartValues = Omit<TokenChartResult, 'tokenId'>;
type PoolResult = { status: 'ready'; pool: Pool } | { status: 'empty' | 'unavailable' };
const ORIGIN = 'https://api.geckoterminal.com/api/v2';
const CACHE_MS = 90_000,
  EMPTY_CACHE_MS = 15_000,
  POOL_CACHE_MS = 300_000,
  MAX_BODY_BYTES = 1_000_000,
  MAX_ROWS = 1000;
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);
const RANGES: Record<
  TokenChartRange,
  { timeframe: 'minute' | 'hour'; aggregate: number; limit: number; seconds: number }
> = {
  '24h': { timeframe: 'minute', aggregate: 5, limit: 289, seconds: 86400 },
  '7d': { timeframe: 'hour', aggregate: 1, limit: 169, seconds: 604800 },
  '30d': { timeframe: 'hour', aggregate: 4, limit: 181, seconds: 2592000 },
};
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
function relation(value: unknown) {
  const data = object(object(value)?.data);
  return data?.type === 'token' &&
    typeof data.id === 'string' &&
    data.id.startsWith('solana_') &&
    address(data.id.slice(7))
    ? data.id.slice(7)
    : null;
}
function liquidity(value: unknown) {
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
function selectPool(value: unknown, mint: string): PoolResult {
  const root = object(value);
  const rows = root?.data;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('Invalid pool list.');
  if (rows.length === 0) return { status: 'empty' };
  const included = root?.included;
  if (!Array.isArray(included) || included.length > MAX_ROWS)
    throw new Error('Missing token identities.');
  const identities = new Map<string, string>();
  for (const raw of included) {
    const token = object(raw);
    const attributes = object(token?.attributes);
    if (token?.type !== 'token') continue;
    if (!address(attributes?.address) || token.id !== `solana_${attributes.address}`)
      throw new Error('Invalid included token identity.');
    identities.set(token.id as string, attributes.address);
  }
  const candidates: Pool[] = [];
  let invalid = false;
  for (const raw of rows) {
    const p = object(raw),
      attributes = object(p?.attributes),
      relationships = object(p?.relationships);
    const base = relation(relationships?.base_token),
      quote = relation(relationships?.quote_token);
    if (
      p?.type !== 'pool' ||
      !address(attributes?.address) ||
      p.id !== `solana_${attributes.address}` ||
      !base ||
      !quote ||
      identities.get(`solana_${base}`) !== base ||
      identities.get(`solana_${quote}`) !== quote
    ) {
      invalid = true;
      continue;
    }
    // A returned pool with the requested token on the quote side is not a base-token chart.
    if (base !== mint) {
      if (quote !== mint) invalid = true;
      continue;
    }
    if (!QUOTES.has(quote) || quote === mint) continue;
    const depth = liquidity(attributes.reserve_in_usd);
    if (depth === null) {
      invalid = true;
      continue;
    }
    candidates.push({ address: attributes.address, quote, liquidity: depth });
  }
  candidates.sort(
    (a, b) =>
      b.liquidity - a.liquidity || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  );
  return candidates.length
    ? { status: 'ready', pool: candidates[0] }
    : { status: invalid ? 'unavailable' : 'empty' };
}
function parseCandles(
  value: unknown,
  mint: string,
  pool: Pool,
  range: TokenChartRange,
  now: number,
): TokenChartCandle[] {
  const root = object(value),
    data = object(root?.data),
    meta = object(root?.meta),
    attributes = object(data?.attributes);
  if (
    data?.type !== 'ohlcv_request_response' ||
    object(meta?.base)?.address !== mint ||
    object(meta?.quote)?.address !== pool.quote
  )
    throw new Error('OHLCV token identities do not match the selected pool.');
  const rows = attributes?.ohlcv_list;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('Invalid OHLCV list.');
  const end = Math.floor(now / 1000),
    start = end - RANGES[range].seconds;
  const unique = new Map<number, TokenChartCandle>();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 6 ||
      row.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v > Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid OHLCV row.');
    const [time, open, high, low, close, volume] = row as number[];
    if (
      !Number.isSafeInteger(time) ||
      time <= 0 ||
      time > end ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      low > high
    )
      throw new Error('Invalid OHLCV bounds or seconds.');
    if (time < start) continue;
    const next = { time, open, high, low, close, volume },
      prior = unique.get(time);
    if (prior && JSON.stringify(prior) !== JSON.stringify(next))
      throw new Error('Conflicting OHLCV timestamps.');
    unique.set(time, next);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

/** Display-only OHLCV, never a source of accounting or execution authority.
 * Official schema: https://api.geckoterminal.com/docs/v2/swagger.json
 * Public quota: https://apiguide.geckoterminal.com/faq (30/minute); this instance allows 25/minute.
 */
export class GeckoTerminalTokenChart {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maximumCacheEntries: number;
  private readonly cache = new Map<string, { expires: number; value: ChartValues }>();
  private readonly poolCache = new Map<string, { expires: number; value: PoolResult }>();
  private readonly pending = new Map<string, Promise<ChartValues>>();
  private readonly poolPending = new Map<string, Promise<PoolResult>>();
  private requestTimes: number[] = [];
  private cooldownUntil = 0;
  private active = 0;
  constructor(options: TokenChartOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maximumCacheEntries = options.maximumCacheEntries ?? 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 6000)
      throw new Error('Chart timeout must be 1–6000 milliseconds.');
    if (
      !Number.isSafeInteger(this.maximumCacheEntries) ||
      this.maximumCacheEntries < 1 ||
      this.maximumCacheEntries > 10000
    )
      throw new Error('Chart cache must hold 1–10000 entries.');
  }
  private remember<T>(
    cache: Map<string, { expires: number; value: T }>,
    key: string,
    value: T,
    ttl: number,
  ) {
    cache.delete(key);
    cache.set(key, { expires: this.now() + ttl, value });
    while (cache.size > this.maximumCacheEntries) cache.delete(cache.keys().next().value!);
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Chart request timed out.'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work(controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  private async body(response: Response, signal: AbortSignal): Promise<unknown> {
    if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Chart body is empty or oversized.');
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error('Chart body is oversized.');
        chunks.push(value);
      }
      signal.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  private async json(url: string, signal: AbortSignal, allowNotFound = false): Promise<unknown> {
    signal.throwIfAborted();
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((t) => t > now - 60000);
    if (this.active >= 3 || now < this.cooldownUntil || this.requestTimes.length >= 25)
      throw new Error('Chart provider quota is unavailable.');
    this.requestTimes.push(now);
    this.active++;
    try {
      const response = await this.request(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      signal.throwIfAborted();
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const wait = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(header ?? '') - this.now();
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          this.now() + Math.max(60000, Math.min(86400000, Number.isFinite(wait) ? wait : 60000)),
        );
      }
      if (allowNotFound && response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return { data: [] };
      }
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Chart provider unavailable.');
      }
      return await this.body(response, signal);
    } finally {
      this.active--;
    }
  }
  private async pool(mint: string): Promise<PoolResult> {
    const cached = this.poolCache.get(mint);
    if (cached && cached.expires > this.now()) return cached.value;
    if (cached) this.poolCache.delete(mint);
    const prior = this.poolPending.get(mint);
    if (prior) return prior;
    if (this.poolPending.size >= Math.min(32, this.maximumCacheEntries))
      return { status: 'unavailable' };
    const work = this.bounded(async (signal) =>
      selectPool(
        await this.json(
          `${ORIGIN}/networks/solana/tokens/${mint}/pools?include=base_token%2Cquote_token&page=1`,
          signal,
          true,
        ),
        mint,
      ),
    )
      .catch(() => ({ status: 'unavailable' }) as const)
      .then((value) => {
        this.remember(
          this.poolCache,
          mint,
          value,
          value.status === 'ready'
            ? POOL_CACHE_MS
            : value.status === 'empty'
              ? EMPTY_CACHE_MS
              : CACHE_MS,
        );
        return value;
      })
      .finally(() => this.poolPending.delete(mint));
    this.poolPending.set(mint, work);
    return work;
  }
  private empty(
    mint: string,
    range: TokenChartRange,
    status: TokenChartResult['status'] = 'unavailable',
    pool?: Pool,
  ): ChartValues {
    return {
      mint,
      range,
      currency: 'USD',
      provider: 'GeckoTerminal',
      status,
      updatedAt: status === 'empty' ? new Date(this.now()).toISOString() : null,
      poolAddress: pool?.address ?? null,
      sourceUrl: pool ? `https://www.geckoterminal.com/solana/pools/${pool.address}` : null,
      candles: [],
    };
  }
  private async chart(mint: string, range: TokenChartRange): Promise<ChartValues> {
    let selected: Pool | undefined;
    try {
      return await this.bounded(async (signal) => {
        const found = await this.pool(mint);
        signal.throwIfAborted();
        if (found.status !== 'ready') return this.empty(mint, range, found.status);
        selected = found.pool;
        const interval = RANGES[range];
        const end = Math.floor(this.now() / 1000);
        const query = new URLSearchParams({
          aggregate: String(interval.aggregate),
          before_timestamp: String(end + 1),
          limit: String(interval.limit),
          currency: 'usd',
          token: mint,
          include_empty_intervals: 'false',
        });
        const data = await this.json(
          `${ORIGIN}/networks/solana/pools/${selected.address}/ohlcv/${interval.timeframe}?${query}`,
          signal,
        );
        const candles = parseCandles(data, mint, selected, range, this.now());
        return {
          ...this.empty(mint, range, candles.length ? 'ready' : 'empty', selected),
          updatedAt: new Date(this.now()).toISOString(),
          candles,
        };
      });
    } catch {
      return this.empty(mint, range, 'unavailable', selected);
    }
  }
  async get(tokenId: string, mint: string, range: TokenChartRange): Promise<TokenChartResult> {
    if (
      typeof tokenId !== 'string' ||
      !tokenId ||
      tokenId.length > 200 ||
      !address(mint) ||
      !Object.hasOwn(RANGES, range)
    )
      return { ...this.empty(mint, range), tokenId };
    const key = `${mint}:${range}`;
    const cached = this.cache.get(key);
    let value: ChartValues;
    if (cached && cached.expires > this.now()) value = cached.value;
    else {
      if (cached) this.cache.delete(key);
      let work = this.pending.get(key);
      if (!work) {
        if (this.pending.size >= Math.min(32, this.maximumCacheEntries))
          return { ...this.empty(mint, range), tokenId };
        work = this.chart(mint, range)
          .then((result) => {
            this.remember(
              this.cache,
              key,
              result,
              result.status === 'empty' ? EMPTY_CACHE_MS : CACHE_MS,
            );
            return result;
          })
          .finally(() => this.pending.delete(key));
        this.pending.set(key, work);
      }
      value = await work;
    }
    return { ...value, tokenId, candles: value.candles.map((c) => ({ ...c })) };
  }
}
