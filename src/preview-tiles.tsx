import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, Heart, Search } from './icons';
import { Avatar, Brand, BrandLogo, PlatformMark, marketDataLabel } from './components';
import { TokenImage } from './TokenImage';
import {
  getStreamer,
  useCatalog,
  money,
  decimalMoney,
  streamers,
  tokens,
  overallGiftSpending,
  treasury,
} from './data';
import type { Token } from './data';
import { useReducedMotionPreference } from './use-reduced-motion-preference';
import './preview-tiles.css';

const previewEase = [0.22, 1, 0.36, 1] as const;
type PreviewMotion = { reduced: boolean; paused: boolean };

function TileFooter({ title, detail = 'Open' }: { title: string; detail?: string }) {
  return (
    <div className="preview-footer">
      <span>{title}</span>
      <span>
        {detail}
        <ArrowRight size={14} />
      </span>
    </div>
  );
}
function MiniToken({ token }: { token: Token }) {
  const streamer = getStreamer(token.streamerId);
  return (
    <div className="mini-token">
      <div className="mini-token-art">
        <TokenImage src={token.image} alt="" />
        <span>
          <Avatar streamer={streamer} />
          {streamer.name}
        </span>
      </div>
      <div className="mini-token-info">
        <strong>{token.name}</strong>
        <span title={marketDataLabel(token)}>
          {money(token.mcap, true)} <small>MC</small>
        </span>
      </div>
    </div>
  );
}
function TokenPreview() {
  if (!tokens.length)
    return (
      <Link to="/explore" className="preview-tile preview-explore">
        <div className="preview-first-token">
          <img src="/assets/brand/fee-coin.png" alt="" />
          <strong>
            Start something
            <br />
            worth supporting.
          </strong>
        </div>
        <TileFooter title="Explore" />
      </Link>
    );
  const reels = Array.from({ length: 3 }, (_, column) =>
    Array.from({ length: 3 }, (_, row) => tokens[(column + row * 3) % tokens.length]),
  );
  return (
    <Link
      to="/explore"
      className="preview-tile preview-explore"
      aria-label="Explore community tokens"
    >
      <div className="token-wall" aria-hidden="true">
        {reels.map((reel, i) => (
          <div className={`token-wall-column column-${i}`} key={i}>
            <div className="token-wall-run">
              {[0, 1].map((copy) => (
                <div className="token-wall-group" key={copy}>
                  {reel.map((token, j) => (
                    <MiniToken token={token} key={`${token.id}-${j}`} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TileFooter title="Explore" />
    </Link>
  );
}
function StreamPreview({ reduced }: Pick<PreviewMotion, 'reduced'>) {
  return (
    <Link
      to="/explore"
      className="preview-tile preview-stream"
      aria-label="Discover streamer communities"
    >
      <img
        className="preview-stream-scene"
        src="/assets/scene/streaming.jpg"
        alt="A violet-lit streaming setup"
      />
      <div className="preview-stream-top">
        <span>
          <BrandLogo brand="twitch" />
          Made for the stream
        </span>
        <span className="public-platform-soon">
          <BrandLogo brand="kick" /> <small>Coming soon</small>
        </span>
      </div>
      <motion.div
        className="stream-payment"
        initial={reduced ? false : { opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: reduced ? 0 : 0.56, delay: reduced ? 0 : 0.12, ease: previewEase }}
      >
        <BrandLogo brand="twitch" />
        <div>
          <strong>For your stream.</strong>
          <span>Backed by your community</span>
        </div>
        <span className="payment-heart">
          <Heart size={21} weight="fill" />
        </span>
      </motion.div>
      <TileFooter title="Streamers" />
    </Link>
  );
}
function RollingAmount({ amount, reduced }: { amount: number; reduced: boolean }) {
  const str = decimalMoney(amount);
  return (
    <span className="rolling-amount" role="img" aria-label={str}>
      {str.split('').map((char, i) =>
        /\d/.test(char) && !reduced ? (
          <span className="rolling-digit" aria-hidden="true" key={i}>
            <motion.span
              initial={{ y: '0em' }}
              whileInView={{ y: `-${Number(char)}em` }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: Math.min(i * 0.02, 0.12), ease: previewEase }}
            >
              {Array.from({ length: 10 }, (_, n) => (
                <span key={n}>{n}</span>
              ))}
            </motion.span>
          </span>
        ) : (
          <span aria-hidden="true" key={i}>
            {char}
          </span>
        ),
      )}
    </span>
  );
}
function StatsPreview({ reduced }: Pick<PreviewMotion, 'reduced'>) {
  const catalog = useCatalog();
  return (
    <Link
      to="/donations"
      className="preview-tile preview-stats"
      aria-label={
        catalog.loading || catalog.error
          ? 'View donations and treasury'
          : `View donations: ${decimalMoney(overallGiftSpending)} in confirmed gifts; ${money(treasury.held)} in treasury`
      }
    >
      <div className="preview-stats-body">
        <div className="preview-stat-label">
          <span>Confirmed gifts</span>
          <small>{catalog.loading ? 'Loading' : catalog.error ? 'Unavailable' : 'Confirmed'}</small>
        </div>
        {catalog.loading || catalog.error ? (
          <strong className="rolling-amount">—</strong>
        ) : (
          <RollingAmount amount={overallGiftSpending} reduced={reduced} />
        )}
        <div className="preview-confirmed-note">
          <Heart size={24} />
          <span>
            Receipt and payment verified.
            <br />
            Real support for streamers.
          </span>
        </div>
        <div className="preview-treasury">
          <span>In treasury</span>
          <strong>{catalog.loading || catalog.error ? '—' : money(treasury.held)}</strong>
        </div>
      </div>
      <TileFooter title="Donations" />
    </Link>
  );
}
function LaunchPreview({ reduced, paused }: PreviewMotion) {
  const availableStreamers = streamers
    .filter((streamer) => streamer.platform === 'twitch')
    .slice(0, 2);
  const recipientCount = Math.max(availableStreamers.length, 1);
  const [selected, setSelected] = useState(0);
  const selectedIndex = selected % recipientCount;
  useEffect(() => {
    if (paused || recipientCount < 2) return;
    const timer = setInterval(() => setSelected((i) => (i + 1) % recipientCount), 3500);
    return () => clearInterval(timer);
  }, [paused, recipientCount]);
  return (
    <Link
      to="/launch"
      className="preview-tile preview-launch"
      aria-label="Launch a token for a Twitch streamer"
    >
      <div className="preview-launch-label">Pick your streamer</div>
      <div className="preview-search">
        <Search size={15} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={availableStreamers[selectedIndex]?.id ?? 'empty'}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.46, ease: previewEase }}
          >
            {availableStreamers.length
              ? '@' + availableStreamers[selectedIndex].handle
              : 'Your Twitch streamer'}
          </motion.span>
        </AnimatePresence>
        <span className="preview-cursor" />
      </div>
      <div className="preview-recipients">
        {!availableStreamers.length && (
          <div className="preview-recipient">
            <BrandLogo brand="twitch" />
            <span>
              <strong>Twitch</strong>
              <small>Choose a real channel</small>
            </span>
          </div>
        )}
        {availableStreamers.map((s, i) => (
          <div className={`preview-recipient ${selectedIndex === i ? 'selected' : ''}`} key={s.id}>
            {selectedIndex === i && (
              <motion.span
                className="preview-selection"
                layoutId="preview-selection"
                transition={{ duration: reduced ? 0 : 0.56, ease: previewEase }}
              />
            )}
            <Avatar streamer={s} />
            <span>
              <strong>{s.name}</strong>
              <small>@{s.handle}</small>
            </span>
            <PlatformMark platform={s.platform} />
            {selectedIndex === i && <Check size={13} />}
          </div>
        ))}
        <div className="preview-recipient public-platform-soon">
          <BrandLogo brand="kick" />
          <span>
            <strong>Kick</strong>
            <small>Coming soon</small>
          </span>
        </div>
      </div>
      <TileFooter title="Launch" />
    </Link>
  );
}
function FlowPreview({ reduced, paused }: PreviewMotion) {
  const lines = useRef<HTMLDivElement>(null);
  const animation = useRef<SVGSVGElement>(null);
  const [lineWidth, setLineWidth] = useState(85);
  useEffect(() => {
    const element = lines.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setLineWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const svg = animation.current;
    if (!svg) return;
    if (paused) svg.pauseAnimations();
    else svg.unpauseAnimations();
  }, [paused]);
  const branch = lineWidth * 0.48;
  const radius = Math.min(12, branch / 2);
  const upper = `M0 52H${branch - radius}Q${branch} 52 ${branch} ${52 - radius}V${20 + radius}Q${branch} 20 ${branch + radius} 20H${lineWidth}`;
  const lower = `M0 52H${branch - radius}Q${branch} 52 ${branch} ${52 + radius}V${84 - radius}Q${branch} 84 ${branch + radius} 84H${lineWidth}`;
  return (
    <Link
      to="/flow"
      className="preview-tile preview-flow"
      aria-label="See how creator fees are routed: 80 percent for streamers and 20 percent for POG buybacks"
    >
      <div className="preview-flow-label">Every fee, accounted for</div>
      <div className="preview-route" aria-hidden="true">
        <div className="preview-route-source">
          <Brand small />
        </div>
        <div className="preview-route-lines" ref={lines}>
          <svg ref={animation} viewBox={`0 0 ${lineWidth} 104`}>
            <path
              d={upper}
              fill="none"
              stroke="var(--pog-ultra)"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={lower}
              fill="none"
              stroke="var(--pog-volt)"
              vectorEffect="non-scaling-stroke"
            />
            {!reduced && (
              <circle r="3" fill="var(--pog-volt)">
                <animateMotion dur="4s" repeatCount="indefinite" path={upper} />
              </circle>
            )}
          </svg>
        </div>
        <div className="preview-route-ends">
          <div>
            <span className="preview-route-icon">
              <BrandLogo brand="twitch" />
            </span>
            <span>
              <strong>80%</strong>
              <small>Streamer support</small>
            </span>
          </div>
          <div>
            <span className="preview-route-icon preview-route-icon-pog">
              <Brand small />
            </span>
            <span>
              <strong>20%</strong>
              <small>Platform reserve</small>
            </span>
          </div>
        </div>
      </div>
      <TileFooter title="Capital flow" />
    </Link>
  );
}
export function PreviewTiles() {
  useCatalog();
  const reduced = useReducedMotionPreference();
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const updateVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);
  const paused = reduced || userPaused || hovered || focused || hidden;
  return (
    <div className="preview-showcase">
      <div className="preview-motion-tools">
        <button
          type="button"
          className="preview-motion-toggle"
          aria-pressed={userPaused}
          disabled={reduced}
          onClick={() => setUserPaused((value) => !value)}
        >
          {reduced ? 'Motion reduced' : userPaused ? 'Resume animations' : 'Pause animations'}
        </button>
      </div>
      <section
        className="preview-grid"
        aria-label="Explore pog"
        data-motion-paused={paused}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <TokenPreview />
        <StreamPreview reduced={reduced} />
        <StatsPreview reduced={reduced} />
        <LaunchPreview reduced={reduced} paused={paused} />
        <FlowPreview reduced={reduced} paused={paused} />
      </section>
    </div>
  );
}
