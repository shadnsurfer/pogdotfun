export interface TokenFeeMapping {
  tokenId: string;
  mint: string;
  creator: string;
  /** An operator verifies that this creator wallet is used for this mint alone. */
  dedicatedCreatorVerified: boolean;
}

export interface SolUsdQuote {
  /** USD cents per SOL, fixed-point; never a binary floating-point amount. */
  centsPerSol: string;
  observedAt: string;
  source: string;
}

export interface PreparedTransaction {
  id: string;
  kind: 'claim' | 'topup';
  tokenId: string;
  mint: string;
  creator: string;
  signature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  createdAt: string;
  amountLamports?: string;
  destination?: string;
  networkFeeLamports?: string;
}

export type TransactionState =
  | 'prepared'
  | 'broadcast'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'expired_review'
  | 'retired_expired';

export interface JournalTransaction extends PreparedTransaction {
  state: TransactionState;
  detail?: string;
}

export interface TransactionJournal {
  get(id: string): JournalTransaction | undefined;
  /** Must be atomic and durable. An existing ID may never be overwritten. */
  insert(transaction: PreparedTransaction): JournalTransaction;
  update(id: string, state: TransactionState, detail?: string): void;
}

export interface FinalizedTransferProof {
  signature: string;
  slot: number;
  confirmation: 'finalized';
  amountLamports: string;
  networkFeeLamports: string;
}

export interface FundingDestination {
  address: string;
  network: 'solana';
  asset: 'SOL';
  reference: string;
  accountId: string;
  expiresAt: string;
  /** Must come from an authenticated, validated Coinbase deposit-address response. */
  verifiedAt: string;
}

export function valueLamportsInUsdCents(
  lamports: bigint,
  quote: SolUsdQuote,
  now = Date.now(),
  maximumAgeMs = 60_000,
): number {
  const observed = Date.parse(quote.observedAt);
  if (
    lamports < 0n ||
    !/^\d+$/.test(quote.centsPerSol) ||
    BigInt(quote.centsPerSol) <= 0n ||
    !quote.source?.trim() ||
    !Number.isFinite(observed) ||
    observed > now + 5_000 ||
    now - observed > maximumAgeMs
  ) {
    throw new Error('A fresh, identified SOL/USD quote is required.');
  }
  const cents = (lamports * BigInt(quote.centsPerSol)) / 1_000_000_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('USD value exceeds safe range.');
  return Number(cents);
}
