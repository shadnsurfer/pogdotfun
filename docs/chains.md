# POG multichain execution

`server/chains/index.ts` provides executable, separately configured EVM adapters. No credentials, funded wallets, contract bytecode hashes, or bridge routes are supplied by the repository. Constructing an adapter does not publish anything. `buildLaunch` builds ABI calldata; `simulate` calls the node; `execute` signs and broadcasts; `reconcile` verifies the canonical receipt and platform evidence. Existing Solana execution remains separate.

## Verified protocol surfaces

References checked on September 18, 2026:

- [Flap Portal interface](https://docs.flap.sh/flap/developers/token-launcher-developers/launch-token-through-portal): `newTokenV6`, `claim`, `VanityTokenCreated`, `BeneficiaryClaimed`.
- [Flap deployments](https://docs.flap.sh/flap/developers/deployed-contract-addresses): BNB chain ID 56, Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`.
- [PONs v2 developer documentation](https://docs.ponsfamily.com/v2): Robinhood chain ID 4663, factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`. The root documentation describes an older V3-pool factory; this adapter explicitly targets v2 and does not interpret old launch records as v2 records. The direct documentation page was region restricted in the research tool; the official site's indexed v2 documentation supplied the interface. Revalidate deployment bindings before enabling a worker.

The Flap adapter uses a standard zero-tax `TOKEN_V2_PERMIT` launch through V6 with the configured beneficiary and a native BNB quote. NewTokenV5 is a legacy entry point in the current documentation. Metadata must already be pinned through Flap's upload service, and the caller must supply a CREATE2 salt producing the required `8888` suffix. On-chain simulation rejects invalid salts. LP revenue is claimable after the protocol has accrued it; launching does not guarantee revenue. Tax launch, extension, alternate quote asset, and alternate migrator fields are constrained rather than exposed as arbitrary inputs.

PONs builds native ETH launches with a live `previewLaunchEconomics` commitment, the current launch fee, an explicit creator recipient, zero extra creator tax, and disabled buyback. It checks `canLaunch` before building. The documentation currently reports that public v2 launches are closed and allowlisted callers are required. A successful simulation remains mandatory. The v2 audit engagements are reported as unfinished; the adapter makes no audit claim.

PONs native escrow `claim()` is implemented, as is `balanceOf(recipient)`. A successful claim receipt returns `requiresPayoutEvidence: true` without an invented payout amount: the published documentation names the native `Claimed` event but does not provide its complete indexed ABI. Such a receipt must not create a spendable fee lot. Bind independently verified event/transfer evidence before crediting it. Unswept curve/hook fees and ERC-20 balances are separate from the native escrow balance; this implementation does not sweep, trade, release buybacks, or assume those balances are available.

## Runtime composition

Inject:

- `createHttpChainRpc(httpsUrl)` for a concrete JSON-RPC transport with timeouts and response identity checks.
- `createVaultEvmSigner(vault.forRole('claims'), secretName, expectedAddress)` for signing from a role-scoped encrypted secret. A signer key must match its configured address. Private keys never enter intents, journals, or RPC requests.
- `new SqliteExecutionJournal(database)` for durable signed bytes, account nonce coordination, and process locks. SQLite synchronous mode is FULL. `FileExecutionJournal(directory)` is an alternative with atomic rename and fsync. Protect the database and journal directory as private runtime state; signed raw transactions are sensitive before broadcast.
- `feeRecipient`, which must equal the signer-controlled address; explicit `maxValueWei`, `maxGas`, `maxGasPriceWei`, and at least two `confirmations`.
- `deploymentCodeHashes`, keyed by lowercase deployed address. Values are reviewed runtime-code Keccak hashes. Missing/mismatched code fails closed. These hashes must be provisioned from verified contracts, never automatically trusted from the first RPC response.
- For Flap, `storagePins` must include the Portal's `EIP1967_IMPLEMENTATION_SLOT`, its reviewed bytes32 implementation value, and a code hash for the implementation address in `deploymentCodeHashes`. Both proxy storage and implementation bytecode are checked. A different proxy scheme requires a reviewed adapter change.

Example composition, with bindings loaded by the private process configuration:

```ts
const adapter = createPonsAdapter({
  rpc: createHttpChainRpc(bindings.rpcUrl),
  signer: createVaultEvmSigner(vault.forRole('claims'), bindings.secretName, bindings.account),
  journal: new SqliteExecutionJournal(db),
  feeRecipient: bindings.account,
  confirmations: bindings.confirmations,
  maxValueWei: bindings.maxValueWei,
  maxGas: bindings.maxGas,
  maxGasPriceWei: bindings.maxGasPriceWei,
  deploymentCodeHashes: bindings.deploymentCodeHashes,
});
```

Every execution checks chain ID, contract destination, function/argument policy, value limits, simulated execution, gas limits, and the recovered signer plus decoded signed transaction. A persistent reservation precedes signing, and signed bytes precede broadcast. Same-ID replay returns the existing transaction hash. A different payload using that ID fails. Timeout recovery calls `reconcile`; explicit `rebroadcast` sends identical stored bytes. An uncertain reserved intent never signs again. Account locks survive process crashes and require investigation before removal. A nonce unacknowledged by the node blocks another intent, preventing accidental replacement transactions.

Receipts remain pending until the configured confirmation depth, then their block hash must match the canonical block. Launch events must have the pinned emitter, caller, and recipient; PONs also checks the launch's state at the receipt block. This is confirmation-depth finality, not proof of an L2's settlement on Ethereum. Choose depth appropriate to the network and operational risk; do not infer L1 settlement from a sequencer receipt.

Flap claims are restricted to native-quote tokens registered by successful launch reconciliation in this journal. The claim event must match that token and the fee wallet. Native BNB and returned launch-token amounts are separate. `evidenceId` includes chain, transaction hash, and log index and must be deduplicated by the fee ledger. Importing older tokens requires a separate reviewed provenance binding; arbitrary token addresses are refused.

## Exchange settlement boundary

BNB on chain 56 and ETH on chain 4663 are distinct network assets. An Ethereum deposit address does not authorize sending either asset to it on another network. `validateSettlementRoute` requires matching source/destination asset and chain for direct transfer plus authenticated exchange network verification. Cross-network routes require an explicitly bound bridge adapter with matching input/output networks and assets, followed by verified exchange deposit evidence. The validator does not itself implement or certify a bridge. No bridge, incompatible direct-deposit fallback, exchange credit, or card capacity is fabricated by these adapters.

## Validation

Run `npx tsx --test tests/multichain*.test.ts`. Fixtures cover launch calldata and economics, chain identity, destination/value tampering, signer substitution, bytecode and proxy bindings, durable locks, replay, nonce uncertainty, receipt finality/reorgs, event identity, native-fee provenance, and exchange-network mismatch. Tests are deterministic and do not send network transactions.

## Fee source and launch service

`server/agents/evm-source.ts` connects these adapters to the autonomous pipeline without an HTTP mutation surface:

```ts
const source = createEvmFeeSource({
  db,
  adapters: [flapAdapter, ponsAdapter],
  identityVerifier, // resolves username -> authenticated provider identity
  minimumClaimWei: bindings.minimumClaimWei,
  // ponsFeeEvidence: independently verified, token-attributed native payout reader
});
await source.recoverLaunches();
for (const lot of await source.scan()) {
  feeRouter.recordClaim(lot);
  source.acknowledge(lot.id);
}
```

Build a launch intent using its chain adapter, then call `source.executeLaunch(intent, recipient)`. It verifies the streamer with the injected provider identity resolver and durably binds that identity before signing. Registration requires independent canonical launch reconciliation. Repeating the same launch is recoverable; changing its parameters or streamer is rejected. `registerConfirmedLaunch` can register an already completed launch after the same independent checks. Keep these methods private to the trusted agent composition.

The source probes native claimable balances before spending gas. It persists each claim intent and sequence before execution, recovers the same claim on restart, and returns durable fee lots only after confirmed payout evidence. Call `acknowledge` only after the native fee router atomically records the 80/20 split, streamer job, and buyback outbox; redelivery before acknowledgment is intentional. `issues()` exposes blocked claim state without endpoint credentials.

PONs is disabled for fee-lot emission until `PonsFeeEvidence` verifies the finalized claim's chain, transaction, fee wallet, token attribution, positive amount, and unique log identity. Because `claim()` empties the wallet's aggregate escrow, multiple registered PONs launches sharing a fee wallet are blocked pending a reviewed allocation adapter. A single registration still requires independently verified token attribution; it does not imply all escrow funds came from that token. No source method deposits native EVM assets into Coinbase. Only the router's 80% streamer child is passed to exchange settlement. Its 20% buyback child follows the separate Robinhood ETH → official $POG dev-wallet → buy-and-burn route described in [buybacks](buybacks.md).
