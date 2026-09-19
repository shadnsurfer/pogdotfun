export type ChartRange = '24h' | '7d' | '30d';
export interface TokenPriceQuote {
  priceUsd?: number | null;
  marketDataStatus?: 'fresh' | 'stale' | 'warming' | 'unavailable';
  marketDataUpdatedAt?: string | null;
}

export function tokenChartQuote(quote: TokenPriceQuote): {
  price: number;
  updatedAt: string;
  stale: boolean;
} | null {
  if (
    typeof quote.priceUsd !== 'number' ||
    !Number.isFinite(quote.priceUsd) ||
    quote.priceUsd <= 0 ||
    !['fresh', 'stale'].includes(quote.marketDataStatus ?? '') ||
    typeof quote.marketDataUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(quote.marketDataUpdatedAt))
  )
    return null;
  return {
    price: quote.priceUsd,
    updatedAt: quote.marketDataUpdatedAt,
    stale: quote.marketDataStatus === 'stale',
  };
}

/** Disable saved settings so the provider opens the price chart, not market cap. */
export function tokenChartFallbackUrl(mint: string | undefined): string | null {
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  const query = new URLSearchParams({
    embed: '1',
    loadChartSettings: '0',
    trades: '0',
    tabs: '0',
    // Hiding pair info currently prevents the provider's embed from fetching the pair.
    info: '1',
    chartLeftToolbar: '0',
    chartDefaultOnMobile: '1',
    chartTheme: 'dark',
    theme: 'dark',
    chartStyle: '3',
    chartType: 'price',
    interval: '5',
  });
  return `https://dexscreener.com/solana/${mint}?${query}`;
}

export interface PriceCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface TokenChartData {
  tokenId: string;
  mint: string;
  range: ChartRange;
  currency: 'USD';
  provider: 'GeckoTerminal';
  status: 'ready' | 'empty' | 'unavailable';
  updatedAt: string | null;
  poolAddress: string | null;
  sourceUrl: string | null;
  candles: PriceCandle[];
}

/** Six significant digits preserve low-priced tokens without compact-dollar rounding. */
export function formatTokenPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  if (value > 0 && value < 1e-12) return `$${Number(value.toPrecision(6)).toExponential()}`;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value >= 1 || value === 0 ? 2 : 0,
    maximumSignificantDigits: 6,
    maximumFractionDigits: 20,
  })}`;
}

/** Reject inconsistent snapshots before passing data to the strict chart time scale. */
export function parseTokenChart(
  value: unknown,
  tokenId: string,
  range: ChartRange,
): TokenChartData {
  const invalid = (): never => {
    throw new Error('Price history could not be verified.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (
    data.tokenId !== tokenId ||
    data.range !== range ||
    data.currency !== 'USD' ||
    data.provider !== 'GeckoTerminal' ||
    typeof data.mint !== 'string' ||
    !data.mint ||
    !['ready', 'empty', 'unavailable'].includes(String(data.status)) ||
    !Array.isArray(data.candles) ||
    data.candles.length > 2000 ||
    !(
      data.updatedAt === null ||
      (typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt)))
    ) ||
    !(data.poolAddress === null || (typeof data.poolAddress === 'string' && !!data.poolAddress))
  )
    return invalid();
  if (data.sourceUrl !== null) {
    if (typeof data.sourceUrl !== 'string') return invalid();
    try {
      const url = new URL(data.sourceUrl);
      if (
        url.protocol !== 'https:' ||
        !['geckoterminal.com', 'www.geckoterminal.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        return invalid();
    } catch {
      return invalid();
    }
  }
  if ((data.status === 'ready') !== data.candles.length > 0) return invalid();
  let lastTime = 0;
  const candles: PriceCandle[] = data.candles.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const c = item as Record<string, unknown>;
    if (
      typeof c.time !== 'number' ||
      !Number.isSafeInteger(c.time) ||
      c.time <= lastTime ||
      !Number.isFinite(new Date(c.time * 1000).getTime()) ||
      !['open', 'high', 'low', 'close'].every(
        (key) => typeof c[key] === 'number' && Number.isFinite(c[key]) && c[key] > 0,
      ) ||
      typeof c.volume !== 'number' ||
      !Number.isFinite(c.volume) ||
      c.volume < 0
    )
      return invalid();
    const candle = c as unknown as PriceCandle;
    if (
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > candle.high
    )
      return invalid();
    lastTime = candle.time;
    return {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
  });
  return {
    tokenId,
    mint: data.mint,
    range,
    currency: 'USD',
    provider: 'GeckoTerminal',
    status: data.status as TokenChartData['status'],
    updatedAt: data.updatedAt as string | null,
    poolAddress: data.poolAddress as string | null,
    sourceUrl: data.sourceUrl as string | null,
    candles,
  };
}
