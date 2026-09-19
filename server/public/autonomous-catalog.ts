import type { PipelineJob } from '../agents/pipeline.ts';
import type { publicCatalog, CatalogPayoutStatus } from './catalog.ts';

type Catalog = ReturnType<typeof publicCatalog>;
interface Totals {
  convertedUsdCents: number;
  streamerBudgetUsdCents: number;
  platformReserveUsdCents: number;
  spentUsdCents: number;
  availableUsdCents: number;
  reservedUsdCents: number;
  /** Active unspent gift budgets; completed residuals are excluded. */
  pendingUsdCents: number;
  /** Unspent exchange proceeds from completed gifts; unavailable for automatic reuse. */
  residualUsdCents: number;
  heldUsdCents: number;
  /** Unsupported unfinished historical allocations are held, never spendable. */
  heldLegacyUsdCents: number;
  completedPaymentCount: number;
  pendingPaymentCount: number;
  feeLotCount: number;
}
export interface PublicAutonomousDonation {
  id: string;
  tokenId: string;
  platform: 'twitch' | 'kick';
  username: string;
  chain: PipelineJob['chain'];
  spentUsdCents: number;
  receiptReference: string;
  completedAt: string | null;
}
function invalid(): never {
  throw new Error('Invalid autonomous financial evidence.');
}
function cents(value: unknown, allowZero = true): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    invalid();
  return value;
}
function add(left: number, right: number): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(value);
}
function validDate(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}
function uniqueJobs(jobs: PipelineJob[]): PipelineJob[] {
  const seen = new Map<string, string>(),
    receipts = new Set<string>();
  const result: PipelineJob[] = [];
  for (const job of jobs) {
    if (
      !job.id ||
      !job.tokenId ||
      !['solana', 'bnb', 'robinhood'].includes(job.chain) ||
      ![
        'claimed',
        'depositing',
        'deposited',
        'converting',
        'converted',
        'gifting',
        'completed',
      ].includes(job.phase)
    )
      invalid();
    // Include only public financial identity and attribution in duplicate comparison.
    const identity = JSON.stringify([
      job.tokenId,
      job.chain,
      job.asset,
      job.amountBaseUnits,
      job.claimReference,
      job.recipient,
      job.phase,
      job.netUsdCents,
      job.allocationVersion,
      job.streamerBudgetUsdCents,
      job.platformReserveUsdCents,
      job.spentUsdCents,
      job.residualUsdCents,
      job.receiptReference,
      job.createdAt,
      job.completedAt,
    ]);
    const old = seen.get(job.id);
    if (old !== undefined) {
      if (old !== identity) invalid();
      continue;
    }
    seen.set(job.id, identity);
    if (['converted', 'gifting', 'completed'].includes(job.phase)) {
      const net = cents(job.netUsdCents, false);
      if (add(cents(job.streamerBudgetUsdCents, false), cents(job.platformReserveUsdCents)) !== net)
        invalid();
      if (
        job.allocationVersion === 'native-streamer-v1' &&
        (job.streamerBudgetUsdCents !== net || job.platformReserveUsdCents !== 0)
      )
        invalid();
    }
    if (job.phase === 'completed') {
      if (!job.receiptReference || receipts.has(job.receiptReference)) invalid();
      receipts.add(job.receiptReference);
      if (
        add(cents(job.spentUsdCents, false), cents(job.residualUsdCents)) !==
        job.streamerBudgetUsdCents
      )
        invalid();
    }
    result.push(job);
  }
  return result;
}
function total(jobs: PipelineJob[]): Totals {
  const result: Totals = {
    convertedUsdCents: 0,
    streamerBudgetUsdCents: 0,
    platformReserveUsdCents: 0,
    spentUsdCents: 0,
    availableUsdCents: 0,
    reservedUsdCents: 0,
    pendingUsdCents: 0,
    residualUsdCents: 0,
    heldUsdCents: 0,
    heldLegacyUsdCents: 0,
    completedPaymentCount: 0,
    pendingPaymentCount: 0,
    feeLotCount: jobs.length,
  };
  for (const job of jobs) {
    if (['converted', 'gifting', 'completed'].includes(job.phase)) {
      result.convertedUsdCents = add(result.convertedUsdCents, job.netUsdCents!);
      result.streamerBudgetUsdCents = add(
        result.streamerBudgetUsdCents,
        job.streamerBudgetUsdCents!,
      );
      result.platformReserveUsdCents = add(
        result.platformReserveUsdCents,
        job.platformReserveUsdCents!,
      );
    }
    if (job.phase === 'completed') {
      result.spentUsdCents = add(result.spentUsdCents, job.spentUsdCents!);
      result.residualUsdCents = add(result.residualUsdCents, job.residualUsdCents!);
      result.completedPaymentCount++;
    } else {
      result.pendingPaymentCount++;
      if (job.allocationVersion !== 'native-streamer-v1') {
        if (['converted', 'gifting'].includes(job.phase))
          result.heldLegacyUsdCents = add(result.heldLegacyUsdCents, job.streamerBudgetUsdCents!);
        continue;
      }
      if (job.phase === 'converted')
        result.availableUsdCents = add(result.availableUsdCents, job.streamerBudgetUsdCents!);
      if (job.phase === 'gifting')
        result.reservedUsdCents = add(result.reservedUsdCents, job.streamerBudgetUsdCents!);
    }
  }
  result.pendingUsdCents = add(result.availableUsdCents, result.reservedUsdCents);
  result.heldUsdCents = add(
    add(add(result.pendingUsdCents, result.residualUsdCents), result.heldLegacyUsdCents),
    result.platformReserveUsdCents,
  );
  return result;
}
/** All totals come from persisted pipeline evidence; no native-fee price estimates. */
export function publicAutonomousLedger(
  jobs: PipelineJob[],
): Totals & { byChain: Record<PipelineJob['chain'], Totals> } {
  const unique = uniqueJobs(jobs);
  return {
    ...total(unique),
    byChain: {
      solana: total(unique.filter((j) => j.chain === 'solana')),
      bnb: total(unique.filter((j) => j.chain === 'bnb')),
      robinhood: total(unique.filter((j) => j.chain === 'robinhood')),
    },
  };
}
/** Deliberate allowlist: issuer, card account, browser session and exchange order IDs stay private. */
export function publicAutonomousDonations(jobs: PipelineJob[]): PublicAutonomousDonation[] {
  return uniqueJobs(jobs)
    .filter((j) => j.phase === 'completed')
    .map((j) => ({
      id: j.id,
      tokenId: j.tokenId,
      platform: j.recipient.platform,
      username: j.recipient.username,
      chain: j.chain,
      spentUsdCents: j.spentUsdCents!,
      receiptReference: j.receiptReference!,
      completedAt: validDate(j.completedAt),
    }))
    .sort(
      (a, b) =>
        (b.completedAt ? Date.parse(b.completedAt) : 0) -
          (a.completedAt ? Date.parse(a.completedAt) : 0) || a.id.localeCompare(b.id),
    );
}
function status(jobs: PipelineJob[], sum: Totals): CatalogPayoutStatus {
  if (jobs.some((j) => j.phase !== 'completed' && j.allocationVersion !== 'native-streamer-v1'))
    return 'uncertain';
  if (jobs.some((j) => j.phase === 'gifting')) return 'in_progress';
  if (sum.availableUsdCents > 0) return 'ready';
  if (jobs.some((j) => ['depositing', 'deposited', 'converting'].includes(j.phase)))
    return 'funding_pending';
  if (jobs.some((j) => j.phase === 'claimed')) return 'accumulating';
  return sum.completedPaymentCount > 0 ? 'paid' : 'awaiting_fees';
}
/** Replace settlement balances, never add them to the claim ledger's old budget estimates.
 * Claim/gas and executed treasury records remain their original historical facts.
 * Budget allocation uses persisted native-split proceeds, never old estimates.
 * Completed exchange residual is exposed only by publicAutonomousLedger, never as card credit.
 */
export function projectAutonomousCatalog(catalog: Catalog, jobs: PipelineJob[]): Catalog {
  const unique = uniqueJobs(jobs),
    all = total(unique);
  const tokens = catalog.tokens.map((token) => {
    const relevant = unique.filter((j) => j.tokenId === token.id),
      sum = total(relevant);
    const dates = relevant
      .filter((j) => j.phase === 'completed')
      .map((j) => validDate(j.completedAt))
      .filter((d): d is string => d !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    return {
      ...token,
      donatedUsdCents: sum.spentUsdCents,
      convertedUsdCents: sum.convertedUsdCents,
      streamerAllocatedUsdCents: sum.streamerBudgetUsdCents,
      buybackAllocatedUsdCents: 0,
      pendingUsdCents: sum.pendingUsdCents,
      availableUsdCents: sum.availableUsdCents,
      reservedUsdCents: sum.reservedUsdCents,
      cardResidualUsdCents: 0,
      conversionPendingUsdCents: 0,
      paymentCostsUsdCents: 0,
      completedPaymentCount: sum.completedPaymentCount,
      pendingPaymentCount: sum.pendingPaymentCount,
      payoutStatus: status(relevant, sum),
      lastDonationAt: dates.at(-1) ?? null,
    };
  });
  const streamers = catalog.streamers.map((streamer) => {
    const relevant = unique.filter(
        (j) =>
          j.recipient.platform === streamer.platform &&
          (j.recipient.providerId === streamer.id ||
            (streamer.id.startsWith('legacy:') &&
              j.recipient.username.toLowerCase() === streamer.handle.toLowerCase())),
      ),
      sum = total(relevant);
    return {
      ...streamer,
      donatedUsdCents: sum.spentUsdCents,
      convertedUsdCents: sum.convertedUsdCents,
      streamerAllocatedUsdCents: sum.streamerBudgetUsdCents,
      buybackAllocatedUsdCents: 0,
      pendingUsdCents: sum.pendingUsdCents,
      conversionPendingUsdCents: 0,
      paymentCostsUsdCents: 0,
      completedPaymentCount: sum.completedPaymentCount,
      pendingPaymentCount: sum.pendingPaymentCount,
      payoutStatus: status(relevant, sum),
    };
  });
  // Keep independently recorded chain history; old payment/funding rows cannot
  // masquerade as active budgets or confirmed donations under the new pipeline.
  const historical = catalog.activity.filter((event) =>
    ['Claim', 'Buyback', 'Burn'].includes(event.kind),
  );
  const donations: Catalog['activity'] = [];
  for (const job of unique) {
    const completedAt = validDate(job.completedAt);
    if (job.phase !== 'completed' || !completedAt) continue;
    const token = tokens.find((t) => t.id === job.tokenId);
    donations.push({
      id: `agent:${job.id}`,
      tokenId: job.tokenId,
      kind: 'Donation',
      amountUsdCents: job.spentUsdCents!,
      amountMeaning: 'spent',
      status: 'Confirmed',
      createdAt: completedAt,
      reference: job.receiptReference!,
      verification: 'Reconciled platform receipt and posted issuer charge',
      cardChargeStatus: 'COMPLETED',
      tokenName: token?.name,
      tokenSymbol: token?.symbol,
      tokenAddress: token?.address,
      recipientId: job.recipient.providerId,
      recipientPlatform: job.recipient.platform,
      recipientUsername: job.recipient.username,
      route: 'streamer',
    });
  }
  const activity = [...historical, ...donations].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  );
  const historyCount =
    catalog.stats.claimCount + (catalog.stats.buybackCount ?? 0) + (catalog.stats.burnCount ?? 0);
  const eventCount = Math.max(historyCount, historical.length) + donations.length;
  return {
    ...catalog,
    tokens,
    streamers,
    stats: {
      ...catalog.stats,
      totalDonatedUsdCents: all.spentUsdCents,
      convertedUsdCents: all.convertedUsdCents,
      streamerAllocatedUsdCents: all.streamerBudgetUsdCents,
      buybackAllocatedUsdCents: 0,
      platformReserveUsdCents: all.platformReserveUsdCents,
      buybackReserveUsdCents: 0,
      streamerPendingUsdCents: all.pendingUsdCents,
      streamerAvailableUsdCents: all.availableUsdCents,
      streamerReservedUsdCents: all.reservedUsdCents,
      cardResidualUsdCents: 0,
      conversionPendingUsdCents: 0,
      paymentCostsUsdCents: 0,
      totalRecordedCostsUsdCents: add(
        cents(catalog.stats.claimNetworkFeesUsdCents),
        cents(catalog.stats.buybackNetworkFeesUsdCents ?? 0),
      ),
      completedPaymentCount: all.completedPaymentCount,
      pendingPaymentCount: all.pendingPaymentCount,
      heldUsdCents: all.heldUsdCents,
    },
    activity: activity.slice(0, 200),
    activitySummary: {
      totalCount: eventCount,
      returnedCount: Math.min(activity.length, 200),
      truncated: eventCount > Math.min(activity.length, 200),
    },
  };
}
