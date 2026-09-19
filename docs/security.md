# Security boundaries

POG has no human financial-control interface. Public requests cannot claim fees, transfer vault funds, approve gifts, submit manual receipts, view remote browser sessions, or read credentials. Token launch requests still require authenticated wallet ownership and verified recipients.

## Credentials

`SecretVault` stores AES-256-GCM ciphertext in SQLite. The credential name and sorted role policy are authenticated additional data; changing either makes decryption fail. Each write uses a fresh 96-bit nonce. Closing the vault destroys its in-memory wrapping-key copy and invalidates readers.

The service composition root uses scoped readers for `claims`, `treasury`, `settlement`, `browser`, and `identity`. Existing provider libraries receive only their necessary decrypted inputs in memory. Decrypted secrets are never returned by the API. The root wrapping key is the bootstrap trust boundary: inject it from a workload secret manager and keep it separate from database backups. Configuration rejects plaintext provider credentials in the runtime environment in favor of encrypted vault entries.

Provision secrets before service startup using private provisioning code and `SecretVault.provision(name, value, roles)`. Provisioning is deliberately not an HTTP or browser feature. Examples of names: `POG_COINBASE_KEY_NAME`, `POG_COINBASE_PRIVATE_KEY`, `BROWSERBASE_API_KEY`, `POG_SOLANA_RPC_URL`, `POG_LAUNCH_ENCRYPTION_KEY`, `TWITCH_CLIENT_SECRET`, `KICK_CLIENT_SECRET`. API keys must have the minimum account permissions and network restrictions the provider supports.

This repository's role readers are application capabilities within a trusted process, not a hardware security boundary. A host administrator with code/process access can defeat software-only isolation. Use separate workload identities, private networking, KMS/HSM signing, disk encryption and access-controlled backups where those guarantees are required. SQLite accounting data itself is not encrypted by this implementation; encrypted credentials are. Browserbase contexts and saved checkout payment instruments are secured by that provider, not by local database encryption.

The trusted worker module receives `secrets.forRole(role)`, a read-only credential capability with no provisioning or key-export method. Bind the official $POG dev-wallet key only to `treasury`, then pass that reader to the verified EVM signer. Provider adapters must not expose the signer to HTTP or browser workers.

## Financial invariants

- Immutable native 80/20 splits precede transfers and USD sales. Only the streamer child can fund checkout; the buyback child can fund only the pinned Robinhood-chain $POG dev wallet.
- Buyback, swap and burn references are unique; a completed buy is not a completed supply burn. Unknown side effects remain reserved.
- Native quantities and decimal conversions remain exact; invalid/stale quotes fail closed.
- Durable claim, deposit, conversion, card charge and receipt identities prevent repeated credit.
- Chain ID/genesis, canonical contracts, implementation storage pins, fee beneficiaries and transaction bytes are checked before trusting receipts.
- The browser holds a durable exclusive context lease. Preparing a checkout never grants purchase authority.
- Card capacity is independent from exchange proceeds and is reserved across concurrent fee jobs.
- Every final click has a committed submitting record. Unknown outcomes retain ownership and budget.
- Only exact authenticated receipt and posted-charge evidence completes a job. No human assertion can override it through the API.
- CAPTCHA, sign-in, verification, 3-D Secure, unsupported currencies, changed UI and uncertain navigation halt execution.

The audit log is protected from ordinary update/delete SQL by triggers. It is not cryptographically tamper-proof against a database/host administrator. External immutable audit storage can be added at deployment.

## Local and deployment separation

The local entry point loads `.env.pog` and defaults to `.data/pog.db`. It does not load an existing `.env` or migrate a previous database. Automation is disabled by default. Source export uses an allowlist and excludes all dot-environment files except the empty example, private data, deployment metadata, diagnostic output and local backups.
