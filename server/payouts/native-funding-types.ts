import type { SolUsdQuote } from '../providers/contracts.ts';

export interface NativeFundingReservation {
  amountLamports: string;
  maxNetworkFeeLamports: string;
  sourceQuote: SolUsdQuote;
  cardId: string;
  slotNumber: number;
  giftMaxUsdCents: number;
  conversionMaxUsdCents: number;
  gasMaxUsdCents: number;
}
export interface NativeFundingIntent extends NativeFundingReservation {
  version: 1;
  paymentId: string;
  tokenId: string;
  creatorAddress: string;
  sourceAvailableLamports: string;
  sourceAvailableCostBasisCents: number;
  reservedSourceCostBasisCents: number;
  sourceValueUsdCents: number;
  createdAt: string;
}
export interface NativeFundingInput {
  invoiceId: string;
  depositAddress: string;
  signature: string;
  amountLamports: string;
  networkFeeLamports: string;
  sourceValueUsdCents: number;
  networkFeeCents: number;
  sourceQuote: SolUsdQuote;
  slotNumber: number;
  cardId: string;
  confirmation: 'finalized';
  slot: number;
}
export interface NativeCreditInput {
  invoiceId: string;
  activityId: string;
  cardId: string;
  slotNumber: number;
  creditedUsdCents: number;
  activityCreatedAt: string;
  source: 'coinbase_get_card_activity';
}
export interface NativeFundingMetadata {
  version: 1;
  sourceQuote: SolUsdQuote;
  sourceValueUsdCents: number;
  cardId: string;
  slotNumber: number;
  slot: number;
  /** Verified incurred gas exceeded policy; reconciliation never restores spend authority. */
  costOverrun?: true;
  conversionStatus: 'unresolved';
  conversionDifferenceUsdCents: number | null;
}
