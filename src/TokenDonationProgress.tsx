import { useId } from 'react';
import { Link } from 'react-router-dom';
import { TokenArt } from './components';
import { DonationRecipient } from './DonationRecipient';
import { decimalMoney, getStreamer, payoutProgressLabel, tokens, useCatalog } from './data';
import type { FinancialMetrics } from './data';
import { UnclaimedFees } from './UnclaimedFees';
import './token-donation-progress.css';

function recordedAmount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function hasRecordedDonationActivity(metrics: FinancialMetrics): boolean {
  return [
    metrics.feeAccrual?.unclaimedUsdCents ?? undefined,
    metrics.claimedUsdCents,
    metrics.streamerAllocatedUsdCents,
    metrics.pendingUsdCents,
    metrics.donatedUsdCents,
    metrics.claimCount,
    metrics.completedPaymentCount,
    metrics.pendingPaymentCount,
  ].some((value) => (recordedAmount(value) ?? 0) > 0);
}

function exactMetricMoney(value: number | undefined): string {
  const cents = recordedAmount(value);
  return decimalMoney(cents === null ? null : cents / 100);
}

export function TokenDonationProgress({ limit }: { limit?: number }) {
  const catalog = useCatalog();
  const headingId = useId();
  const activeTokens = tokens
    .filter(hasRecordedDonationActivity)
    .sort(
      (a, b) =>
        (recordedAmount(b.pendingUsdCents) ?? -1) - (recordedAmount(a.pendingUsdCents) ?? -1) ||
        (recordedAmount(b.streamerAllocatedUsdCents) ?? -1) -
          (recordedAmount(a.streamerAllocatedUsdCents) ?? -1) ||
        (b.feeAccrual?.unclaimedUsdCents ?? -1) - (a.feeAccrual?.unclaimedUsdCents ?? -1) ||
        a.id.localeCompare(b.id),
    );
  const visibleTokens =
    limit === undefined ? activeTokens : activeTokens.slice(0, Math.max(0, limit));
  if (!visibleTokens.length && !catalog.loading && !catalog.error) return null;

  return (
    <section
      className="token-donation-progress"
      aria-labelledby={headingId}
      data-catalog-state={catalog.error ? 'stale' : catalog.loading ? 'loading' : 'ready'}
    >
      <div className="tdp-heading">
        <div>
          <h2 id={headingId}>Token donation progress</h2>
          <p>
            Creator fees supporting streamers. Funds awaiting a gift and delivered gifts are shown
            separately.
          </p>
        </div>
        {visibleTokens.length < activeTokens.length && (
          <Link className="text-link" to="/donations">
            View all progress
          </Link>
        )}
      </div>
      {catalog.error ? (
        <p className="tdp-notice tdp-stale" role="status">
          {visibleTokens.length
            ? 'Showing the last confirmed token donation progress. It could not be refreshed.'
            : 'Token donation progress could not be loaded.'}
        </p>
      ) : catalog.loading ? (
        <p className="tdp-notice" role="status">
          {visibleTokens.length
            ? 'Refreshing token donation progress. Last confirmed amounts are shown below.'
            : 'Loading token donation progress…'}
        </p>
      ) : null}
      <div className="tdp-list">
        {visibleTokens.map((token) => {
          const streamer = getStreamer(token.streamerId);
          return (
            <article
              className="tdp-row"
              key={token.id}
              aria-label={`${token.name} donation progress`}
            >
              <div className="tdp-identity">
                <Link className="tdp-token" to={`/token/${token.id}`}>
                  <TokenArt token={token} />
                  <span>
                    <strong>{token.name}</strong>
                    <span>${token.symbol}</span>
                  </span>
                </Link>
                <DonationRecipient
                  compact
                  label="Supporting"
                  platform={streamer.platform}
                  username={streamer.handle}
                  profile={{
                    id: streamer.id,
                    platform: streamer.platform,
                    username: streamer.handle,
                    displayName: streamer.name,
                    imageUrl: streamer.image,
                    channelUrl: streamer.channelUrl ?? '',
                  }}
                />
              </div>
              <div className="tdp-funds">
                <dl className="tdp-metrics">
                  <div>
                    <dt>Allocated to streamer</dt>
                    <dd>{exactMetricMoney(token.streamerAllocatedUsdCents)}</dd>
                  </div>
                  <div>
                    <dt>Awaiting gift</dt>
                    <dd>{exactMetricMoney(token.pendingUsdCents)}</dd>
                  </div>
                  <div>
                    <dt>Delivered gifts</dt>
                    <dd>{exactMetricMoney(token.donatedUsdCents)}</dd>
                  </div>
                </dl>
                {token.feeAccrual && (
                  <p className="tdp-note">
                    <UnclaimedFees token={token} />
                  </p>
                )}
                <p className="tdp-payout-status">{payoutProgressLabel(token)}</p>
              </div>
            </article>
          );
        })}
      </div>
      {visibleTokens.length > 0 && (
        <p className="tdp-note">
          All amounts in USD. Allocations are before costs. Awaiting gift includes reserved funds
          and unused card credit. Unclaimed fees are estimates awaiting collection. Fees count as
          delivered only after a gift is confirmed.
        </p>
      )}
    </section>
  );
}
