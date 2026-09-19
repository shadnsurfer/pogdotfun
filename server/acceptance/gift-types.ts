import type { DonationRecipientProfile } from '../public/donation-recipients.ts';

interface AcceptanceGiftQuoteBase {
  accountId: string;
  recipientPlatform: 'twitch' | 'kick';
  recipientUsername: string;
  recipientProviderId: string;
  kind: 'gift_sub';
  giftUnits: number;
  nativeTotalMinorUnits: number;
  observedAt: string;
}

export type AcceptanceGiftQuote = AcceptanceGiftQuoteBase &
  (
    | { nativeCurrency: 'USD'; totalUsdCents: number }
    | { recipientPlatform: 'twitch'; nativeCurrency: 'HKD'; totalUsdCents?: never }
  );

/** HKD has no promised USD rate. This server-derived allowance detects overruns;
 * it is not an issuer-enforced exchange quote or a guaranteed maximum charge. */
export type AcceptanceStoredGiftQuote =
  | Extract<AcceptanceGiftQuote, { nativeCurrency: 'USD' }>
  | (Extract<AcceptanceGiftQuote, { nativeCurrency: 'HKD' }> & { usdCeilingCents: number });

/** Native checkout evidence; only the trusted driver path can attest browser observation. */
export type AcceptanceGiftEvidence = AcceptanceGiftQuote & {
  nativeReceiptId: string;
  cardActivityId: string;
  completedAt: string;
  confirmationObserved: true;
};

export interface AcceptanceCardCharge {
  activityId: string;
  amountUsdCents: number;
  currency: 'USD';
  merchant: string;
  status: 'AUTHORIZED' | 'COMPLETED';
  activityCreatedAt: string;
}

export interface PublicAcceptanceReceipt {
  recipientProfile?: DonationRecipientProfile;
  id: string;
  origin: 'owner_funded_acceptance';
  sourceLabel: 'Owner-funded test';
  executionMode: 'assisted' | 'autonomous';
  verification: 'operator_reviewed_card_verified' | 'browser_observed_card_verified';
  recipientPlatform: 'twitch' | 'kick';
  recipientUsername: string;
  channelUrl: string;
  kind: 'gift_sub';
  giftUnits: number;
  nativeCurrency: 'USD' | 'HKD';
  nativeTotalMinorUnits: number;
  spentUsdCents: number;
  streamerNetUsdCents: null;
  fundingAmountLamports: string;
  fundingTransactionUrl: string;
  cardCreditUsdCents: number;
  cardChargeStatus: 'AUTHORIZED' | 'COMPLETED';
  completedAt: string;
  receiptUrl: string;
}

export interface AcceptanceGiftRecord {
  id: string;
  fundingRequestId: string;
  operator: string;
  accountId: 'pogdotfun';
  status: 'in_progress' | 'outcome_unknown' | 'receipt_review' | 'completed';
  recipient: { platform: 'twitch' | 'kick'; username: string; providerId: string };
  fundingSignature: string;
  fundingAmountLamports: string;
  cardCreditUsdCents: number;
  maxSpendUsdCents: number;
  budgetOperationId: string;
  /** Trusted start intent only; absent on legacy assisted records. */
  automationOnly?: true;
  /** Set only after durable browser ownership is verified. */
  executionMode?: 'assisted' | 'autonomous';
  automatedBinding?: {
    generation?: 1;
    attemptId: string;
    contextId: string;
    sessionId: string;
    leaseId: string;
  };
  browserAttemptId?: string;
  budgetAttemptId?: string;
  quote?: AcceptanceStoredGiftQuote;
  evidence?: AcceptanceGiftEvidence;
  cardCharge?: AcceptanceCardCharge;
  receipt?: PublicAcceptanceReceipt;
  createdAt: string;
  updatedAt: string;
}

export class AcceptanceGiftError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
