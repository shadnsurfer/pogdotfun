# Native POG buyback and supply burn

`server/agents/buyback.ts` is the durable buyback coordinator. It accepts the native **20% child fee lot** already produced by the native allocation router. It does not split that lot again, touch the 80% streamer branch, value native balances in USD, or treat a quote as money received.

The intended path is SOL, BNB, or Robinhood ETH → verified native ETH on Robinhood chain **4663** → the configured agent-controlled developer wallet → purchase of the pinned official POG token → an actual reduction of token supply.

## Configuration and bindings

The repository supplies the coordinator, validation, journal, and deterministic tests. It does **not** supply a live bridge, DEX route, token address, developer wallet, burn ABI, funded account, or deployed transaction implementation. A deployment must implement the typed trusted interfaces against concrete verified protocols. Missing or malformed methods hold the allocation; they never enable a pretend purchase or burn.

`createBuybackWorker(db, options)` takes `BuybackOptions`:

- `enabled`, overridden by the composition root's automation and transaction gates.
- `target`: `chainId: 4663`, nonzero `tokenAddress`, nonzero `devWallet`, reviewed `tokenCodeHash`, and `tokenDecimals`.
- `policy`: integer native source limits per chain, source gas limits, target gas limit, minimum/maximum ETH purchase input, router allowlist, maximum quote age, maximum slippage, and bounded jobs per run. All money values are base-unit decimal strings. Slippage is capped at 1,000 basis points by the worker.
- `transfers`: separate `NativeBuybackTransferAdapter` implementations for each enabled source network. A Robinhood-native source still needs an exact, journaled transfer implementation; it is not automatically trusted because the symbols match.
- `swap`: `PogSwapAdapter`, including `verifyTarget`, `quote`, `submit`, and `reconcile`.
- `burn`: `PogBurnAdapter` implementing a genuinely supported supply-reducing method for the pinned deployment.

`verifyTarget` is a read-only, trusted deployment and signer check. It must verify chain 4663, token runtime code and any upgradeable implementation binding, token decimals, developer wallet, and the address controlled by the injected signer. It runs before each new irreversible stage. A configuration string alone is not ownership or deployment evidence. The public `targetVerifiedAt` is set only after a separately reconciled finalized purchase matches all target identities.

Worker implementations receive a role-scoped treasury credential capability from the private process composition. They must never accept raw keys, arbitrary calldata, target addresses, or payout assertions from an HTTP request. Secrets, signed transaction bytes, quotes, and internal requests are omitted from `list()` and `listBuybackJobs(db)`.

## Durable stages

The coordinator persists each stable operation ID and its complete request **before** invoking the adapter. Every adapter must also journal exact signed transaction bytes, account nonce or equivalent transaction identity, and destination/value limits before broadcasting. An external-call timeout advances no evidence. Restarts call `reconcile` for that exact operation and never invoke `submit` again.

| Stage                       | Required evidence before advancing                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reserved` → `transferring` | Fresh route quote binds the child source amount, asset and network to native ETH and the developer wallet. Target ownership/deployment check passes.                                                                                                   |
| `transferring` → `funded`   | Finalized source debit and destination native ETH credit, correct source claim reference, correct chain 4663 wallet, actual received ETH meeting the persisted minimum. Source debit includes gas and fees and cannot exceed the 20% child allocation. |
| `funded` → `buying`         | Fresh quote for exact ETH input, pinned POG token, developer wallet and allowlisted router. The input leaves twice the maximum target gas budget for purchase and burn.                                                                                |
| `buying` → `bought`         | Finalized purchase from and to the developer wallet; exact chain, token, code hash, decimals and router; bounded realized ETH debit/gas; actual acquired tokens meeting the persisted minimum.                                                         |
| `bought` → `burning`        | Enough residual branch ETH remains for bounded burn gas; request burns exactly the acquired token amount through the reviewed burn adapter.                                                                                                            |
| `burning` → `completed`     | Finalized transaction-attributed wallet decrease **and total-supply decrease**, each exactly equal to the acquired amount. Correct token, code hash, chain and signer, with gas inside the branch reserve.                                             |

A transfer to a zero/dead address, a burn-like event, or a successful receipt alone is insufficient. The burn adapter must prove the transaction caused the supply reduction, rather than compare unrelated block-wide state snapshots. If the token has no verified supply-reducing method, the burn binding remains unavailable and no new source transfer starts.

The coordinator commits evidence identities and stage changes atomically. EVM transaction identities are lowercased and unique across transfer, purchase and burn stages; Solana signatures remain case-sensitive. A single transaction cannot fund two allocations. Compare-and-swap revisions prevent two workers from submitting the same stage. The rotating bounded queue continues past held jobs so one unsupported route cannot starve others.

## Accounting and residuals

The source amount remains denominated in its original asset. After a finalized transfer:

`amountBaseUnits = sourceSpentBaseUnits + residualSourceBaseUnits`

`sourceSpentBaseUnits` includes the verified source gas and route fees. The worker cannot take gas from the 80% streamer allocation implicitly.

After a purchase and burn:

`receivedEthWei = ethSpentWei + swapGasWei + burnGasWei + residualEthWei`

`targetGasSpentWei` is the cumulative target gas for the verified stages. Before burn, `burnGasWei` is absent and contributes zero. Native ETH is credited only from the finalized destination transfer; token output is credited only from the finalized purchase.

`purchasedTokenBaseUnits = burnedTokenBaseUnits + residualTokenBaseUnits`

Residual native source funds, target ETH, and any unburned tokens remain explicit branch-owned balances. The coordinator does not automatically sweep them, send them to Coinbase, reuse them for another allocation, or assign a speculative USD value.

## Composition and recovery

The composition root records each router outbox child with `worker.recordClaim(lot)` and acknowledges that outbox only after the database write succeeds. Repeating an identical child is idempotent; changing its contents or reusing its claim evidence under another ID is rejected. `ready(chain)` means the enabled chain has complete callable bindings and configuration. It does not claim the RPC, wallet, liquidity, or bridge is currently available. `canRecord(chain)` checks whether a source policy can retain that chain's allocation.

`runOnce()` processes a bounded fair batch independently from the Coinbase gift pipeline. `list()` returns sanitized jobs. `listBuybackJobs(db)` reads persisted history without requiring current target configuration or credentials.

A process crash after the stage reservation but before adapter submission is deliberately ambiguous to the coordinator. The adapter's durable journal must resolve it; the worker will not invent a replacement transaction or silently clear the reservation. A durable singleton pins the official target at worker initialization. Changing its chain, token, code hash, decimals, or developer wallet rejects worker construction before any action; target configuration cannot silently switch across allocations. Missing evidence, expired quotes, wrong destinations, excessive debit, unsupported burn methods and provider errors retain the job and its residuals for verified recovery.

## Validation

`npx tsx --test tests/native-buyback.test.ts` exercises the native allocation path, timeout/restart recovery, disabled/missing bindings, callable interface checks, finality and destination mismatch, case-varied transaction replay, source gas bounds, target signer ownership, low output, unchanged supply, fair queue processing and concurrent workers. Fixtures make no provider calls and broadcast no transactions.
