# POG browser agents

POG separates channel discovery, live status, checkout preparation, one purchase attempt, and settlement reconciliation. A public profile match alone never authorizes a gift. Browser drivers run on the server through the existing Browserbase CDP connector and an exclusive `OwnedPage` lease. They do not return a human live-view URL, cookies, card details, or browser credentials.

## Provider identity and live status

Both Twitch and Kick are accepted recipient platforms. `StreamerDirectory.liveStatus` uses authenticated official APIs. Twitch uses its Get Streams endpoint. Kick uses `GET https://api.kick.com/public/v1/channels?broadcaster_user_id=ID` with an app access token from `https://id.kick.com/oauth/token`.

Kick checks the returned numeric broadcaster ID and slug against the pinned recipient, requires an explicit boolean `stream.is_live`, and validates `stream.start_time` for a live channel. An empty, ambiguous, renamed, mismatched, or malformed channel response is unknown, not proof of offline status. Kick's channel response has no native stream ID, so POG derives a session identity from the broadcaster ID and normalized start time. It does not present this value as a Kick receipt or API stream ID.

Credentials are `KICK_CLIENT_ID` and `KICK_CLIENT_SECRET`. They are server credentials and must not appear in client bundles or API responses. The common live gate must refresh status before the final purchase action and keep unknown/offline recipients on hold.

Sources: [Kick Channels API](https://docs.kick.com/apis/channels), [Twitch Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams). Kick's documented channel API permits an app token and supports broadcaster IDs or slugs, but these query types cannot be mixed.

## Kick selector contract

`KickCheckoutDriver` has the same worker method shape as the Twitch driver: `prepare`, `readQuote`, `submit`, and `inspect`, with an observation-only `readDelivery` method for reconciliation. Quotes currently require explicit USD currency. The driver's constructor accepts a trusted server-side `KickSelectorContract`.

**No verified Kick DOM contract ships with this implementation.** The unit-test selectors are synthetic fixtures. No authenticated Kick session or live purchase was used to validate them. An absent, malformed, expired, or unsupported contract produces `contract_unverified` before navigation or purchase. Enabling Kick recipient selection does not imply that live gifting has passed acceptance.

A contract must specify version 1, a revision, a verification time no more than 90 days old, a SHA-256 evidence digest, one approved checkout origin, and every selector in `server/providers/kick-checkout.ts`. The timestamp and digest record configuration provenance; they are not proof that a purchase occurred. The trusted deployment process must review the actual DOM and retain the evidence before supplying the contract. Do not populate provenance with test fixtures or guessed values.

The selected DOM must expose:

- The signed-in account, channel username, and numeric broadcaster ID on the pinned Kick channel page.
- Separate controls for opening the gift dialog, filling gift quantity, and opening payment review. These must not submit payment.
- An unambiguous review container with the exact recipient, integer quantity, explicit `USD` currency, full decimal total, and one checked card control whose label contains its brand and final four digits.
- One final purchase button scoped to that review container.
- A distinct confirmation container with receipt ID, the exact successful status, recipient, quantity, currency, and total.

A live UI that cannot expose these facts remains unsupported by this contract version. Changes in wording, iframe origin, duplicate elements, or structure stop execution until a new review. Approved origins are a transport restriction, not a claim that any particular origin has been observed in Kick checkout. The driver accepts American Express/Amex, Visa, and Mastercard labels; matching requires the intended saved card's final four digits. It never enters a card number or security code.

## Purchase authority and reconciliation

The coordinator must hold durable exclusive browser ownership and persist its original payment intent before checkout. Each intent pins the account, platform, broadcaster ID, username, gift quantity, card final four digits, native cap, and USD allowance. The driver's `beforeSubmit` callback must synchronously persist the transition to submitting and recheck fresh live status and available funding. An async callback does not grant permission to click.

Immediately before purchase, the driver reads the review again and compares it with the approved quote. Quotes older than 30 seconds, price changes, recipient changes, and card changes stop the action. A process-local session guard supplements the durable journal and prevents concurrent or repeated purchase calls through the same driver. It is not a replacement for the journal across process restarts.

There is exactly one final purchase click. A timeout, lost ownership, missing confirmation, verification challenge, or uncertain result remains held for reconciliation. Do not create a new intent, reconnect for another purchase, or release reserved funds merely because a browser call failed. `readDelivery` only inspects the existing page; it never navigates or submits. When reconciling a known quote, pass it as the third argument so the receipt must retain the exact approved total.

CAPTCHA, two-factor authentication, and verification challenges are never bypassed. Browser confirmation is delivery evidence only. The coordinator must separately reconcile the receipt and issuer charge against the original funded allowance before reporting settled support. Coinbase trading balances or successful conversion alone do not prove that an American Express card can fund a purchase.

## Local verification

Run `node --import tsx --test tests/kick*.test.ts`. Tests use mocked API responses and synthetic browser fixtures only. They cover broadcaster identity, explicit offline status, malformed live data, unconfigured contracts, exact checkout facts, American Express matching, challenges, lost ownership, stale quotes, changed totals, asynchronous authority, concurrent submissions, and no repeated click after timeout. These tests verify defensive behavior and are not a live checkout acceptance result.

## Durable runtime integration

`AgentBrowserRunner` in `server/agents/browser.ts` supplies the coordinator for pipeline jobs. Construct it with the shared SQLite database, Browserbase configuration, platform-specific donor accounts and saved browser contexts, the common live gate, and a trusted `readEvidence` implementation. The optional Kick contract is validated before provisioning. The public HTTP surface does not expose these methods or accept evidence.

`submit(job)` derives a stable UUID from the original fee-job identity, atomically records the operation and acquires the browser-context lock, and creates at most one provider session using that UUID as `pogAttemptId` metadata. The CDP ownership callback compares the exact session, context, lease, attempt, and durable state. The runner passes a private diagnostic identity to the driver without exposing a connect URL. It journals `submitting` synchronously before the final click and retains the original operation after every failure. A repeated `submit` returns the existing reference without another purchase.

`reconcile(job)` can find an uncertain provisioned session by the saved attempt ID. It never reprovisions or repeats checkout. Unsubmitted or uncertain operations keep their locks. Settlement requires trusted evidence matching the job, card account, purchase reference, recipient, gift quantity, card final four digits, USD amount, and a posted charge, with receipt and issuer evidence digests. Receipt and charge references cannot be reused across jobs. Only a terminal provider session and committed settlement release the context lock.

There is no default issuer/receipt reader: an absent reader blocks submission before any provider call. Integrating an authenticated evidence source and reviewing the actual Kick DOM remain deployment requirements. The runner does not turn test fixtures, browser success text, or exchange conversion into settlement evidence.
