import { decimalMoney } from './data';
import type { FinancialMetrics } from './data';

export function UnclaimedFees({ token }: { token: FinancialMetrics }) {
  const fees = token.feeAccrual;
  const amount = fees?.unclaimedUsdCents;
  return (
    <span>
      Unclaimed fees (est.):{' '}
      <strong>{decimalMoney(typeof amount === 'number' ? amount / 100 : null)}</strong>
      {fees?.observedAt ? (
        <>
          {' '}
          · {fees.status === 'stale' ? 'Last checked' : 'Updated'}{' '}
          <time dateTime={fees.observedAt}>
            {new Date(fees.observedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </>
      ) : fees?.status === 'loading' ? (
        ' · Updating…'
      ) : (
        ' · Temporarily unavailable'
      )}
    </span>
  );
}
