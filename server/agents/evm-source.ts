import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import { equalAddress, fingerprint } from '../chains/index.ts';
import type { Reconciliation, TransactionIntent } from '../chains/index.ts';
import type { FeeLot } from './pipeline.ts';

export interface EvmFeeSourceAdapter {
  chainId: 56 | 4663;
  buildClaim(id: string, token: Address): Promise<TransactionIntent>;
  execute(intent: TransactionIntent): Promise<{ hash: Hex }>;
  reconcile(intent: TransactionIntent): Promise<Reconciliation>;
  claimableNative(token: Address): Promise<bigint>;
}
export interface RecipientIdentityVerifier {
  /** Resolve against authenticated provider data, not a caller-supplied assertion. */
  resolve(platform: 'twitch' | 'kick', username: string): Promise<FeeLot['recipient']>;
}
export interface PonsFeeEvidence {
  /** Independently verify a finalized native payout and its token attribution. */
  verify(input: { token: Address; intent: TransactionIntent; receipt: Reconciliation }): Promise<{
    chainId: 4663;
    transactionHash: Hex;
    recipient: Address;
    token: Address;
    amountWei: bigint;
    evidenceId: string;
  } | null>;
}
export interface EvmFeeSourceOptions {
  db: DatabaseSync;
  adapters: EvmFeeSourceAdapter[];
  identityVerifier: RecipientIdentityVerifier;
  minimumClaimWei: bigint;
  ponsFeeEvidence?: PonsFeeEvidence;
}
interface LaunchRecord {
  key: string;
  chain_id: 56 | 4663;
  token: Address;
  fee_recipient: Address;
  recipient: string;
  launch_hash: Hex;
  sequence: number;
}
function stringifyIntent(intent: TransactionIntent) {
  return JSON.stringify({ ...intent, value: intent.value.toString() });
}
function parseIntent(raw: string): TransactionIntent {
  const parsed = JSON.parse(raw);
  return { ...parsed, value: BigInt(parsed.value) } as TransactionIntent;
}
function digest(input: string) {
  return createHash('sha256').update(input).digest('hex');
}
function validHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
function validateRecipient(recipient: FeeLot['recipient']) {
  if (
    !['twitch', 'kick'].includes(recipient.platform) ||
    !new RegExp(`^${recipient.platform}:[1-9]\\d{0,29}$`).test(recipient.providerId) ||
    !/^[a-zA-Z0-9_]{3,25}$/.test(recipient.username)
  )
    throw new Error('Invalid streamer identity');
}
function matchesRecipient(a: FeeLot['recipient'], b: FeeLot['recipient']) {
  return (
    a.platform === b.platform &&
    a.providerId === b.providerId &&
    a.username.toLowerCase() === b.username.toLowerCase()
  );
}

/** Worker-only launch registry, recoverable claims, and a durable fee-lot outbox.
 * It performs no exchange transfer. EVM native assets require an explicit settlement route.
 */
export function createEvmFeeSource(options: EvmFeeSourceOptions) {
  const { db } = options;
  if (options.minimumClaimWei <= 0n) throw new Error('A positive minimum claim policy is required');
  const adapters = new Map(options.adapters.map((adapter) => [adapter.chainId, adapter]));
  if (adapters.size !== options.adapters.length) throw new Error('Duplicate EVM adapter chain');
  db.exec(`CREATE TABLE IF NOT EXISTS evm_launch_registry(key TEXT PRIMARY KEY,chain_id INTEGER NOT NULL,token TEXT NOT NULL,fee_recipient TEXT NOT NULL,recipient TEXT NOT NULL,launch_hash TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,issue TEXT);
    CREATE TABLE IF NOT EXISTS evm_launch_intents(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,intent TEXT NOT NULL,recipient TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evm_claim_jobs(id TEXT PRIMARY KEY,launch_key TEXT NOT NULL,sequence INTEGER NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(launch_key,sequence));
    CREATE TABLE IF NOT EXISTS evm_fee_outbox(id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS evm_source_locks(scope TEXT PRIMARY KEY,owner TEXT NOT NULL);`);
  function adapterFor(chainId: 56 | 4663) {
    const adapter = adapters.get(chainId);
    if (!adapter) throw new Error('EVM adapter is not configured');
    return adapter;
  }
  async function verifiedRecipient(recipient: FeeLot['recipient']) {
    validateRecipient(recipient);
    const resolved = await options.identityVerifier.resolve(recipient.platform, recipient.username);
    validateRecipient(resolved);
    if (!matchesRecipient(recipient, resolved))
      throw new Error('Streamer provider identity mismatch');
    return resolved;
  }
  async function registerConfirmedLaunch(
    intent: TransactionIntent,
    reconciliation: Reconciliation,
    recipient: FeeLot['recipient'],
  ) {
    if (
      intent.kind !== 'launch' ||
      reconciliation.status !== 'confirmed' ||
      !reconciliation.token ||
      !validHash(reconciliation.hash)
    )
      throw new Error('Confirmed launch required');
    // Do not trust the reconciliation object supplied by a caller: reread canonical evidence.
    const checked = await adapterFor(intent.chainId).reconcile(intent);
    if (
      checked.status !== 'confirmed' ||
      !checked.token ||
      checked.hash !== reconciliation.hash ||
      !checked.evidenceId ||
      checked.evidenceId !== reconciliation.evidenceId ||
      !equalAddress(checked.token, reconciliation.token)
    )
      throw new Error('Launch reconciliation evidence mismatch');
    const resolved = await verifiedRecipient(recipient);
    const key = `${intent.chainId}:${checked.token.toLowerCase()}`;
    const existing = db
      .prepare('SELECT * FROM evm_launch_registry WHERE key=?')
      .get(key) as unknown as LaunchRecord | undefined;
    if (existing) {
      if (
        existing.launch_hash !== checked.hash ||
        !equalAddress(existing.fee_recipient, intent.feeRecipient) ||
        !matchesRecipient(JSON.parse(existing.recipient), resolved)
      )
        throw new Error('Conflicting immutable launch registration');
      return;
    }
    const planned = db
      .prepare('SELECT recipient FROM evm_launch_intents WHERE id=?')
      .get(`${intent.chainId}:${intent.id}`);
    if (planned && !matchesRecipient(JSON.parse(String(planned.recipient)), resolved))
      throw new Error('Launch recipient differs from durable intent');
    db.prepare(
      'INSERT INTO evm_launch_registry(key,chain_id,token,fee_recipient,recipient,launch_hash) VALUES (?,?,?,?,?,?)',
    ).run(
      key,
      intent.chainId,
      checked.token,
      intent.feeRecipient,
      JSON.stringify(resolved),
      checked.hash,
    );
  }
  async function executeLaunch(intent: TransactionIntent, recipient: FeeLot['recipient']) {
    if (intent.kind !== 'launch') throw new Error('Launch intent required');
    const resolved = await verifiedRecipient(recipient);
    const id = `${intent.chainId}:${intent.id}`;
    const hash = fingerprint(intent);
    const prior = db.prepare('SELECT * FROM evm_launch_intents WHERE id=?').get(id);
    if (
      prior &&
      (prior.fingerprint !== hash ||
        !matchesRecipient(JSON.parse(String(prior.recipient)), resolved))
    )
      throw new Error('Conflicting durable launch intent');
    db.prepare(
      'INSERT OR IGNORE INTO evm_launch_intents(id,fingerprint,intent,recipient) VALUES (?,?,?,?)',
    ).run(id, hash, stringifyIntent(intent), JSON.stringify(resolved));
    const adapter = adapterFor(intent.chainId);
    await adapter.execute(intent);
    const result = await adapter.reconcile(intent);
    if (result.status === 'confirmed') await registerConfirmedLaunch(intent, result, resolved);
    return result;
  }
  async function recoverLaunches() {
    const rows = db.prepare('SELECT intent,recipient FROM evm_launch_intents').all();
    for (const row of rows)
      await executeLaunch(parseIntent(String(row.intent)), JSON.parse(String(row.recipient)));
  }
  async function scan(policy?: {
    canClaim(candidate: Pick<FeeLot, 'chain' | 'recipient'>): boolean;
  }): Promise<FeeLot[]> {
    const owner = randomUUID();
    const locked = db
      .prepare("INSERT OR IGNORE INTO evm_source_locks(scope,owner) VALUES ('scan',?)")
      .run(owner);
    if (!locked.changes)
      throw new Error('EVM fee source locked; reconcile prior worker before retry');
    try {
      const launches = db
        .prepare('SELECT * FROM evm_launch_registry ORDER BY key')
        .all() as unknown as LaunchRecord[];
      for (const launch of launches) {
        try {
          const adapter = adapterFor(launch.chain_id);
          if (launch.chain_id === 4663) {
            if (!options.ponsFeeEvidence)
              throw new Error('PONs payout evidence adapter is required');
            // PONs claim() empties an entire recipient ledger. Do not assign a mixed-token payout to one streamer.
            if (
              launches.filter(
                (other) =>
                  other.chain_id === 4663 &&
                  equalAddress(other.fee_recipient, launch.fee_recipient),
              ).length !== 1
            )
              throw new Error('PONs shared escrow needs a reviewed per-token allocation adapter');
          }
          const id = `evm-claim-${digest(`${launch.key}:${launch.sequence}`)}`;
          const saved = db.prepare('SELECT * FROM evm_claim_jobs WHERE id=?').get(id);
          let intent: TransactionIntent;
          if (saved) intent = parseIntent(String(saved.intent));
          else {
            if (
              policy &&
              !policy.canClaim({
                chain: launch.chain_id === 56 ? 'bnb' : 'robinhood',
                recipient: JSON.parse(launch.recipient),
              })
            )
              continue;
            const available = await adapter.claimableNative(launch.token);
            if (available < options.minimumClaimWei) continue;
            intent = await adapter.buildClaim(id, launch.token);
            if (
              intent.kind !== 'claim' ||
              intent.chainId !== launch.chain_id ||
              intent.id !== id ||
              !equalAddress(intent.feeRecipient, launch.fee_recipient)
            )
              throw new Error('Claim intent registry mismatch');
            db.prepare(
              'INSERT INTO evm_claim_jobs(id,launch_key,sequence,intent,state) VALUES (?,?,?,?,?)',
            ).run(id, launch.key, launch.sequence, stringifyIntent(intent), 'pending');
          }
          const submitted = await adapter.execute(intent);
          const receipt = await adapter.reconcile(intent);
          if (submitted.hash !== receipt.hash)
            throw new Error('Claim transaction reconciliation mismatch');
          if (receipt.status === 'pending') continue;
          if (receipt.status === 'reverted') throw new Error('Claim reverted; review before retry');
          let amount = receipt.feeAmountWei;
          let evidenceId = receipt.evidenceId;
          if (launch.chain_id === 4663 || receipt.requiresPayoutEvidence) {
            const evidence = await options.ponsFeeEvidence?.verify({
              token: launch.token,
              intent,
              receipt,
            });
            if (
              !evidence ||
              evidence.chainId !== launch.chain_id ||
              evidence.transactionHash !== receipt.hash ||
              !equalAddress(evidence.recipient, launch.fee_recipient) ||
              !equalAddress(evidence.token, launch.token)
            )
              throw new Error('PONs payout evidence identity mismatch');
            amount = evidence.amountWei;
            evidenceId = evidence.evidenceId;
          } else if (!receipt.token || !equalAddress(receipt.token, launch.token))
            throw new Error('Claim token evidence mismatch');
          if (
            amount === undefined ||
            amount < 0n ||
            !evidenceId ||
            !new RegExp(`^${launch.chain_id}:${receipt.hash}:0x[0-9a-fA-F]+$`).test(evidenceId)
          )
            throw new Error('Verified native fee amount and event identity required');
          db.exec('BEGIN IMMEDIATE');
          try {
            if (amount > 0n) {
              const lot: FeeLot = {
                id: `evm-fee-${digest(evidenceId)}`,
                tokenId: launch.key,
                chain: launch.chain_id === 56 ? 'bnb' : 'robinhood',
                asset: launch.chain_id === 56 ? 'BNB' : 'ETH',
                amountBaseUnits: amount.toString(),
                decimals: 18,
                claimReference: evidenceId,
                recipient: JSON.parse(launch.recipient),
              };
              const existing = db
                .prepare('SELECT payload FROM evm_fee_outbox WHERE evidence_id=?')
                .get(evidenceId);
              if (existing) throw new Error('Claim event was already allocated');
              db.prepare('INSERT INTO evm_fee_outbox(id,evidence_id,payload) VALUES (?,?,?)').run(
                lot.id,
                evidenceId,
                JSON.stringify(lot),
              );
            }
            db.prepare("UPDATE evm_claim_jobs SET state='complete' WHERE id=?").run(id);
            db.prepare(
              'UPDATE evm_launch_registry SET sequence=sequence+1,issue=NULL WHERE key=? AND sequence=?',
            ).run(launch.key, launch.sequence);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        } catch (error) {
          // Persist a bounded operational issue, without RPC endpoints or credential-bearing details.
          const message =
            error instanceof Error && /^(PONs |Claim |Verified )/.test(error.message)
              ? error.message
              : 'Claim pending or unavailable; reconcile the persisted intent';
          db.prepare('UPDATE evm_launch_registry SET issue=? WHERE key=?').run(message, launch.key);
        }
      }
      return db
        .prepare('SELECT payload FROM evm_fee_outbox WHERE acknowledged=0 ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.payload)) as FeeLot);
    } finally {
      db.prepare("DELETE FROM evm_source_locks WHERE scope='scan' AND owner=?").run(owner);
    }
  }
  return {
    registerConfirmedLaunch,
    executeLaunch,
    recoverLaunches,
    scan,
    /** Call only after pipeline.recordClaim has durably accepted the lot; duplicate delivery is safe. */
    acknowledge(id: string) {
      db.prepare('UPDATE evm_fee_outbox SET acknowledged=1 WHERE id=?').run(id);
    },
    issues() {
      return db
        .prepare('SELECT key,issue FROM evm_launch_registry WHERE issue IS NOT NULL')
        .all()
        .map((row) => ({ tokenId: String(row.key), issue: String(row.issue) }));
    },
  };
}
