/** Split only the creator fees actually claimed, never gross trading fees. */
export function allocateClaimedFees(claimedBaseUnits: bigint) {
  if (typeof claimedBaseUnits !== 'bigint' || claimedBaseUnits <= 0n) {
    throw new RangeError('Claimed fees must be a positive bigint in base units.');
  }
  const buybackBaseUnits = (claimedBaseUnits * 2000n) / 10000n;
  return {
    claimedBaseUnits,
    streamerBaseUnits: claimedBaseUnits - buybackBaseUnits,
    buybackBaseUnits,
  };
}

export type PayoutStatus = 'accrued' | 'claimed' | 'converted' | 'submitted' | 'settled' | 'failed';

export interface Payout {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: PayoutStatus;
  readonly processedEvents: Readonly<Record<string, string>>;
  readonly settlementReference?: string;
}

type EventIdentity = { id: string; payoutId: string };
export type PayoutEvent = EventIdentity &
  (
    | {
        type:
          | 'claim_confirmed'
          | 'conversion_settled'
          | 'payout_submitted'
          | 'payout_failed'
          | 'alert_observed';
      }
    | { type: 'payout_settled'; amountMinor: bigint; currency: string; providerReference: string }
  );

export function createPayout(input: { id: string; amountMinor: bigint; currency: string }): Payout {
  if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('A payout ID is required.');
  if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) {
    throw new RangeError('Expected payout amount must be a positive bigint in fiat minor units.');
  }
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new Error('Currency must be a three-letter uppercase code.');
  return { ...input, status: 'accrued', processedEvents: {} };
}

/** Call only after the provider adapter has authenticated and reconciled its event. */
export function transitionPayout(payout: Payout, event: PayoutEvent): Payout {
  if (!event.id?.trim() || event.payoutId !== payout.id) throw new Error('Invalid event identity.');
  const fingerprint =
    event.type === 'payout_settled'
      ? JSON.stringify([
          event.type,
          String(event.amountMinor),
          event.currency,
          event.providerReference,
        ])
      : JSON.stringify([event.type]);
  if (Object.hasOwn(payout.processedEvents, event.id)) {
    if (payout.processedEvents[event.id] !== fingerprint)
      throw new Error('Conflicting duplicate event.');
    return payout;
  }

  let status = payout.status;
  let settlementReference = payout.settlementReference;
  if (event.type === 'alert_observed') {
    // An on-screen alert says nothing about payment settlement.
  } else if (event.type === 'payout_failed' && !['settled', 'failed'].includes(status)) {
    status = 'failed';
  } else if (event.type === 'claim_confirmed' && status === 'accrued') {
    status = 'claimed';
  } else if (event.type === 'conversion_settled' && status === 'claimed') {
    status = 'converted';
  } else if (event.type === 'payout_submitted' && status === 'converted') {
    status = 'submitted';
  } else if (event.type === 'payout_settled' && status === 'submitted') {
    if (
      event.amountMinor !== payout.amountMinor ||
      event.currency !== payout.currency ||
      typeof event.providerReference !== 'string' ||
      !event.providerReference.trim()
    )
      throw new Error('Settlement does not match the expected payout.');
    status = 'settled';
    settlementReference = event.providerReference;
  } else {
    throw new Error(`Illegal payout transition: ${status} + ${event.type}.`);
  }

  return {
    ...payout,
    status,
    ...(settlementReference ? { settlementReference } : {}),
    processedEvents: { ...payout.processedEvents, [event.id]: fingerprint },
  };
}
