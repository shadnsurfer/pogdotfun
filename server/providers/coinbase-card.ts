/** Coinbase One is a credit card. Exchange cash is never card credit evidence. */
export interface CoinbaseCardBalanceEvidence {
  cardAccountId: string;
  currency: 'USD';
  availableCreditCents: string;
  observedAt: number;
  active: boolean;
  evidenceId: string;
}
export interface CoinbaseCardChargeEvidence {
  cardAccountId: string;
  chargeId: string;
  merchant: string;
  currency: 'USD';
  amountCents: string;
  status: 'pending' | 'posted' | 'reversed';
  observedAt: number;
  evidenceId: string;
}
/** Implement only against an authenticated, supported card-data integration (e.g. consented Plaid).
 * This is a trusted server adapter boundary, never an operator-supplied evidence JSON endpoint. */
export interface CoinbaseCardEvidenceSource {
  readBalance(cardAccountId: string): Promise<CoinbaseCardBalanceEvidence | null>;
  readCharge(cardAccountId: string, chargeId: string): Promise<CoinbaseCardChargeEvidence | null>;
}
export type CoinbaseCardReadinessResult =
  { ready: false; reason: string } | { ready: true; evidence: CoinbaseCardBalanceEvidence };
export class CoinbaseCardReadiness {
  constructor(
    private readonly source?: CoinbaseCardEvidenceSource,
    private readonly options: { now?: () => number; maxAgeMs?: number } = {},
  ) {}
  async check(input: {
    cardAccountId: string;
    requiredUsdCents: string;
  }): Promise<CoinbaseCardReadinessResult> {
    if (!this.source) return { ready: false, reason: 'card_evidence_source_unavailable' };
    if (!input.cardAccountId || !/^[1-9]\d{0,19}$/.test(input.requiredUsdCents))
      return { ready: false, reason: 'invalid_card_request' };
    try {
      const evidence = await this.source.readBalance(input.cardAccountId);
      const now = (this.options.now ?? Date.now)();
      const maxAge = this.options.maxAgeMs ?? 60_000;
      if (
        !Number.isFinite(maxAge) ||
        maxAge <= 0 ||
        maxAge > 300_000 ||
        !evidence ||
        evidence.cardAccountId !== input.cardAccountId ||
        evidence.currency !== 'USD' ||
        !evidence.active ||
        !evidence.evidenceId ||
        !Number.isFinite(evidence.observedAt) ||
        evidence.observedAt > now ||
        now - evidence.observedAt > maxAge ||
        !/^(0|[1-9]\d{0,19})$/.test(evidence.availableCreditCents)
      )
        return { ready: false, reason: 'card_evidence_invalid_or_stale' };
      if (BigInt(evidence.availableCreditCents) < BigInt(input.requiredUsdCents))
        return { ready: false, reason: 'insufficient_available_credit' };
      return { ready: true, evidence };
    } catch {
      return { ready: false, reason: 'card_evidence_unavailable' };
    }
  }
}
