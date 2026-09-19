import type { AcceptanceGiftQuote, AcceptanceGiftEvidence } from './gift-types.ts';
import type { OwnedPage, OwnedBrowserLease } from '../providers/browserbase-cdp.ts';
import type { TwitchGiftIntent } from '../providers/twitch-checkout.ts';
export interface AutomaticDelivery {
  completedAt: string;
  evidenceDigest: string;
}
export interface AutomaticReceipt {
  evidence: Omit<AcceptanceGiftEvidence, 'cardActivityId'>;
  source: { emailId: string; receivedAt: string; evidenceDigest: string };
}
export interface AutomaticDriver {
  prepare(scope: OwnedPage, intent: TwitchGiftIntent): Promise<AcceptanceGiftQuote>;
  readQuote(scope: OwnedPage, intent: TwitchGiftIntent): Promise<AcceptanceGiftQuote>;
  submit(
    scope: OwnedPage,
    intent: TwitchGiftIntent,
    quote: AcceptanceGiftQuote,
    beforeSubmit: () => void,
  ): Promise<AutomaticDelivery>;
  inspect(scope: OwnedPage, intent?: TwitchGiftIntent): Promise<unknown>;
}
export interface AutomaticConnector {
  hasActiveConnection(sessionId: string): boolean;
  withOwnedPage<T>(lease: OwnedBrowserLease, work: (scope: OwnedPage) => Promise<T>): Promise<T>;
}
