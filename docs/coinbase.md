# Coinbase funding and Coinbase One credit evidence

POG separates three facts: a matching deposit credited to a Coinbase account, a fully settled USD sale, and independently verified card credit. None implies the next.

## Provider

`server/providers/coinbase.ts` exports `CoinbaseProvider`. Construct it with `getCredentials`, an asynchronous getter returning `{ keyName, privateKey }` from the encrypted credential store. The private key must be an ECDSA P-256 PEM key. The provider does not read environment variables, persist credentials, or log upstream responses. Use Coinbase keys restricted to the required view/trade permissions and intended account/portfolio. No transfer permission is needed by this provider.

- `listTransactionIds(accountId, startingAfter?)` reads one page of at most 100 account transactions and returns `{ transactionIds, nextStartingAfter }`. The worker must enforce a scan budget and persist its cursor. Provider pagination URLs are never followed.
- `verifyDepositAddress({ accountId, asset, address, network }, maxPages = 5)` authenticates the wallet account and asset, then searches its receive addresses for an exact address/network match. It returns the bound address ID and verification time. Call immediately before preparing an onchain send. This verifies a configured address; it creates no new address and uses no receive/transfer permission. The search is bounded to 100 addresses per page and ten pages maximum.
- `reconcileDeposit(transactionId, expected)` requires exact account resource path, receive/completed status, positive decimal asset amount, confirmed network, exact network name, and exact chain transaction hash. `expected` contains `{ accountId, network, transactionHash, asset, amount }`.
- `coinbaseClientOrderId(durableEventId)` derives a stable ID. Persist the immutable sale request before submitting. Reuse the same ID and parameters after uncertain outcomes; never generate a replacement ID to retry a possibly submitted sale.
- `createMarketSell({ clientOrderId, productId, baseSize })` submits a SELL market IOC order through Advanced Trade. Only USD quote products are accepted. This method can move funds when deliberately invoked with valid credentials; all repository tests replace the HTTP transport.
- `reconcileMarketSell(orderId, originalRequest)` requires matching identity, spot product, side and market IOC base size, full fill, and settled state. It returns exact gross, fee, and net decimal strings plus `spendableUsdCents`, rounded downward using integer arithmetic. Partial or cancelled orders are blocked for investigation; they must never trigger an automatic full-size replacement order.
- `findMarketSell(clientOrderId, maxPages = 5)` recovers the order ID through read-only order-history pagination after a lost create response. It returns `{ orderId, clientOrderId }` or `null`; always pass the result to full reconciliation. A scan-limit or repeated cursor throws, and absence never authorizes a replacement mutation. EU accounts requiring additional proof authentication remain blocked.

The provider fixes the origin to `https://api.coinbase.com`, prohibits redirects, signs each request with a fresh ES256 JWT, limits each response to 1 MiB, and bounds credentials/network/body processing to 10 seconds by default (maximum 30 seconds). Errors expose stable codes only. It does not automatically retry mutations.

The worker owns deposit/transaction uniqueness, durable sale and funding journals, supported chain and asset mapping, finality, origin wallet ownership, deposit address validation, atomic spend reservations, and recipient gift idempotency. A returned deposit record verifies Coinbase account credit; it does not independently establish the original chain transaction's destination or fee provenance.

## Deposit API limitation

Coinbase's current [Transactions documentation](https://docs.cdp.coinbase.com/coinbase-app/track-apis/transactions) documents list/show account endpoints, but says `network.hash` and `network.network_name` are supplied only for SEND transactions. Therefore a RECEIVE response may lack the evidence needed for strict chain correlation. POG blocks those responses. The positive mocked fixture demonstrates the validator contract, not a guarantee that Coinbase returns those fields for incoming deposits. Before live use, establish a supported authenticated deposit evidence source that includes the account, chain, hash, asset, and exact credited amount. Matching only on amount, date, or asset is insufficient.

## Native allocation before conversion

Confirmed creator fees split **in native base units before conversion**. The buyback child receives `floor(nativeBaseUnits / 5)`; the streamer child receives the remainder. The persisted allocation version is `native-streamer-v1`. Only the streamer child enters Coinbase settlement. Its entire actual net USD sale result becomes `streamerBudgetUsdCents`; `platformReserveUsdCents` is zero. There is no second USD split.

The native 20% child has a separate durable buyback worker: an explicitly injected verified route sends it to ETH on Robinhood Chain (4663), then buys the configured official POG token through the configured dev wallet and burns the purchased tokens. No bridge, swap, burn, token address, or dev wallet is invented or implicitly enabled. Before every new submission, adapter readiness and immutable target binding are checked. Receipts must prove actual source debit, destination funds, exact target/code hash, swap spend/output, and burn supply decrease. Native source residuals, ETH residuals, gas, and token burns are reported exactly in their own assets without synthetic USD valuations.

Card checks, purchase caps, and reservations use only the persisted streamer budget. Completed gift residual equals budget minus verified spending and is held separately from native buyback residuals. Neither establishes card credit. Unsupported unfinished historical allocation versions remain held; actual historical completed spending is preserved. The official POG identity is Robinhood EVM; historical Solana treasury rows cannot identify it. Public verified identity requires the trusted worker's confirmed purchase binding, not configuration alone.

## Coinbase One credit card boundary

Coinbase One is a [credit card](https://help.coinbase.com/en/creditcard/overview). A USD trade settlement does not top up a prepaid balance or increase available credit. Card repayment and authorization remain separate.

`server/providers/coinbase-card.ts` exports a trusted `CoinbaseCardEvidenceSource` interface for balance and charge records, and `CoinbaseCardReadiness` for fresh available-credit checks. Without a source, readiness returns `card_evidence_source_unavailable`. Even a ready result is only an observation; the worker must reserve credit atomically and independently reconcile the final merchant charge and gift receipt.

Coinbase documents a [read-only Plaid connection](https://help.coinbase.com/en/creditcard/budgeting-app) for Coinbase One balances and transactions. No Plaid adapter is included here. A production adapter requires supported institution access, user consent, authenticated data retrieval, verified account binding, freshness, and reliable posted-charge identity. Do not expose a JSON endpoint that lets an operator assert card evidence. Do not infer credit availability from exchange funds or card credentials. No invented card top-up, repayment, or issuer-charge endpoint is used.

## Verified API references

- [Coinbase App API key authentication](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication): ES256 JWT signing and two-minute expiry.
- [Create Order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order): market IOC and duplicate client order ID behavior.
- [Get Order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/get-order): settlement, filled size/value, and total fees.
- [List Orders](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders): bounded order-history recovery by matching the persisted client ID.
- [Onchain Addresses](https://docs.cdp.coinbase.com/coinbase-app/transfer-apis/onchain-addresses) and [Accounts](https://docs.cdp.coinbase.com/coinbase-app/track-apis/accounts): authenticated account, asset, and deposit destination binding.

Run deterministic tests with `node --import tsx --test tests/coinbase.test.ts`. No authenticated Coinbase requests are made by these tests.
