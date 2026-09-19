import {
  paymentSpendableUsdCents,
  type OperationsService,
  type PaymentStatus,
} from '../operations.ts';
import type { createPumpLaunchService } from '../launch/service.ts';
import type { createPublicServices } from './service.ts';
import type { LiveStatus } from '../workers/streamer-live.ts';

type Snapshot = ReturnType<OperationsService['snapshot']>;
type Payment = Snapshot['payments'][number];
import type { PublicPlatformToken } from './native-buybacks.ts';
export type CatalogPayoutStatus =
  | Exclude<PaymentStatus, 'completed' | 'cancelled'>
  | 'awaiting_fees'
  | 'accumulating'
  | 'paid'
  | 'no_payout_due';
export interface CatalogTreasurySummary {
  buybackSpentUsdCents: number;
  buybackReserveUsdCents: number;
  buybackNetworkFeesUsdCents: number;
  burnedTokenBaseUnits: string | null;
  burnedTokenDecimals: number | null;
  buybackCount: number;
  burnCount: number;
  platformReserveUsdCents?: number;
  buybackNetworkFeesByToken?: Record<string, number>;
  receipts: Array<{
    id: string;
    kind: 'Buyback' | 'Burn';
    tokenId: string;
    mint: string;
    signature: string;
    transactionUrl: string;
    amountUsdCents: number | null;
    tokenBaseUnits: string;
    tokenDecimals: number;
    createdAt: string;
  }>;
}
export interface CatalogActivity {
  id: string;
  tokenId: string;
  kind: 'Donation' | 'Payout' | 'Claim' | 'Offramp' | 'Buyback' | 'Burn';
  amountUsdCents: number | null;
  amountMeaning: 'spent' | 'budget' | 'spendable' | 'claimed' | 'card_credit' | 'cost_basis';
  status: 'Confirmed' | 'Pending' | 'Settled';
  createdAt: string;
  reference: string;
  transactionUrl?: string;
  confirmationUrl?: string;
  payoutStatus?: CatalogPayoutStatus;
  verification?: string;
  cardChargeStatus?: 'AUTHORIZED' | 'COMPLETED';
  tokenBaseUnits?: string;
  tokenDecimals?: number | null;
  tokenName?: string;
  tokenSymbol?: string;
  tokenAddress?: string;
  recipientId?: string;
  recipientPlatform?: 'twitch' | 'kick';
  recipientUsername?: string;
  route?: 'streamer' | 'treasury';
}
const pending = (payment: Payment) => !['completed', 'cancelled'].includes(payment.status);
function payoutStatus(
  payments: Payment[],
  pendingCents: number,
  claimedCents: number,
): CatalogPayoutStatus {
  const priority = [
    'uncertain',
    'in_progress',
    'funding_submitted',
    'funding_pending',
    'ready',
    'reserved',
    'awaiting_threshold',
  ] as const;
  return (
    priority.find((status) => payments.some((payment) => payment.status === status)) ??
    (pendingCents > 0
      ? 'accumulating'
      : payments.some((payment) => payment.status === 'completed' && payment.completion)
        ? 'paid'
        : claimedCents > 0
          ? 'no_payout_due'
          : 'awaiting_fees')
  );
}

/** Totals use every persisted record; the bounded activity feed is presentation only. */
export function publicCatalog(
  operations: Pick<OperationsService, 'snapshot'>,
  launches: Pick<ReturnType<typeof createPumpLaunchService>, 'allConfirmedMetadata'>,
  profiles: ReturnType<ReturnType<typeof createPublicServices>['recipients']>,
  options: {
    streamerStatuses?: LiveStatus[];
    now?: number;
  } = {},
) {
  const snapshot = operations.snapshot();
  const treasury = ('treasury' in snapshot ? snapshot.treasury : undefined) as
    CatalogTreasurySummary | undefined;
  const launched = launches.allConfirmedMetadata();
  const completed = snapshot.payments.filter(
    (payment) => payment.status === 'completed' && payment.completion,
  );
  const tokens = snapshot.tokens.map((token) => {
    const data = launched.find((t) => t.id === token.id);
    const claims = snapshot.claims.filter((claim) => claim.tokenId === token.id);
    const payments = snapshot.payments.filter((payment) => payment.tokenId === token.id);
    const donations = completed.filter((payment) => payment.tokenId === token.id);
    const balance = token.balances;
    const pendingUsdCents =
      balance.availableCents + balance.reservedCents + balance.cardResidualCents;
    return {
      id: token.id,
      name: token.name,
      symbol: token.symbol,
      image: data?.imageUri ?? '',
      color: token.recipientPlatform === 'kick' ? '#53FC18' : '#9146FF',
      launchpad: 'pump' as const,
      // Legacy registrations lack a provider ID; group only their recorded platform/handle.
      streamerId:
        data?.recipientId ??
        `legacy:${token.recipientPlatform}:${token.recipientUsername.toLowerCase()}`,
      mcap: null,
      volume: null,
      change: null,
      created: Date.parse(token.createdAt),
      address: token.mint,
      description: data?.description ?? '',
      donatedUsdCents: balance.spentCents,
      claimedUsdCents: balance.claimedCents,
      streamerAllocatedUsdCents: claims.reduce((sum, claim) => sum + claim.streamerCents, 0),
      buybackAllocatedUsdCents: claims.reduce((sum, claim) => sum + claim.buybackCents, 0),
      pendingUsdCents,
      availableUsdCents: balance.availableCents,
      reservedUsdCents: balance.reservedCents,
      cardResidualUsdCents: balance.cardResidualCents,
      conversionPendingUsdCents: balance.conversionPendingCents ?? 0,
      paymentCostsUsdCents:
        balance.costCents - (treasury?.buybackNetworkFeesByToken?.[token.id] ?? 0),
      claimNetworkFeesUsdCents: balance.claimNetworkFeeCents,
      convertedUsdCents: payments.reduce(
        (sum, payment) => sum + (payment.funding?.credit?.creditedUsdCents ?? 0),
        0,
      ),
      completedPaymentCount: donations.length,
      pendingPaymentCount: payments.filter(pending).length,
      claimCount: claims.length,
      payoutStatus: payoutStatus(payments, pendingUsdCents, balance.claimedCents),
      lastDonationAt:
        donations
          .map((payment) => payment.completion!.completedAt)
          .sort()
          .at(-1) ?? null,
    };
  });
  const streamers = [...new Set(tokens.map((token) => token.streamerId))].map((id) => {
    const community = tokens.filter((token) => token.streamerId === id);
    const first = community[0];
    const source = snapshot.tokens.find((token) => token.id === first.id)!;
    const profile = profiles.find((profile) => profile.id === id);
    const recipient = {
      platform: source.recipientPlatform,
      handle: (profile?.handle ?? source.recipientUsername).toLowerCase(),
    };
    const live = options.streamerStatuses?.find(
      (status) =>
        status.platform === recipient.platform &&
        status.providerId === id &&
        status.username.toLowerCase() === recipient.handle,
    );
    const now = options.now ?? Date.now();
    const current =
      live?.checkedAt &&
      Number.isFinite(Date.parse(live.checkedAt)) &&
      Date.parse(live.checkedAt) <= now + 5000 &&
      Date.parse(live.nextCheckAt) > now;
    const ids = new Set(community.map((token) => token.id));
    const payments = snapshot.payments.filter((payment) => ids.has(payment.tokenId));
    const sum = (
      key:
        | 'donatedUsdCents'
        | 'claimedUsdCents'
        | 'streamerAllocatedUsdCents'
        | 'buybackAllocatedUsdCents'
        | 'pendingUsdCents'
        | 'convertedUsdCents'
        | 'paymentCostsUsdCents'
        | 'conversionPendingUsdCents'
        | 'completedPaymentCount'
        | 'pendingPaymentCount'
        | 'claimCount',
    ) => community.reduce((total, token) => total + token[key], 0);
    return {
      id,
      name: profile?.name ?? source.recipientUsername,
      handle: profile?.handle ?? source.recipientUsername,
      platform: source.recipientPlatform,
      color: first.color,
      image: profile?.image ?? '',
      category: profile?.category ?? '',
      bio: profile?.bio ?? '',
      channelUrl: profile?.channelUrl ?? source.channelUrl,
      donatedUsdCents: sum('donatedUsdCents'),
      claimedUsdCents: sum('claimedUsdCents'),
      streamerAllocatedUsdCents: sum('streamerAllocatedUsdCents'),
      buybackAllocatedUsdCents: sum('buybackAllocatedUsdCents'),
      pendingUsdCents: sum('pendingUsdCents'),
      convertedUsdCents: sum('convertedUsdCents'),
      paymentCostsUsdCents: sum('paymentCostsUsdCents'),
      conversionPendingUsdCents: sum('conversionPendingUsdCents'),
      completedPaymentCount: sum('completedPaymentCount'),
      pendingPaymentCount: sum('pendingPaymentCount'),
      claimCount: sum('claimCount'),
      tokenCount: community.length,
      payoutStatus: payoutStatus(payments, sum('pendingUsdCents'), sum('claimedUsdCents')),
      liveStatus: current ? live!.status : ('unknown' as const),
      liveCheckedAt: live?.checkedAt ?? null,
      nextLiveCheckAt: live?.nextCheckAt ?? null,
    };
  });
  const activity: CatalogActivity[] = [
    ...completed.map((payment): CatalogActivity => ({
      id: payment.id,
      tokenId: payment.tokenId,
      kind: 'Donation',
      amountUsdCents: payment.completion!.spentUsdCents,
      amountMeaning: 'spent',
      status: 'Confirmed',
      createdAt: payment.completion!.completedAt,
      reference: payment.id,
      transactionUrl: payment.funding?.transactionUrl,
      confirmationUrl: payment.completion!.confirmationUrl,
      verification: payment.completion!.verification,
      ...(payment.completion!.cardChargeStatus
        ? { cardChargeStatus: payment.completion!.cardChargeStatus }
        : {}),
    })),
    ...snapshot.claims.map((claim): CatalogActivity => ({
      id: claim.id,
      tokenId: claim.tokenId,
      kind: 'Claim',
      amountUsdCents: claim.grossUsdCents,
      amountMeaning: 'claimed',
      status: 'Confirmed',
      createdAt: claim.createdAt,
      reference: claim.signature,
      transactionUrl: claim.transactionUrl,
    })),
    ...snapshot.payments
      .filter((payment) => payment.funding?.credit)
      .map((payment): CatalogActivity => ({
        id: `funding:${payment.id}`,
        tokenId: payment.tokenId,
        kind: 'Offramp',
        amountUsdCents: payment.funding!.credit!.creditedUsdCents,
        amountMeaning: 'card_credit',
        status: 'Confirmed',
        createdAt: payment.funding!.credit!.confirmedAt,
        reference: payment.id,
        transactionUrl: payment.funding!.transactionUrl,
        verification: payment.funding!.credit!.verification,
      })),
    ...snapshot.payments.filter(pending).map((payment): CatalogActivity => ({
      id: `pending:${payment.id}`,
      tokenId: payment.tokenId,
      kind: 'Payout',
      amountUsdCents:
        payment.funding?.native && payment.funding.credit
          ? paymentSpendableUsdCents(payment)
          : payment.budgetCents,
      amountMeaning: payment.funding?.native && payment.funding.credit ? 'spendable' : 'budget',
      status: 'Pending',
      payoutStatus: payment.status as CatalogPayoutStatus,
      createdAt: payment.updatedAt,
      reference: payment.id,
    })),
    ...(treasury?.receipts ?? []).map((receipt): CatalogActivity => ({
      id: receipt.id,
      tokenId: receipt.tokenId,
      kind: receipt.kind,
      amountUsdCents: receipt.amountUsdCents,
      amountMeaning: receipt.kind === 'Buyback' ? 'spent' : 'cost_basis',
      status: 'Confirmed',
      createdAt: receipt.createdAt,
      reference: receipt.signature,
      transactionUrl: receipt.transactionUrl,
      tokenBaseUnits: receipt.tokenBaseUnits,
      tokenDecimals: receipt.tokenDecimals,
    })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  const t = snapshot.totals;
  const pendingCents = t.availableCents + t.reservedCents + t.cardResidualCents;
  const reserve = treasury?.buybackReserveUsdCents ?? t.buybackCents;
  const sources = [...snapshot.tokens, ...(snapshot.platformTokens ?? [])];
  // Historical Solana treasury registrations never establish official Robinhood POG identity.
  const platformToken: PublicPlatformToken | null = null;
  return {
    tokens,
    streamers,
    platformToken,
    stats: {
      totalDonatedUsdCents: t.spentCents,
      totalClaimedUsdCents: t.claimedCents,
      streamerAllocatedUsdCents: snapshot.claims.reduce(
        (sum, claim) => sum + claim.streamerCents,
        0,
      ),
      buybackAllocatedUsdCents: snapshot.claims.reduce((sum, claim) => sum + claim.buybackCents, 0),
      streamerPendingUsdCents: pendingCents,
      streamerAvailableUsdCents: t.availableCents,
      streamerReservedUsdCents: t.reservedCents,
      cardResidualUsdCents: t.cardResidualCents,
      conversionPendingUsdCents: t.conversionPendingCents ?? 0,
      paymentCostsUsdCents: tokens.reduce((sum, token) => sum + token.paymentCostsUsdCents, 0),
      totalRecordedCostsUsdCents: t.costCents + t.claimNetworkFeeCents,
      claimNetworkFeesUsdCents: t.claimNetworkFeeCents,
      convertedUsdCents: tokens.reduce((sum, token) => sum + token.convertedUsdCents, 0),
      completedPaymentCount: completed.length,
      pendingPaymentCount: snapshot.payments.filter(pending).length,
      claimCount: snapshot.claims.length,
      tokenCount: tokens.length,
      streamerCount: streamers.length,
      buybackSpentUsdCents: treasury?.buybackSpentUsdCents ?? null,
      buybackReserveUsdCents: reserve,
      buybackNetworkFeesUsdCents: treasury?.buybackNetworkFeesUsdCents ?? null,
      platformReserveUsdCents: treasury?.platformReserveUsdCents ?? 0,
      burnedTokenBaseUnits: treasury?.burnedTokenBaseUnits ?? null,
      burnedTokenDecimals: treasury?.burnedTokenDecimals ?? null,
      buybackCount: treasury?.buybackCount ?? null,
      burnCount: treasury?.burnCount ?? null,
      heldUsdCents: pendingCents + reserve + (treasury?.platformReserveUsdCents ?? 0),
    },
    activity: activity.slice(0, 200).map((event) => {
      const source = sources.find((source) => source.id === event.tokenId);
      const community = tokens.find((token) => token.id === event.tokenId);
      const recipient = source && 'recipientPlatform' in source ? source : undefined;
      return {
        ...event,
        tokenName: source?.name,
        tokenSymbol: source?.symbol,
        tokenAddress: source?.mint,
        recipientId: community?.streamerId,
        recipientPlatform: recipient?.recipientPlatform,
        recipientUsername: recipient?.recipientUsername,
        route: (!community || event.kind === 'Buyback' || event.kind === 'Burn'
          ? 'treasury'
          : 'streamer') as 'streamer' | 'treasury',
      };
    }),
    activitySummary: {
      totalCount: activity.length,
      returnedCount: Math.min(activity.length, 200),
      truncated: activity.length > 200,
    },
  };
}
