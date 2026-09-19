import type { BuybackJob, BuybackTarget } from '../agents/buyback.ts';
import type { NativeFeeSplit } from '../agents/fee-router.ts';
import type { FeeLot } from '../agents/pipeline.ts';
import { validPlatformTarget, type PlatformIdentity } from '../treasury/platform-identity.ts';

export interface PublicPlatformToken extends PlatformIdentity {
  id: 'platform-pog';
  name: 'Pog';
  symbol: 'POG';
  solSpentLamports: string;
  targetFeesSpentLamports: string;
  burnedTokenBaseUnits: string;
  buybackCount: number;
  burnCount: number;
  lastExecutionAt: string | null;
}
export interface PublicNativeBuybackLedger {
  allocationVersion: 'native-streamer-v1';
  sources: Array<{
    chain: FeeLot['chain'];
    asset: FeeLot['asset'];
    decimals: number;
    claimedBaseUnits: string;
    streamerBaseUnits: string;
    buybackBaseUnits: string;
    pendingBuybackBaseUnits: string;
    sourceSpentBaseUnits: string;
    residualSourceBaseUnits: string;
  }>;
  receivedSolLamports: string;
  solSpentLamports: string;
  targetFeesSpentLamports: string;
  residualSolLamports: string;
  purchasedTokenBaseUnits: string;
  burnedTokenBaseUnits: string;
  residualTokenBaseUnits: string;
  tokenDecimals: number | null;
  buybackCount: number;
  burnCount: number;
  receipts: Array<{
    id: string;
    sourceChain: FeeLot['chain'];
    sourceAsset: FeeLot['asset'];
    sourceAmountBaseUnits: string;
    phase: BuybackJob['phase'];
    receivedSolLamports: string | null;
    solSpentLamports: string | null;
    burnedTokenBaseUnits: string | null;
    sourceTransferReference: string | null;
    transferReference: string | null;
    buyReference: string | null;
    burnReference: string | null;
    completedAt: string | null;
  }>;
}
function invalid(): never {
  throw new Error('Invalid native buyback evidence.');
}
function units(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  return BigInt(value);
}
function time(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function reference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
  return value;
}
function targetIdentity(target: BuybackTarget): string {
  if (!validPlatformTarget(target)) invalid();
  return JSON.stringify([
    target.chain,
    target.mintAddress,
    target.devWallet,
    target.tokenProgramId,
    target.tokenDecimals,
  ]);
}
function lotIdentity(lot: FeeLot): string {
  return JSON.stringify([
    lot.id,
    lot.tokenId,
    lot.chain,
    lot.asset,
    lot.decimals,
    lot.amountBaseUnits,
    lot.claimReference,
    lot.recipient,
  ]);
}
/** Native allocations and confirmed target-chain receipts stay separate from USD/card ledgers. */
export function projectNativeBuybacks<T extends object>(
  catalog: T,
  context: { target?: BuybackTarget; jobs: BuybackJob[]; splits: NativeFeeSplit[] },
) {
  const boundTarget = context.target ?? context.jobs[0]?.target;
  const configured = boundTarget ? targetIdentity(boundTarget) : null;
  const sources = new Map<string, PublicNativeBuybackLedger['sources'][number]>();
  const children = new Map<string, FeeLot>();
  const originalIds = new Set<string>();
  const claimIds = new Set<string>();
  for (const split of context.splits) {
    const o = split.original,
      s = split.streamer,
      b = split.buyback,
      amount = units(o.amountBaseUnits),
      buyback = amount / 5n;
    const claimKey = JSON.stringify([o.chain, o.tokenId, o.claimReference]);
    if (
      split.version !== 'native-streamer-v1' ||
      originalIds.has(o.id) ||
      claimIds.has(claimKey) ||
      !time(split.createdAt) ||
      amount <= 0n ||
      !['solana', 'bnb', 'robinhood'].includes(o.chain) ||
      o.asset !== ({ solana: 'SOL', bnb: 'BNB', robinhood: 'ETH' } as const)[o.chain] ||
      o.decimals !== (o.chain === 'solana' ? 9 : 18) ||
      lotIdentity(s) !==
        lotIdentity({ ...o, id: `${o.id}:streamer`, amountBaseUnits: String(amount - buyback) }) ||
      (buyback === 0n
        ? b !== null
        : !b ||
          lotIdentity(b) !==
            lotIdentity({ ...o, id: `${o.id}:buyback`, amountBaseUnits: String(buyback) }))
    )
      invalid();
    originalIds.add(o.id);
    claimIds.add(claimKey);
    if (b) children.set(b.id, b);
    const key = JSON.stringify([o.chain, o.asset, o.decimals]);
    const row = sources.get(key) ?? {
      chain: o.chain,
      asset: o.asset,
      decimals: o.decimals,
      claimedBaseUnits: '0',
      streamerBaseUnits: '0',
      buybackBaseUnits: '0',
      pendingBuybackBaseUnits: '0',
      sourceSpentBaseUnits: '0',
      residualSourceBaseUnits: '0',
    };
    row.claimedBaseUnits = String(BigInt(row.claimedBaseUnits) + amount);
    row.streamerBaseUnits = String(BigInt(row.streamerBaseUnits) + amount - buyback);
    row.buybackBaseUnits = String(BigInt(row.buybackBaseUnits) + buyback);
    row.pendingBuybackBaseUnits = String(BigInt(row.pendingBuybackBaseUnits) + buyback);
    sources.set(key, row);
  }
  const ledger: PublicNativeBuybackLedger = {
    allocationVersion: 'native-streamer-v1',
    sources: [...sources.values()],
    receivedSolLamports: '0',
    solSpentLamports: '0',
    targetFeesSpentLamports: '0',
    residualSolLamports: '0',
    purchasedTokenBaseUnits: '0',
    burnedTokenBaseUnits: '0',
    residualTokenBaseUnits: '0',
    tokenDecimals: boundTarget?.tokenDecimals ?? null,
    buybackCount: 0,
    burnCount: 0,
    receipts: [],
  };
  const ids = new Set<string>(),
    proofs = new Set<string>();
  let verifiedAt: string | null = null,
    lastExecutionAt: string | null = null;
  let verifiedTarget: BuybackTarget | undefined;
  const sum = (
    key:
      | 'receivedSolLamports'
      | 'solSpentLamports'
      | 'targetFeesSpentLamports'
      | 'residualSolLamports'
      | 'purchasedTokenBaseUnits'
      | 'burnedTokenBaseUnits'
      | 'residualTokenBaseUnits',
    value: bigint,
  ) => {
    ledger[key] = String(BigInt(ledger[key]) + value);
  };
  for (const job of context.jobs) {
    const child = children.get(job.id);
    const bound = targetIdentity(job.target);
    if (
      ids.has(job.id) ||
      !child ||
      lotIdentity(child) !== lotIdentity(job) ||
      !configured ||
      configured !== bound ||
      !['reserved', 'transferring', 'funded', 'buying', 'bought', 'burning', 'completed'].includes(
        job.phase,
      )
    )
      invalid();
    ids.add(job.id);
    const bought = ['bought', 'burning', 'completed'].includes(job.phase),
      funded = ['funded', 'buying', 'bought', 'burning', 'completed'].includes(job.phase),
      completed = job.phase === 'completed';
    const received = funded ? units(job.receivedSolLamports) : 0n;
    if (funded && received <= 0n) invalid();
    if (funded) {
      const transferProof = reference(job.transferReference);
      if (proofs.has(transferProof)) invalid();
      proofs.add(transferProof);
      reference(job.sourceTransferReference);
      sum('receivedSolLamports', received);
      const sourceSpent = units(job.sourceSpentBaseUnits),
        sourceResidual = units(job.residualSourceBaseUnits);
      if (sourceSpent <= 0n || sourceSpent + sourceResidual !== units(job.amountBaseUnits))
        invalid();
      const source = sources.get(JSON.stringify([job.chain, job.asset, job.decimals]))!;
      source.sourceSpentBaseUnits = String(BigInt(source.sourceSpentBaseUnits) + sourceSpent);
      source.residualSourceBaseUnits = String(
        BigInt(source.residualSourceBaseUnits) + sourceResidual,
      );
      source.pendingBuybackBaseUnits = String(
        BigInt(source.pendingBuybackBaseUnits) - units(job.amountBaseUnits),
      );
    }
    let spent: bigint | null = null,
      burned: bigint | null = null;
    if (bought) {
      if (!time(job.targetVerifiedAt)) invalid();
      verifiedTarget = job.target;
      verifiedAt =
        verifiedAt && Date.parse(verifiedAt) > Date.parse(job.targetVerifiedAt)
          ? verifiedAt
          : job.targetVerifiedAt;
      spent = units(job.solSpentLamports);
      const residual = units(job.residualSolLamports),
        purchased = units(job.purchasedTokenBaseUnits);
      const gas = units(job.targetFeesSpentLamports);
      if (gas !== units(job.swapFeeLamports) + (completed ? units(job.burnFeeLamports) : 0n))
        invalid();
      if (spent <= 0n || purchased <= 0n || spent + gas + residual !== received) invalid();
      sum('targetFeesSpentLamports', gas);
      const proof = reference(job.buyReference);
      if (proofs.has(proof)) invalid();
      proofs.add(proof);
      sum('solSpentLamports', spent);
      sum('residualSolLamports', residual);
      sum('purchasedTokenBaseUnits', purchased);
      ledger.buybackCount++;
      if (completed) {
        burned = units(job.burnedTokenBaseUnits);
        const remainder = units(job.residualTokenBaseUnits);
        if (burned <= 0n || burned + remainder !== purchased || !time(job.completedAt)) invalid();
        const proof = reference(job.burnReference);
        if (proofs.has(proof)) invalid();
        proofs.add(proof);
        sum('burnedTokenBaseUnits', burned);
        sum('residualTokenBaseUnits', remainder);
        ledger.burnCount++;
        lastExecutionAt =
          lastExecutionAt && Date.parse(lastExecutionAt) > Date.parse(job.completedAt)
            ? lastExecutionAt
            : job.completedAt;
      } else sum('residualTokenBaseUnits', purchased);
    } else if (funded) sum('residualSolLamports', received);
    ledger.receipts.push({
      id: job.id,
      sourceChain: job.chain,
      sourceAsset: job.asset,
      sourceAmountBaseUnits: job.amountBaseUnits,
      phase: job.phase,
      receivedSolLamports: funded ? String(received) : null,
      solSpentLamports: spent === null ? null : String(spent),
      burnedTokenBaseUnits: burned === null ? null : String(burned),
      sourceTransferReference: funded ? reference(job.sourceTransferReference) : null,
      transferReference: funded ? reference(job.transferReference) : null,
      buyReference: bought ? reference(job.buyReference) : null,
      burnReference: completed ? reference(job.burnReference) : null,
      completedAt: completed ? job.completedAt! : null,
    });
  }
  const platformToken: PublicPlatformToken | null =
    verifiedAt && verifiedTarget
      ? {
          id: 'platform-pog',
          name: 'Pog',
          symbol: 'POG',
          chain: 'solana',
          address: verifiedTarget.mintAddress,
          devWallet: verifiedTarget.devWallet,
          tokenProgramId: verifiedTarget.tokenProgramId,
          tokenDecimals: verifiedTarget.tokenDecimals,
          verifiedAt,
          solSpentLamports: ledger.solSpentLamports,
          targetFeesSpentLamports: ledger.targetFeesSpentLamports,
          burnedTokenBaseUnits: ledger.burnedTokenBaseUnits,
          buybackCount: ledger.buybackCount,
          burnCount: ledger.burnCount,
          lastExecutionAt,
        }
      : null;
  const {
    platformToken: _oldToken,
    nativeBuybackLedger: _oldLedger,
    officialPlatformIntent: _oldIntent,
    ...base
  } = catalog as T & {
    platformToken?: unknown;
    nativeBuybackLedger?: unknown;
    officialPlatformIntent?: unknown;
  };
  return {
    ...base,
    platformToken,
    nativeBuybackLedger: ledger,
    officialPlatformIntent: {
      chain: 'solana' as const,
      status: !context.target
        ? ('unconfigured' as const)
        : platformToken
          ? ('verified' as const)
          : ('configured' as const),
    },
  };
}
