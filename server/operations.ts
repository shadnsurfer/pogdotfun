import { randomUUID } from 'node:crypto';
import type { AcceptanceCardCharge } from './acceptance/gift-types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { valueLamportsInUsdCents } from './providers/contracts.ts';
import type { SolUsdQuote } from './providers/contracts.ts';
import type {
  NativeFundingReservation,
  NativeFundingIntent,
  NativeFundingInput,
  NativeCreditInput,
  NativeFundingMetadata,
} from './payouts/native-funding-types.ts';

const THRESHOLD_CENTS = 5000;
const MAX_CENTS = 1_000_000_000_000;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

type ObjectInput = Record<string, unknown>;
type Account =
  | 'income'
  | 'available'
  | 'reserved'
  | 'buyback'
  | 'spent'
  | 'cost'
  | 'card_residual'
  | 'fx'
  | 'platform_reserve'
  | 'conversion_pending'
  | 'buyback_spent';
export type PaymentStatus =
  | 'reserved'
  | 'funding_pending'
  | 'funding_submitted'
  | 'awaiting_threshold'
  | 'ready'
  | 'in_progress'
  | 'uncertain'
  | 'completed'
  | 'cancelled';
export class OperationsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export interface RegisteredToken {
  id: string;
  name: string;
  symbol: string;
  mint: string;
  creatorAddress: string;
  chain: 'solana';
  launchpad: 'pump';
  recipientPlatform: 'twitch' | 'kick';
  recipientUsername: string;
  recipientVerified: true;
  dedicatedCreatorVerified: true;
  channelUrl: string;
  createdAt: string;
}
export interface PlatformFeeToken {
  id: string;
  name: string;
  symbol: string;
  mint: string;
  creatorAddress: string;
  kind: 'platform';
  chain: 'solana';
  launchpad: 'pump';
  dedicatedCreatorVerified: true;
  buybackBps: number;
  createdAt: string;
}
export type FeeToken = RegisteredToken | PlatformFeeToken;
export interface TreasuryReceipt {
  id: string;
  kind: 'Buyback' | 'Burn' | 'Failed' | 'Transfer';
  tokenId: string;
  mint: string;
  signature: string;
  consumedLamports: string;
  networkFeeLamports: string;
  amountUsdCents: number | null;
  networkFeeUsdCents: number;
  tokenBaseUnits: string;
  tokenDecimals: number;
  slot: number;
  parentBuyId?: string;
  executionWallet?: string;
  transferFrom?: string;
  transferredLamports?: string;
  sourceCostBasisCents?: number;
  transactionUrl?: string;
  createdAt?: string;
}
export interface Claim {
  id: string;
  tokenId: string;
  signature: string;
  amountLamports: string;
  streamerLamports: string;
  buybackLamports: string;
  grossUsdCents: number;
  streamerCents: number;
  platformReserveCents?: number;
  platformReserveLamports?: string;
  buybackCents: number;
  networkFeeCents: number;
  valuationAt: string;
  slot: number;
  confirmation: 'finalized';
  transactionUrl: string;
  createdAt: string;
}
export interface FailedClaimCost {
  id: string;
  tokenId: string;
  signature: string;
  networkFeeLamports: string;
  networkFeeCents: number;
  valuationAt: string;
  slot: number;
  confirmation: 'finalized_failure';
  transactionUrl: string;
  createdAt: string;
}
export interface Funding {
  /** Native funding has a source valuation, never a promised provider USD quote. */
  native?: NativeFundingMetadata;
  invoiceId: string;
  depositAddress: string;
  signature: string;
  transactionUrl: string;
  amountLamports: string;
  networkFeeLamports?: string;
  sourceCostBasisCents?: number;
  networkSourceCostBasisCents?: number;
  fxAdjustmentCents?: number;
  amountUsdCents: number;
  networkFeeCents: number;
  valuationAt: string;
  createdAt: string;
  networkFeeBooked?: boolean;
  credit?: {
    creditedUsdCents: number;
    providerFeeCents: number | null;
    reference: string;
    evidenceUrl: string;
    confirmedAt: string;
    verification: 'operator_confirmed' | 'provider_verified';
    providerFeeBooked?: boolean;
  };
}
/** Server-only evidence collected independently by the checkout driver and authenticated card reader.
 * HTTP callers cannot select this completion path. Full provenance remains private. */
export interface VerifiedPaymentCompletionEvidence {
  paymentId: string;
  accountId: string;
  recipientProviderId: string;
  recipientUsername: string;
  giftUnits: number;
  nativeCurrency: 'USD' | 'HKD';
  nativeTotalMinorUnits: number;
  quoteObservedAt: string;
  submittedAt: string;
  deliveryCompletedAt: string;
  deliveryEvidenceDigest: string;
  cardCharge: AcceptanceCardCharge;
  nativeReceiptId?: string;
  confirmationUrl?: string;
}
export interface OperationPayment {
  id: string;
  tokenId: string;
  budgetCents: number;
  costEstimate?: { networkFeeCents: number; providerFeeCents: number; estimatedSpendCents: number };
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
  funding?: Funding;
  nativeFundingIntent?: NativeFundingIntent;
  failedFunding?: {
    signature: string;
    transactionUrl: string;
    networkFeeLamports: string;
    networkFeeCents: number;
    sourceCostBasisCents: number;
    fxAdjustmentCents: number;
    valuationAt: string;
    confirmation: 'finalized_failure';
    verification: 'chain_verified';
    reconciledAt: string;
    releasedCents: number;
    costOverrun?: true;
  };
  issue?: string;
  completion?: {
    spentUsdCents: number;
    confirmationUrl?: string;
    /** Private native/card purchase reference, never included in public donation DTOs. */
    paymentReference?: string;
    completionAttested?: true;
    kind: 'bits' | 'kicks' | 'gift_sub' | 'tip';
    giftUnits?: number;
    note?: string;
    completedAt: string;
    verification: 'operator_confirmed' | 'browser_observed_card_verified';
    cardActivityId?: string;
    nativeReceiptId?: string;
    cardChargeStatus?: AcceptanceCardCharge['status'];
  };
}
export interface Balances {
  claimedCents: number;
  availableCents: number;
  reservedCents: number;
  buybackCents: number;
  spentCents: number;
  costCents: number;
  cardResidualCents: number;
  claimNetworkFeeCents: number;
  fxAdjustmentCents: number;
  /** Signed source valuation minus actual credit; not a verified fee or spendable asset. */
  conversionPendingCents: number;
}
/** The accounting ceiling; execution must also honor its existing shared gift hold. */
export function paymentSpendableUsdCents(payment: OperationPayment): number {
  const funding = payment.funding;
  if (!funding?.credit) return 0;
  if (funding.native) {
    const intent = payment.nativeFundingIntent;
    if (!intent || funding.native.costOverrun || funding.credit.providerFeeCents !== null) return 0;
    return Math.max(
      0,
      Math.min(
        funding.credit.creditedUsdCents,
        intent.giftMaxUsdCents,
        payment.budgetCents - funding.networkFeeCents - intent.conversionMaxUsdCents,
      ),
    );
  }
  if (funding.credit.providerFeeCents === null) return 0;
  return Math.max(
    0,
    Math.min(
      funding.credit.creditedUsdCents,
      payment.budgetCents - funding.networkFeeCents - funding.credit.providerFeeCents,
    ),
  );
}
function object(input: unknown): ObjectInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new OperationsError(400, 'Expected a JSON object.');
  return input as ObjectInput;
}
function text(value: unknown, label: string, max = 200): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new OperationsError(400, `${label} is required and must be valid text.`);
  return value.trim();
}
function cents(value: unknown, label: string, zero = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (zero ? 0 : 1) ||
    value > MAX_CENTS
  )
    throw new OperationsError(
      400,
      `${label} must be integer USD cents within the supported range.`,
    );
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new OperationsError(400, `${label} must be a nonnegative safe integer.`);
  return value;
}
function lamports(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new OperationsError(400, 'Amount must be a positive lamports string within u64.');
  return value;
}
function base58(value: unknown, bytes: number, label: string): string {
  const encoded = text(value, label, bytes === 32 ? 44 : 88);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(encoded))
    throw new OperationsError(400, `${label} must be base58.`);
  let number = 0n;
  for (const character of encoded) number = number * 58n + BigInt(BASE58.indexOf(character));
  let size = 0;
  while (number > 0n) {
    size += 1;
    number >>= 8n;
  }
  size += encoded.match(/^1*/)?.[0].length ?? 0;
  if (size !== bytes) throw new OperationsError(400, `${label} must encode ${bytes} bytes.`);
  return encoded;
}
function isoDate(value: unknown): string {
  const result = text(value, 'Valuation time', 40);
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result)))
    throw new OperationsError(400, 'Valuation time must be an ISO timestamp.');
  return new Date(result).toISOString();
}
function httpsUrl(value: unknown): string {
  try {
    const raw = text(value, 'Receipt URL', 2048);
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
      throw new Error();
    return url.href;
  } catch {
    throw new OperationsError(400, 'Use a full HTTPS receipt URL without embedded credentials.');
  }
}
export function readOperatorConfirmation(input: Record<string, unknown>) {
  const confirmationUrl =
    input.confirmationUrl === undefined || input.confirmationUrl === ''
      ? undefined
      : httpsUrl(input.confirmationUrl);
  if (!confirmationUrl && input.completionAttested !== true)
    throw new OperationsError(
      400,
      'Explicit confirmation of successful delivery is required without a public invoice.',
    );
  const paymentReference =
    input.paymentReference === undefined || input.paymentReference === ''
      ? undefined
      : text(input.paymentReference, 'Private payment reference', 128);
  if (!confirmationUrl && !paymentReference)
    throw new OperationsError(
      400,
      'Provide the private native purchase or card transaction reference.',
    );
  return {
    ...(confirmationUrl ? { confirmationUrl } : {}),
    ...(paymentReference ? { paymentReference } : {}),
    ...(!confirmationUrl ? { completionAttested: true as const } : {}),
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const timestamp = () => new Date().toISOString();
const transactionUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

/** Accounting only: confirmed provider adapters own verification and blockchain execution. */
export function createOperations(
  db: DatabaseSync,
  policy: { streamerBps: number } = { streamerBps: 8000 },
) {
  if (!Number.isInteger(policy.streamerBps) || policy.streamerBps < 0 || policy.streamerBps > 10000)
    throw new Error('Invalid allocation policy.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_tokens (id TEXT PRIMARY KEY, mint TEXT UNIQUE NOT NULL, creator_address TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_platform_tokens (id TEXT PRIMARY KEY, mint TEXT UNIQUE NOT NULL, creator_address TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_native_funding_intents (payment_id TEXT PRIMARY KEY, token_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_native_funding_proofs (payment_id TEXT PRIMARY KEY, signature TEXT UNIQUE NOT NULL, invoice_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_native_credit_proofs (payment_id TEXT PRIMARY KEY, activity_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_verified_payment_completions (payment_id TEXT PRIMARY KEY, card_activity_id TEXT UNIQUE NOT NULL, native_receipt_id TEXT UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_checkout_receipts (
      platform TEXT NOT NULL, account_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
      payment_id TEXT NOT NULL UNIQUE, PRIMARY KEY(platform,account_id,receipt_id)
    );
    CREATE TABLE IF NOT EXISTS ops_treasury_receipts (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, signature TEXT UNIQUE NOT NULL, parent_buy_id TEXT UNIQUE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ops_treasury_no_update BEFORE UPDATE ON ops_treasury_receipts BEGIN SELECT RAISE(ABORT, 'Treasury receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_treasury_no_delete BEFORE DELETE ON ops_treasury_receipts BEGIN SELECT RAISE(ABORT, 'Treasury receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_platform_no_update BEFORE UPDATE ON ops_platform_tokens BEGIN SELECT RAISE(ABORT, 'Platform allocation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_platform_no_delete BEFORE DELETE ON ops_platform_tokens BEGIN SELECT RAISE(ABORT, 'Platform allocation is immutable'); END;
    CREATE TABLE IF NOT EXISTS ops_claims (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, signature TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_claim_costs (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, signature TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ops_claim_costs_no_update BEFORE UPDATE ON ops_claim_costs BEGIN SELECT RAISE(ABORT, 'Failed claim costs are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_claim_costs_no_delete BEFORE DELETE ON ops_claim_costs BEGIN SELECT RAISE(ABORT, 'Failed claim costs are immutable'); END;
    CREATE TABLE IF NOT EXISTS ops_payments (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, status TEXT NOT NULL, funding_signature TEXT UNIQUE, invoice_id TEXT UNIQUE, confirmation_url TEXT UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_journal (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, token_id TEXT NOT NULL, payment_id TEXT, account TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents) = 'integer'), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_commands (idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_journal_token ON ops_journal(token_id, account);
    CREATE INDEX IF NOT EXISTS ops_payments_token ON ops_payments(token_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS ops_payment_purchase_reference ON ops_payments(json_extract(payload,'$.completion.paymentReference')) WHERE json_extract(payload,'$.completion.paymentReference') IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS ops_journal_no_update BEFORE UPDATE ON ops_journal BEGIN SELECT RAISE(ABORT, 'Ledger entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_journal_no_delete BEFORE DELETE ON ops_journal BEGIN SELECT RAISE(ABORT, 'Ledger entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_claims_no_update BEFORE UPDATE ON ops_claims BEGIN SELECT RAISE(ABORT, 'Claims are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_claims_no_delete BEFORE DELETE ON ops_claims BEGIN SELECT RAISE(ABORT, 'Claims are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_tokens_no_update BEFORE UPDATE ON ops_tokens BEGIN SELECT RAISE(ABORT, 'Registered recipient allocations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_tokens_no_delete BEFORE DELETE ON ops_tokens BEGIN SELECT RAISE(ABORT, 'Registered recipient allocations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_audit_no_update BEFORE UPDATE ON ops_audit BEGIN SELECT RAISE(ABORT, 'Audit entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_audit_no_delete BEFORE DELETE ON ops_audit BEGIN SELECT RAISE(ABORT, 'Audit entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_failed_funding_immutable BEFORE UPDATE ON ops_payments
      WHEN json_extract(OLD.payload,'$.failedFunding') IS NOT NULL
      AND json_extract(NEW.payload,'$.failedFunding') IS NOT json_extract(OLD.payload,'$.failedFunding')
      BEGIN SELECT RAISE(ABORT, 'Failed funding proofs are immutable'); END;
  `);
  for (const table of [
    'ops_native_funding_intents',
    'ops_native_funding_proofs',
    'ops_native_credit_proofs',
    'ops_verified_payment_completions',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Native funding evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Native funding evidence is immutable'); END;`);
  }
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
        throw new OperationsError(
          409,
          'This transaction, invoice, creator, or receipt is already assigned.',
        );
      throw error;
    }
  }
  function token(id: string): RegisteredToken {
    const row = db.prepare('SELECT payload FROM ops_tokens WHERE id = ?').get(id);
    if (!row) throw new OperationsError(404, 'Registered token not found.');
    return JSON.parse(row.payload as string) as RegisteredToken;
  }
  function payment(id: string): OperationPayment {
    const row = db.prepare('SELECT payload FROM ops_payments WHERE id = ?').get(id);
    if (!row) throw new OperationsError(404, 'Payment not found.');
    return JSON.parse(row.payload as string) as OperationPayment;
  }
  function audit(actor: string, action: string, entityId: string, detail: unknown) {
    db.prepare(
      'INSERT INTO ops_audit(actor,action,entity_id,detail,created_at) VALUES(?,?,?,?,?)',
    ).run(
      text(actor, 'Authenticated actor'),
      action,
      entityId,
      JSON.stringify(detail),
      timestamp(),
    );
  }
  function journal(
    eventId: string,
    tokenId: string,
    paymentId: string | null,
    entries: [Account, number][],
  ) {
    if (
      entries.some(([, value]) => !Number.isSafeInteger(value)) ||
      entries.reduce((sum, [, value]) => sum + value, 0) !== 0
    )
      throw new Error('Unbalanced journal event.');
    const insert = db.prepare(
      'INSERT INTO ops_journal(event_id,token_id,payment_id,account,amount_cents,created_at) VALUES(?,?,?,?,?,?)',
    );
    for (const [account, value] of entries)
      if (value !== 0) insert.run(eventId, tokenId, paymentId, account, value, timestamp());
  }
  function balances(tokenId: string): Balances {
    const accounts = Object.fromEntries(
      db
        .prepare(
          'SELECT account,SUM(amount_cents) AS amount FROM ops_journal WHERE token_id = ? GROUP BY account',
        )
        .all(tokenId)
        .map((row) => [row.account as string, row.amount as number]),
    );
    const network = db
      .prepare(
        "SELECT COALESCE(SUM(json_extract(payload,'$.networkFeeCents')),0) AS amount FROM (SELECT payload FROM ops_claims WHERE token_id = ? UNION ALL SELECT payload FROM ops_claim_costs WHERE token_id = ?)",
      )
      .get(tokenId, tokenId)!.amount as number;
    return {
      claimedCents: -(accounts.income ?? 0),
      availableCents: accounts.available ?? 0,
      reservedCents: accounts.reserved ?? 0,
      buybackCents: accounts.buyback ?? 0,
      spentCents: accounts.spent ?? 0,
      costCents: accounts.cost ?? 0,
      cardResidualCents: accounts.card_residual ?? 0,
      claimNetworkFeeCents: network,
      fxAdjustmentCents: -(accounts.fx ?? 0),
      conversionPendingCents: accounts.conversion_pending ?? 0,
    };
  }
  function assetBalances(tokenId: string) {
    const claims = db
      .prepare('SELECT payload FROM ops_claims WHERE token_id = ?')
      .all(tokenId)
      .map((row) => JSON.parse(row.payload as string) as Claim);
    const funded = db
      .prepare(
        'SELECT payload FROM ops_payments WHERE token_id = ? AND funding_signature IS NOT NULL',
      )
      .all(tokenId)
      .map((row) => JSON.parse(row.payload as string) as OperationPayment);
    const claimed = claims.reduce((sum, claim) => sum + BigInt(claim.amountLamports), 0n);
    const streamer = claims.reduce((sum, claim) => sum + BigInt(claim.streamerLamports), 0n);
    const sent = funded.reduce(
      (sum, payment) => sum + BigInt(payment.funding?.amountLamports ?? '0'),
      0n,
    );
    const gas = funded.reduce(
      (sum, payment) =>
        sum +
        BigInt(
          payment.funding?.networkFeeLamports ?? payment.failedFunding?.networkFeeLamports ?? '0',
        ),
      0n,
    );
    const initialBasis = claims.reduce((sum, claim) => sum + claim.streamerCents, 0);
    const usedBasis = funded.reduce((sum, payment) => {
      if (payment.failedFunding) return sum + payment.failedFunding.sourceCostBasisCents;
      const funding = payment.funding!;
      return (
        sum +
        (funding.sourceCostBasisCents ?? funding.amountUsdCents) +
        (BigInt(funding.networkFeeLamports ?? '0') > 0n
          ? (funding.networkSourceCostBasisCents ?? funding.networkFeeCents)
          : 0)
      );
    }, 0);
    const nativeReservations = db
      .prepare(
        `SELECT i.payload FROM ops_native_funding_intents i
      JOIN ops_payments p ON p.id=i.payment_id WHERE i.token_id=? AND p.funding_signature IS NULL AND p.status<>'cancelled'`,
      )
      .all(tokenId)
      .map((row) => JSON.parse(String(row.payload)) as NativeFundingIntent);
    const reservedLamports = nativeReservations.reduce(
      (sum, plan) => sum + BigInt(plan.amountLamports) + BigInt(plan.maxNetworkFeeLamports),
      0n,
    );
    const reservedBasis = nativeReservations.reduce(
      (sum, plan) => sum + plan.reservedSourceCostBasisCents,
      0,
    );
    return {
      claimedLamports: String(claimed),
      streamerAvailableLamports: String(streamer - sent - gas - reservedLamports),
      streamerAvailableCostBasisCents: initialBasis - usedBasis - reservedBasis,
      streamerReservedLamports: String(reservedLamports),
      streamerReservedCostBasisCents: reservedBasis,
      fundedLamports: String(sent),
      fundingGasLamports: String(gas),
      buybackLamports: String(
        claims.reduce((sum, c) => sum + BigInt(c.buybackLamports), 0n) -
          treasuryReceipts(tokenId).reduce((sum, r) => sum + BigInt(r.consumedLamports), 0n),
      ),
    };
  }
  function savePayment(value: OperationPayment) {
    db.prepare(
      'UPDATE ops_payments SET status=?,funding_signature=?,invoice_id=?,confirmation_url=?,payload=? WHERE id=?',
    ).run(
      value.status,
      value.funding?.signature ?? value.failedFunding?.signature ?? null,
      value.funding?.invoiceId ?? null,
      value.completion?.confirmationUrl ?? null,
      JSON.stringify(value),
      value.id,
    );
    return value;
  }
  function command<T>(key: unknown, action: string, input: unknown, execute: () => T): T {
    const idempotencyKey = text(key, 'Idempotency key', 160);
    const fingerprint = canonical({ action, input });
    return transaction(() => {
      const existing = db
        .prepare('SELECT fingerprint,result FROM ops_commands WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new OperationsError(409, 'Conflicting duplicate idempotency key.');
        return JSON.parse(existing.result as string) as T;
      }
      const result = execute();
      db.prepare('INSERT INTO ops_commands(idempotency_key,fingerprint,result) VALUES(?,?,?)').run(
        idempotencyKey,
        fingerprint,
        JSON.stringify(result),
      );
      return result;
    });
  }
  function platformTokens(): PlatformFeeToken[] {
    return db
      .prepare('SELECT payload FROM ops_platform_tokens ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as PlatformFeeToken);
  }
  function feeTokens(): FeeToken[] {
    return [
      ...db
        .prepare('SELECT payload FROM ops_tokens ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(String(row.payload)) as RegisteredToken),
      ...platformTokens(),
    ];
  }
  function feeToken(id: string) {
    const result = feeTokens().find((t) => t.id === id);
    if (!result) throw new OperationsError(404, 'Fee token not found.');
    return result;
  }
  /** Called only after the service verifies the configured official mint and its dedicated signer. */
  function registerPlatformToken(value: unknown, actor: string) {
    const input = object(value);
    if (
      !Number.isSafeInteger(input.buybackBps) ||
      Number(input.buybackBps) < 0 ||
      Number(input.buybackBps) > 10000
    )
      throw new OperationsError(
        400,
        'An explicit platform fee policy (buybackBps 0–10000) is required.',
      );
    if (input.dedicatedCreatorVerified !== true)
      throw new OperationsError(400, 'Verify a dedicated platform creator wallet.');
    const data = {
      name: text(input.name, 'Platform token name', 32),
      symbol: text(input.symbol, 'Platform symbol', 10),
      mint: base58(input.mint, 32, 'Platform mint'),
      creatorAddress: base58(input.creatorAddress, 32, 'Platform creator'),
      kind: 'platform' as const,
      chain: 'solana' as const,
      launchpad: 'pump' as const,
      dedicatedCreatorVerified: true as const,
      buybackBps: Number(input.buybackBps),
    };
    return transaction(() => {
      const old = platformTokens().find((t) => t.mint === data.mint);
      if (old) {
        const { id: _id, createdAt: _at, ...prior } = old;
        if (canonical(prior) !== canonical(data))
          throw new OperationsError(409, 'Platform fee policy is immutable.');
        return old;
      }
      if (feeTokens().some((t) => t.mint === data.mint || t.creatorAddress === data.creatorAddress))
        throw new OperationsError(
          409,
          'Mint and dedicated creator must be unique across all fee tokens.',
        );
      if (platformTokens().length)
        throw new OperationsError(409, 'One official platform mint is supported.');
      const result: PlatformFeeToken = { ...data, id: randomUUID(), createdAt: timestamp() };
      db.prepare('INSERT INTO ops_platform_tokens VALUES(?,?,?,?)').run(
        result.id,
        result.mint,
        result.creatorAddress,
        JSON.stringify(result),
      );
      audit(actor, 'platform_token_registered', result.id, {
        mint: result.mint,
        buybackBps: result.buybackBps,
      });
      return result;
    });
  }
  function treasuryReceipts(tokenId?: string): TreasuryReceipt[] {
    const rows = tokenId
      ? db
          .prepare('SELECT payload FROM ops_treasury_receipts WHERE token_id=? ORDER BY rowid')
          .all(tokenId)
      : db.prepare('SELECT payload FROM ops_treasury_receipts ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(String(row.payload)) as TreasuryReceipt);
  }
  function treasurySource(tokenId: string) {
    return {
      ...feeToken(tokenId),
      ...assetBalances(tokenId),
      buybackCostBasisCents: balances(tokenId).buybackCents,
    };
  }
  /** Principal stays attributed to its fee source when custody moves wallets. */
  function treasuryCustody(tokenId: string, wallet: string) {
    const source = treasurySource(tokenId);
    const total = BigInt(source.buybackLamports);
    const held = treasuryReceipts(tokenId)
      .filter((r) => r.executionWallet === wallet)
      .reduce(
        (sum, r) => sum + BigInt(r.transferredLamports ?? '0') - BigInt(r.consumedLamports),
        0n,
      );
    const allCentral = treasuryReceipts(tokenId)
      .filter((r) => r.executionWallet && r.executionWallet !== source.creatorAddress)
      .reduce(
        (sum, r) => sum + BigInt(r.transferredLamports ?? '0') - BigInt(r.consumedLamports),
        0n,
      );
    if (source.creatorAddress === wallet)
      return { atCreatorLamports: '0', atTreasuryLamports: String(total - allCentral) };
    return { atCreatorLamports: String(total - allCentral), atTreasuryLamports: String(held) };
  }
  /** Trusted finalized transaction adapter only; never exposed as an attestation endpoint. */
  function recordTreasuryReceipt(
    value: TreasuryReceipt,
    actor: string,
    verification?: { verifiedOverrun: true },
  ) {
    const data: TreasuryReceipt = { ...value };
    text(data.id, 'Treasury receipt ID');
    base58(data.signature, 64, 'Treasury signature');
    base58(data.mint, 32, 'Purchased mint');
    lamports(data.consumedLamports);
    lamports(data.networkFeeLamports);
    integer(data.slot, 'Finalized slot');
    cents(data.networkFeeUsdCents, 'Network fee', true);
    if (
      !['Buyback', 'Burn', 'Failed', 'Transfer'].includes(data.kind) ||
      !/^\d+$/.test(data.tokenBaseUnits) ||
      !Number.isInteger(data.tokenDecimals) ||
      data.tokenDecimals < 0 ||
      data.tokenDecimals > 18
    )
      throw new OperationsError(400, 'Invalid treasury proof.');
    if (data.executionWallet) base58(data.executionWallet, 32, 'Execution wallet');
    if (data.kind === 'Transfer') {
      base58(data.executionWallet, 32, 'Transfer destination');
      base58(data.transferFrom, 32, 'Transfer source');
      lamports(data.transferredLamports);
      if (
        BigInt(data.transferredLamports!) < 1n ||
        data.executionWallet === data.transferFrom ||
        data.tokenBaseUnits !== '0' ||
        data.amountUsdCents !== null ||
        data.consumedLamports !== data.networkFeeLamports
      )
        throw new OperationsError(400, 'Invalid treasury transfer proof.');
    } else if (data.transferFrom !== undefined || data.transferredLamports !== undefined) {
      throw new OperationsError(400, 'Only a verified transfer can move custody.');
    }
    if (data.kind === 'Buyback') {
      cents(data.amountUsdCents, 'Buyback amount', true);
      if (BigInt(data.tokenBaseUnits) < 1n)
        throw new OperationsError(400, 'A buyback requires confirmed token receipt.');
    }
    if (BigInt(data.networkFeeLamports) > BigInt(data.consumedLamports))
      throw new OperationsError(400, 'Invalid treasury network cost.');
    const fingerprint = canonical(data);
    return transaction(() => {
      const old = db
        .prepare('SELECT fingerprint,payload FROM ops_treasury_receipts WHERE id=? OR signature=?')
        .get(data.id, data.signature);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new OperationsError(409, 'Conflicting treasury receipt.');
        return JSON.parse(String(old.payload)) as TreasuryReceipt;
      }
      if (data.kind === 'Burn') {
        const parent = treasuryReceipts(data.tokenId).find(
          (r) => r.id === data.parentBuyId && r.kind === 'Buyback',
        );
        if (
          !parent ||
          parent.mint !== data.mint ||
          parent.tokenBaseUnits !== data.tokenBaseUnits ||
          parent.tokenDecimals !== data.tokenDecimals ||
          parent.executionWallet !== data.executionWallet ||
          data.amountUsdCents !== null
        )
          throw new OperationsError(409, 'Burn must exactly match the confirmed buy receipt.');
        if (treasuryReceipts().some((r) => r.parentBuyId === data.parentBuyId))
          throw new OperationsError(409, 'This purchase already has a burn receipt.');
      }
      const source = treasurySource(data.tokenId);
      const consumed = BigInt(data.consumedLamports);
      const available = BigInt(source.buybackLamports);
      const custody = treasuryCustody(data.tokenId, data.executionWallet ?? source.creatorAddress);
      if (data.kind === 'Transfer') {
        if (
          data.transferFrom !== source.creatorAddress ||
          BigInt(data.transferredLamports!) > BigInt(custody.atCreatorLamports)
        )
          throw new OperationsError(409, 'Transfer exceeds the source custody reserve.');
      } else if (
        data.executionWallet &&
        consumed > BigInt(custody.atTreasuryLamports) &&
        !verification?.verifiedOverrun
      ) {
        throw new OperationsError(409, 'Treasury custody has not been funded for this source.');
      } else if (
        !data.executionWallet &&
        consumed > BigInt(custody.atTreasuryLamports) &&
        treasuryReceipts(data.tokenId).some((r) => r.kind === 'Transfer') &&
        !verification?.verifiedOverrun
      ) {
        throw new OperationsError(
          409,
          'Legacy source spending cannot consume transferred custody.',
        );
      }
      if (consumed > available && !verification?.verifiedOverrun)
        throw new OperationsError(409, 'Treasury spend exceeds the source buyback reserve.');
      const basis =
        available === 0n
          ? 0
          : Number((BigInt(source.buybackCostBasisCents) * consumed) / available);
      const spent = data.kind === 'Buyback' ? data.amountUsdCents! : 0;
      const actual = spent + data.networkFeeUsdCents;
      const result = {
        ...data,
        sourceCostBasisCents: basis,
        transactionUrl: transactionUrl(data.signature),
        createdAt: timestamp(),
      };
      db.prepare('INSERT INTO ops_treasury_receipts VALUES(?,?,?,?,?,?)').run(
        data.id,
        data.tokenId,
        data.signature,
        data.kind === 'Burn' ? data.parentBuyId! : null,
        fingerprint,
        JSON.stringify(result),
      );
      journal(data.id, data.tokenId, null, [
        ['buyback', -basis],
        ['buyback_spent', spent],
        ['cost', data.networkFeeUsdCents],
        ['fx', basis - actual],
      ]);
      audit(actor, 'treasury_' + data.kind.toLowerCase(), data.id, {
        signature: data.signature,
        tokenId: data.tokenId,
      });
      return result;
    });
  }
  function treasurySnapshot() {
    const receipts = treasuryReceipts();
    const buys = receipts.filter((r) => r.kind === 'Buyback');
    const burns = receipts.filter((r) => r.kind === 'Burn');
    const decimals = new Set(burns.map((r) => r.tokenDecimals));
    const mints = new Set(burns.map((r) => r.mint));
    const comparableBurns = mints.size <= 1 && decimals.size <= 1;
    return {
      platformReserveUsdCents: Number(
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_cents),0) amount FROM ops_journal WHERE account='platform_reserve'",
          )
          .get()!.amount,
      ),
      buybackNetworkFeesByToken: Object.fromEntries(
        feeTokens().map((t) => [
          t.id,
          receipts.filter((r) => r.tokenId === t.id).reduce((n, r) => n + r.networkFeeUsdCents, 0),
        ]),
      ),
      buybackSpentUsdCents: buys.reduce((n, r) => n + (r.amountUsdCents ?? 0), 0),
      buybackReserveUsdCents: feeTokens().reduce((n, t) => n + balances(t.id).buybackCents, 0),
      buybackNetworkFeesUsdCents: receipts.reduce((n, r) => n + r.networkFeeUsdCents, 0),
      burnedTokenBaseUnits: comparableBurns
        ? String(burns.reduce((n, r) => n + BigInt(r.tokenBaseUnits), 0n))
        : null,
      burnedTokenDecimals: comparableBurns && decimals.size === 1 ? [...decimals][0] : null,
      buybackCount: buys.length,
      burnCount: burns.length,
      transfers: receipts.filter((r) => r.kind === 'Transfer'),
      receipts: receipts
        .filter((r) => r.kind === 'Buyback' || r.kind === 'Burn')
        .map((r) => ({ ...r, transactionUrl: r.transactionUrl!, createdAt: r.createdAt! })),
    };
  }
  function registerToken(value: unknown, actor: string) {
    const input = object(value);
    if (input.chain !== 'solana' || input.launchpad !== 'pump')
      throw new OperationsError(400, 'Only Pump.fun on Solana is currently available.');
    if (input.recipientPlatform !== 'twitch' && input.recipientPlatform !== 'kick')
      throw new OperationsError(400, 'Choose Twitch or Kick.');
    if (input.recipientVerified !== true)
      throw new OperationsError(
        400,
        'The recipient must be verified before registering a fee allocation.',
      );
    if (input.dedicatedCreatorVerified !== true)
      throw new OperationsError(
        400,
        'Verify that the fee-creator wallet is dedicated to this mint before registration.',
      );
    const username = text(input.recipientUsername, 'Recipient username', 25).toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(username))
      throw new OperationsError(400, 'Invalid streamer username.');
    const symbol = text(input.symbol, 'Token symbol', 10);
    if (!/^[A-Z0-9]{2,10}$/.test(symbol))
      throw new OperationsError(400, 'Use 2–10 uppercase letters or numbers for the token symbol.');
    const data = {
      name: text(input.name, 'Token name', 32),
      symbol,
      mint: base58(input.mint, 32, 'Mint address'),
      creatorAddress: base58(input.creatorAddress, 32, 'Dedicated creator address'),
      chain: 'solana' as const,
      launchpad: 'pump' as const,
      recipientPlatform: input.recipientPlatform as RegisteredToken['recipientPlatform'],
      recipientUsername: username,
      recipientVerified: true as const,
      dedicatedCreatorVerified: true as const,
      channelUrl: `https://${input.recipientPlatform === 'twitch' ? 'www.twitch.tv' : 'kick.com'}/${username}`,
    };
    return transaction(() => {
      if (
        platformTokens().some(
          (t) => t.mint === data.mint || t.creatorAddress === data.creatorAddress,
        )
      )
        throw new OperationsError(
          409,
          'Mint and dedicated creator already registered to platform.',
        );
      const prior = db.prepare('SELECT payload FROM ops_tokens WHERE mint = ?').get(data.mint);
      if (prior) {
        const existing = JSON.parse(prior.payload as string) as RegisteredToken;
        const { id: _id, createdAt: _createdAt, ...old } = existing;
        if (canonical(data) !== canonical(old))
          throw new OperationsError(
            409,
            'Conflicting token registration; recipient allocation is immutable.',
          );
        return existing;
      }
      const result: RegisteredToken = { ...data, id: randomUUID(), createdAt: timestamp() };
      db.prepare('INSERT INTO ops_tokens(id,mint,creator_address,payload) VALUES(?,?,?,?)').run(
        result.id,
        result.mint,
        result.creatorAddress,
        JSON.stringify(result),
      );
      audit(actor, 'token_registered', result.id, {
        mint: result.mint,
        recipient: result.recipientUsername,
      });
      return result;
    });
  }
  /** Trusted adapter only: gas paid from operating funds, without successful fee revenue. */
  function recordFailedClaimCost(value: unknown, actor: string): FailedClaimCost {
    const input = object(value);
    if (input.confirmation !== 'finalized_failure')
      throw new OperationsError(400, 'Only finalized claim failure costs may be booked.');
    const data = {
      tokenId: text(input.tokenId, 'Token ID'),
      signature: base58(input.signature, 64, 'Failed claim signature'),
      networkFeeLamports: lamports(input.networkFeeLamports),
      networkFeeCents: cents(input.networkFeeCents, 'Claim network fee', true),
      valuationAt: isoDate(input.valuationAt),
      slot: integer(input.slot, 'Finalized slot'),
      confirmation: 'finalized_failure' as const,
    };
    const fingerprint = canonical(data);
    return transaction(() => {
      feeToken(data.tokenId);
      if (db.prepare('SELECT 1 FROM ops_claims WHERE signature=?').get(data.signature))
        throw new OperationsError(409, 'A successful claim already uses this signature.');
      const existing = db
        .prepare('SELECT fingerprint,payload FROM ops_claim_costs WHERE signature=?')
        .get(data.signature);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new OperationsError(409, 'Conflicting failed claim cost signature.');
        return JSON.parse(String(existing.payload)) as FailedClaimCost;
      }
      if (balances(data.tokenId).claimNetworkFeeCents + data.networkFeeCents > MAX_CENTS)
        throw new OperationsError(400, 'Token lifetime network cost limit exceeded.');
      const result: FailedClaimCost = {
        ...data,
        id: randomUUID(),
        createdAt: timestamp(),
        transactionUrl: transactionUrl(data.signature),
      };
      db.prepare('INSERT INTO ops_claim_costs VALUES(?,?,?,?,?)').run(
        result.id,
        result.tokenId,
        result.signature,
        fingerprint,
        JSON.stringify(result),
      );
      audit(actor, 'claim_failed_cost_confirmed', result.id, {
        tokenId: result.tokenId,
        signature: result.signature,
        networkFeeCents: result.networkFeeCents,
      });
      return result;
    });
  }
  /** The caller must verify the finalized Pump transaction and creator/mint attribution first. */
  function recordClaim(value: unknown, actor: string) {
    const input = object(value);
    const data = {
      tokenId: text(input.tokenId, 'Token ID'),
      signature: base58(input.signature, 64, 'Claim signature'),
      amountLamports: lamports(input.amountLamports),
      grossUsdCents: cents(input.grossUsdCents, 'Gross claim'),
      networkFeeCents: cents(input.networkFeeCents, 'Claim network fee', true),
      valuationAt: isoDate(input.valuationAt),
      slot: integer(input.slot, 'Finalized slot'),
      confirmation: 'finalized' as const,
    };
    if (input.confirmation !== 'finalized')
      throw new OperationsError(400, 'Only finalized claims may be booked.');
    // The worker enforces the $50 threshold before preparing a claim. Never omit an
    // actually finalized receipt merely because its observed USD value changed.
    return transaction(() => {
      const sourceToken = feeToken(data.tokenId);
      if (db.prepare('SELECT 1 FROM ops_claim_costs WHERE signature=?').get(data.signature))
        throw new OperationsError(409, 'A failed claim already uses this signature.');
      const fingerprint = canonical(data);
      const existing = db
        .prepare('SELECT fingerprint,payload FROM ops_claims WHERE signature = ?')
        .get(data.signature);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new OperationsError(409, 'Conflicting duplicate claim signature.');
        return JSON.parse(existing.payload as string) as Claim;
      }
      if (balances(data.tokenId).claimedCents + data.grossUsdCents > MAX_CENTS)
        throw new OperationsError(400, 'Token lifetime accounting limit exceeded.');
      const platform = 'kind' in sourceToken && sourceToken.kind === 'platform';
      const bps = platform ? sourceToken.buybackBps : 10000 - policy.streamerBps;
      const buybackCents = Number((BigInt(data.grossUsdCents) * BigInt(bps)) / 10000n);
      const buybackLamports = (BigInt(data.amountLamports) * BigInt(bps)) / 10000n;
      const result: Claim = {
        ...data,
        id: randomUUID(),
        createdAt: timestamp(),
        transactionUrl: transactionUrl(data.signature),
        buybackCents,
        streamerCents: platform ? 0 : data.grossUsdCents - buybackCents,
        ...(platform
          ? {
              platformReserveCents: data.grossUsdCents - buybackCents,
              platformReserveLamports: String(BigInt(data.amountLamports) - buybackLamports),
            }
          : {}),
        buybackLamports: String(buybackLamports),
        streamerLamports: platform ? '0' : String(BigInt(data.amountLamports) - buybackLamports),
      };
      db.prepare(
        'INSERT INTO ops_claims(id,token_id,signature,fingerprint,payload) VALUES(?,?,?,?,?)',
      ).run(result.id, result.tokenId, result.signature, fingerprint, JSON.stringify(result));
      journal(result.id, result.tokenId, null, [
        ['income', -result.grossUsdCents],
        ['available', result.streamerCents],
        ['buyback', result.buybackCents],
        ['platform_reserve', result.platformReserveCents ?? 0],
      ]);
      audit(actor, 'claim_finalized', result.id, {
        tokenId: result.tokenId,
        signature: result.signature,
        grossUsdCents: result.grossUsdCents,
      });
      return result;
    });
  }
  function reservePayment(value: unknown, actor: string) {
    const input = object(value);
    const tokenId = text(input.tokenId, 'Token ID');
    const explicitBudget =
      input.budgetCents === undefined ? undefined : cents(input.budgetCents, 'Payment budget');
    const networkFeeCents = cents(
      input.estimatedNetworkFeeCents ?? 0,
      'Estimated network cost',
      true,
    );
    const providerFeeCents = cents(
      input.estimatedProviderFeeCents ?? 0,
      'Estimated provider cost',
      true,
    );
    return command(
      input.idempotencyKey,
      'reserve',
      { tokenId, budgetCents: explicitBudget, networkFeeCents, providerFeeCents },
      () => {
        token(tokenId);
        const available = balances(tokenId).availableCents;
        const budgetCents = explicitBudget ?? available;
        if (budgetCents < THRESHOLD_CENTS)
          throw new OperationsError(400, 'The streamer payout threshold is $50 USD after costs.');
        if (budgetCents > available)
          throw new OperationsError(
            409,
            'The token does not have enough available streamer funds.',
          );
        const estimatedSpendCents = budgetCents - networkFeeCents - providerFeeCents;
        if (estimatedSpendCents < THRESHOLD_CENTS)
          throw new OperationsError(
            400,
            'The estimated send after funding costs must meet the $50 USD minimum.',
          );
        const result: OperationPayment = {
          id: randomUUID(),
          tokenId,
          budgetCents,
          costEstimate: { networkFeeCents, providerFeeCents, estimatedSpendCents },
          status: 'reserved',
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        db.prepare('INSERT INTO ops_payments(id,token_id,status,payload) VALUES(?,?,?,?)').run(
          result.id,
          result.tokenId,
          result.status,
          JSON.stringify(result),
        );
        journal(randomUUID(), tokenId, result.id, [
          ['available', -budgetCents],
          ['reserved', budgetCents],
        ]);
        audit(actor, 'payment_reserved', result.id, { tokenId, budgetCents });
        return result;
      },
    );
  }
  function nativeQuote(value: unknown): SolUsdQuote {
    const input = object(value);
    const quote = {
      centsPerSol: text(input.centsPerSol, 'SOL valuation'),
      observedAt: isoDate(input.observedAt),
      source: text(input.source, 'Valuation source'),
    };
    try {
      valueLamportsInUsdCents(1n, quote, Date.parse(quote.observedAt));
    } catch {
      throw new OperationsError(400, 'A valid independent source valuation is required.');
    }
    return quote;
  }
  function nativeIntent(id: string): NativeFundingIntent {
    const row = db
      .prepare('SELECT payload FROM ops_native_funding_intents WHERE payment_id=?')
      .get(id);
    if (!row) throw new OperationsError(409, 'The original native source reservation is required.');
    const intent = JSON.parse(String(row.payload)) as NativeFundingIntent;
    if (canonical(payment(id).nativeFundingIntent) !== canonical(intent))
      throw new OperationsError(409, 'The native source reservation differs from the payment.');
    return intent;
  }
  /** Pins token-owned principal and basis before the coordinator may issue an invoice. */
  function reserveNativeFunding(id: string, value: NativeFundingReservation, actor: string) {
    const input = object(value);
    const data: NativeFundingReservation = {
      amountLamports: lamports(input.amountLamports),
      maxNetworkFeeLamports: lamports(input.maxNetworkFeeLamports),
      sourceQuote: nativeQuote(input.sourceQuote),
      cardId: text(input.cardId, 'Card identity'),
      slotNumber: integer(input.slotNumber, 'Card slot'),
      giftMaxUsdCents: cents(input.giftMaxUsdCents, 'Gift ceiling'),
      conversionMaxUsdCents: cents(input.conversionMaxUsdCents, 'Conversion allowance'),
      gasMaxUsdCents: cents(input.gasMaxUsdCents, 'Gas ceiling'),
    };
    if (
      !data.slotNumber ||
      BigInt(data.amountLamports) % 10_000_000n !== 0n ||
      data.giftMaxUsdCents < THRESHOLD_CENTS
    )
      throw new OperationsError(
        400,
        'Native funding requires an exact 0.01 SOL principal and at least $50 gift allowance.',
      );
    return transaction(() => {
      const result = payment(id);
      if (result.status === 'cancelled' || result.failedFunding)
        throw new OperationsError(409, 'A resolved failed native reservation cannot be renewed.');
      if (result.nativeFundingIntent) {
        const old = nativeIntent(id);
        const prior = Object.fromEntries(
          Object.keys(data).map((key) => [key, old[key as keyof NativeFundingReservation]]),
        );
        if (canonical(prior) !== canonical(data))
          throw new OperationsError(409, 'Conflicting immutable native funding reservation.');
        return result;
      }
      if (result.status !== 'reserved' || result.funding || result.failedFunding)
        throw new OperationsError(409, 'Native funding requires an untouched reserved payment.');
      if (
        data.giftMaxUsdCents + data.conversionMaxUsdCents + data.gasMaxUsdCents >
        result.budgetCents
      )
        throw new OperationsError(
          409,
          'Native gift and cost ceilings exceed the approved payment budget.',
        );
      const assets = assetBalances(result.tokenId);
      const available = BigInt(assets.streamerAvailableLamports);
      const total = BigInt(data.amountLamports) + BigInt(data.maxNetworkFeeLamports);
      if (total > available || available <= 0n)
        throw new OperationsError(409, 'Native funding exceeds unreserved streamer SOL.');
      const basis = Number((BigInt(assets.streamerAvailableCostBasisCents) * total) / available);
      if (basis > result.budgetCents)
        throw new OperationsError(409, 'Native source cost basis exceeds the reserved payment.');
      const sourceValueUsdCents = valueLamportsInUsdCents(
        BigInt(data.amountLamports),
        data.sourceQuote,
      );
      if (sourceValueUsdCents < THRESHOLD_CENTS || sourceValueUsdCents > data.giftMaxUsdCents)
        throw new OperationsError(
          409,
          'Native source valuation is outside the original gift allowance.',
        );
      const intent: NativeFundingIntent = {
        ...data,
        version: 1,
        paymentId: id,
        tokenId: result.tokenId,
        creatorAddress: token(result.tokenId).creatorAddress,
        sourceAvailableLamports: assets.streamerAvailableLamports,
        sourceAvailableCostBasisCents: assets.streamerAvailableCostBasisCents,
        reservedSourceCostBasisCents: basis,
        sourceValueUsdCents,
        createdAt: timestamp(),
      };
      db.prepare('INSERT INTO ops_native_funding_intents VALUES(?,?,?)').run(
        id,
        result.tokenId,
        JSON.stringify(intent),
      );
      result.nativeFundingIntent = intent;
      result.status = 'funding_pending';
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'native_funding_reserved', id, {
        amountLamports: data.amountLamports,
        sourceCostBasisCents: basis,
      });
      return result;
    });
  }
  /** Trusted finalized transfer proof only; no native proof is accepted over the ledger HTTP route. */
  function recordNativeFunding(
    id: string,
    value: NativeFundingInput,
    actor: string,
    verification?: { verifiedOverrun: true },
  ) {
    const input = object(value);
    const data: NativeFundingInput = {
      invoiceId: text(input.invoiceId, 'Native invoice'),
      depositAddress: base58(input.depositAddress, 32, 'Deposit address'),
      signature: base58(input.signature, 64, 'Funding signature'),
      amountLamports: lamports(input.amountLamports),
      networkFeeLamports:
        input.networkFeeLamports === '0' ? '0' : lamports(input.networkFeeLamports),
      sourceValueUsdCents: cents(input.sourceValueUsdCents, 'Source valuation'),
      networkFeeCents: cents(input.networkFeeCents, 'Network cost', true),
      sourceQuote: nativeQuote(input.sourceQuote),
      slotNumber: integer(input.slotNumber, 'Card slot'),
      cardId: text(input.cardId, 'Card identity'),
      confirmation: 'finalized',
      slot: integer(input.slot, 'Finalized slot'),
    };
    if (input.confirmation !== 'finalized' || !data.slot || !data.slotNumber)
      throw new OperationsError(400, 'Native funding requires a finalized original transfer.');
    return transaction(() => {
      const result = payment(id);
      const intent = nativeIntent(id);
      const saved = db
        .prepare('SELECT payload FROM ops_native_funding_proofs WHERE payment_id=?')
        .get(id);
      if (saved) {
        if (canonical(JSON.parse(String(saved.payload))) !== canonical(data))
          throw new OperationsError(409, 'Conflicting native funding proof.');
        return result;
      }
      if (
        !['funding_pending', 'uncertain'].includes(result.status) ||
        result.funding ||
        result.failedFunding
      )
        throw new OperationsError(
          409,
          'Native funding is no longer awaiting its original transfer.',
        );
      const gas = BigInt(data.networkFeeLamports);
      const gasCents = Number(
        (gas * BigInt(intent.sourceQuote.centsPerSol) + 999_999_999n) / 1_000_000_000n,
      );
      const costOverrun =
        gas > BigInt(intent.maxNetworkFeeLamports) || data.networkFeeCents > intent.gasMaxUsdCents;
      if (
        data.amountLamports !== intent.amountLamports ||
        data.cardId !== intent.cardId ||
        data.slotNumber !== intent.slotNumber ||
        canonical(data.sourceQuote) !== canonical(intent.sourceQuote) ||
        data.sourceValueUsdCents !== intent.sourceValueUsdCents ||
        (costOverrun && !verification?.verifiedOverrun) ||
        data.networkFeeCents !== gasCents ||
        data.depositAddress === intent.creatorAddress
      )
        throw new OperationsError(
          409,
          'Native funding proof differs from its immutable source reservation.',
        );
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acceptance_funding'")
          .get() &&
        db
          .prepare('SELECT 1 FROM acceptance_funding WHERE invoice_id=? OR signature=? LIMIT 1')
          .get(data.invoiceId, data.signature)
      )
        throw new OperationsError(
          409,
          'Native funding evidence is already assigned to an owner-funded test.',
        );
      const basis = BigInt(intent.sourceAvailableCostBasisCents),
        available = BigInt(intent.sourceAvailableLamports),
        principal = BigInt(intent.amountLamports);
      const sourceCostBasisCents = Number((basis * principal) / available);
      const networkSourceCostBasisCents =
        Number((basis * (principal + gas)) / available) - sourceCostBasisCents;
      const fxAdjustmentCents =
        data.sourceValueUsdCents +
        data.networkFeeCents -
        sourceCostBasisCents -
        networkSourceCostBasisCents;
      result.funding = {
        invoiceId: data.invoiceId,
        depositAddress: data.depositAddress,
        signature: data.signature,
        transactionUrl: transactionUrl(data.signature),
        amountLamports: data.amountLamports,
        networkFeeLamports: data.networkFeeLamports,
        sourceCostBasisCents,
        networkSourceCostBasisCents,
        fxAdjustmentCents,
        amountUsdCents: data.sourceValueUsdCents,
        networkFeeCents: data.networkFeeCents,
        valuationAt: data.sourceQuote.observedAt,
        createdAt: timestamp(),
        networkFeeBooked: true,
        native: {
          version: 1,
          sourceQuote: data.sourceQuote,
          sourceValueUsdCents: data.sourceValueUsdCents,
          cardId: data.cardId,
          slotNumber: data.slotNumber,
          slot: data.slot,
          ...(costOverrun ? { costOverrun: true as const } : {}),
          conversionStatus: 'unresolved',
          conversionDifferenceUsdCents: null,
        },
      };
      db.prepare('INSERT INTO ops_native_funding_proofs VALUES(?,?,?,?)').run(
        id,
        data.signature,
        data.invoiceId,
        JSON.stringify(data),
      );
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', fxAdjustmentCents],
        ['fx', -fxAdjustmentCents],
        ['reserved', -data.networkFeeCents],
        ['cost', data.networkFeeCents],
      ]);
      result.status = costOverrun ? 'uncertain' : 'funding_submitted';
      if (costOverrun)
        result.issue =
          'Verified native gas exceeded its original ceiling. Actual costs are recorded; purchase remains blocked for reconciliation.';
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'native_funding_recorded', id, {
        signature: data.signature,
        sourceValueUsdCents: data.sourceValueUsdCents,
        sourceCostBasisCents,
        networkFeeCents: data.networkFeeCents,
      });
      return result;
    });
  }
  /** Actual same-invoice net card credit; valuation differences never establish a provider fee. */
  function recordNativeCredit(id: string, value: NativeCreditInput, actor: string) {
    const input = object(value);
    const data: NativeCreditInput = {
      invoiceId: text(input.invoiceId, 'Native invoice'),
      activityId: text(input.activityId, 'Card activity'),
      cardId: text(input.cardId, 'Card identity'),
      slotNumber: integer(input.slotNumber, 'Card slot'),
      creditedUsdCents: cents(input.creditedUsdCents, 'Actual net credit'),
      activityCreatedAt: isoDate(input.activityCreatedAt),
      source: 'coinbase_get_card_activity',
    };
    if (input.source !== data.source)
      throw new OperationsError(400, 'Authenticated native card activity is required.');
    return transaction(() => {
      const result = payment(id),
        intent = nativeIntent(id),
        funding = result.funding;
      const saved = db
        .prepare('SELECT payload FROM ops_native_credit_proofs WHERE payment_id=?')
        .get(id);
      if (saved) {
        if (canonical(JSON.parse(String(saved.payload))) !== canonical(data))
          throw new OperationsError(409, 'Conflicting native card credit proof.');
        return result;
      }
      if (
        !funding?.native ||
        funding.credit ||
        !['funding_submitted', 'uncertain'].includes(result.status)
      )
        throw new OperationsError(409, 'Native credit requires its finalized uncredited transfer.');
      if (
        data.invoiceId !== funding.invoiceId ||
        data.cardId !== intent.cardId ||
        data.slotNumber !== intent.slotNumber ||
        Date.parse(data.activityCreatedAt) > Date.now() + 5000
      )
        throw new OperationsError(
          409,
          'Native credit does not match the original invoice, card or a valid observation time.',
        );
      const difference = funding.native.sourceValueUsdCents - data.creditedUsdCents;
      funding.credit = {
        creditedUsdCents: data.creditedUsdCents,
        providerFeeCents: null,
        reference: data.activityId,
        evidenceUrl: 'https://www.coinbase.com',
        confirmedAt: timestamp(),
        verification: 'provider_verified',
        providerFeeBooked: false,
      };
      funding.native.conversionDifferenceUsdCents = difference;
      db.prepare('INSERT INTO ops_native_credit_proofs VALUES(?,?,?)').run(
        id,
        data.activityId,
        JSON.stringify(data),
      );
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', -difference],
        ['conversion_pending', difference],
      ]);
      result.status = funding.native.costOverrun
        ? 'uncertain'
        : paymentSpendableUsdCents(result) >= THRESHOLD_CENTS
          ? 'ready'
          : 'awaiting_threshold';
      if (result.status === 'awaiting_threshold')
        result.issue =
          'Actual spendable native card credit is below $50. Hold this original invoice; do not send or top up again.';
      else if (!funding.native.costOverrun) delete result.issue;
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'native_card_credit_confirmed', id, {
        creditedUsdCents: data.creditedUsdCents,
        conversionPendingCents: difference,
        providerFeeKnown: false,
      });
      return result;
    });
  }
  /** Lock the budget before preparing or broadcasting a transfer. */
  function beginFunding(id: string, value: unknown, actor: string) {
    const input = object(value);
    return command(input.idempotencyKey, `begin-funding:${id}`, {}, () => {
      const result = payment(id);
      if (result.status !== 'reserved')
        throw new OperationsError(409, 'Only an unfunded reserved payment can begin funding.');
      result.status = 'funding_pending';
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'funding_started', id, { budgetCents: result.budgetCents });
      return result;
    });
  }
  /** Record an independently verified, finalized transfer to the provider invoice address. */
  function recordFunding(id: string, value: unknown, actor: string) {
    if (payment(id).nativeFundingIntent)
      throw new OperationsError(
        409,
        'Native funding requires its authenticated native proof path.',
      );
    const input = object(value);
    const data = {
      invoiceId: text(input.invoiceId, 'Coinbase invoice ID'),
      depositAddress: base58(input.depositAddress, 32, 'Coinbase deposit address'),
      signature: base58(input.signature, 64, 'Funding signature'),
      amountLamports: lamports(input.amountLamports),
      networkFeeLamports:
        input.networkFeeLamports === undefined || input.networkFeeLamports === '0'
          ? '0'
          : lamports(input.networkFeeLamports),
      amountUsdCents: cents(input.amountUsdCents, 'Funding amount'),
      networkFeeCents: cents(input.networkFeeCents, 'Funding network fee', true),
      valuationAt: isoDate(input.valuationAt),
    };
    return transaction(() => {
      const result = payment(id);
      if (result.funding) {
        const {
          credit: _credit,
          createdAt: _createdAt,
          transactionUrl: _url,
          networkFeeBooked: _networkBooked,
          sourceCostBasisCents: _sourceBasis,
          networkSourceCostBasisCents: _networkBasis,
          fxAdjustmentCents: _fxAdjustment,
          ...old
        } = result.funding;
        if (
          canonical({ ...old, networkFeeLamports: old.networkFeeLamports ?? '0' }) !==
          canonical(data)
        )
          throw new OperationsError(
            409,
            'Conflicting funding record; a payment can have only one funding transfer.',
          );
        return result;
      }
      if (!['reserved', 'funding_pending', 'uncertain'].includes(result.status))
        throw new OperationsError(
          409,
          'Funding requires a reserved, pending, or uncertain payment.',
        );
      const assets = assetBalances(result.tokenId);
      const availableLamports = BigInt(assets.streamerAvailableLamports);
      const transferLamports = BigInt(data.amountLamports);
      const gasLamports = BigInt(data.networkFeeLamports);
      const consumedLamports = transferLamports + gasLamports;
      if (consumedLamports > availableLamports)
        throw new OperationsError(
          400,
          'Funding exceeds the SOL allocated to this token’s streamers.',
        );
      const availableBasis = BigInt(assets.streamerAvailableCostBasisCents);
      const sourceCostBasisCents = Number((availableBasis * transferLamports) / availableLamports);
      const networkSourceCostBasisCents =
        gasLamports > 0n
          ? Number((availableBasis * consumedLamports) / availableLamports) - sourceCostBasisCents
          : data.networkFeeCents;
      if (sourceCostBasisCents + networkSourceCostBasisCents > result.budgetCents)
        throw new OperationsError(
          400,
          'Funding source cost basis and network cost exceed the approved payment budget.',
        );
      const fxAdjustmentCents =
        data.amountUsdCents +
        data.networkFeeCents -
        sourceCostBasisCents -
        networkSourceCostBasisCents;
      result.funding = {
        ...data,
        sourceCostBasisCents,
        networkSourceCostBasisCents,
        fxAdjustmentCents,
        transactionUrl: transactionUrl(data.signature),
        createdAt: timestamp(),
        networkFeeBooked: true,
      };
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', fxAdjustmentCents],
        ['fx', -fxAdjustmentCents],
      ]);
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', -data.networkFeeCents],
        ['cost', data.networkFeeCents],
      ]);
      result.status = 'funding_submitted';
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'funding_recorded', id, {
        signature: data.signature,
        amountUsdCents: data.amountUsdCents,
        sourceCostBasisCents,
        networkSourceCostBasisCents,
        fxAdjustmentCents,
      });
      return result;
    });
  }
  function recordCardCredit(
    id: string,
    value: unknown,
    actor: string,
    verification: 'operator_confirmed' | 'provider_verified',
  ) {
    if (payment(id).nativeFundingIntent)
      throw new OperationsError(
        409,
        'Native credit requires actual authenticated native evidence.',
      );
    const input = object(value);
    const data = {
      creditedUsdCents: cents(input.creditedUsdCents, 'Credited amount'),
      providerFeeCents: cents(input.providerFeeCents, 'Provider fee', true),
      reference: text(input.reference, 'Credit confirmation reference'),
      evidenceUrl: httpsUrl(input.evidenceUrl),
    };
    return command(input.idempotencyKey, `credit:${id}`, { ...data, verification }, () => {
      const result = payment(id);
      if (
        !result.funding ||
        result.funding.credit ||
        !['funding_submitted', 'uncertain'].includes(result.status)
      )
        throw new OperationsError(
          409,
          'Credit confirmation requires an uncredited funding transfer.',
        );
      if (data.creditedUsdCents + data.providerFeeCents !== result.funding.amountUsdCents)
        throw new OperationsError(
          400,
          'Credited amount plus provider costs must match the funded USD amount.',
        );
      result.funding.credit = {
        ...data,
        confirmedAt: timestamp(),
        verification,
        providerFeeBooked: true,
      };
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', -data.providerFeeCents],
        ['cost', data.providerFeeCents],
      ]);
      result.status = data.creditedUsdCents >= THRESHOLD_CENTS ? 'ready' : 'awaiting_threshold';
      result.updatedAt = timestamp();
      if (result.status === 'awaiting_threshold')
        result.issue =
          'Confirmed card credit is below the $50 send threshold. Hold for operator reconciliation; do not send or top up the same invoice again.';
      else delete result.issue;
      savePayment(result);
      audit(actor, 'card_credit_confirmed', id, {
        creditedUsdCents: data.creditedUsdCents,
        providerFeeCents: data.providerFeeCents,
        verification,
      });
      return result;
    });
  }
  function confirmFunding(id: string, value: unknown, actor: string) {
    return recordCardCredit(id, value, actor, 'operator_confirmed');
  }
  /** Only the provider service may call this after authenticating its response. */
  function confirmFundingVerified(id: string, value: unknown, actor: string) {
    return recordCardCredit(id, value, actor, 'provider_verified');
  }
  function startPayment(id: string, value: unknown, actor: string) {
    const input = object(value);
    return command(input.idempotencyKey, `start:${id}`, {}, () => {
      const result = payment(id);
      if (result.status !== 'ready')
        throw new OperationsError(
          409,
          'Only a ready payment can start; reconcile an existing attempt before another spend.',
        );
      // Card spending is serialized per platform donor account, including unresolved attempts.
      const platform = token(result.tokenId).recipientPlatform;
      const busy = db
        .prepare(
          "SELECT payload FROM ops_payments WHERE status IN ('in_progress','uncertain') AND id <> ?",
        )
        .all(id)
        .map((row) => JSON.parse(row.payload as string) as OperationPayment)
        .some((other) => token(other.tokenId).recipientPlatform === platform);
      if (busy)
        throw new OperationsError(
          409,
          'This donor account has an in-progress or uncertain payment requiring reconciliation.',
        );
      result.status = 'in_progress';
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'payment_started', id, { platform });
      return result;
    });
  }
  function markUncertain(id: string, value: unknown, actor: string) {
    const input = object(value);
    const reason = text(input.reason, 'Reconciliation reason', 1000);
    return command(input.idempotencyKey, `uncertain:${id}`, { reason }, () => {
      const result = payment(id);
      if (!['funding_pending', 'funding_submitted', 'ready', 'in_progress'].includes(result.status))
        throw new OperationsError(
          409,
          'Only a submitted or active payment may enter reconciliation.',
        );
      result.status = 'uncertain';
      result.issue = reason;
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'payment_uncertain', id, { reason });
      return result;
    });
  }
  function validateCompletionEvidence(id: string, value: unknown) {
    const input = object(value);
    const kind = input.kind;
    if (kind !== 'bits' && kind !== 'kicks' && kind !== 'gift_sub' && kind !== 'tip')
      throw new OperationsError(400, 'Choose a supported donation kind.');
    const giftUnits =
      input.giftUnits === undefined ? undefined : integer(input.giftUnits, 'Gift units');
    if (giftUnits === 0) throw new OperationsError(400, 'Gift units must be positive.');
    const data = {
      spentUsdCents: cents(input.spentUsdCents, 'Actual amount spent'),
      ...readOperatorConfirmation(input),
      kind: kind as NonNullable<OperationPayment['completion']>['kind'],
      ...(giftUnits !== undefined ? { giftUnits } : {}),
      ...(input.note === undefined || input.note === ''
        ? {}
        : { note: text(input.note, 'Operator note', 1000) }),
    };
    const idempotencyKey = text(input.idempotencyKey, 'Idempotency key', 160);
    const previous = db
      .prepare('SELECT fingerprint FROM ops_commands WHERE idempotency_key=?')
      .get(idempotencyKey);
    if (previous && previous.fingerprint !== canonical({ action: `complete:${id}`, input: data }))
      throw new OperationsError(409, 'Conflicting duplicate idempotency key.');
    const assigned = db
      .prepare(
        "SELECT id FROM ops_payments WHERE id<>? AND (confirmation_url=? OR json_extract(payload,'$.completion.paymentReference')=? OR json_extract(payload,'$.completion.nativeReceiptId')=? OR json_extract(payload,'$.completion.cardActivityId')=?) LIMIT 1",
      )
      .get(
        id,
        data.confirmationUrl ?? null,
        data.paymentReference ?? null,
        data.paymentReference ?? null,
        data.paymentReference ?? null,
      );
    if (assigned)
      throw new OperationsError(
        409,
        'This purchase reference or invoice is already assigned to another payment.',
      );
    if (
      data.paymentReference &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_manual_donations'",
        )
        .get() &&
      db
        .prepare(
          'SELECT id FROM public_manual_donations WHERE native_receipt_id=? OR card_activity_id=? LIMIT 1',
        )
        .get(data.paymentReference, data.paymentReference)
    )
      throw new OperationsError(
        409,
        'This purchase reference is already assigned to a reviewed manual donation.',
      );
    return data;
  }
  /** Neither this method nor its evidence discriminator is reachable through route(). */
  function completePaymentVerified(
    id: string,
    value: VerifiedPaymentCompletionEvidence,
    actor: string,
  ) {
    const input = object(value),
      charge = object(input.cardCharge);
    const evidence: VerifiedPaymentCompletionEvidence = {
      paymentId: text(input.paymentId, 'Payment identity'),
      accountId: text(input.accountId, 'Donor account'),
      recipientProviderId: text(input.recipientProviderId, 'Stable recipient identity'),
      recipientUsername: text(input.recipientUsername, 'Recipient username'),
      giftUnits: integer(input.giftUnits, 'Gift units'),
      nativeCurrency: input.nativeCurrency as 'USD' | 'HKD',
      nativeTotalMinorUnits: cents(input.nativeTotalMinorUnits, 'Native checkout total'),
      quoteObservedAt: isoDate(input.quoteObservedAt),
      submittedAt: isoDate(input.submittedAt),
      deliveryCompletedAt: isoDate(input.deliveryCompletedAt),
      deliveryEvidenceDigest: text(
        input.deliveryEvidenceDigest,
        'Browser delivery evidence digest',
        64,
      ),
      cardCharge: {
        activityId: text(charge.activityId, 'Authenticated card activity', 128),
        amountUsdCents: cents(charge.amountUsdCents, 'Authenticated card amount'),
        currency: charge.currency as 'USD',
        merchant: text(charge.merchant, 'Card merchant'),
        status: charge.status as AcceptanceCardCharge['status'],
        activityCreatedAt: isoDate(charge.activityCreatedAt),
      },
      ...(input.nativeReceiptId === undefined
        ? {}
        : { nativeReceiptId: text(input.nativeReceiptId, 'Native receipt', 128) }),
      ...(input.confirmationUrl === undefined
        ? {}
        : { confirmationUrl: httpsUrl(input.confirmationUrl) }),
    };
    if (
      evidence.paymentId !== id ||
      !/^twitch:[0-9]+$/.test(evidence.recipientProviderId) ||
      !/^[a-f0-9]{64}$/.test(evidence.deliveryEvidenceDigest) ||
      evidence.giftUnits < 1 ||
      !['USD', 'HKD'].includes(evidence.nativeCurrency) ||
      evidence.nativeTotalMinorUnits < 1 ||
      evidence.cardCharge.currency !== 'USD' ||
      evidence.cardCharge.amountUsdCents < 1 ||
      !['AUTHORIZED', 'COMPLETED'].includes(evidence.cardCharge.status) ||
      !/\btwitch\b/i.test(evidence.cardCharge.merchant) ||
      Date.parse(evidence.quoteObservedAt) > Date.parse(evidence.submittedAt) ||
      Date.parse(evidence.submittedAt) > Date.parse(evidence.deliveryCompletedAt) ||
      Date.parse(evidence.deliveryCompletedAt) > Date.now() + 5000 ||
      Date.parse(evidence.cardCharge.activityCreatedAt) < Date.parse(evidence.submittedAt) - 5000 ||
      Date.parse(evidence.cardCharge.activityCreatedAt) > Date.now() + 5000 ||
      (evidence.nativeCurrency === 'USD' &&
        evidence.nativeTotalMinorUnits !== evidence.cardCharge.amountUsdCents)
    )
      throw new OperationsError(
        409,
        'Independent browser delivery and authenticated card evidence must match the bound purchase.',
      );
    return finishPayment(id, { idempotencyKey: `verified-completion:${id}` }, actor, evidence);
  }
  function assertVerifiedEvidenceUnused(id: string, evidence: VerifiedPaymentCompletionEvidence) {
    const references = [
      evidence.cardCharge.activityId,
      evidence.nativeReceiptId ?? evidence.cardCharge.activityId,
    ];
    const exists = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const assigned = db
      .prepare(
        `SELECT id FROM ops_payments WHERE id<>? AND (
      json_extract(payload,'$.completion.paymentReference') IN (?,?) OR
      json_extract(payload,'$.completion.nativeReceiptId') IN (?,?) OR
      json_extract(payload,'$.completion.cardActivityId') IN (?,?) OR confirmation_url=?) LIMIT 1`,
      )
      .get(id, ...references, ...references, ...references, evidence.confirmationUrl ?? null);
    if (
      assigned ||
      (exists('public_manual_donations') &&
        db
          .prepare(
            'SELECT 1 FROM public_manual_donations WHERE native_receipt_id IN (?,?) OR card_activity_id IN (?,?)',
          )
          .get(...references, ...references)) ||
      (exists('acceptance_gifts') &&
        db
          .prepare(
            `SELECT 1 FROM acceptance_gifts WHERE card_activity_id IN (?,?) OR json_extract(payload,'$.evidence.nativeReceiptId') IN (?,?) OR json_extract(payload,'$.cardCharge.activityId') IN (?,?)`,
          )
          .get(...references, ...references, ...references)) ||
      db
        .prepare(
          'SELECT 1 FROM worker_checkout_receipts WHERE payment_id<>? AND platform=? AND receipt_id IN (?,?)',
        )
        .get(id, 'twitch', ...references)
    )
      throw new OperationsError(
        409,
        'This card activity or native receipt is already assigned to another donation.',
      );
  }
  function completePayment(id: string, value: unknown, actor: string) {
    return finishPayment(id, value, actor);
  }
  function finishPayment(
    id: string,
    value: unknown,
    actor: string,
    evidence?: VerifiedPaymentCompletionEvidence,
  ) {
    const input = object(value);
    const data = evidence
      ? {
          spentUsdCents: evidence.cardCharge.amountUsdCents,
          kind: 'gift_sub' as const,
          giftUnits: evidence.giftUnits,
          paymentReference: evidence.cardCharge.activityId,
          cardActivityId: evidence.cardCharge.activityId,
          cardChargeStatus: evidence.cardCharge.status,
          ...(evidence.nativeReceiptId ? { nativeReceiptId: evidence.nativeReceiptId } : {}),
          ...(evidence.confirmationUrl ? { confirmationUrl: evidence.confirmationUrl } : {}),
        }
      : validateCompletionEvidence(id, input);
    const kind = data.kind;
    // The scheduling minimum must not hide an already-paid operator gift.
    // Only explicit reconciliation of an eligible funded payout may record a
    // smaller actual purchase; reservation, funding and checkout gates stay intact.
    if (
      !evidence &&
      data.spentUsdCents < THRESHOLD_CENTS &&
      (input.completionAttested !== true ||
        (payment(id).funding?.credit?.creditedUsdCents ?? 0) < THRESHOLD_CENTS)
    )
      throw new OperationsError(
        400,
        'The actual donation must meet the $50 USD sending threshold.',
      );
    return command(
      input.idempotencyKey,
      evidence ? `complete-verified:${id}` : `complete:${id}`,
      evidence ?? data,
      () => {
        const result = payment(id);
        if (
          !['ready', 'in_progress', 'uncertain'].includes(result.status) ||
          !result.funding?.credit
        )
          throw new OperationsError(
            409,
            'Completion requires credited funding and a ready, active, or uncertain payment; completed payments cannot be repeated.',
          );
        const recipient = token(result.tokenId);
        if (evidence) {
          if (
            !result.funding.native ||
            result.funding.credit.verification !== 'provider_verified' ||
            result.funding.credit.creditedUsdCents < THRESHOLD_CENTS ||
            paymentSpendableUsdCents(result) < THRESHOLD_CENTS
          )
            throw new OperationsError(
              409,
              'Verified completion requires eligible native funding at the $50 threshold.',
            );
          if (
            recipient.recipientPlatform !== 'twitch' ||
            recipient.recipientUsername !== evidence.recipientUsername
          )
            throw new OperationsError(
              409,
              'Verified recipient does not match this payment allocation.',
            );
          assertVerifiedEvidenceUnused(id, evidence);
          db.prepare('INSERT INTO ops_verified_payment_completions VALUES(?,?,?,?)').run(
            id,
            evidence.cardCharge.activityId,
            evidence.nativeReceiptId ?? null,
            JSON.stringify(evidence),
          );
          if (evidence.nativeReceiptId)
            db.prepare('INSERT INTO worker_checkout_receipts VALUES(?,?,?,?)').run(
              'twitch',
              evidence.accountId,
              evidence.nativeReceiptId,
              id,
            );
        }
        if (
          (kind === 'bits' && recipient.recipientPlatform !== 'twitch') ||
          (kind === 'kicks' && recipient.recipientPlatform !== 'kick')
        )
          throw new OperationsError(400, 'Gift kind does not match the recipient platform.');
        if (data.spentUsdCents > result.funding.credit.creditedUsdCents)
          throw new OperationsError(400, 'Actual spend exceeds the confirmed card credit.');
        if (result.funding.native && data.spentUsdCents > paymentSpendableUsdCents(result))
          throw new OperationsError(
            400,
            'Actual spend exceeds the original native purchase allowance.',
          );
        const knownProviderFee = result.funding.native ? 0 : result.funding.credit.providerFeeCents;
        if (knownProviderFee === null)
          throw new OperationsError(409, 'Legacy funding requires verified provider costs.');
        const costs = result.funding.networkFeeCents + knownProviderFee;
        if (data.spentUsdCents + costs > result.budgetCents)
          throw new OperationsError(
            400,
            'The actual spend plus funding costs exceeds the approved payment budget.',
          );
        const bookedCosts =
          (result.funding.networkFeeBooked ? result.funding.networkFeeCents : 0) +
          (result.funding.credit.providerFeeBooked ? knownProviderFee : 0);
        const cardResidual = result.funding.credit.creditedUsdCents - data.spentUsdCents;
        const unfunded =
          result.budgetCents -
          (result.funding.sourceCostBasisCents ?? result.funding.amountUsdCents) -
          (result.funding.networkSourceCostBasisCents ?? result.funding.networkFeeCents);
        journal(randomUUID(), result.tokenId, id, [
          [
            'reserved',
            -(
              result.budgetCents +
              (result.funding.fxAdjustmentCents ?? 0) -
              bookedCosts -
              (result.funding.native?.conversionDifferenceUsdCents ?? 0)
            ),
          ],
          ['spent', data.spentUsdCents],
          ['cost', costs - bookedCosts],
          ['card_residual', cardResidual],
          ['available', unfunded],
        ]);
        result.completion = {
          ...data,
          completedAt: evidence?.deliveryCompletedAt ?? timestamp(),
          verification: evidence ? 'browser_observed_card_verified' : 'operator_confirmed',
        };
        result.status = 'completed';
        result.updatedAt = timestamp();
        delete result.issue;
        savePayment(result);
        audit(
          actor,
          evidence ? 'donation_browser_card_verified' : 'donation_operator_confirmed',
          id,
          {
            spentUsdCents: data.spentUsdCents,
            cardResidualCents: cardResidual,
            verification: result.completion.verification,
          },
        );
        return result;
      },
    );
  }
  function cancelPayment(id: string, value: unknown, actor: string) {
    const input = object(value);
    const reason = text(input.reason, 'Cancellation reason', 1000);
    return command(input.idempotencyKey, `cancel:${id}`, { reason }, () => {
      const result = payment(id);
      if (result.status !== 'reserved' || result.funding)
        throw new OperationsError(
          409,
          'Only an unfunded reserved payment can be cancelled. Sent or uncertain funds require reconciliation.',
        );
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', -result.budgetCents],
        ['available', result.budgetCents],
      ]);
      result.status = 'cancelled';
      result.issue = reason;
      result.updatedAt = timestamp();
      savePayment(result);
      audit(actor, 'payment_cancelled', id, { reason });
      return result;
    });
  }
  /** Trusted service only: the caller verifies a finalized failed receipt with no transfer. */
  function resolveFailedFunding(
    id: string,
    value: unknown,
    actor: string,
    verification?: { verifiedOverrun: true },
  ) {
    const input = object(value);
    if (input.confirmation !== 'finalized_failure')
      throw new OperationsError(
        400,
        'Only a definitively finalized failed receipt can release funding; timeout or expiry is not proof.',
      );
    const data = {
      signature: base58(input.signature, 64, 'Failed funding signature'),
      networkFeeLamports:
        input.networkFeeLamports === '0' ? '0' : lamports(input.networkFeeLamports),
      networkFeeCents: cents(input.networkFeeCents, 'Failed funding network cost', true),
      valuationAt: isoDate(input.valuationAt),
      confirmation: 'finalized_failure' as const,
    };
    return command(input.idempotencyKey, `failed-funding:${id}`, data, () => {
      const result = payment(id);
      if (result.nativeFundingIntent && result.failedFunding) {
        nativeIntent(id);
        const original = Object.fromEntries(
          Object.keys(data).map((key) => [
            key,
            result.failedFunding![key as keyof NonNullable<OperationPayment['failedFunding']>],
          ]),
        );
        if (canonical(original) !== canonical(data))
          throw new OperationsError(409, 'Conflicting finalized native failure proof.');
        return result;
      }

      if (
        !['funding_pending', 'uncertain'].includes(result.status) ||
        result.funding ||
        result.failedFunding
      )
        throw new OperationsError(
          409,
          'Only an uncredited pending or uncertain funding attempt can be resolved as failed.',
        );
      const assets = assetBalances(result.tokenId);
      const intent = result.nativeFundingIntent ? nativeIntent(id) : undefined;
      const availableLamports = intent
        ? BigInt(intent.sourceAvailableLamports)
        : BigInt(assets.streamerAvailableLamports);
      const gasLamports = BigInt(data.networkFeeLamports);
      const costOverrun =
        intent &&
        (gasLamports > BigInt(intent.maxNetworkFeeLamports) ||
          data.networkFeeCents > intent.gasMaxUsdCents);
      if (intent) {
        const gasCents = Number(
          (gasLamports * BigInt(intent.sourceQuote.centsPerSol) + 999_999_999n) / 1_000_000_000n,
        );
        if (
          data.valuationAt !== intent.sourceQuote.observedAt ||
          data.networkFeeCents !== gasCents ||
          (costOverrun && !verification?.verifiedOverrun)
        )
          throw new OperationsError(
            409,
            'Failed native funding proof differs from its original source reservation.',
          );
      }
      if (gasLamports > availableLamports && !(intent && verification?.verifiedOverrun))
        throw new OperationsError(
          409,
          'Failed transaction gas exceeds this token’s remaining streamer SOL allocation.',
        );
      const sourceCostBasisCents =
        gasLamports === 0n
          ? 0
          : Number(
              (BigInt(
                intent?.sourceAvailableCostBasisCents ?? assets.streamerAvailableCostBasisCents,
              ) *
                gasLamports) /
                availableLamports,
            );
      if (sourceCostBasisCents > result.budgetCents && !(intent && verification?.verifiedOverrun))
        throw new OperationsError(
          409,
          'Failed transaction source cost exceeds the reserved budget.',
        );
      const fxAdjustmentCents = data.networkFeeCents - sourceCostBasisCents;
      const releasedCents = result.budgetCents - sourceCostBasisCents;
      journal(randomUUID(), result.tokenId, id, [
        ['reserved', fxAdjustmentCents],
        ['fx', -fxAdjustmentCents],
        ['reserved', -data.networkFeeCents],
        ['cost', data.networkFeeCents],
        ['reserved', -releasedCents],
        ['available', releasedCents],
      ]);
      result.failedFunding = {
        ...data,
        transactionUrl: transactionUrl(data.signature),
        sourceCostBasisCents,
        fxAdjustmentCents,
        releasedCents,
        verification: 'chain_verified',
        ...(costOverrun ? { costOverrun: true as const } : {}),
        reconciledAt: timestamp(),
      };
      result.status = 'cancelled';
      result.updatedAt = timestamp();
      result.issue =
        'Funding failed on chain. Verified gas was recorded and the unspent reservation was released.';
      savePayment(result);
      audit(actor, 'funding_failure_reconciled', id, {
        signature: data.signature,
        networkFeeCents: data.networkFeeCents,
        sourceCostBasisCents,
        fxAdjustmentCents,
        releasedCents,
      });
      return result;
    });
  }
  function publicDonations() {
    return db
      .prepare(
        "SELECT payload FROM ops_payments WHERE status='completed' ORDER BY rowid DESC LIMIT 200",
      )
      .all()
      .map((row) => {
        const result = JSON.parse(row.payload as string) as OperationPayment;
        const recipient = token(result.tokenId);
        return {
          id: result.id,
          tokenId: result.tokenId,
          tokenName: recipient.name,
          tokenSymbol: recipient.symbol,
          mint: recipient.mint,
          chain: 'solana',
          launchpad: 'pump',
          recipientPlatform: recipient.recipientPlatform,
          recipientUsername: recipient.recipientUsername,
          channelUrl: recipient.channelUrl,
          spentUsdCents: result.completion!.spentUsdCents,
          streamerNetUsdCents: null,
          kind: result.completion!.kind,
          giftUnits: result.completion!.giftUnits ?? null,
          completedAt: result.completion!.completedAt,
          verification: result.completion!.verification,
          ...(result.completion!.cardChargeStatus
            ? { cardChargeStatus: result.completion!.cardChargeStatus }
            : {}),
          fundingTransactionUrl: result.funding!.transactionUrl,
          confirmationUrl: result.completion!.confirmationUrl,
        };
      });
  }
  function snapshot() {
    const tokens = db
      .prepare('SELECT payload FROM ops_tokens ORDER BY rowid')
      .all()
      .map((row) => {
        const result = JSON.parse(row.payload as string) as RegisteredToken;
        return {
          ...result,
          balances: balances(result.id),
          assetBalances: assetBalances(result.id),
        };
      });
    const totals: Balances = {
      claimedCents: 0,
      availableCents: 0,
      reservedCents: 0,
      buybackCents: 0,
      spentCents: 0,
      costCents: 0,
      cardResidualCents: 0,
      claimNetworkFeeCents: 0,
      fxAdjustmentCents: 0,
      conversionPendingCents: 0,
    };
    const platforms = platformTokens().map((t) => ({
      ...t,
      balances: balances(t.id),
      assetBalances: assetBalances(t.id),
    }));
    for (const entry of [...tokens, ...platforms])
      for (const key of Object.keys(totals) as (keyof Balances)[]) {
        totals[key] += entry.balances[key];
        if (!Number.isSafeInteger(totals[key]))
          throw new Error('Aggregate accounting limit exceeded.');
      }
    const payments = db
      .prepare('SELECT payload FROM ops_payments ORDER BY rowid DESC')
      .all()
      .map((row) => {
        const result = JSON.parse(row.payload as string) as OperationPayment;
        return { ...result, token: token(result.tokenId) };
      });
    const claims = db
      .prepare('SELECT payload FROM ops_claims ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.payload as string) as Claim);
    const auditTrail = db
      .prepare('SELECT * FROM ops_audit ORDER BY id DESC LIMIT 100')
      .all()
      .map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        entityId: row.entity_id,
        detail: JSON.parse(row.detail as string),
        createdAt: row.created_at,
      }));
    return {
      tokens,
      platformTokens: platforms,
      treasury: treasurySnapshot(),
      claims,
      failedClaimCosts: db
        .prepare('SELECT payload FROM ops_claim_costs ORDER BY rowid DESC')
        .all()
        .map((row) => JSON.parse(String(row.payload)) as FailedClaimCost),
      payments,
      totals,
      audit: auditTrail,
      configuration: {
        currency: 'USD',
        claimThresholdCents: THRESHOLD_CENTS,
        payoutThresholdCents: THRESHOLD_CENTS,
        streamerPercent: policy.streamerBps / 100,
        buybackPercent: (10000 - policy.streamerBps) / 100,
        activeChains: ['solana'],
        activeLaunchpads: ['pump'],
        activeRecipientPlatforms: ['twitch', 'kick'],
        fundingProvider: 'coinbase',
        paymentMode: 'autonomous',
        claimNetworkFees: 'Reported separately; paid by operating treasury',
        unspentCardCredit: 'Held for reconciliation; never automatically funded again',
      },
    };
  }
  return {
    snapshot,
    feeTokens,
    registerPlatformToken,
    treasurySource,
    treasuryCustody,
    treasurySnapshot,
    recordTreasuryReceipt,
    publicDonations,
    registerToken,
    recordClaim,
    recordFailedClaimCost,
    reservePayment,
    beginFunding,
    recordFunding,
    reserveNativeFunding,
    recordNativeFunding,
    recordNativeCredit,
    confirmFunding,
    confirmFundingVerified,
    startPayment,
    markUncertain,
    completePayment,
    completePaymentVerified,
    validateCompletionEvidence,
    cancelPayment,
    resolveFailedFunding,
  };
}

export type OperationsService = ReturnType<typeof createOperations>;
export type OperationsSnapshot = ReturnType<OperationsService['snapshot']>;
export type PublicDonation = ReturnType<OperationsService['publicDonations']>[number];
