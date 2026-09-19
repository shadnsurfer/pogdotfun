import { useCatalog } from '../data';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ArrowUpRightIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CoinsIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import { Empty, Modal, PageHeading, Status, TokenArt } from '../components';
import {
  decimalMoney,
  displayMoney,
  getStreamer,
  getToken,
  ledger,
  money,
  catalogCounts,
  activitySummary,
  eventAmount,
  payoutStatusLabel,
  tokenDonations,
  tokens,
  totalDonations,
  donationSummary,
  overallGiftSpending,
  treasury,
  platformToken,
  nativeBuybackLedger,
  streamers,
} from '../data';
import { PlatformTreasury } from '../PlatformTreasury';
import { hasRecordedDonationActivity, TokenDonationProgress } from '../TokenDonationProgress';
import { DonationRecipient } from '../DonationRecipient';
import { activityRecipient } from '../donation-recipient-data';
import type { LedgerEvent } from '../data';
import type { PublicAutonomousDonation } from '../../server/public/autonomous-catalog';
import './transparency-v2.css';

const activityName = (kind: LedgerEvent['kind']) =>
  kind === 'Donation'
    ? 'Pog confirmed'
    : kind === 'Payout'
      ? 'Payout budget'
      : kind === 'Claim'
        ? 'Creator fee claimed'
        : kind === 'Offramp'
          ? 'Converted to USD'
          : kind;
const PAGE_SIZE = 8;
const eventRecipientLabel = (event: LedgerEvent) =>
  event.kind === 'Donation'
    ? 'Gift sent to'
    : event.kind === 'Payout'
      ? 'Reserved for'
      : event.kind === 'Offramp'
        ? 'Funding for'
        : 'Allocated for';

export function isAutonomousDonation(value: unknown): value is PublicAutonomousDonation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const donation = value as Partial<PublicAutonomousDonation>;
  const text = (value: unknown) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f]/.test(value);
  return (
    text(donation.id) &&
    text(donation.tokenId) &&
    (donation.platform === 'twitch' || donation.platform === 'kick') &&
    typeof donation.username === 'string' &&
    /^[A-Za-z0-9_]{3,25}$/.test(donation.username) &&
    (donation.chain === 'solana' || donation.chain === 'bnb' || donation.chain === 'robinhood') &&
    typeof donation.spentUsdCents === 'number' &&
    Number.isSafeInteger(donation.spentUsdCents) &&
    donation.spentUsdCents > 0 &&
    text(donation.receiptReference) &&
    (donation.completedAt === null ||
      (typeof donation.completedAt === 'string' &&
        donation.completedAt.length <= 64 &&
        Number.isFinite(Date.parse(donation.completedAt))))
  );
}

export function parseAutonomousDonations(value: unknown): PublicAutonomousDonation[] {
  if (
    !Array.isArray(value) ||
    !value.every(isAutonomousDonation) ||
    new Set(value.map((donation) => donation.id)).size !== value.length ||
    new Set(value.map((donation) => donation.receiptReference)).size !== value.length ||
    value.reduce((sum, donation) => sum + BigInt(donation.spentUsdCents), 0n) >
      BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Invalid autonomous donation response');
  return value;
}

export function SentDonationList({ donations }: { donations: PublicAutonomousDonation[] }) {
  if (!donations.length) return null;
  const ordered = [...donations].sort(
    (a, b) =>
      (b.completedAt ? Date.parse(b.completedAt) : 0) -
        (a.completedAt ? Date.parse(a.completedAt) : 0) || a.id.localeCompare(b.id),
  );
  const chainName = { solana: 'Solana', bnb: 'BNB Chain', robinhood: 'Robinhood Chain' };
  return (
    <>
      <div className="tv-public-summary">
        <strong>
          {decimalMoney(donations.reduce((sum, donation) => sum + donation.spentUsdCents, 0) / 100)}
        </strong>
        <span>
          Recent gifts sent · {donations.length} {donations.length === 1 ? 'record' : 'records'}
        </span>
      </div>
      <div className="tv-confirmed-list">
        {ordered.map((donation) => (
          <article
            className="tv-confirmed-receipt"
            key={donation.id}
            aria-label={`Gift sent to @${donation.username}`}
          >
            <div className="tv-confirmed-recipient">
              <DonationRecipient platform={donation.platform} username={donation.username} />
              <p className="tv-confirmed-source">{chainName[donation.chain]} creator fees</p>
            </div>
            <div className="tv-confirmed-amount">
              <strong>{decimalMoney(donation.spentUsdCents / 100)} USD</strong>
              <span>Confirmed streamer gift</span>
            </div>
            <div className="tv-confirmed-proof">
              <span>
                Gift sent · Confirmed ·{' '}
                {donation.completedAt ? (
                  <time dateTime={donation.completedAt}>
                    {new Date(donation.completedAt).toLocaleDateString()}
                  </time>
                ) : (
                  'Completion time unavailable'
                )}
              </span>
              <span>Posted card charge</span>
              <span>
                Receipt reference · <code>{donation.receiptReference}</code>
              </span>
            </div>
          </article>
        ))}
      </div>
      <p className="tv-public-note">
        Amounts are confirmed gift spending in USD, not the streamer's net cash earnings.
      </p>
    </>
  );
}

function CompletedDonations({ hasTokenProgress }: { hasTokenProgress: boolean }) {
  const [donations, setDonations] = useState<PublicAutonomousDonation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const response = await fetch('/api/donations', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Receipt service unavailable');
        const result = await response.json();
        const confirmed = parseAutonomousDonations(result.donations);
        if (!controller.signal.aborted) {
          setDonations(confirmed);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted)
          setError('Completed donations could not be refreshed. Try again.');
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    const onVisible = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  return (
    <>
      <section className="tv-confirmed" aria-labelledby="confirmed-donations">
        <div className="tv-section-heading">
          <h2 id="confirmed-donations">Gifts sent</h2>
          <button
            className="text-link"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
            aria-label="Refresh confirmed donations"
          >
            {loading ? 'Refreshing…' : error ? 'Retry' : 'Refresh'}
          </button>
        </div>
        {error && (
          <p className="tv-public-error" role="status">
            {error}
          </p>
        )}
        {loading && !donations.length && !error && (
          <p className="tv-public-empty" role="status">
            Loading completed donations…
          </p>
        )}
        {!loading && !error && !donations.length && (
          <div className="tv-public-empty">
            <strong>
              {hasTokenProgress ? 'No gift receipts to show yet.' : 'No gifts sent yet.'}
            </strong>
            <p>
              {hasTokenProgress && 'Token fees and pending funds are recorded above. '}
              Confirmed gifts will appear here with their payment details.
            </p>
          </div>
        )}
        <SentDonationList donations={donations} />
      </section>
    </>
  );
}

export function DonationsPage() {
  const catalog = useCatalog();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'treasury' ? 'treasury' : 'donations';
  const [filter, setFilter] = useState('All activity');
  const [query, setQuery] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [receipt, setReceipt] = useState<LedgerEvent | null>(null);
  const visible = ledger.filter((event) => {
    const recipient = activityRecipient(event, tokens, streamers);
    const identity =
      event.route === 'treasury'
        ? 'Treasury'
        : `${recipient?.profile?.displayName ?? ''} @${recipient?.username ?? ''} ${recipient?.platform ?? ''}`;
    return (
      (filter === 'All activity' || event.kind === filter) &&
      `${event.tokenName ?? getToken(event.tokenId).name} ${event.tokenSymbol ?? getToken(event.tokenId).symbol} ${identity} ${event.reference}`
        .toLowerCase()
        .includes(query.toLowerCase().trim())
    );
  });
  const receiptRecipient = receipt ? activityRecipient(receipt, tokens, streamers) : null;
  const currentPage = Math.min(pageIndex, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  const pageEvents = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const givingTokens = [...tokens]
    .sort((a, b) => (tokenDonations(b.id) ?? -1) - (tokenDonations(a.id) ?? -1))
    .slice(0, 4);
  return (
    <div className="page transparency-v2">
      <PageHeading
        title="Donations"
        description="Creator fees. Streamer payouts. Every transaction."
        action={
          <Link className="btn btn-secondary" to="/flow">
            Capital flow
            <ArrowUpRightIcon size={16} />
          </Link>
        }
      />
      <TokenDonationProgress />
      {!catalog.loading && !catalog.error && (
        <section className="tv-overview" aria-label="Overall gifts sent">
          <div className="tv-primary-total">
            <span>Gifts sent</span>
            <strong>{decimalMoney(overallGiftSpending)}</strong>
            <small>
              {donationSummary?.completedGiftCount ?? catalogCounts.completedPayments ?? '—'}{' '}
              completed{' '}
              {(donationSummary?.completedGiftCount ?? catalogCounts.completedPayments) === 1
                ? 'gift purchase'
                : 'gift purchases'}{' '}
              · USD spending
            </small>
          </div>
          <div className="tv-overview-balances">
            <div>
              <span>Delivery status</span>
              <strong>{overallGiftSpending > 0 ? 'Sent' : 'Awaiting gifts'}</strong>
            </div>
          </div>
        </section>
      )}
      <CompletedDonations hasTokenProgress={tokens.some(hasRecordedDonationActivity)} />
      {(catalog.loading || catalog.error) && (
        <p className="notice" role="status">
          {catalog.error || 'Loading live ledger…'}
        </p>
      )}
      {!catalog.loading && !catalog.error && (
        <>
          <div className="tv-demo-divider">
            <h2>Ledger & treasury</h2>
            <span>Confirmed fees and their recorded allocations.</span>
          </div>
          <Tabs.Root
            value={view}
            onValueChange={(value) => setParams(value === 'treasury' ? { view: 'treasury' } : {})}
          >
            <div className="tv-tab-row">
              <Tabs.List className="tv-tabs" aria-label="Donation overview">
                <Tabs.Trigger value="donations">Community donations</Tabs.Trigger>
                <Tabs.Trigger value="treasury">$POG treasury</Tabs.Trigger>
              </Tabs.List>
              <span className="tv-demo">USD</span>
            </div>
            <Tabs.Content value="donations" className="tv-tab-content">
              <section className="tv-overview">
                <div className="tv-primary-total">
                  <span>Paid from creator fees</span>
                  <strong>{displayMoney(totalDonations)}</strong>
                  <small>
                    {catalogCounts.completedPayments ?? '—'} completed payments · USD equivalent
                  </small>
                </div>
                <div className="tv-overview-balances">
                  <div>
                    <span>Awaiting payout</span>
                    <strong>{displayMoney(treasury.payoutPending)}</strong>
                  </div>
                  <div>
                    <span>Allocated to streamers</span>
                    <strong>{displayMoney(treasury.streamerAllocation)}</strong>
                  </div>
                </div>
              </section>
            </Tabs.Content>
            <Tabs.Content value="treasury" className="tv-tab-content">
              <PlatformTreasury token={platformToken} ledger={nativeBuybackLedger} />
              <section className="tv-treasury">
                <h2>Streamer conversion ledger</h2>
                <div className="tv-treasury-metrics">
                  {[
                    ['Converted streamer proceeds', displayMoney(treasury.converted)],
                    ['Confirmed gift spending', displayMoney(treasury.paid)],
                    ['Awaiting gifts', displayMoney(treasury.payoutPending)],
                    ['Recorded claim network costs', displayMoney(treasury.claimNetworkFees)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <p className="tv-treasury-note">
                  Only the native 80% streamer share goes to Coinbase. Its actual net sale proceeds
                  fund gifts. Native buyback amounts above are separate from USD proceeds and card
                  credit.
                </p>
              </section>
            </Tabs.Content>
          </Tabs.Root>
          <p className="tv-public-note">
            Awaiting payout includes converted gift budgets and reserved purchases. Completed
            purchase residuals remain separate exchange proceeds and are unavailable for automatic
            reuse. Creator-fee allocations are measured before costs.
          </p>
          <section className="tv-ledger">
            <div className="tv-section-heading">
              <h2>Recent activity</h2>
              <label className="tv-search">
                <MagnifyingGlassIcon size={17} />
                <input
                  aria-label="Search activity"
                  placeholder="Search activity"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPageIndex(0);
                  }}
                />
              </label>
            </div>
            {activitySummary.truncated && (
              <p className="tv-public-note">
                Showing the latest {activitySummary.returnedCount} of{' '}
                {activitySummary.totalCount?.toLocaleString()} records. Totals and payment counts
                include the full ledger.
              </p>
            )}
            <div className="tv-filters" aria-label="Filter activity">
              {['All activity', 'Donation', 'Payout', 'Claim', 'Offramp', 'Buyback', 'Burn'].map(
                (item) => (
                  <button
                    key={item}
                    className={filter === item ? 'active' : ''}
                    aria-pressed={filter === item}
                    onClick={() => {
                      setFilter(item);
                      setPageIndex(0);
                    }}
                  >
                    {item === 'Donation'
                      ? 'Donations'
                      : item === 'Claim'
                        ? 'Claims'
                        : item === 'All activity'
                          ? item
                          : `${item}s`}
                  </button>
                ),
              )}
            </div>
            {pageEvents.length ? (
              <>
                <div className="tv-payment-list">
                  {pageEvents.map((event) => {
                    const listed = tokens.some((token) => token.id === event.tokenId);
                    const token = {
                      ...getToken(event.tokenId),
                      ...(event.tokenName
                        ? {
                            name: event.tokenName,
                            symbol: event.tokenSymbol ?? '',
                            address: event.tokenAddress ?? '',
                          }
                        : {}),
                    };
                    const recipient = activityRecipient(event, tokens, streamers);
                    const source = (
                      <>
                        <TokenArt token={token} />
                        <span>
                          From {token.name} {token.symbol && <>· ${token.symbol}</>}
                        </span>
                      </>
                    );
                    return (
                      <article className="tv-payment" key={event.id}>
                        <div className="tv-payment-route">
                          {event.route === 'treasury' ? (
                            <Link
                              to="/donations?view=treasury"
                              className="tv-identity tv-treasury-recipient"
                            >
                              <CoinsIcon size={32} />
                              <span>
                                $POG treasury<small>Native buyback & burn allocation</small>
                              </span>
                            </Link>
                          ) : recipient ? (
                            <DonationRecipient
                              platform={recipient.platform}
                              username={recipient.username}
                              profile={recipient.profile}
                              label={eventRecipientLabel(event)}
                              compact
                            />
                          ) : (
                            <div className="tv-recipient-unavailable">
                              <strong>Recipient unavailable</strong>
                              <span>The recorded profile could not be resolved.</span>
                            </div>
                          )}
                          {listed ? (
                            <Link to={`/token/${token.id}`} className="tv-payment-source">
                              {source}
                            </Link>
                          ) : (
                            <div className="tv-payment-source">{source}</div>
                          )}
                        </div>
                        <button
                          className="tv-payment-amount"
                          onClick={() => setReceipt(event)}
                          aria-label={`View ${event.reference} receipt`}
                        >
                          <strong>{eventAmount(event)}</strong>
                          <span>
                            {activityName(event.kind)}
                            {event.amountMeaning === 'budget'
                              ? ' · before costs'
                              : String(event.amountMeaning) === 'spendable'
                                ? ' · available for gift'
                                : ''}
                          </span>
                        </button>
                        <div className="tv-payment-state">
                          <Status status={event.status} />
                          <span>
                            {event.kind === 'Payout'
                              ? payoutStatusLabel(event.payoutStatus)
                              : event.age}
                          </span>
                        </div>
                        <button
                          className="tv-open-receipt"
                          onClick={() => setReceipt(event)}
                          aria-label={`Open receipt ${event.reference}`}
                        >
                          <ArrowUpRightIcon size={18} />
                        </button>
                      </article>
                    );
                  })}
                </div>
                <div className="tv-pagination">
                  <span>
                    {currentPage * PAGE_SIZE + 1}–
                    {Math.min((currentPage + 1) * PAGE_SIZE, visible.length)} of {visible.length}{' '}
                    records
                  </span>
                  <div>
                    <button
                      disabled={currentPage === 0}
                      aria-label="Previous records"
                      onClick={() => setPageIndex(currentPage - 1)}
                    >
                      <CaretLeftIcon size={16} />
                    </button>
                    <button
                      disabled={(currentPage + 1) * PAGE_SIZE >= visible.length}
                      aria-label="Next records"
                      onClick={() => setPageIndex(currentPage + 1)}
                    >
                      <CaretRightIcon size={16} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <Empty title="No matching activity">
                <p>Try another token, creator, or activity type.</p>
              </Empty>
            )}
          </section>
          <section className="tv-giving">
            <div className="tv-section-heading">
              <h2>Top tokens</h2>
              <Link className="text-link" to="/explore">
                View all
                <ArrowUpRightIcon size={15} />
              </Link>
            </div>
            <div className="tv-giving-list">
              {givingTokens.map((token) => (
                <Link key={token.id} to={`/token/${token.id}`}>
                  <TokenArt token={token} />
                  <span>
                    <strong>{token.name}</strong>
                    <small>For {getStreamer(token.streamerId).name}</small>
                  </span>
                  <strong className="tv-giving-amount">
                    {money(tokenDonations(token.id), true)}
                  </strong>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
      {receipt && (
        <Modal title="Ledger record" onClose={() => setReceipt(null)}>
          <div className="receipt-amount">
            <span className="sample-label">Ledger record</span>
            <strong>{eventAmount(receipt)}</strong>
            <Status status={receipt.status} />
          </div>
          <dl className="receipt-details">
            <div>
              <dt>Activity</dt>
              <dd>{receipt.kind}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{receipt.tokenName ?? getToken(receipt.tokenId).name}</dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd>
                {receipt.route === 'treasury' ? (
                  '$POG treasury'
                ) : receiptRecipient ? (
                  <DonationRecipient
                    platform={receiptRecipient.platform}
                    username={receiptRecipient.username}
                    profile={receiptRecipient.profile}
                    label={eventRecipientLabel(receipt)}
                    compact
                  />
                ) : (
                  'Recipient unavailable'
                )}
              </dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>{receipt.reference}</dd>
            </div>
            <div>
              <dt>Date (UTC)</dt>
              <dd>{new Date(receipt.date).toLocaleString('en-CA', { timeZone: 'UTC' })}</dd>
            </div>
          </dl>
          {receipt.transactionUrl && (
            <a className="text-link" href={receipt.transactionUrl} target="_blank" rel="noreferrer">
              View on-chain transaction
            </a>
          )}
          {receipt.confirmationUrl && (
            <a
              className="text-link"
              href={receipt.confirmationUrl}
              target="_blank"
              rel="noreferrer"
            >
              View payment confirmation
            </a>
          )}
          <p className="notice">
            Recorded ledger activity. Completed donation receipts are listed above.
          </p>
        </Modal>
      )}
    </div>
  );
}

export function FlowPage() {
  return (
    <div className="page">
      <PageHeading
        title="Autonomous capital flow"
        description="Token fees become verified streamer support."
      />
      <ol className="card">
        <li>Verify creator fees on Solana, BNB, or Robinhood Chain.</li>
        <li>Journal and finalize the claim into the agent-controlled fee wallet.</li>
        <li>Use an explicitly supported route to the platform Coinbase account.</li>
        <li>Reconcile the deposit and convert to USD through the Coinbase API.</li>
        <li>Check fresh Twitch or Kick live status and independent credit-card capacity.</li>
        <li>
          Reserve the token budget and let the Browserbase agent submit one exact gift purchase.
        </li>
        <li>
          Reconcile the posted card charge and streamer receipt; retain any unused allocation.
        </li>
      </ol>
      <p>
        Before conversion, native creator fees split 80% to streamer support and 20% to POG buybacks
        and burns on Robinhood Chain. All actual net USD proceeds from the streamer share fund
        gifts. A pending transfer or checkout never counts as a donation.
      </p>
    </div>
  );
}
