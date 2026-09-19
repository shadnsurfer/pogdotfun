import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { validSolanaAddress } from '../treasury/platform-identity.ts';
import { publicAddresses } from '../treasury/public-addresses.ts';
import type { FeeLot } from './pipeline.ts';

export interface BuybackTarget {
  chain: 'solana';
  mintAddress: string;
  devWallet: string;
  tokenProgramId: string;
  tokenDecimals: number;
}
export interface BuybackPolicy {
  maxSlippageBps: number;
  maxQuoteAgeMs: number;
  maxTargetFeeLamports: string;
  minimumBuyLamports: string;
  maximumBuyLamports: string;
  maxSourceAmountBaseUnits: Partial<Record<FeeLot['chain'], string>>;
  maxSourceGasBaseUnits: Partial<Record<FeeLot['chain'], string>>;
  allowedRouterPrograms: string[];
  maxJobsPerRun?: number;
}
export interface NativeTransferQuote {
  id: string;
  quotedAt: number;
  expiresAt: number;
  sourceChain: FeeLot['chain'];
  sourceAsset: FeeLot['asset'];
  sourceAmountBaseUnits: string;
  destinationChain: 'solana';
  recipient: string;
  expectedSolLamports: string;
}
export interface NativeTransferRequest {
  operationId: string;
  lot: FeeLot;
  target: BuybackTarget;
  quote: NativeTransferQuote;
  minimumSolOutLamports: string;
  maxSourceGasBaseUnits: string;
}
export interface NativeTransferEvidence {
  operationId: string;
  finalized: boolean;
  sourceChain: FeeLot['chain'];
  sourceAsset: FeeLot['asset'];
  sourceClaimReference: string;
  sourceAmountBaseUnits: string;
  /** Total allocation debit INCLUDING source gas and route fees. Must not exceed the child lot. */
  sourceDebitBaseUnits: string;
  sourceGasBaseUnits: string;
  sourceTransactionId: string;
  destinationChain: 'solana';
  recipient: string;
  solAmountLamports: string;
  destinationSignature: string;
  evidenceId: string;
}
export interface NativeBuybackTransferAdapter {
  quote(request: {
    operationId: string;
    lot: FeeLot;
    target: BuybackTarget;
    maxSlippageBps: number;
    maxSourceGasBaseUnits: string;
  }): Promise<NativeTransferQuote>;
  /** Persist signed bytes/nonces BEFORE broadcasting. Idempotency is operationId, across restarts. */
  submit(request: NativeTransferRequest): Promise<{ reference: string }>;
  /** Must verify both finalized source debit and actual Solana SOL credit, never a bridge quote. */
  reconcile(request: NativeTransferRequest): Promise<NativeTransferEvidence | null>;
}
export interface PogSwapQuote {
  id: string;
  quotedAt: number;
  expiresAt: number;
  chain: 'solana';
  mintAddress: string;
  recipient: string;
  routerProgramId: string;
  inputSolLamports: string;
  expectedTokenBaseUnits: string;
}
export interface PogSwapRequest {
  operationId: string;
  target: BuybackTarget;
  inputSolLamports: string;
  quote: PogSwapQuote;
  minimumTokenBaseUnits: string;
  maxFeeLamports: string;
}
export interface PogSwapEvidence {
  operationId: string;
  finalized: boolean;
  chain: 'solana';
  mintAddress: string;
  tokenProgramId: string;
  tokenDecimals: number;
  from: string;
  recipient: string;
  routerProgramId: string;
  solSpentLamports: string;
  feeLamports: string;
  tokenAmountBaseUnits: string;
  signature: string;
  evidenceId: string;
}
export interface VerifiedBuybackTarget extends BuybackTarget {
  verified: true;
  signerAddress: string;
  observedAt: number;
}
export interface PogSwapAdapter {
  /** Read-only chain/deployment check plus proof the injected signer owns devWallet. */
  verifyTarget(target: BuybackTarget): Promise<VerifiedBuybackTarget>;
  quote(request: {
    operationId: string;
    target: BuybackTarget;
    inputSolLamports: string;
    maxSlippageBps: number;
  }): Promise<PogSwapQuote>;
  /** Enforce pinned router program, mint, recipient/minimum output/fee. Journal before broadcast. */
  submit(request: PogSwapRequest): Promise<{ reference: string }>;
  reconcile(request: PogSwapRequest): Promise<PogSwapEvidence | null>;
}
export interface PogBurnRequest {
  operationId: string;
  target: BuybackTarget;
  instruction: 'BurnChecked';
  tokenAmountBaseUnits: string;
  maxFeeLamports: string;
}
export interface PogBurnEvidence {
  operationId: string;
  finalized: boolean;
  chain: 'solana';
  mintAddress: string;
  tokenProgramId: string;
  instruction: 'BurnChecked';
  from: string;
  amountBaseUnits: string;
  totalSupplyBefore: string;
  totalSupplyAfter: string;
  walletBalanceBefore: string;
  walletBalanceAfter: string;
  feeLamports: string;
  signature: string;
  evidenceId: string;
}
export interface PogBurnAdapter {
  /** Bind an SPL BurnChecked instruction for the pinned mint and token program.
   * Verify mint/account ownership and journal signed bytes before broadcasting. */
  submit(request: PogBurnRequest): Promise<{ reference: string }>;
  /** Transaction-attributed state deltas, not unrelated block-wide before/after readings. */
  reconcile(request: PogBurnRequest): Promise<PogBurnEvidence | null>;
}
export interface BuybackOptions {
  enabled: boolean;
  target: BuybackTarget;
  policy: BuybackPolicy;
  transfers: Partial<Record<FeeLot['chain'], NativeBuybackTransferAdapter>>;
  swap?: PogSwapAdapter;
  burn?: PogBurnAdapter;
  now?: () => number;
}
export interface BuybackJob extends FeeLot {
  phase: 'reserved' | 'transferring' | 'funded' | 'buying' | 'bought' | 'burning' | 'completed';
  target: BuybackTarget;
  createdAt: string;
  completedAt?: string;
  targetVerifiedAt?: string;
  sourceSpentBaseUnits?: string;
  residualSourceBaseUnits?: string;
  receivedSolLamports?: string;
  solSpentLamports?: string;
  targetFeesSpentLamports?: string;
  swapFeeLamports?: string;
  burnFeeLamports?: string;
  residualSolLamports?: string;
  purchasedTokenBaseUnits?: string;
  burnedTokenBaseUnits?: string;
  residualTokenBaseUnits?: string;
  sourceTransferReference?: string;
  transferReference?: string;
  buyReference?: string;
  burnReference?: string;
  issue?: string;
}
interface StoredJob extends BuybackJob {
  transferRequest?: NativeTransferRequest;
  swapRequest?: PogSwapRequest;
  burnRequest?: PogBurnRequest;
}
const chains = ['solana', 'bnb', 'robinhood'] as const;
const sameAddress = (a: string, b: string) => a === b;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const operationId = (id: string, stage: string) => `buyback-${stage}-${hash(id)}`;
function units(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value))
    throw new Error('Invalid integer evidence');
  return BigInt(value);
}
function positive(value: string): bigint {
  const n = units(value);
  if (n <= 0n) throw new Error('Positive amount required');
  return n;
}
function address(value: string) {
  if (!validSolanaAddress(value)) throw new Error('Pinned nonzero Solana address required');
}
function txHash(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid finalized transaction hash');
}
function signature(value: string) {
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 64 && bs58.encode(bytes) === value) return;
  } catch {
    /* invalid base58 */
  }
  throw new Error('Invalid finalized Solana signature');
}
function identity(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(value))
    throw new Error('Invalid operation evidence identity');
}
function targetIdentity(target: BuybackTarget) {
  return JSON.stringify([
    target.chain,
    target.mintAddress,
    target.devWallet,
    target.tokenProgramId,
    target.tokenDecimals,
  ]);
}
function claimDigest(lot: FeeLot) {
  return hash(
    JSON.stringify([
      lot.id,
      lot.tokenId,
      lot.chain,
      lot.asset,
      lot.amountBaseUnits,
      lot.decimals,
      lot.claimReference,
      lot.recipient,
    ]),
  );
}
function publicJob(job: StoredJob): BuybackJob {
  const { transferRequest: _transfer, swapRequest: _swap, burnRequest: _burn, ...view } = job;
  return view;
}

/** Consumes the already split native 20% child. Never converts the streamer allocation or credits quotes. */
export function createBuybackWorker(db: DatabaseSync, options: BuybackOptions) {
  const target = structuredClone(options.target),
    policy = structuredClone(options.policy);
  const now = options.now ?? Date.now;
  address(target.mintAddress);
  address(target.devWallet);
  address(target.tokenProgramId);
  if (
    target.chain !== 'solana' ||
    target.devWallet !== publicAddresses.devWallet ||
    !Number.isInteger(target.tokenDecimals) ||
    target.tokenDecimals < 0 ||
    target.tokenDecimals > 18
  )
    throw new Error('Pinned Solana mint and published dev wallet required');
  if (
    !Number.isInteger(policy.maxSlippageBps) ||
    policy.maxSlippageBps < 0 ||
    policy.maxSlippageBps > 1000 ||
    !Number.isSafeInteger(policy.maxQuoteAgeMs) ||
    policy.maxQuoteAgeMs < 1 ||
    policy.maxQuoteAgeMs > 300000 ||
    !policy.allowedRouterPrograms.length
  )
    throw new Error('Invalid buyback policy');
  policy.allowedRouterPrograms.forEach(address);
  positive(policy.maxTargetFeeLamports);
  positive(policy.minimumBuyLamports);
  positive(policy.maximumBuyLamports);
  if (units(policy.maximumBuyLamports) < units(policy.minimumBuyLamports))
    throw new Error('Invalid buyback amount limits');
  const batchSize = policy.maxJobsPerRun ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('Invalid buyback batch size');
  for (const chain of chains) {
    if (policy.maxSourceAmountBaseUnits[chain] !== undefined)
      positive(policy.maxSourceAmountBaseUnits[chain]!);
    if (policy.maxSourceGasBaseUnits[chain] !== undefined)
      units(policy.maxSourceGasBaseUnits[chain]!);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS agent_buyback_jobs(id TEXT PRIMARY KEY,claim_identity TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,phase TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_buyback_evidence(identity TEXT PRIMARY KEY,job_id TEXT NOT NULL,stage TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_buyback_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_rowid INTEGER NOT NULL);
    INSERT OR IGNORE INTO agent_buyback_cursor VALUES(1,0);
    CREATE TABLE IF NOT EXISTS agent_buyback_target(singleton INTEGER PRIMARY KEY CHECK(singleton=1),identity TEXT NOT NULL,target TEXT NOT NULL);`);
  const targetBinding = targetIdentity(target);
  for (const row of db.prepare('SELECT payload FROM agent_buyback_jobs').all()) {
    if (targetIdentity((JSON.parse(String(row.payload)) as StoredJob).target) !== targetBinding)
      throw new Error('Official target binding cannot change for existing buybacks');
  }
  db.prepare('INSERT OR IGNORE INTO agent_buyback_target VALUES(1,?,?)').run(
    targetBinding,
    JSON.stringify(target),
  );
  if (
    db.prepare('SELECT identity FROM agent_buyback_target WHERE singleton=1').get()?.identity !==
    targetBinding
  )
    throw new Error('Official target binding cannot change across worker restarts');
  let running: Promise<void> | undefined;
  function canRecord(chain: FeeLot['chain']) {
    return (
      chains.includes(chain) &&
      policy.maxSourceAmountBaseUnits[chain] !== undefined &&
      policy.maxSourceGasBaseUnits[chain] !== undefined
    );
  }
  function ready(chain: FeeLot['chain']) {
    const transfer = options.transfers[chain],
      swap = options.swap,
      burn = options.burn;
    return (
      options.enabled === true &&
      canRecord(chain) &&
      typeof transfer?.quote === 'function' &&
      typeof transfer.submit === 'function' &&
      typeof transfer.reconcile === 'function' &&
      typeof swap?.verifyTarget === 'function' &&
      typeof swap.quote === 'function' &&
      typeof swap.submit === 'function' &&
      typeof swap.reconcile === 'function' &&
      typeof burn?.submit === 'function' &&
      typeof burn.reconcile === 'function'
    );
  }
  function recordClaim(lot: FeeLot) {
    identity(lot.id);
    identity(lot.claimReference);
    if (
      !canRecord(lot.chain) ||
      !lot.tokenId ||
      lot.asset !== { solana: 'SOL', bnb: 'BNB', robinhood: 'ETH' }[lot.chain] ||
      lot.decimals !== (lot.chain === 'solana' ? 9 : 18) ||
      positive(lot.amountBaseUnits) > units(policy.maxSourceAmountBaseUnits[lot.chain]!) ||
      !['twitch', 'kick'].includes(lot.recipient.platform) ||
      !new RegExp(`^${lot.recipient.platform}:[1-9]\\d*$`).test(lot.recipient.providerId)
    )
      throw new Error('Invalid native buyback allocation');
    const digest = claimDigest(lot);
    const old = db.prepare('SELECT digest,payload FROM agent_buyback_jobs WHERE id=?').get(lot.id);
    if (old) {
      if (
        old.digest !== digest ||
        targetIdentity((JSON.parse(String(old.payload)) as StoredJob).target) !== targetBinding
      )
        throw new Error('Conflicting buyback allocation');
      return;
    }
    const job: StoredJob = {
      ...structuredClone(lot),
      phase: 'reserved',
      target,
      createdAt: new Date(now()).toISOString(),
    };
    db.prepare('INSERT INTO agent_buyback_jobs VALUES(?,?,?,?,0,?)').run(
      lot.id,
      `${lot.chain}:${lot.claimReference}`,
      digest,
      job.phase,
      JSON.stringify(job),
    );
  }
  function fresh(quote: { id: string; quotedAt: number; expiresAt: number }) {
    identity(quote.id);
    const time = now();
    if (
      !Number.isFinite(quote.quotedAt) ||
      !Number.isFinite(quote.expiresAt) ||
      quote.quotedAt > time ||
      time - quote.quotedAt > policy.maxQuoteAgeMs ||
      quote.expiresAt <= time ||
      quote.expiresAt - quote.quotedAt > policy.maxQuoteAgeMs
    )
      throw new Error('Quote expired or unbounded');
  }
  function minimum(expected: string) {
    const result = (positive(expected) * BigInt(10000 - policy.maxSlippageBps)) / 10000n;
    if (result <= 0n) throw new Error('Quote output too small');
    return result.toString();
  }
  function save(
    job: StoredJob,
    revision: number,
    stage?: string,
    identities: string[] = [],
  ): boolean {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT revision FROM agent_buyback_jobs WHERE id=?').get(job.id);
      if (current?.revision !== revision) {
        db.exec('ROLLBACK');
        return false;
      }
      for (const id of new Set(identities))
        db.prepare('INSERT INTO agent_buyback_evidence VALUES(?,?,?)').run(id, job.id, stage!);
      db.prepare(
        'UPDATE agent_buyback_jobs SET phase=?,revision=revision+1,payload=? WHERE id=?',
      ).run(job.phase, JSON.stringify(job), job.id);
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function run() {
    if (options.enabled !== true) return;
    const cursor = Number(
      db.prepare('SELECT last_rowid FROM agent_buyback_cursor WHERE singleton=1').get()!.last_rowid,
    );
    const rows = db
      .prepare(
        "SELECT rowid,payload,revision FROM agent_buyback_jobs WHERE phase!='completed' ORDER BY CASE WHEN rowid>? THEN 0 ELSE 1 END,rowid LIMIT ?",
      )
      .all(cursor, batchSize);
    for (const row of rows) {
      let job = JSON.parse(String(row.payload)) as StoredJob;
      let revision = Number(row.revision);
      const commit = (next: StoredJob, stage?: string, identities: string[] = []) => {
        delete next.issue;
        if (!save(next, revision, stage, identities)) return false;
        job = next;
        revision++;
        return true;
      };
      try {
        if (targetIdentity(job.target) !== targetBinding)
          throw new Error('Configured target changed; original operation remains held');
        if (!ready(job.chain))
          throw new Error('Required source, swap, or supply-burn binding unavailable');
        const transfer = options.transfers[job.chain]!,
          swap = options.swap!,
          burn = options.burn!;
        if (units(job.amountBaseUnits) > units(policy.maxSourceAmountBaseUnits[job.chain]!))
          throw new Error('Source allocation exceeds current policy');
        if (['reserved', 'funded', 'bought'].includes(job.phase)) {
          const binding = await swap.verifyTarget(target);
          if (
            binding.verified !== true ||
            binding.chain !== 'solana' ||
            !sameAddress(binding.mintAddress, target.mintAddress) ||
            binding.tokenProgramId !== target.tokenProgramId ||
            binding.tokenDecimals !== target.tokenDecimals ||
            !sameAddress(binding.devWallet, target.devWallet) ||
            !sameAddress(binding.signerAddress, target.devWallet) ||
            !Number.isFinite(binding.observedAt) ||
            binding.observedAt > now() ||
            now() - binding.observedAt > policy.maxQuoteAgeMs
          )
            throw new Error('Verified target deployment and signer ownership required');
        }
        switch (job.phase) {
          case 'reserved': {
            const id = operationId(job.id, 'transfer');
            const lot: FeeLot = {
              id: job.id,
              tokenId: job.tokenId,
              chain: job.chain,
              asset: job.asset,
              amountBaseUnits: job.amountBaseUnits,
              decimals: job.decimals,
              claimReference: job.claimReference,
              recipient: job.recipient,
            };
            const quote = await transfer.quote({
              operationId: id,
              lot,
              target,
              maxSlippageBps: policy.maxSlippageBps,
              maxSourceGasBaseUnits: policy.maxSourceGasBaseUnits[job.chain]!,
            });
            fresh(quote);
            if (
              quote.sourceChain !== job.chain ||
              quote.sourceAsset !== job.asset ||
              quote.sourceAmountBaseUnits !== job.amountBaseUnits ||
              quote.destinationChain !== 'solana' ||
              !sameAddress(quote.recipient, target.devWallet)
            )
              throw new Error('Transfer quote identity mismatch');
            const request: NativeTransferRequest = {
              operationId: id,
              lot,
              target,
              quote,
              minimumSolOutLamports: minimum(quote.expectedSolLamports),
              maxSourceGasBaseUnits: policy.maxSourceGasBaseUnits[job.chain]!,
            };
            if (!commit({ ...job, phase: 'transferring', transferRequest: request })) break;
            const result = await transfer.submit(request);
            identity(result.reference);
            commit({ ...job, sourceTransferReference: result.reference });
            break;
          }
          case 'transferring': {
            const request = job.transferRequest;
            if (!request) throw new Error('Missing persisted transfer request');
            const proof = await transfer.reconcile(request);
            if (!proof) break;
            if (
              proof.finalized !== true ||
              proof.operationId !== request.operationId ||
              proof.sourceChain !== job.chain ||
              proof.sourceAsset !== job.asset ||
              proof.sourceClaimReference !== job.claimReference ||
              proof.sourceAmountBaseUnits !== job.amountBaseUnits ||
              proof.destinationChain !== 'solana' ||
              !sameAddress(proof.recipient, target.devWallet)
            )
              throw new Error('Finalized transfer identity mismatch');
            const debit = positive(proof.sourceDebitBaseUnits),
              gas = units(proof.sourceGasBaseUnits),
              received = positive(proof.solAmountLamports);
            if (
              debit > units(job.amountBaseUnits) ||
              gas > debit ||
              gas > units(request.maxSourceGasBaseUnits) ||
              received < units(request.minimumSolOutLamports)
            )
              throw new Error('Finalized transfer exceeds policy');
            identity(proof.sourceTransactionId);
            if (job.chain === 'solana') signature(proof.sourceTransactionId);
            else txHash(proof.sourceTransactionId);
            signature(proof.destinationSignature);
            identity(proof.evidenceId);
            const sourceReference =
              job.chain === 'solana'
                ? proof.sourceTransactionId
                : proof.sourceTransactionId.toLowerCase();
            const destinationReference = proof.destinationSignature;
            commit(
              {
                ...job,
                phase: 'funded',
                sourceSpentBaseUnits: debit.toString(),
                residualSourceBaseUnits: (units(job.amountBaseUnits) - debit).toString(),
                receivedSolLamports: received.toString(),
                residualSolLamports: received.toString(),
                sourceTransferReference: sourceReference,
                transferReference: destinationReference,
              },
              'transfer',
              [
                `transfer:evidence:${proof.evidenceId}`,
                `transaction:${job.chain === 'solana' ? 'solana' : job.chain === 'bnb' ? '56' : '4663'}:${sourceReference}`,
                `transaction:solana:${destinationReference}`,
              ],
            );
            break;
          }
          case 'funded': {
            const received = positive(job.receivedSolLamports!),
              reserve = 2n * units(policy.maxTargetFeeLamports);
            const input = received - reserve;
            if (
              input < units(policy.minimumBuyLamports) ||
              input > units(policy.maximumBuyLamports)
            )
              throw new Error('Realized SOL cannot satisfy buy and fee limits');
            const id = operationId(job.id, 'buy');
            const quote = await swap.quote({
              operationId: id,
              target,
              inputSolLamports: input.toString(),
              maxSlippageBps: policy.maxSlippageBps,
            });
            fresh(quote);
            if (
              quote.chain !== 'solana' ||
              !sameAddress(quote.mintAddress, target.mintAddress) ||
              !sameAddress(quote.recipient, target.devWallet) ||
              quote.inputSolLamports !== input.toString() ||
              !policy.allowedRouterPrograms.some((router) =>
                sameAddress(router, quote.routerProgramId),
              )
            )
              throw new Error('Swap quote identity mismatch');
            const request: PogSwapRequest = {
              operationId: id,
              target,
              inputSolLamports: input.toString(),
              quote,
              minimumTokenBaseUnits: minimum(quote.expectedTokenBaseUnits),
              maxFeeLamports: policy.maxTargetFeeLamports,
            };
            if (!commit({ ...job, phase: 'buying', swapRequest: request })) break;
            const result = await swap.submit(request);
            identity(result.reference);
            commit({ ...job, buyReference: result.reference });
            break;
          }
          case 'buying': {
            const request = job.swapRequest;
            if (!request) throw new Error('Missing persisted swap request');
            const proof = await swap.reconcile(request);
            if (!proof) break;
            if (
              proof.finalized !== true ||
              proof.operationId !== request.operationId ||
              proof.chain !== 'solana' ||
              !sameAddress(proof.mintAddress, target.mintAddress) ||
              proof.tokenProgramId !== target.tokenProgramId ||
              proof.tokenDecimals !== target.tokenDecimals ||
              !sameAddress(proof.from, target.devWallet) ||
              !sameAddress(proof.recipient, target.devWallet) ||
              !sameAddress(proof.routerProgramId, request.quote.routerProgramId)
            )
              throw new Error('Finalized swap identity mismatch');
            const spent = positive(proof.solSpentLamports),
              gas = units(proof.feeLamports),
              tokens = positive(proof.tokenAmountBaseUnits);
            if (
              spent > units(request.inputSolLamports) ||
              gas > units(request.maxFeeLamports) ||
              tokens < units(request.minimumTokenBaseUnits) ||
              spent + gas > units(job.receivedSolLamports!)
            )
              throw new Error('Finalized swap exceeds policy');
            signature(proof.signature);
            identity(proof.evidenceId);
            commit(
              {
                ...job,
                phase: 'bought',
                solSpentLamports: spent.toString(),
                targetFeesSpentLamports: gas.toString(),
                swapFeeLamports: gas.toString(),
                residualSolLamports: (units(job.receivedSolLamports!) - spent - gas).toString(),
                purchasedTokenBaseUnits: tokens.toString(),
                residualTokenBaseUnits: tokens.toString(),
                buyReference: proof.signature,
                targetVerifiedAt: new Date(now()).toISOString(),
              },
              'buy',
              [`buy:evidence:${proof.evidenceId}`, `transaction:solana:${proof.signature}`],
            );
            break;
          }
          case 'bought': {
            if (units(job.residualSolLamports!) < units(policy.maxTargetFeeLamports))
              throw new Error('Insufficient branch residual for bounded burn fee');
            const request: PogBurnRequest = {
              operationId: operationId(job.id, 'burn'),
              target,
              instruction: 'BurnChecked',
              tokenAmountBaseUnits: job.purchasedTokenBaseUnits!,
              maxFeeLamports: policy.maxTargetFeeLamports,
            };
            if (!commit({ ...job, phase: 'burning', burnRequest: request })) break;
            const result = await burn.submit(request);
            identity(result.reference);
            commit({ ...job, burnReference: result.reference });
            break;
          }
          case 'burning': {
            const request = job.burnRequest;
            if (!request) throw new Error('Missing persisted burn request');
            const proof = await burn.reconcile(request);
            if (!proof) break;
            if (
              proof.finalized !== true ||
              proof.operationId !== request.operationId ||
              proof.chain !== 'solana' ||
              !sameAddress(proof.mintAddress, target.mintAddress) ||
              proof.tokenProgramId !== target.tokenProgramId ||
              proof.instruction !== 'BurnChecked' ||
              !sameAddress(proof.from, target.devWallet) ||
              proof.amountBaseUnits !== request.tokenAmountBaseUnits
            )
              throw new Error('Finalized burn identity mismatch');
            const burned = positive(proof.amountBaseUnits),
              gas = units(proof.feeLamports);
            if (
              units(proof.totalSupplyBefore) - units(proof.totalSupplyAfter) !== burned ||
              units(proof.walletBalanceBefore) - units(proof.walletBalanceAfter) !== burned ||
              gas > units(request.maxFeeLamports) ||
              gas > units(job.residualSolLamports!)
            )
              throw new Error('Actual supply-reduction proof required');
            signature(proof.signature);
            identity(proof.evidenceId);
            commit(
              {
                ...job,
                phase: 'completed',
                targetFeesSpentLamports: (units(job.targetFeesSpentLamports!) + gas).toString(),
                burnFeeLamports: gas.toString(),
                burnedTokenBaseUnits: burned.toString(),
                residualTokenBaseUnits: (units(job.purchasedTokenBaseUnits!) - burned).toString(),
                residualSolLamports: (units(job.residualSolLamports!) - gas).toString(),
                burnReference: proof.signature,
                completedAt: new Date(now()).toISOString(),
              },
              'burn',
              [`burn:evidence:${proof.evidenceId}`, `transaction:solana:${proof.signature}`],
            );
            break;
          }
        }
      } catch {
        save(
          {
            ...job,
            issue:
              'Buyback held; reconcile the original operation or supply the missing verified binding.',
          },
          revision,
        );
      } finally {
        db.prepare('UPDATE agent_buyback_cursor SET last_rowid=? WHERE singleton=1').run(
          row.rowid!,
        );
      }
    }
  }
  return {
    recordClaim,
    canRecord,
    ready,
    runOnce(): Promise<void> {
      return (running ??= run().finally(() => {
        running = undefined;
      }));
    },
    list(): BuybackJob[] {
      return listBuybackJobs(db);
    },
  };
}

/** Read-only projection; does not require credentials or a configured target. */
export function listBuybackJobs(db: DatabaseSync): BuybackJob[] {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_buyback_jobs'")
      .get()
  )
    return [];
  return db
    .prepare('SELECT payload FROM agent_buyback_jobs ORDER BY rowid')
    .all()
    .map((row) => publicJob(JSON.parse(String(row.payload))));
}
