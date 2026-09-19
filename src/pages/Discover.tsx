import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useReducedMotionPreference } from '../use-reduced-motion-preference';
import { ArrowRight, ArrowUpRight, Heart, Search } from '../icons';
import {
  Avatar,
  BrandLogo,
  Empty,
  PageHeading,
  PlatformMark,
  SectionLink,
  TokenCard,
  TokenFilters,
} from '../components';
import { PreviewTiles } from '../preview-tiles';
import { TokenImage } from '../TokenImage';
import { TokenDonationProgress } from '../TokenDonationProgress';
import {
  useCatalog,
  refreshCatalog,
  filterTokens,
  getStreamer,
  getToken,
  giftMoney,
  overallGiftSpending,
  donationSummary,
  payments,
  sortTokens,
  streamerDonations,
  streamers,
  tokens,
  tokenDonations,
} from '../data';
import type { Sort } from '../data';
function PaymentBadge() {
  const [index, setIndex] = useState(0),
    [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  const reduce = useReducedMotionPreference();
  const paymentCount = payments.length;
  useEffect(() => {
    if (hovered || focused || reduce || !paymentCount) return;
    const timer = setInterval(
      () => setIndex((i) => ((Number.isSafeInteger(i) && i >= 0 ? i : 0) + 1) % paymentCount),
      6500,
    );
    return () => clearInterval(timer);
  }, [hovered, focused, reduce, paymentCount]);
  if (!paymentCount)
    return (
      <Link to="/flow" className="hero-payment">
        <Heart size={15} aria-hidden="true" />
        <span>Creator fees. Real support.</span>
      </Link>
    );
  const payment = payments[Number.isSafeInteger(index) && index >= 0 ? index % paymentCount : 0],
    streamer = getStreamer(getToken(payment.tokenId).streamerId);
  return (
    <Link
      to="/donations"
      className="hero-payment"
      aria-label="View completed donations"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={index}
          className="hero-payment-content"
          initial={reduce ? false : { opacity: 0, y: 7 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 1 } : { opacity: 0, y: -7 }}
          transition={{ duration: 0.28 }}
        >
          <Heart size={15} />
          <strong>{giftMoney(payment.amount)}</strong>
          <span>pog’d to</span>
          <Avatar streamer={streamer} />
          <b>{streamer.name}</b>
          <PlatformMark platform={streamer.platform} />
        </motion.span>
      </AnimatePresence>
    </Link>
  );
}
function TopStreamers() {
  return (
    <aside className="top-streamers">
      <div className="section-heading">
        <h2>Top streamers</h2>
      </div>
      <div className="streamer-list">
        {!streamers.length && <p className="catalog-empty">The first community is on its way.</p>}
        {[...streamers]
          .sort((a, b) => (streamerDonations(b.id) ?? -1) - (streamerDonations(a.id) ?? -1))
          .map((s) => (
            <Link to={`/streamer/${s.id}`} className="streamer-profile-card" key={s.id}>
              <div className="streamer-profile-top">
                <Avatar streamer={s} />
                <span>
                  <strong>{s.name}</strong>
                  <small>@{s.handle}</small>
                </span>
                <PlatformMark platform={s.platform} />
              </div>
              <div className="streamer-profile-stats">
                <span>
                  <strong>{tokens.filter((t) => t.streamerId === s.id).length}</strong>
                  <small>Tokens</small>
                </span>
                <span>
                  <strong>{giftMoney(streamerDonations(s.id), true)}</strong>
                  <small>Donations received</small>
                </span>
                <ArrowUpRight size={14} />
              </div>
            </Link>
          ))}
      </div>
    </aside>
  );
}
export function HomePage() {
  const catalog = useCatalog();
  const [pad, setPad] = useState('all'),
    [sort, setSort] = useState<Sort>('mcap');
  return (
    <div className="home-page">
      {catalog.error && tokens.length > 0 && <CatalogRefreshNotice />}
      <section className="home-intro">
        <img
          className="hero-coin hero-coin-fees"
          src="/assets/brand/fee-coin.png"
          alt=""
          aria-hidden="true"
        />
        <img
          className="hero-coin hero-coin-channel"
          src="/assets/brand/channel-coin.png"
          alt=""
          aria-hidden="true"
        />
        <PaymentBadge />
        <h1>
          Launch a token.
          <br /> Back the stream.
        </h1>
        <p>
          Turn creator fees into donations on{' '}
          <span className="inline-platform">
            <BrandLogo brand="twitch" />
            <span>Twitch</span>
          </span>
          <span className="inline-platform">
            <BrandLogo brand="kick" />
            and Kick.
          </span>
          <span className="hero-chain-note">
            Built for multichain. Solana live now, more chains coming soon.
          </span>
        </p>
        <div className="hero-actions">
          <Link to="/launch" className="btn btn-primary">
            Launch a token
          </Link>
          <Link to="/docs" className="btn btn-secondary">
            How it works
          </Link>
        </div>
        <p className="hero-support-note">
          Gifted subs start around $50. Funds wait until the streamer is live.
        </p>
      </section>
      <PreviewTiles />
      <TokenDonationProgress limit={4} />
      <section className="home-directory">
        <div className="home-bottom-grid">
          <div className="tokens-section">
            <div className="section-heading">
              <h2>Top tokens</h2>
              <SectionLink to="/explore">View all</SectionLink>
            </div>
            <TokenFilters pad={pad} setPad={setPad} sort={sort} setSort={setSort} />
            {!tokens.length && <CatalogEmpty loading={catalog.loading} error={catalog.error} />}
            <div className="token-grid home-token-grid">
              {sortTokens(filterTokens(tokens, '', pad), sort)
                .slice(0, 6)
                .map((token, index) => (
                  <TokenCard token={token} key={token.id} index={index} />
                ))}
            </div>
          </div>
          <TopStreamers />
        </div>
      </section>
      <section className="home-recent">
        <div className="section-heading">
          <h2>Recent donations</h2>
          <SectionLink to="/donations">View ledger</SectionLink>
        </div>
        <div className="home-payment-list">
          {!payments.length && (
            <p className="catalog-empty">
              {overallGiftSpending > 0 || (donationSummary?.completedGiftCount ?? 0) > 0 ? (
                <>
                  Confirmed gifts are available in the donation history.{' '}
                  <Link to="/donations">View confirmed gifts</Link>
                </>
              ) : (
                'Completed donations will appear here with their receipts.'
              )}
            </p>
          )}
          {payments.slice(0, 4).map((payment) => {
            const token = getToken(payment.tokenId),
              streamer = getStreamer(token.streamerId);
            return (
              <Link to={`/streamer/${streamer.id}`} key={payment.id} className="home-payment-row">
                <div>
                  <strong>{giftMoney(payment.amount)}</strong>
                  <p>
                    pog’d to <b>{streamer.name}</b>
                  </p>
                </div>
                <div className="payment-identities">
                  <TokenImage src={token.image} alt={token.name} />
                  <ArrowRight size={15} />
                  <Avatar streamer={streamer} />
                  <PlatformMark platform={streamer.platform} />
                </div>
                <span className="payment-age">{payment.age}</span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
export function ExplorePage() {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams(),
    [pad, setPad] = useState('all'),
    [sort, setSort] = useState<Sort>('mcap');
  const query = params.get('q') ?? '',
    shown = sortTokens(filterTokens(tokens, query, pad), sort);
  return (
    <div className="page explore-page">
      {catalog.error && tokens.length > 0 && <CatalogRefreshNotice />}
      <PageHeading
        title="Explore tokens"
        description="Community tokens that support streamers. Live on Solana today, with more chains coming soon."
        action={
          <Link className="btn btn-primary" to="/launch">
            Launch a token
          </Link>
        }
      />
      {tokens.length > 0 && (
        <section className="trending-section" aria-label="Community tokens">
          <div className="section-heading">
            <h2>Community spotlight</h2>
            <a className="text-link" href="#all-tokens">
              View all
            </a>
          </div>
          <div className="trending-strip">
            {sortTokens(tokens, 'donations')
              .slice(0, 4)
              .map((token) => (
                <Link className="trending-token" key={token.id} to={`/token/${token.id}`}>
                  <TokenImage src={token.image} alt="" />
                  <div>
                    <strong>{token.name}</strong>
                    <small>{token.symbol}</small>
                  </div>
                  <span>
                    <small>Gifts sent</small>
                    <strong>{giftMoney(tokenDonations(token.id), true)}</strong>
                  </span>
                </Link>
              ))}
          </div>
        </section>
      )}
      <section className="explore-directory" id="all-tokens">
        <div className="section-heading">
          <h2>All tokens</h2>
          <span className="results-count" role="status" aria-live="polite">
            Showing {shown.length} of {shown.length}
            {shown.length !== tokens.length ? ` · ${tokens.length} total` : ''}
          </span>
        </div>
        <div className="explore-controls">
          <TokenFilters pad={pad} setPad={setPad} sort={sort} setSort={setSort} />
          <label className="explore-search">
            <Search size={18} />
            <input
              aria-label="Search tokens"
              placeholder="Name or contract address"
              value={query}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('q', e.target.value);
                else next.delete('q');
                setParams(next, { replace: true });
              }}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setParams({}, { replace: true })}>
                ×
              </button>
            )}
          </label>
        </div>
        {!tokens.length ? (
          <CatalogEmpty loading={catalog.loading} error={catalog.error} />
        ) : shown.length ? (
          <div className="token-grid explore-token-grid" id="explore-token-results">
            {shown.map((token, index) => (
              <TokenCard token={token} key={token.id} index={index} />
            ))}
          </div>
        ) : (
          <Empty title="No tokens found">
            <p>Try another name, contract address, or launchpad.</p>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setParams({});
                setPad('all');
              }}
            >
              Reset filters
            </button>
          </Empty>
        )}
      </section>
    </div>
  );
}

function CatalogRefreshNotice() {
  return (
    <div className="catalog-refresh-notice" role="status">
      <p>Live refresh unavailable. Showing the last confirmed catalog and totals.</p>
      <button className="text-link" onClick={() => void refreshCatalog()}>
        Try again
      </button>
    </div>
  );
}

function CatalogEmpty({ loading, error }: { loading: boolean; error: string }) {
  return (
    <Empty
      title={
        loading
          ? 'Loading the community…'
          : error
            ? 'Catalog unavailable'
            : 'The first token starts here.'
      }
    >
      <p>
        {error ||
          (loading
            ? 'Getting the latest confirmed launches.'
            : 'Confirmed launches will appear here. Make yours the first.')}
      </p>
      {error ? (
        <button className="btn btn-secondary" onClick={() => void refreshCatalog()}>
          Try again
        </button>
      ) : (
        !loading && (
          <Link className="btn btn-primary" to="/launch">
            Launch a token
          </Link>
        )
      )}
    </Empty>
  );
}
