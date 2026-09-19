import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AreaSeries, ColorType, CrosshairMode, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import {
  formatTokenPrice,
  parseTokenChart,
  tokenChartFallbackUrl,
  tokenChartQuote,
} from './token-price-chart-data';
import type {
  ChartRange,
  PriceCandle,
  TokenChartData,
  TokenPriceQuote,
} from './token-price-chart-data';
import { displayMoney, wholePercent } from './data';
import './token-price-chart.css';

const ranges: ChartRange[] = ['24h', '7d', '30d'];
const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

interface TokenPriceChartProps {
  tokenId: string;
  symbol: string;
  mint?: string;
  quote?: TokenPriceQuote;
}

export function TokenPriceChart({ tokenId, symbol, mint, quote }: TokenPriceChartProps) {
  const [range, setRange] = useState<ChartRange>('24h');
  const focusRange = useRef<string | null>(null);
  // A new identity gets a fresh view immediately, before effects or a response can arrive.
  return (
    <PriceChartView
      key={`${tokenId}:${mint ?? ''}:${range}`}
      tokenId={tokenId}
      symbol={symbol}
      mint={mint}
      quote={quote}
      range={range}
      focusRange={focusRange}
      onRange={(next) => {
        if (next === range) return;
        focusRange.current = `${tokenId}:${next}`;
        setRange(next);
      }}
    />
  );
}

function PriceChartView({
  tokenId,
  symbol,
  range,
  onRange,
  focusRange,
  mint,
  quote,
}: TokenPriceChartProps & {
  range: ChartRange;
  onRange: (range: ChartRange) => void;
  focusRange: RefObject<string | null>;
}) {
  const labelId = useId();
  const helpId = useId();
  const host = useRef<HTMLDivElement>(null);
  const selectedRange = useRef<HTMLButtonElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const candlesRef = useRef(new Map<number, PriceCandle>());
  const fitted = useRef(false);
  const [data, setData] = useState<TokenChartData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'unavailable'>('loading');
  const [hovered, setHovered] = useState<PriceCandle | null>(null);
  const [retry, setRetry] = useState(0);
  const marketQuote = tokenChartQuote(quote ?? {});
  const fallbackUrl =
    state === 'empty' || state === 'unavailable' ? tokenChartFallbackUrl(mint) : null;

  useLayoutEffect(() => {
    // The keyed view deliberately clears old data; restore only user-selected
    // range focus, never initial page focus or focus during background refresh.
    if (focusRange.current === `${tokenId}:${range}`)
      selectedRange.current?.focus({ preventScroll: true });
    focusRange.current = null;
  }, [tokenId, range, focusRange]);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#16161a' },
        textColor: '#898991',
        fontFamily: 'Nunito, sans-serif',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: '#ffffff08' } },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.15, bottom: 0.12 },
        minimumWidth: 82,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        minBarSpacing: 0.5,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#89899166', labelBackgroundColor: '#303035' },
        horzLine: { color: '#89899166', labelBackgroundColor: '#303035' },
      },
      localization: {
        locale: 'en-US',
        priceFormatter: formatTokenPrice,
        timeFormatter: (time: number) => `${dateTime.format(new Date(time * 1000))} UTC`,
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#53fc18',
      topColor: '#53fc181c',
      bottomColor: '#53fc1800',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#16161a',
      crosshairMarkerBackgroundColor: '#53fc18',
    });
    chartRef.current = chart;
    seriesRef.current = series;
    chart.subscribeCrosshairMove((event) => {
      if (!event.point || event.point.x < 0 || event.point.y < 0 || typeof event.time !== 'number')
        setHovered(null);
      else setHovered(candlesRef.current.get(event.time) ?? null);
    });
    return () => {
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let current: AbortController | undefined;
    let busy = false;
    let refreshEvery = 60_000;
    let timer: number | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const refresh = async () => {
      if (disposed || busy || !visible()) return;
      window.clearTimeout(timer);
      busy = true;
      current = new AbortController();
      const controller = current;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(
          `/api/tokens/${encodeURIComponent(tokenId)}/chart?range=${range}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (!response.ok) throw new Error('Chart unavailable');
        const value = await response.text();
        if (value.length > 1_000_000) throw new Error('Chart response too large');
        const parsed = parseTokenChart(JSON.parse(value), tokenId, range);
        if (disposed) return;
        // New pools can appear shortly after launch; missing history should recover promptly.
        refreshEvery = parsed.status === 'empty' ? 15_000 : 60_000;
        setData(parsed);
        setState(parsed.status);
      } catch {
        if (!disposed) {
          refreshEvery = 60_000;
          setData(null);
          setState('unavailable');
        }
      } finally {
        window.clearTimeout(timeout);
        busy = false;
        // Count from completion so a slow initial lookup cannot land just before cache expiry.
        if (!disposed && visible()) timer = window.setTimeout(() => void refresh(), refreshEvery);
      }
    };
    void refresh();
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      current?.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tokenId, range, retry]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const candles = data?.status === 'ready' ? data.candles : [];
    candlesRef.current = new Map(candles.map((c) => [c.time, c]));
    setHovered(null);
    if (candles.length) {
      const minimum = Math.min(...candles.map((c) => c.close));
      const base = 10 ** Math.min(100, Math.max(2, 5 - Math.floor(Math.log10(minimum))));
      series.applyOptions({
        pointMarkersVisible: candles.length === 1,
        pointMarkersRadius: 3,
        priceFormat: { type: 'custom', formatter: formatTokenPrice, minMove: 1 / base, base },
      });
    }
    series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    if (candles.length && !fitted.current) {
      chartRef.current?.timeScale().fitContent();
      fitted.current = true;
    }
    if (!candles.length) fitted.current = false;
  }, [data]);

  const current = state === 'ready' ? (hovered ?? data?.candles.at(-1)) : null;
  const first = data?.candles[0]?.close;
  const latest = data?.candles.at(-1)?.close;
  const change = first && latest ? (latest / first - 1) * 100 : null;
  const move = (direction: number) => {
    const scale = chartRef.current?.timeScale();
    const visible = scale?.getVisibleLogicalRange();
    if (scale && visible) {
      const offset = (visible.to - visible.from) * 0.2 * direction;
      scale.setVisibleLogicalRange({ from: visible.from + offset, to: visible.to + offset });
    }
  };
  const zoom = (factor: number) => {
    const scale = chartRef.current?.timeScale();
    const visible = scale?.getVisibleLogicalRange();
    if (scale && visible) {
      const center = (visible.from + visible.to) / 2;
      const half = Math.max(1, ((visible.to - visible.from) * factor) / 2);
      scale.setVisibleLogicalRange({ from: center - half, to: center + half });
    }
  };
  function retryNow() {
    setData(null);
    setHovered(null);
    setState('loading');
    setRetry((value) => value + 1);
  }

  return (
    <section className="token-price-chart" aria-labelledby={labelId}>
      <div className="tpc-heading">
        <div>
          <h2 id={labelId}>
            Price <span>{symbol} / USD</span>
          </h2>
          <div className="tpc-price-row">
            <strong>{formatTokenPrice(current?.close ?? marketQuote?.price)}</strong>
            {state === 'ready' && change !== null && Number.isFinite(change) && (
              <span className={change < 0 ? 'tpc-change tpc-negative' : 'tpc-change'}>
                {wholePercent(change, true)} <small>{range}</small>
              </span>
            )}
          </div>
        </div>
        {!fallbackUrl && (
          <div className="tpc-ranges" role="group" aria-label="Price chart time range">
            {ranges.map((value) => (
              <button
                key={value}
                ref={range === value ? selectedRange : undefined}
                type="button"
                aria-pressed={range === value}
                onClick={() => onRange(value)}
              >
                {value}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tpc-readout" aria-live="off">
        {current ? (
          <>
            <time dateTime={new Date(current.time * 1000).toISOString()}>
              {dateTime.format(new Date(current.time * 1000))} UTC
            </time>
            <span>Interval volume {displayMoney(current.volume, true)}</span>
          </>
        ) : marketQuote ? (
          <>
            <span>{marketQuote.stale ? 'Last known price' : 'Latest price'} · DEX Screener</span>
            <time dateTime={marketQuote.updatedAt}>
              {dateTime.format(new Date(marketQuote.updatedAt))} UTC
            </time>
          </>
        ) : (
          <span>Token price in US dollars</span>
        )}
      </div>
      <div
        className={`tpc-plot-wrap${fallbackUrl ? ' tpc-plot-fallback' : ''}`}
        aria-busy={state === 'loading'}
      >
        <div
          ref={host}
          className={`tpc-plot${state !== 'ready' ? ' tpc-plot-hidden' : ''}`}
          tabIndex={state === 'ready' ? 0 : -1}
          role="img"
          aria-label={`${symbol} price history over ${range}`}
          aria-describedby={helpId}
          onKeyDown={(event) => {
            if (state !== 'ready') return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              move(event.key === 'ArrowLeft' ? -1 : 1);
            }
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              zoom(0.7);
            }
            if (event.key === '-') {
              event.preventDefault();
              zoom(1.4);
            }
            if (event.key === 'Home') {
              event.preventDefault();
              chartRef.current?.timeScale().fitContent();
            }
          }}
        />
        {fallbackUrl && (
          <iframe
            key={mint}
            className="tpc-embed"
            title={`${symbol} live USD price chart from DEX Screener`}
            src={fallbackUrl}
            referrerPolicy="no-referrer"
            allow="fullscreen"
          />
        )}
        {state !== 'ready' && !fallbackUrl && (
          <div className="tpc-state" role="status">
            <span className="tpc-state-symbol" aria-hidden="true">
              {state === 'loading' ? '···' : '—'}
            </span>
            <strong>
              {state === 'loading'
                ? 'Loading price history'
                : state === 'empty'
                  ? 'No indexed price history yet'
                  : 'Price history is unavailable'}
            </strong>
            <p>
              {state === 'empty'
                ? 'The chart will appear when GeckoTerminal indexes trading for this token.'
                : state === 'unavailable'
                  ? 'Price data could not be loaded. Try again in a moment.'
                  : 'Fetching trading data from GeckoTerminal.'}
            </p>
            {state !== 'loading' && (
              <button type="button" onClick={retryNow}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      {fallbackUrl ? (
        <div className="tpc-source">
          <span>Live price history · DEX Screener</span>
          <a href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer">
            Open chart ↗
          </a>
        </div>
      ) : (
        <>
          <div className="tpc-footer">
            <p id={helpId}>
              Drag to pan · Scroll to zoom{' '}
              <span className="tpc-keyboard-help">· Arrow keys pan, +/− zoom, Home resets</span>
            </p>
            <button
              type="button"
              disabled={state !== 'ready'}
              onClick={() => chartRef.current?.timeScale().fitContent()}
            >
              Reset view
            </button>
          </div>
          <div className="tpc-source">
            <span>
              {data?.sourceUrl ? (
                <a href={data.sourceUrl} target="_blank" rel="noreferrer">
                  Data from GeckoTerminal ↗
                </a>
              ) : (
                'Data from GeckoTerminal'
              )}
              {data?.updatedAt && <> · Updated {dateTime.format(new Date(data.updatedAt))} UTC</>}
            </span>
            <span>
              TradingView Lightweight Charts™
              <br />
              Copyright (с) 2025{' '}
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
                TradingView, Inc.
              </a>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
