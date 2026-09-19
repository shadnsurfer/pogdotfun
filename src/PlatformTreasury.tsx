import type { PlatformToken } from './data';
import type { PublicNativeBuybackLedger } from '../server/public/native-buybacks';
import './platform-treasury.css';
const units = (value: string, decimals: number) => {
  if (
    !/^(0|[1-9]\d{0,155})$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  )
    return '—';
  const amount = BigInt(value),
    scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (amount / scale).toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
};
export function PlatformTreasury({
  token,
  ledger,
}: {
  token: PlatformToken | null;
  ledger?: PublicNativeBuybackLedger | null;
}) {
  return (
    <section className="tv-treasury platform-treasury" aria-label="Official token">
      <div className="section-heading">
        <h2>Official $POG token</h2>
        <span>Robinhood Chain · 4663</span>
      </div>
      {token ? (
        <>
          <div className="platform-addresses">
            <p>
              Verified token <code>{token.address}</code>
            </p>
            <p>
              Dev wallet <code>{token.devWallet}</code>
            </p>
          </div>
          <p className="tv-treasury-note">
            Target binding verified against a confirmed purchase on Robinhood Chain. Amounts below
            come from confirmed execution.
          </p>
          <div className="tv-treasury-metrics">
            {[
              ['Spent on buybacks', `${units(token.ethSpentWei, 18)} ETH`],
              ['Buyback and burn gas', `${units(token.targetGasSpentWei, 18)} ETH`],
              ['Confirmed buybacks', String(token.buybackCount)],
              ['Confirmed burns', String(token.burnCount)],
              ['$POG burned', units(token.burnedTokenBaseUnits, token.tokenDecimals)],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p>
          The official POG target has not been verified. Its address and dev wallet will appear
          after a confirmed purchase verifies the target binding.
        </p>
      )}
      <h3>Native creator-fee allocation</h3>
      <p className="tv-treasury-note">
        Each confirmed fee lot splits before conversion: 80% supports its streamer; 20% funds POG
        buybacks and burns on Robinhood Chain. The buyback share keeps its original asset until a
        confirmed transfer. No USD valuation is assigned to it.
      </p>
      {ledger?.sources.length ? (
        <div className="tv-treasury-metrics">
          {ledger.sources.map((source) => (
            <div key={source.chain}>
              <span>
                {source.chain === 'solana'
                  ? 'Solana'
                  : source.chain === 'bnb'
                    ? 'BNB Chain'
                    : 'Robinhood Chain'}{' '}
                · {source.asset}
              </span>
              <strong>
                {units(source.buybackBaseUnits, source.decimals)} {source.asset} allocated
              </strong>
              <small>
                {units(source.pendingBuybackBaseUnits, source.decimals)} {source.asset} awaiting
                confirmed transfer
              </small>
              <small>
                {units(source.sourceSpentBaseUnits, source.decimals)} {source.asset} confirmed
                source spending
              </small>
              <small>
                {units(source.residualSourceBaseUnits, source.decimals)} {source.asset} source
                residual held
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p>No native fee allocations recorded.</p>
      )}
      {ledger && (
        <div className="tv-treasury-metrics">
          <div>
            <span>Confirmed destination funds</span>
            <strong>{units(ledger.receivedEthWei, 18)} ETH</strong>
          </div>
          <div>
            <span>Destination ETH residual held</span>
            <strong>{units(ledger.residualEthWei, 18)} ETH</strong>
          </div>
          <div>
            <span>Unburned POG held</span>
            <strong>
              {ledger.tokenDecimals === null
                ? '—'
                : units(ledger.residualTokenBaseUnits, ledger.tokenDecimals)}
            </strong>
          </div>
        </div>
      )}
      <p className="tv-treasury-note">
        An allocation or bridge transfer does not count as a buyback or burn. Source and destination
        residuals remain held and cannot fund streamer gifts.
      </p>
      {ledger?.receipts.length ? (
        <div>
          <h3>Native execution receipts</h3>
          {ledger.receipts.map((receipt) => (
            <p key={receipt.id}>
              <strong>
                {receipt.sourceChain} · {receipt.phase}
              </strong>
              {receipt.sourceTransferReference && (
                <>
                  {' '}
                  · Source <code>{receipt.sourceTransferReference}</code>
                </>
              )}
              {receipt.transferReference && (
                <>
                  {' '}
                  · Transfer <code>{receipt.transferReference}</code>
                </>
              )}
              {receipt.buyReference && (
                <>
                  {' '}
                  · Buy <code>{receipt.buyReference}</code>
                </>
              )}
              {receipt.burnReference && (
                <>
                  {' '}
                  · Burn <code>{receipt.burnReference}</code>
                </>
              )}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
