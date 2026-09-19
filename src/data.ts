import { useSyncExternalStore } from 'react';
import bs58 from 'bs58';
import { retryAfterSeconds } from '../server/retry-after';
import type {
  PublicNativeBuybackLedger,
  PublicPlatformToken,
} from '../server/public/native-buybacks';
import type { FeeAccrual } from '../server/public/unclaimed-fees';
export type Launchpad = 'pump' | 'pons';
export type Platform = 'twitch' | 'kick';
export type Sort = 'mcap' | 'donations' | 'newest' | 'volume';
export interface FinancialMetrics {
  feeAccrual?: FeeAccrual;
  donatedUsdCents?: number;
  claimedUsdCents?: number;
  streamerAllocatedUsdCents?: number;
  buybackAllocatedUsdCents?: number;
  pendingUsdCents?: number;
  convertedUsdCents?: number;
  paymentCostsUsdCents?: number;
  /** Signed source valuation minus actual card credit; unresolved, never spendable. */
  conversionPendingUsdCents?: number;
  completedPaymentCount?: number;
  pendingPaymentCount?: number;
  claimCount?: number;
  payoutStatus?: string;
}
export interface Streamer extends FinancialMetrics {
  id: string;
  name: string;
  handle: string;
  platform: Platform;
  color: string;
  image: string;
  category: string;
  bio: string;
  channelUrl?: string;
  donatedUsdCents?: number;
  tokenCount?: number;
  totalGiftSpendingUsdCents?: number;
  manualGiftSpendingUsdCents?: number;
  manualGiftCount?: number;
  liveStatus?: 'live' | 'offline' | 'unknown';
  liveCheckedAt?: string | null;
  nextLiveCheckAt?: string | null;
}
export interface Token extends FinancialMetrics {
  id: string;
  name: string;
  symbol: string;
  image: string;
  color: string;
  launchpad: Launchpad;
  streamerId: string;
  mcap: number | null;
  volume: number | null;
  change: number | null;
  priceUsd?: number | null;
  created: number;
  address: string;
  description: string;
  donatedUsdCents?: number;
  marketDataStatus?: 'fresh' | 'stale' | 'warming' | 'unavailable';
  marketDataUpdatedAt?: string | null;
}
export type PlatformToken = PublicPlatformToken;
export let nativeBuybackLedger: PublicNativeBuybackLedger | null = null;
export let platformToken: PlatformToken | null = null;
export type EventKind = 'Donation' | 'Payout' | 'Claim' | 'Swap' | 'Offramp' | 'Buyback' | 'Burn';
export interface LedgerEvent {
  id: string;
  tokenId: string;
  kind: EventKind;
  amount: number | null;
  status: 'Settled' | 'Confirmed' | 'Pending';
  age: string;
  date: string;
  reference: string;
  transactionUrl?: string;
  confirmationUrl?: string;
  amountMeaning?: 'spent' | 'budget' | 'spendable' | 'claimed' | 'card_credit' | 'cost_basis';
  payoutStatus?: string;
  verification?: string;
  cardChargeStatus?: 'AUTHORIZED' | 'COMPLETED';
  tokenBaseUnits?: string;
  tokenDecimals?: number | null;
  tokenName?: string;
  tokenSymbol?: string;
  tokenAddress?: string;
  recipientId?: string;
  recipientPlatform?: Platform;
  recipientUsername?: string;
  route?: 'streamer' | 'treasury';
}
export let tokens: Token[] = [];
export const comingSoonTokens: Token[] = [];
export let streamers: Streamer[] = [];
export let payments: LedgerEvent[] = [];
export let ledger: LedgerEvent[] = [];
export let totalDonations = 0;
export interface DonationSummary {
  totalGiftSpendingUsdCents: number;
  creatorFeeGiftSpendingUsdCents: number;
  manualGiftSpendingUsdCents: number;
  completedGiftCount: number;
  manualGiftCount: number;
}
export let donationSummary: DonationSummary | null = null;
/** All verified gifts; creator-fee balances and token metrics remain separate. */
export let overallGiftSpending = 0;
export let catalogCounts = {
  completedPayments: null as number | null,
  pendingPayments: null as number | null,
  claims: null as number | null,
  tokens: null as number | null,
  streamers: null as number | null,
  buybacks: null as number | null,
  burns: null as number | null,
};
export let activitySummary = {
  totalCount: null as number | null,
  returnedCount: 0,
  truncated: false,
};
export let treasury = {
  claimed: 0,
  streamerAllocation: 0,
  buybackAllocation: 0,
  paid: 0,
  payoutPending: 0,
  buybacks: null as number | null,
  buybackReserve: null as number | null,
  held: null as number | null,
  paymentCosts: null as number | null,
  claimNetworkFees: null as number | null,
  buybackNetworkFees: null as number | null,
  platformReserve: null as number | null,
  totalRecordedCosts: null as number | null,
  converted: null as number | null,
  burnedTokens: null as string | null,
};
function metric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function signedMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
function dollars(value: unknown): number | null {
  const cents = metric(value);
  return cents === null ? null : cents / 100;
}
let snapshot = { loading: true, error: '', updatedAt: 0 };
let marketRefreshMs = 5000;
let catalogRetryAt = 0;
/** Identity and ledger reads remain frequent even when market providers back off. */
export const nextCatalogRefreshMs = () =>
  Math.max(catalogRetryAt - Date.now(), snapshot.error ? 10000 : marketRefreshMs);
const subscribers = new Set<() => void>();
export function useCatalog() {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
const catalogInvalid = () =>
  new Error('The catalog response could not be verified. The last confirmed catalog is retained.');
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.trim().length > 0) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function asset(value: unknown) {
  if (!text(value, 8192, true)) return false;
  if (value === '') return true;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return true;
  try {
    const url = new URL(value);
    return (
      ['https:', 'ipfs:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function mint(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch {
    return false;
  }
}
function market(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= Number.MAX_SAFE_INTEGER / 100
    ? value
    : null;
}
function exactUnits(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,155})$/.test(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function verifiedPlatform(value: unknown): PlatformToken | null {
  if (value === null || value === undefined) return null;
  if (
    !object(value) ||
    value.id !== 'platform-pog' ||
    value.name !== 'Pog' ||
    value.symbol !== 'POG' ||
    value.chain !== 'robinhood' ||
    value.chainId !== 4663 ||
    typeof value.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.address) ||
    /^0x0{40}$/.test(value.address) ||
    typeof value.devWallet !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.devWallet) ||
    /^0x0{40}$/.test(value.devWallet) ||
    typeof value.tokenCodeHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.tokenCodeHash) ||
    /^0x0{64}$/.test(value.tokenCodeHash) ||
    metric(value.tokenDecimals) === null ||
    Number(value.tokenDecimals) > 36 ||
    !timestamp(value.verifiedAt) ||
    !exactUnits(value.ethSpentWei) ||
    !exactUnits(value.targetGasSpentWei) ||
    !exactUnits(value.burnedTokenBaseUnits) ||
    metric(value.buybackCount) === null ||
    metric(value.burnCount) === null ||
    (value.lastExecutionAt !== null && !timestamp(value.lastExecutionAt))
  )
    throw catalogInvalid();
  return {
    id: 'platform-pog',
    name: 'Pog',
    symbol: 'POG',
    chain: 'robinhood',
    chainId: 4663,
    address: value.address as `0x${string}`,
    devWallet: value.devWallet as `0x${string}`,
    tokenCodeHash: value.tokenCodeHash as `0x${string}`,
    tokenDecimals: value.tokenDecimals as number,
    verifiedAt: value.verifiedAt,
    ethSpentWei: value.ethSpentWei,
    targetGasSpentWei: value.targetGasSpentWei,
    burnedTokenBaseUnits: value.burnedTokenBaseUnits,
    buybackCount: value.buybackCount as number,
    burnCount: value.burnCount as number,
    lastExecutionAt: value.lastExecutionAt as string | null,
  };
}
function verifiedNativeLedger(value: unknown): PublicNativeBuybackLedger | null {
  if (value === undefined || value === null) return null;
  const keys = [
    'receivedEthWei',
    'ethSpentWei',
    'targetGasSpentWei',
    'residualEthWei',
    'purchasedTokenBaseUnits',
    'burnedTokenBaseUnits',
    'residualTokenBaseUnits',
  ] as const;
  if (
    !object(value) ||
    value.allocationVersion !== 'native-streamer-v1' ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.receipts) ||
    keys.some((key) => !exactUnits(value[key])) ||
    metric(value.buybackCount) === null ||
    metric(value.burnCount) === null ||
    !(
      value.tokenDecimals === null ||
      (metric(value.tokenDecimals) !== null && Number(value.tokenDecimals) <= 36)
    )
  )
    throw catalogInvalid();
  const sources: PublicNativeBuybackLedger['sources'] = [];
  const seen = new Set<string>();
  for (const source of value.sources) {
    if (
      !object(source) ||
      !['solana', 'bnb', 'robinhood'].includes(String(source.chain)) ||
      source.asset !==
        ({ solana: 'SOL', bnb: 'BNB', robinhood: 'ETH' } as Record<string, string>)[
          String(source.chain)
        ] ||
      source.decimals !== (source.chain === 'solana' ? 9 : 18) ||
      [
        'claimedBaseUnits',
        'streamerBaseUnits',
        'buybackBaseUnits',
        'pendingBuybackBaseUnits',
        'sourceSpentBaseUnits',
        'residualSourceBaseUnits',
      ].some((key) => !exactUnits(source[key])) ||
      seen.has(String(source.chain))
    )
      throw catalogInvalid();
    seen.add(String(source.chain));
    const row = {
      chain: source.chain,
      asset: source.asset,
      decimals: source.decimals,
      claimedBaseUnits: source.claimedBaseUnits,
      streamerBaseUnits: source.streamerBaseUnits,
      buybackBaseUnits: source.buybackBaseUnits,
      pendingBuybackBaseUnits: source.pendingBuybackBaseUnits,
      sourceSpentBaseUnits: source.sourceSpentBaseUnits,
      residualSourceBaseUnits: source.residualSourceBaseUnits,
    } as PublicNativeBuybackLedger['sources'][number];
    if (
      BigInt(row.claimedBaseUnits) !==
        BigInt(row.streamerBaseUnits) + BigInt(row.buybackBaseUnits) ||
      BigInt(row.buybackBaseUnits) !==
        BigInt(row.pendingBuybackBaseUnits) +
          BigInt(row.sourceSpentBaseUnits) +
          BigInt(row.residualSourceBaseUnits)
    )
      throw catalogInvalid();
    sources.push(row);
  }
  const receipts: PublicNativeBuybackLedger['receipts'] = [];
  for (const item of value.receipts) {
    if (
      !object(item) ||
      !text(item.id, 256) ||
      !['solana', 'bnb', 'robinhood'].includes(String(item.sourceChain)) ||
      !['SOL', 'BNB', 'ETH'].includes(String(item.sourceAsset)) ||
      !exactUnits(item.sourceAmountBaseUnits) ||
      !['reserved', 'transferring', 'funded', 'buying', 'bought', 'burning', 'completed'].includes(
        String(item.phase),
      ) ||
      ['receivedEthWei', 'ethSpentWei', 'burnedTokenBaseUnits'].some(
        (key) => item[key] !== null && !exactUnits(item[key]),
      ) ||
      ['sourceTransferReference', 'transferReference', 'buyReference', 'burnReference'].some(
        (key) => item[key] !== null && !text(item[key], 512),
      ) ||
      (item.completedAt !== null && !timestamp(item.completedAt))
    )
      throw catalogInvalid();
    receipts.push({
      id: item.id,
      sourceChain: item.sourceChain,
      sourceAsset: item.sourceAsset,
      sourceAmountBaseUnits: item.sourceAmountBaseUnits,
      phase: item.phase,
      receivedEthWei: item.receivedEthWei,
      ethSpentWei: item.ethSpentWei,
      burnedTokenBaseUnits: item.burnedTokenBaseUnits,
      sourceTransferReference: item.sourceTransferReference,
      transferReference: item.transferReference,
      buyReference: item.buyReference,
      burnReference: item.burnReference,
      completedAt: item.completedAt,
    } as PublicNativeBuybackLedger['receipts'][number]);
  }
  const result = {
    allocationVersion: 'native-streamer-v1',
    sources,
    receipts,
    tokenDecimals: value.tokenDecimals,
    buybackCount: value.buybackCount,
    burnCount: value.burnCount,
  } as PublicNativeBuybackLedger;
  for (const key of keys) result[key] = value[key] as string;
  if (
    BigInt(result.receivedEthWei) !==
      BigInt(result.ethSpentWei) +
        BigInt(result.targetGasSpentWei) +
        BigInt(result.residualEthWei) ||
    BigInt(result.purchasedTokenBaseUnits) !==
      BigInt(result.burnedTokenBaseUnits) + BigInt(result.residualTokenBaseUnits)
  )
    throw catalogInvalid();
  return result;
}
const tokenId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const financialKeys = [
  'donatedUsdCents',
  'claimedUsdCents',
  'streamerAllocatedUsdCents',
  'buybackAllocatedUsdCents',
  'pendingUsdCents',
  'convertedUsdCents',
  'paymentCostsUsdCents',
  'completedPaymentCount',
  'pendingPaymentCount',
  'claimCount',
  'availableUsdCents',
  'reservedUsdCents',
  'cardResidualUsdCents',
  'claimNetworkFeesUsdCents',
] as const;
function financial(value: Record<string, unknown>) {
  return (
    financialKeys.every((key) => value[key] === undefined || metric(value[key]) !== null) &&
    (value.conversionPendingUsdCents === undefined ||
      signedMetric(value.conversionPendingUsdCents) !== null) &&
    (value.payoutStatus === undefined || text(value.payoutStatus, 80))
  );
}
const requiredTotals = [
  'totalDonatedUsdCents',
  'totalClaimedUsdCents',
  'streamerAllocatedUsdCents',
  'buybackAllocatedUsdCents',
  'streamerPendingUsdCents',
  'tokenCount',
  'streamerCount',
] as const;
type CatalogStats = Record<string, unknown> & Record<(typeof requiredTotals)[number], number>;
function verifiedDonationSummary(value: unknown, stats: CatalogStats): DonationSummary | null {
  if (value === undefined) return null;
  const keys = [
    'totalGiftSpendingUsdCents',
    'creatorFeeGiftSpendingUsdCents',
    'manualGiftSpendingUsdCents',
    'completedGiftCount',
    'manualGiftCount',
  ] as const;
  if (!object(value) || keys.some((key) => metric(value[key]) === null)) throw catalogInvalid();
  const summary = Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as unknown as DonationSummary;
  if (
    summary.totalGiftSpendingUsdCents !==
      summary.creatorFeeGiftSpendingUsdCents + summary.manualGiftSpendingUsdCents ||
    summary.creatorFeeGiftSpendingUsdCents !== stats.totalDonatedUsdCents ||
    summary.completedGiftCount < summary.manualGiftCount ||
    (stats.completedPaymentCount !== undefined &&
      summary.completedGiftCount !== Number(stats.completedPaymentCount) + summary.manualGiftCount)
  )
    throw catalogInvalid();
  return summary;
}
type IncomingActivity = Omit<LedgerEvent, 'amount' | 'date' | 'age'> & {
  amountUsdCents: number | null;
  createdAt: string;
};
function verifiedFeeAccrual(value: unknown): FeeAccrual | undefined {
  if (value === undefined) return undefined;
  const unavailable: FeeAccrual = {
    unclaimedUsdCents: null,
    unclaimedLamports: null,
    observedAt: null,
    status: 'unavailable',
  };
  if (!object(value)) return unavailable;
  if (value.status === 'loading' || value.status === 'unavailable')
    return { ...unavailable, status: value.status };
  if (
    !['fresh', 'stale'].includes(String(value.status)) ||
    metric(value.unclaimedUsdCents) === null ||
    typeof value.unclaimedLamports !== 'string' ||
    !/^\d{1,30}$/.test(value.unclaimedLamports) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return unavailable;
  const age = Date.now() - Date.parse(value.observedAt);
  if (age < -5000 || age > 300_000) return unavailable;
  return {
    unclaimedUsdCents: value.unclaimedUsdCents as number,
    unclaimedLamports: value.unclaimedLamports,
    observedAt: value.observedAt,
    status: age > 60_000 ? 'stale' : (value.status as 'fresh' | 'stale'),
  };
}
function validateCatalog(data: unknown) {
  if (
    !object(data) ||
    !Array.isArray(data.tokens) ||
    !Array.isArray(data.streamers) ||
    !Array.isArray(data.activity) ||
    !object(data.stats)
  )
    throw catalogInvalid();
  const ids = new Set<string>(),
    mints = new Set<string>(),
    recipients = new Map<string, number>();
  const nextStreamers: Streamer[] = [];
  for (const row of data.streamers) {
    if (
      !object(row) ||
      !text(row.id, 140) ||
      !['twitch', 'kick'].includes(String(row.platform)) ||
      !text(row.handle, 25) ||
      !/^[A-Za-z0-9_]{3,25}$/.test(row.handle) ||
      !(
        new RegExp(`^${row.platform}:[A-Za-z0-9_-]{1,100}$`).test(row.id) ||
        row.id === `legacy:${row.platform}:${row.handle.toLowerCase()}`
      ) ||
      recipients.has(row.id) ||
      !financial(row) ||
      ['totalGiftSpendingUsdCents', 'manualGiftSpendingUsdCents', 'manualGiftCount'].some(
        (key) => row[key] !== undefined && metric(row[key]) === null,
      ) ||
      (row.totalGiftSpendingUsdCents !== undefined &&
        row.donatedUsdCents !== undefined &&
        row.manualGiftSpendingUsdCents !== undefined &&
        row.totalGiftSpendingUsdCents !==
          Number(row.donatedUsdCents) + Number(row.manualGiftSpendingUsdCents)) ||
      (row.tokenCount !== undefined && metric(row.tokenCount) === null)
    )
      throw catalogInvalid();
    // Provider presentation is optional; it must never hide a valid token identity.
    const checkedAt = (value: unknown) =>
      typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    nextStreamers.push({
      ...row,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : row.handle,
      category: typeof row.category === 'string' ? row.category : '',
      bio: typeof row.bio === 'string' ? row.bio : '',
      image: asset(row.image) ? row.image : '',
      color:
        typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color)
          ? row.color
          : row.platform === 'kick'
            ? '#53FC18'
            : '#9146FF',
      channelUrl: `https://${row.platform === 'twitch' ? 'www.twitch.tv' : 'kick.com'}/${row.handle.toLowerCase()}`,
      liveStatus: ['live', 'offline', 'unknown'].includes(String(row.liveStatus))
        ? row.liveStatus
        : 'unknown',
      liveCheckedAt: checkedAt(row.liveCheckedAt),
      nextLiveCheckAt: checkedAt(row.nextLiveCheckAt),
    } as unknown as Streamer);
    recipients.set(row.id, 0);
  }
  for (const row of data.tokens) {
    if (
      !object(row) ||
      !tokenId(row.id) ||
      ids.has(row.id) ||
      !mint(row.address) ||
      mints.has(row.address) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 160 ||
      /[\u0000-\u001f]/.test(row.name) ||
      !text(row.symbol, 32) ||
      typeof row.description !== 'string' ||
      row.description.length > 10000 ||
      !['pump', 'pons'].includes(String(row.launchpad)) ||
      typeof row.streamerId !== 'string' ||
      !recipients.has(row.streamerId) ||
      !financial(row) ||
      typeof row.created !== 'number' ||
      !Number.isSafeInteger(row.created) ||
      row.created < 0 ||
      !Number.isFinite(new Date(row.created).getTime())
    )
      throw catalogInvalid();
    for (const key of ['mcap', 'volume', 'change']) {
      const value = row[key];
      if (
        value !== null &&
        (typeof value !== 'number' || !Number.isFinite(value) || (key !== 'change' && value < 0))
      )
        throw catalogInvalid();
    }
    ids.add(row.id);
    mints.add(row.address);
    recipients.set(row.streamerId, recipients.get(row.streamerId)! + 1);
  }
  for (const row of data.streamers)
    if (row.tokenCount !== undefined && row.tokenCount !== recipients.get(row.id))
      throw catalogInvalid();
  const stats = data.stats;
  if (
    requiredTotals.some((key) => metric(stats[key]) === null) ||
    stats.tokenCount !== data.tokens.length ||
    stats.streamerCount !== data.streamers.length
  )
    throw catalogInvalid();
  for (const [key, value] of Object.entries(stats))
    if (
      (key.endsWith('UsdCents') || key.endsWith('Count')) &&
      value !== null &&
      value !== undefined &&
      (key === 'conversionPendingUsdCents' ? signedMetric(value) : metric(value)) === null
    )
      throw catalogInvalid();
  const eventIds = new Set<string>();
  for (const row of data.activity) {
    if (
      !object(row) ||
      !text(row.id, 200) ||
      eventIds.has(row.id) ||
      !text(row.tokenId, 200) ||
      !['Donation', 'Payout', 'Claim', 'Swap', 'Offramp', 'Buyback', 'Burn'].includes(
        String(row.kind),
      ) ||
      !['Settled', 'Confirmed', 'Pending'].includes(String(row.status)) ||
      (row.amountUsdCents !== null && metric(row.amountUsdCents) === null) ||
      !text(row.createdAt, 64) ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      !text(row.reference, 256)
    )
      throw catalogInvalid();
    eventIds.add(row.id);
  }
  return {
    platformToken: verifiedPlatform(data.platformToken),
    nativeBuybackLedger: verifiedNativeLedger(data.nativeBuybackLedger),
    donationSummary: verifiedDonationSummary(data.donationSummary, stats as CatalogStats),
    tokens: data.tokens.map((row) => ({
      ...row,
      feeAccrual: verifiedFeeAccrual(row.feeAccrual),
      priceUsd: market(row.priceUsd, Number.MIN_VALUE),
      marketDataStatus: ['fresh', 'stale', 'warming', 'unavailable'].includes(row.marketDataStatus)
        ? row.marketDataStatus
        : undefined,
      marketDataUpdatedAt:
        typeof row.marketDataUpdatedAt === 'string' &&
        Number.isFinite(Date.parse(row.marketDataUpdatedAt))
          ? row.marketDataUpdatedAt
          : null,
      image: asset(row.image) ? row.image : '',
      color:
        typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color)
          ? row.color
          : row.streamerId.startsWith('kick:') || row.streamerId.startsWith('legacy:kick:')
            ? '#53FC18'
            : '#9146FF',
    })) as Token[],
    streamers: nextStreamers,
    activity: data.activity as IncomingActivity[],
    stats: stats as CatalogStats,
    activitySummary: object(data.activitySummary) ? data.activitySummary : undefined,
    refreshMs:
      object(data.marketData) && data.marketData.refreshing === true
        ? typeof data.marketData.retryAfterMs === 'number' &&
          Number.isFinite(data.marketData.retryAfterMs)
          ? Math.max(1000, Math.min(5000, data.marketData.retryAfterMs))
          : 2000
        : 5000,
  };
}
async function readCatalog(): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch('/api/catalog', {
          signal: controller.signal,
          cache: 'no-store',
        });
        controller.signal.throwIfAborted();
        if (response.status === 429) {
          catalogRetryAt =
            Date.now() + retryAfterSeconds(response.headers.get('retry-after')) * 1000;
          throw new Error('The live catalog is temporarily busy. It will refresh automatically.');
        }
        if (!response.ok) throw new Error('The live catalog is temporarily unavailable.');
        return await response.json();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('The live catalog took too long to load. Try again.'));
          controller.abort();
        }, 12000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
let inFlight: Promise<void> | null = null;
let refreshQueued = false;
async function refreshOnce() {
  if (Date.now() < catalogRetryAt) return;
  try {
    const data = validateCatalog(await readCatalog());
    const nextTokens = data.tokens.map((token: Token) => ({
      ...token,
      image: token.image || '/assets/brand/mark.svg',
    }));
    const nextStreamers: Streamer[] = data.streamers;
    const nextLedger: LedgerEvent[] = data.activity.map((event) => ({
      ...event,
      amount: dollars(event.amountUsdCents),
      date: event.createdAt,
      age: new Date(event.createdAt).toLocaleDateString(),
    }));
    const nextPayments = nextLedger.filter(
      (event) => event.kind === 'Donation' && ['Confirmed', 'Settled'].includes(event.status),
    );
    const s = data.stats;
    for (const key of [
      'totalDonatedUsdCents',
      'totalClaimedUsdCents',
      'streamerAllocatedUsdCents',
      'buybackAllocatedUsdCents',
      'streamerPendingUsdCents',
    ]) {
      if (metric(s[key]) === null)
        throw new Error('The live financial totals could not be verified.');
    }
    const nextTotalDonations = s.totalDonatedUsdCents / 100;
    const nextTreasury = {
      claimed: s.totalClaimedUsdCents / 100,
      streamerAllocation: s.streamerAllocatedUsdCents / 100,
      buybackAllocation: s.buybackAllocatedUsdCents / 100,
      paid: nextTotalDonations,
      payoutPending: s.streamerPendingUsdCents / 100,
      buybacks: dollars(s.buybackSpentUsdCents),
      buybackReserve: dollars(s.buybackReserveUsdCents),
      held: dollars(s.heldUsdCents),
      paymentCosts: dollars(s.paymentCostsUsdCents),
      claimNetworkFees: dollars(s.claimNetworkFeesUsdCents),
      buybackNetworkFees: dollars(s.buybackNetworkFeesUsdCents),
      platformReserve: dollars(s.platformReserveUsdCents),
      totalRecordedCosts: dollars(s.totalRecordedCostsUsdCents),
      converted: dollars(s.convertedUsdCents),
      burnedTokens: formatTokenUnits(s.burnedTokenBaseUnits, s.burnedTokenDecimals),
    };
    const nextCounts = {
      completedPayments: metric(s.completedPaymentCount),
      pendingPayments: metric(s.pendingPaymentCount),
      claims: metric(s.claimCount),
      tokens: metric(s.tokenCount),
      streamers: metric(s.streamerCount),
      buybacks: metric(s.buybackCount),
      burns: metric(s.burnCount),
    };
    const nextSummary = {
      totalCount: metric(data.activitySummary?.totalCount),
      returnedCount: nextLedger.length,
      truncated: data.activitySummary?.truncated === true,
    };
    // Publish one verified generation; a malformed refresh retains the previous snapshot.
    platformToken = data.platformToken;
    nativeBuybackLedger = data.nativeBuybackLedger;
    tokens = nextTokens;
    streamers = nextStreamers;
    ledger = nextLedger;
    payments = nextPayments;
    totalDonations = nextTotalDonations;
    donationSummary = data.donationSummary;
    overallGiftSpending = data.donationSummary
      ? data.donationSummary.totalGiftSpendingUsdCents / 100
      : nextTotalDonations;
    treasury = nextTreasury;
    catalogCounts = nextCounts;
    activitySummary = nextSummary;
    marketRefreshMs = data.refreshMs;
    catalogRetryAt = 0;
    snapshot = { loading: false, error: '', updatedAt: Date.now() };
  } catch (error) {
    snapshot = {
      ...snapshot,
      loading: false,
      error: error instanceof Error ? error.message : 'Could not load the live catalog.',
    };
  } finally {
    subscribers.forEach((fn) => fn());
  }
}
/** Ordinary reads share one request. A launch forces one trailing fresh generation. */
export function refreshCatalog(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) {
    if (options.force) refreshQueued = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        refreshQueued = false;
        await refreshOnce();
      } while (refreshQueued);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
export const getStreamer = (id: string) =>
  streamers.find((s) => s.id === id) ?? {
    id,
    name: 'Streamer',
    handle: '',
    platform: 'twitch' as const,
    color: '#9146ff',
    image: '/assets/brand/mark.svg',
    category: '',
    bio: '',
  };
export const getToken = (id: string): Token =>
  tokens.find((t) => t.id === id) ?? {
    id,
    name: 'Token',
    symbol: '',
    image: '/assets/brand/mark.svg',
    color: '#9146ff',
    launchpad: 'pump',
    streamerId: '',
    mcap: null,
    volume: null,
    change: null,
    created: 0,
    address: '',
    description: '',
  };
export const tokenDonations = (id: string) =>
  dollars(tokens.find((t) => t.id === id)?.donatedUsdCents);
export const streamerDonations = (id: string) => {
  const streamer = streamers.find((s) => s.id === id);
  return dollars(streamer?.totalGiftSpendingUsdCents ?? streamer?.donatedUsdCents);
};
/** Public presentation only; ledger values remain integer cents. */
export const displayMoney = (value: number | null | undefined, compact = false) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value > 0 && value < 1
      ? '<$1'
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
          ...(compact ? { notation: 'compact' as const } : {}),
        }).format(value);
export const money = displayMoney;
/** Exact dollars for receipts, invoices, card reconciliation and calculations. */
export const decimalMoney = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
export const metricMoney = (cents: number | null | undefined) => displayMoney(dollars(cents));
export const giftMoney = (value: number | null | undefined, compact = false) =>
  value != null && value < 1000 ? decimalMoney(value) : displayMoney(value, compact);
export const wholePercent = (value: number | null | undefined, signed = false) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : `${new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 0,
        signDisplay: signed ? 'exceptZero' : 'auto',
      }).format(Math.abs(value) < 0.5 ? 0 : value)}%`;
export function formatTokenUnits(baseUnits: unknown, decimals: unknown): string | null {
  if (typeof baseUnits !== 'string' || !/^\d{1,78}$/.test(baseUnits)) return null;
  const units = BigInt(baseUnits);
  if (units === 0n) return '0';
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    return null;
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toLocaleString('en-US');
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}
export const payoutStatusLabel = (status?: string) =>
  ({
    awaiting_fees: 'Awaiting creator fees',
    accumulating: 'Accumulating funds',
    awaiting_threshold: 'Below payout threshold',
    reserved: 'Payout reserved',
    funding_pending: 'Funding pending',
    funding_submitted: 'Verifying card credit',
    ready: 'Ready for gifting',
    in_progress: 'Gift in progress',
    uncertain: 'Needs reconciliation',
    paid: 'Payments completed',
    no_payout_due: 'No payout due',
  })[status ?? ''] ?? 'Status unavailable';
/** A next payout's state must not replace the history of gifts already sent. */
export function payoutProgressLabel(
  metrics: FinancialMetrics & Pick<Streamer, 'totalGiftSpendingUsdCents' | 'manualGiftCount'>,
) {
  const recipientTotal = metric(metrics.totalGiftSpendingUsdCents);
  const hasManualGifts = (metric(metrics.manualGiftCount) ?? 0) > 0;
  const recipientHistory = recipientTotal !== null || hasManualGifts;
  const sentCents = recipientTotal ?? (hasManualGifts ? null : metric(metrics.donatedUsdCents));
  const completed =
    (metric(metrics.completedPaymentCount) ?? 0) + (metric(metrics.manualGiftCount) ?? 0);
  if (!(sentCents && sentCents > 0) && completed === 0)
    return payoutStatusLabel(metrics.payoutStatus);
  const sentLabel = recipientHistory ? 'Gifts sent' : 'Sent from creator fees';
  const sent = sentCents === null ? sentLabel : `${sentLabel}: ${decimalMoney(sentCents / 100)}`;
  const hasRemaining =
    (metric(metrics.pendingUsdCents) ?? 0) > 0 || (metric(metrics.pendingPaymentCount) ?? 0) > 0;
  if (!hasRemaining) return sent;
  const nextLabel = recipientHistory ? 'Next creator-fee payout' : 'Next payout';
  return `${sent} · ${nextLabel}: ${payoutStatusLabel(metrics.payoutStatus)}`;
}
export const eventAmount = (event: LedgerEvent) =>
  event.kind === 'Burn' && event.tokenBaseUnits
    ? `${formatTokenUnits(event.tokenBaseUnits, event.tokenDecimals) ?? '—'} POG`
    : displayMoney(event.amount);
export const sortTokens = (list: Token[], sort: Sort) =>
  [...list].sort((a, b) => {
    const difference =
      sort === 'donations'
        ? (metric(b.donatedUsdCents) ?? -1) - (metric(a.donatedUsdCents) ?? -1)
        : sort === 'newest'
          ? b.created - a.created
          : sort === 'volume'
            ? (b.volume ?? -1) - (a.volume ?? -1)
            : (b.mcap ?? -1) - (a.mcap ?? -1);
    return difference || b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
export const filterTokens = (list: Token[], query: string, launchpad: string) =>
  list.filter(
    (t) =>
      (launchpad === 'all' || t.launchpad === launchpad) &&
      `${t.name} ${t.symbol} ${t.address}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
export const padName = (pad: Launchpad) => (pad === 'pump' ? 'Pump.fun' : 'PONs');
