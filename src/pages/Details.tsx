import { useCatalog } from '../data';
import { fundingWaitMessage } from '../funding-status';
import { UnclaimedFees } from '../UnclaimedFees';
import { TokenPriceChart } from '../TokenPriceChart';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Heart,
  ReceiptText,
  Flame,
  ChevronRight,
} from '../icons';
import {
  Avatar,
  BrandLogo,
  Empty,
  Modal,
  PadBadge,
  PageHeading,
  PlatformMark,
  Status,
  TokenArt,
  marketDataLabel,
  TokenCard,
} from '../components';
import {
  comingSoonTokens,
  eventAmount,
  metricMoney,
  activitySummary,
  payoutProgressLabel,
  ledger,
  money,
  giftMoney,
  streamerDonations,
  streamers,
  tokens,
  wholePercent,
} from '../data';
import type { LedgerEvent } from '../data';

const sourceProps = { target: '_blank', rel: 'noreferrer' } as const;
export function DocsPage() {
  return (
    <div className="page">
      <PageHeading
        eyebrow="POG · pog.fun"
        title="Autonomous streamer support"
        description="Creator fees fund verified Twitch and Kick gifts."
      />
      <section className="card">
        <h2>From token fees to a gift</h2>
        <p>
          Pump.fun on Solana, Flap on BNB, and PONs on Robinhood Chain have dedicated execution
          adapters. Fee claims are verified on chain, attributed to their token, and sent through a
          supported Coinbase deposit route for conversion to USD.
        </p>
        <p>
          Browserbase workers use an authenticated platform account and the Coinbase One credit card
          to purchase gifts while the selected streamer is live. Exchange proceeds and card capacity
          are reconciled separately.
        </p>
        <h2>Automatic, with limits</h2>
        <p>
          Encrypted worker credentials, pinned destinations, durable transaction identities,
          spending caps, exclusive browser leases, and independent purchase evidence protect every
          stage. Uncertain outcomes remain reserved. There is no operator dashboard or manual
          payment override.
        </p>
        <h2>Integration readiness</h2>
        <p>
          Provider credentials, supported deposit networks, card evidence, verified checkout
          contracts, and mainnet acceptance are required before activation. Source adapters do not
          imply that accounts or routes are already enabled.
        </p>
        <a href="https://pog.fun">pog.fun</a>
      </section>
    </div>
  );
}

function NotFound({ kind }: { kind: 'token' | 'streamer' }) {
  return (
    <div className="page">
      <PageHeading
        title={`We couldn't find that ${kind}.`}
        description="This profile is not in the confirmed catalog."
      />
      <Empty title="Nothing here just yet.">
        <p>Choose a token to find its community and recipient.</p>
        <Link className="btn btn-primary" to="/explore">
          Explore tokens
          <ArrowUpRight size={16} />
        </Link>
      </Empty>
    </div>
  );
}

function ActivityTable({
  events,
  showToken = false,
}: {
  events: LedgerEvent[];
  showToken?: boolean;
}) {
  const [kind, setKind] = useState('all');
  const [receipt, setReceipt] = useState<LedgerEvent | null>(null);
  const kinds = [...new Set(events.map((event) => event.kind))];
  const shown = events.filter((event) => kind === 'all' || event.kind === kind);
  const receiptToken = receipt ? tokens.find((token) => token.id === receipt.tokenId) : undefined;
  return (
    <>
      <div className="detail-activity-controls">
        <span className="muted">
          {shown.length} recent {shown.length === 1 ? 'record' : 'records'} · USD unless token units
          shown
        </span>
        {kinds.length > 1 && (
          <label className="sort-select">
            <span className="sr-only">Filter activity type</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">All activity</option>
              {kinds.map((item) => (
                <option key={item} value={item}>
                  {item === 'Donation' ? 'Donations' : item}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {activitySummary.truncated && (
        <p className="notice">
          This view filters the latest {activitySummary.returnedCount} platform records. Financial
          totals and payment counts include the full history.
        </p>
      )}
      {shown.length ? (
        <div className="table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Activity</th>
                {showToken && <th scope="col">Token</th>}
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Date (UTC)</th>
                <th scope="col">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((event) => {
                const token = tokens.find((item) => item.id === event.tokenId);
                return (
                  <tr key={event.id}>
                    <td>
                      <span className="detail-event-kind">
                        {event.kind === 'Donation' ? (
                          <Heart size={14} />
                        ) : (
                          <ReceiptText size={14} />
                        )}{' '}
                        {event.kind}
                      </span>
                    </td>
                    {showToken && (
                      <td>{token && <Link to={`/token/${token.id}`}>${token.symbol}</Link>}</td>
                    )}
                    <td>
                      {eventAmount(event)}
                      {event.amountMeaning === 'budget' && <small> · budget before costs</small>}
                    </td>
                    <td>
                      <Status status={event.status} />
                    </td>
                    <td>
                      <time dateTime={event.date}>
                        {new Date(event.date).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </time>
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => setReceipt(event)}
                        aria-label={`View receipt ${event.reference}`}
                      >
                        View
                        <ArrowUpRight size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No activity in this view.">
          <p>Try another activity type.</p>
        </Empty>
      )}
      {receipt && (
        <Modal title="Activity receipt" onClose={() => setReceipt(null)}>
          <div className="detail-receipt-total">
            <span>Recorded {receipt.kind.toLowerCase()}</span>
            <strong>{eventAmount(receipt)}</strong>
          </div>
          <dl className="detail-receipt-fields">
            <div>
              <dt>Token</dt>
              <dd>{receiptToken?.name ?? receipt.tokenName ?? receipt.tokenId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Status status={receipt.status} />
              </dd>
            </div>
            <div>
              <dt>Recorded at</dt>
              <dd>
                {new Date(receipt.date).toLocaleString('en-US', {
                  timeZone: 'UTC',
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}{' '}
                UTC
              </dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>{receipt.reference}</dd>
            </div>
          </dl>
          <p>
            This entry is recorded in the platform ledger. Follow the attached evidence for its
            on-chain transaction or payment confirmation.
          </p>
          {receipt.transactionUrl && (
            <a className="text-link" href={receipt.transactionUrl} {...sourceProps}>
              On-chain transaction
            </a>
          )}
          {receipt.confirmationUrl && (
            <a className="text-link" href={receipt.confirmationUrl} {...sourceProps}>
              Payment confirmation
            </a>
          )}
          <Link className="btn btn-secondary" to="/docs#transparency">
            How receipts work
            <ArrowUpRight size={15} />
          </Link>
        </Modal>
      )}
    </>
  );
}

export function TokenPage() {
  const catalog = useCatalog();
  const { id } = useParams();
  const token = tokens.find((item) => item.id === id);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    setCopyState('idle');
  }, [id]);
  if (!token && (catalog.loading || catalog.error))
    return (
      <div className="page" role="status">
        {catalog.error || 'Loading token…'}
      </div>
    );
  if (!token) {
    const upcoming = comingSoonTokens.find((item) => item.id === id);
    if (upcoming) {
      return (
        <div className="page">
          <PageHeading
            title={`${upcoming.name} · Coming soon`}
            description="PONs on Robinhood Chain is not available yet. This former preview token has no active fee route or payments."
          />
          <Empty title="More chains are coming">
            <p>Explore Pump.fun tokens supporting Twitch. Kick is supported.</p>
            <Link className="btn btn-primary" to="/explore">
              Explore available tokens
            </Link>
          </Empty>
        </div>
      );
    }
    return <NotFound kind="token" />;
  }
  const streamer = streamers.find((item) => item.id === token.streamerId);
  if (!streamer && (catalog.loading || catalog.error))
    return (
      <div className="page" role="status">
        {catalog.error || 'Loading streamer…'}
      </div>
    );
  if (!streamer) return <NotFound kind="streamer" />;
  const fundingWait = fundingWaitMessage(token, streamer);
  const related = tokens.filter(
    (item) => item.id !== token.id && item.streamerId === token.streamerId,
  );
  const activity = ledger.filter((event) => event.tokenId === token.id);
  const copyAddress = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(token.address);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <div className="page token-detail">
      {catalog.error && (
        <p className="notice" role="status">
          Live refresh unavailable. Showing the last confirmed catalog. {catalog.error}
        </p>
      )}
      <Link to="/explore" className="detail-breadcrumb text-link">
        <ArrowLeft size={15} />
        All tokens
      </Link>
      <section className="detail-masthead token-masthead" aria-labelledby="token-title">
        <div className="detail-masthead-copy">
          <div className="detail-labels">
            <PadBadge pad={token.launchpad} />
            <span className="detail-demo-tag">Solana token</span>
          </div>
          <h1 id="token-title">{token.name}</h1>
          <span className="detail-ticker">${token.symbol}</span>
          <p>{token.description}</p>
          <Link className="detail-inline-recipient" to={`/streamer/${streamer.id}`}>
            <Avatar streamer={streamer} />
            <span>
              Streamer <strong>{streamer.name}</strong>
            </span>
            <PlatformMark platform={streamer.platform} />
            <ChevronRight size={16} />
          </Link>
        </div>
        <div className="detail-masthead-art">
          <TokenArt token={token} large />
        </div>
      </section>
      <p className="detail-demo-note">
        Community-created token. A recipient listing does not imply creator affiliation or
        endorsement.
      </p>
      <section className="token-support" aria-labelledby="token-support-title">
        <div className="token-support-heading">
          <h2 id="token-support-title">Support for {streamer.name}</h2>
          <span>From ${token.symbol} fees · USD</span>
        </div>
        <div className="token-support-totals">
          <div>
            <span>Sent from creator fees</span>
            <strong>
              {giftMoney(token.donatedUsdCents === undefined ? null : token.donatedUsdCents / 100)}
            </strong>
            <p>Completed gifts for this streamer</p>
          </div>
          <div>
            <span>Awaiting payout</span>
            <strong>
              {giftMoney(token.pendingUsdCents === undefined ? null : token.pendingUsdCents / 100)}
            </strong>
            <p>Remaining funds allocated to this streamer</p>
          </div>
        </div>
        {fundingWait && (
          <div className="funding-wait-note">
            <strong>{fundingWait.summary}</strong>
            <p>{fundingWait.detail}</p>
          </div>
        )}
        <p className="token-support-note">
          {payoutProgressLabel(token)}. Sent reflects gift spending, not the streamer’s net
          earnings. Awaiting payout includes converted gift budgets and reserved purchases, after
          recorded payment costs.
        </p>
      </section>
      <TokenPriceChart
        tokenId={token.id}
        symbol={token.symbol}
        mint={token.address}
        quote={token}
      />
      <div className="detail-stats" aria-label="Token statistics">
        <div
          className="detail-stat"
          role="group"
          title={marketDataLabel(token)}
          aria-label={`Market cap ${money(token.mcap, true)}. ${marketDataLabel(token)}`}
        >
          <span>Market cap</span>
          <strong>{money(token.mcap, true)}</strong>
        </div>
        <div
          className="detail-stat"
          role="group"
          title={marketDataLabel(token)}
          aria-label={`24h volume ${money(token.volume, true)}. ${marketDataLabel(token)}`}
        >
          <span>24h volume</span>
          <strong>{money(token.volume, true)}</strong>
        </div>
        <div
          className="detail-stat"
          role="group"
          title={marketDataLabel(token)}
          aria-label={`24h change ${wholePercent(token.change, true)}. ${marketDataLabel(token)}`}
        >
          <span>24h change</span>
          <strong className={(token.change ?? 0) >= 0 ? 'positive' : 'negative'}>
            {wholePercent(token.change, true)}
          </strong>
        </div>
        <div className="detail-stat">
          <span>Completed payments</span>
          <strong>{token.completedPaymentCount ?? '—'}</strong>
        </div>
      </div>
      <div className="detail-stats" aria-label="Token payout accounting">
        <div className="detail-stat">
          <span>Claimed fees</span>
          <strong>{metricMoney(token.claimedUsdCents)}</strong>
        </div>
        <div className="detail-stat">
          <span>Allocated to streamer</span>
          <strong>{metricMoney(token.streamerAllocatedUsdCents)}</strong>
        </div>
        <div className="detail-stat">
          <span>Payment costs</span>
          <strong>{metricMoney(token.paymentCostsUsdCents)}</strong>
        </div>
        <div className="detail-stat">
          <span>Pending payments</span>
          <strong>{token.pendingPaymentCount ?? '—'}</strong>
        </div>
      </div>
      <p className="detail-demo-note">
        {payoutProgressLabel(token)}. Pending balances include retained funds and unused card
        credit; allocations are before costs.
      </p>
      {token.feeAccrual && (
        <p className="detail-demo-note">
          <UnclaimedFees token={token} />. Unclaimed fees await collection and are not delivered
          gifts.
        </p>
      )}
      <div className="detail-info-grid">
        <section className="detail-info-section">
          <h2>Streamer</h2>
          <Link className="detail-recipient" to={`/streamer/${streamer.id}`}>
            <Avatar streamer={streamer} large />
            <span>
              <strong>{streamer.name}</strong>
              <span>@{streamer.handle}</span>
            </span>
            <PlatformMark platform={streamer.platform} />
            <ArrowUpRight size={19} />
          </Link>
          <p>
            {streamer.platform === 'kick'
              ? 'Kick gifting requires configured browser and card evidence. Existing token activity and receipts remain available.'
              : 'Creator support is routed through the selected public channel.'}
          </p>
        </section>
        <section className="detail-info-section detail-allocation">
          <div className="detail-section-title">
            <h2>Fee allocation</h2>
            <Link className="text-link" to="/flow">
              View flow
              <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="detail-allocation-bar" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="detail-allocation-labels">
            <span>
              <Heart size={18} />
              <strong>80%</strong>Streamer support
            </span>
            <span>
              <Flame size={18} />
              <strong>20%</strong>Native POG buybacks & burns
            </span>
          </div>
          <p>
            Native creator fees split before conversion. Only the streamer share goes to Coinbase;
            its net proceeds cover gifts and checkout costs.
          </p>
        </section>
      </div>
      <section className="detail-contract">
        <div>
          <h2>Token contract</h2>
          <span>Solana mainnet · Pump.fun</span>
        </div>
        <code className="contract-value">{token.address}</code>
        <button className="btn btn-secondary" onClick={copyAddress}>
          {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
          {copyState === 'copied' ? 'Copied' : 'Copy address'}
        </button>
        <a
          className="btn btn-primary"
          href={`https://pump.fun/coin/${encodeURIComponent(token.address)}`}
          target="_blank"
          rel="noreferrer"
        >
          Trade on Pump.fun <ArrowUpRight size={15} />
        </a>
        <p className="detail-copy-feedback" role="status">
          {copyState === 'failed'
            ? 'Clipboard unavailable. Select and copy the identifier above.'
            : copyState === 'copied'
              ? 'Contract address copied.'
              : ''}
        </p>
      </section>
      <section className="detail-activity">
        <div className="section-heading">
          <h2>Token activity</h2>
          <Link className="text-link" to="/donations">
            Platform activity
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <ActivityTable key={token.id} events={activity} />
      </section>
      {related.length > 0 && (
        <section className="detail-token-section">
          <div className="section-heading">
            <h2>More tokens for {streamer.name}</h2>
            <span className="detail-section-count">{related.length} tokens</span>
          </div>
          <div className="token-grid">
            {related.map((item, index) => (
              <TokenCard key={item.id} token={item} index={index} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function StreamerPage() {
  const catalog = useCatalog();
  const { id } = useParams();
  const streamer = streamers.find((item) => item.id === id);
  if (!streamer && (catalog.loading || catalog.error))
    return (
      <div className="page" role="status">
        {catalog.error || 'Loading streamer…'}
      </div>
    );
  if (!streamer) return <NotFound kind="streamer" />;
  const fundingWait = fundingWaitMessage(streamer, streamer);
  const communityTokens = tokens.filter((token) => token.streamerId === streamer.id);
  const tokenIds = new Set(communityTokens.map((token) => token.id));
  const donations = ledger.filter(
    (event) => event.kind === 'Donation' && tokenIds.has(event.tokenId),
  );
  const channelUrl =
    streamer.platform === 'kick'
      ? `https://kick.com/${streamer.handle}`
      : `https://twitch.tv/${streamer.handle}`;
  return (
    <div className={`page streamer-detail detail-platform-${streamer.platform}`}>
      {catalog.error && (
        <p className="notice" role="status">
          Live refresh unavailable. Showing the last confirmed catalog. {catalog.error}
        </p>
      )}
      <Link to="/explore" className="detail-breadcrumb text-link">
        <ArrowLeft size={15} />
        Explore communities
      </Link>
      <section className="detail-masthead streamer-masthead" aria-labelledby="streamer-title">
        <div className="detail-masthead-copy">
          <div className="detail-labels">
            <span className="detail-platform-name">
              <BrandLogo brand={streamer.platform} />
              {streamer.platform === 'kick' ? 'Kick' : 'Twitch'}
            </span>
            <span className="detail-demo-tag">Public profile</span>
          </div>
          <h1 id="streamer-title">{streamer.name}</h1>
          <p className="detail-handle">@{streamer.handle}</p>
          <a href={channelUrl} className="btn btn-primary" {...sourceProps}>
            Visit channel
            <ArrowUpRight size={17} />
          </a>
        </div>
        <div className="detail-masthead-art streamer-portrait">
          <Avatar streamer={streamer} large />
        </div>
      </section>
      <p className="detail-demo-note">
        Public channel profile. Community tokens do not imply affiliation or endorsement. Donation
        totals count completed gift spending, not the streamer’s net earnings.
      </p>
      <div className="detail-stats" aria-label="Streamer statistics">
        <div className="detail-stat">
          <span>Gifts sent</span>
          <strong className="detail-stat-donations">
            {giftMoney(streamerDonations(streamer.id))}
          </strong>
        </div>
        <div className="detail-stat">
          <span>Tokens</span>
          <strong>{communityTokens.length}</strong>
        </div>
        <div className="detail-stat">
          <span>Completed gift purchases</span>
          <strong>
            {streamer.completedPaymentCount === undefined
              ? '—'
              : streamer.completedPaymentCount + (streamer.manualGiftCount ?? 0)}
          </strong>
        </div>
        <div className="detail-stat">
          <span>Payout method</span>
          <strong className="detail-stat-status">Platform gifting</strong>
        </div>
      </div>
      <div className="detail-stats" aria-label="Streamer payout accounting">
        <div className="detail-stat">
          <span>Allocated to streamer</span>
          <strong>{metricMoney(streamer.streamerAllocatedUsdCents)}</strong>
        </div>
        <div className="detail-stat">
          <span>Awaiting payout</span>
          <strong>{metricMoney(streamer.pendingUsdCents)}</strong>
        </div>
        <div className="detail-stat">
          <span>Pending payments</span>
          <strong>{streamer.pendingPaymentCount ?? '—'}</strong>
        </div>
        <div className="detail-stat">
          <span>Stream observation</span>
          <strong>
            {streamer.liveStatus === 'live'
              ? 'Live'
              : streamer.liveStatus === 'offline'
                ? 'Offline'
                : 'Unknown'}
          </strong>
        </div>
      </div>
      {fundingWait && (
        <div className="funding-wait-note">
          <strong>{fundingWait.summary}</strong>
          <p>{fundingWait.detail}</p>
        </div>
      )}
      <p className="detail-demo-note">
        {payoutProgressLabel(streamer)}.
        {streamer.liveCheckedAt
          ? ` Stream checked ${new Date(streamer.liveCheckedAt).toLocaleString()}.`
          : ' Stream status has not been verified.'}{' '}
        Gifting requires a fresh live check.
      </p>
      <section className="detail-token-section">
        <div className="section-heading">
          <h2>Community tokens</h2>
          <span className="detail-section-count">{communityTokens.length} tokens</span>
        </div>
        <div className="token-grid">
          {communityTokens.map((token, index) => (
            <TokenCard key={token.id} token={token} index={index} />
          ))}
        </div>
      </section>
      <div className="detail-payout-note">
        <Heart size={21} />
        <p>
          {streamer.platform === 'kick'
            ? 'Kick gifting requires configured browser and card evidence. Donation history remains available.'
            : 'Payouts require a verified streamer and an approved payout account.'}
        </p>
        <Link className="text-link" to="/docs#recipients">
          How it works
          <ArrowUpRight size={15} />
        </Link>
      </div>
      <section className="detail-activity">
        <div className="section-heading">
          <h2>Donation history</h2>
          <span className="detail-section-count">Recorded USD payments</span>
        </div>
        {donations.length || (streamerDonations(streamer.id) ?? 0) <= 0 ? (
          <ActivityTable key={streamer.id} events={donations} showToken />
        ) : (
          <p className="notice">
            {giftMoney(streamerDonations(streamer.id))} in gifts sent.{' '}
            <Link className="text-link" to="/donations">
              View confirmed gifts
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
