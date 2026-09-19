import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import type { FeeLot } from './pipeline.ts';

export interface BuybackTarget {
  chainId: 4663;
  tokenAddress: Address;
  devWallet: Address;
  tokenCodeHash: Hex;
  tokenDecimals: number;
}
export interface BuybackPolicy {
  maxSlippageBps: number;
  maxQuoteAgeMs: number;
  maxTargetGasWei: string;
  minimumBuyWei: string;
  maximumBuyWei: string;
  maxSourceAmountBaseUnits: Partial<Record<FeeLot['chain'], string>>;
  maxSourceGasBaseUnits: Partial<Record<FeeLot['chain'], string>>;
  allowedRouters: Address[];
  maxJobsPerRun?: number;
}
export interface NativeTransferQuote {
  id: string;
  quotedAt: number;
  expiresAt: number;
  sourceChain: FeeLot['chain'];
  sourceAsset: FeeLot['asset'];
  sourceAmountBaseUnits: string;
  destinationChainId: 4663;
  recipient: Address;
  expectedEthWei: string;
}
export interface NativeTransferRequest {
  operationId: string;
  lot: FeeLot;
  target: BuybackTarget;
  quote: NativeTransferQuote;
  minimumEthOutWei: string;
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
  sourceTransactionHash: string;
  destinationChainId: 4663;
  recipient: Address;
  ethAmountWei: string;
  destinationTransactionHash: Hex;
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
  /** Must verify both finalized source debit and actual native ETH credit, never a bridge quote. */
  reconcile(request: NativeTransferRequest): Promise<NativeTransferEvidence | null>;
}
export interface PogSwapQuote {
  id: string;
  quotedAt: number;
  expiresAt: number;
  chainId: 4663;
  tokenAddress: Address;
  recipient: Address;
  routerAddress: Address;
  inputEthWei: string;
  expectedTokenBaseUnits: string;
}
export interface PogSwapRequest {
  operationId: string;
  target: BuybackTarget;
  inputEthWei: string;
  quote: PogSwapQuote;
  minimumTokenBaseUnits: string;
  maxGasWei: string;
}
export interface PogSwapEvidence {
  operationId: string;
  finalized: boolean;
  chainId: 4663;
  tokenAddress: Address;
  tokenCodeHash: Hex;
  tokenDecimals: number;
  from: Address;
  recipient: Address;
  routerAddress: Address;
  ethSpentWei: string;
  gasWei: string;
  tokenAmountBaseUnits: string;
  transactionHash: Hex;
  evidenceId: string;
}
export interface VerifiedBuybackTarget extends BuybackTarget {
  verified: true;
  signerAddress: Address;
  observedAt: number;
}
export interface PogSwapAdapter {
  /** Read-only chain/deployment check plus proof the injected signer owns devWallet. */
  verifyTarget(target: BuybackTarget): Promise<VerifiedBuybackTarget>;
  quote(request: {
    operationId: string;
    target: BuybackTarget;
    inputEthWei: string;
    maxSlippageBps: number;
  }): Promise<PogSwapQuote>;
  /** Enforce pinned router, chain, calldata recipient/minimum output/gas. Journal before broadcast. */
  submit(request: PogSwapRequest): Promise<{ reference: string }>;
  reconcile(request: PogSwapRequest): Promise<PogSwapEvidence | null>;
}
export interface PogBurnRequest {
  operationId: string;
  target: BuybackTarget;
  tokenAmountBaseUnits: string;
  maxGasWei: string;
}
export interface PogBurnEvidence {
  operationId: string;
  finalized: boolean;
  chainId: 4663;
  tokenAddress: Address;
  tokenCodeHash: Hex;
  from: Address;
  amountBaseUnits: string;
  totalSupplyBefore: string;
  totalSupplyAfter: string;
  walletBalanceBefore: string;
  walletBalanceAfter: string;
  gasWei: string;
  transactionHash: Hex;
  evidenceId: string;
}
export interface PogBurnAdapter {
  /** Bind an actually supported supply-reducing method. A transfer to a sink is insufficient.
   * Verify the target deployment/implementation and journal signed bytes before broadcasting. */
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
  receivedEthWei?: string;
  ethSpentWei?: string;
  targetGasSpentWei?: string;
  swapGasWei?: string;
  burnGasWei?: string;
  residualEthWei?: string;
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
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
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
  if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value))
    throw new Error('Pinned nonzero target address required');
}
function txHash(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid finalized transaction hash');
}
function identity(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(value))
    throw new Error('Invalid operation evidence identity');
}
function targetIdentity(target: BuybackTarget) {
  return JSON.stringify([
    target.chainId,
    target.tokenAddress.toLowerCase(),
    target.devWallet.toLowerCase(),
    target.tokenCodeHash.toLowerCase(),
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
  address(target.tokenAddress);
  address(target.devWallet);
  txHash(target.tokenCodeHash);
  if (
    target.chainId !== 4663 ||
    !Number.isInteger(target.tokenDecimals) ||
    target.tokenDecimals < 0 ||
    target.tokenDecimals > 36
  )
    throw new Error('Pinned Robinhood target required');
  if (
    !Number.isInteger(policy.maxSlippageBps) ||
    policy.maxSlippageBps < 0 ||
    policy.maxSlippageBps > 1000 ||
    !Number.isSafeInteger(policy.maxQuoteAgeMs) ||
    policy.maxQuoteAgeMs < 1 ||
    policy.maxQuoteAgeMs > 300000 ||
    !policy.allowedRouters.length
  )
    throw new Error('Invalid buyback policy');
  policy.allowedRouters.forEach(address);
  positive(policy.maxTargetGasWei);
  positive(policy.minimumBuyWei);
  positive(policy.maximumBuyWei);
  if (units(policy.maximumBuyWei) < units(policy.minimumBuyWei))
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
            binding.chainId !== 4663 ||
            !sameAddress(binding.tokenAddress, target.tokenAddress) ||
            binding.tokenCodeHash !== target.tokenCodeHash ||
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
              quote.destinationChainId !== 4663 ||
              !sameAddress(quote.recipient, target.devWallet)
            )
              throw new Error('Transfer quote identity mismatch');
            const request: NativeTransferRequest = {
              operationId: id,
              lot,
              target,
              quote,
              minimumEthOutWei: minimum(quote.expectedEthWei),
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
              proof.destinationChainId !== 4663 ||
              !sameAddress(proof.recipient, target.devWallet)
            )
              throw new Error('Finalized transfer identity mismatch');
            const debit = positive(proof.sourceDebitBaseUnits),
              gas = units(proof.sourceGasBaseUnits),
              received = positive(proof.ethAmountWei);
            if (
              debit > units(job.amountBaseUnits) ||
              gas > debit ||
              gas > units(request.maxSourceGasBaseUnits) ||
              received < units(request.minimumEthOutWei)
            )
              throw new Error('Finalized transfer exceeds policy');
            identity(proof.sourceTransactionHash);
            if (job.chain !== 'solana') txHash(proof.sourceTransactionHash);
            txHash(proof.destinationTransactionHash);
            identity(proof.evidenceId);
            const sourceHash =
              job.chain === 'solana'
                ? proof.sourceTransactionHash
                : proof.sourceTransactionHash.toLowerCase();
            const destinationHash = proof.destinationTransactionHash.toLowerCase();
            commit(
              {
                ...job,
                phase: 'funded',
                sourceSpentBaseUnits: debit.toString(),
                residualSourceBaseUnits: (units(job.amountBaseUnits) - debit).toString(),
                receivedEthWei: received.toString(),
                residualEthWei: received.toString(),
                sourceTransferReference: sourceHash,
                transferReference: destinationHash,
              },
              'transfer',
              [
                `transfer:evidence:${proof.evidenceId}`,
                `transaction:${job.chain === 'solana' ? 'solana' : job.chain === 'bnb' ? '56' : '4663'}:${sourceHash}`,
                `transaction:4663:${destinationHash}`,
              ],
            );
            break;
          }
          case 'funded': {
            const received = positive(job.receivedEthWei!),
              reserve = 2n * units(policy.maxTargetGasWei);
            const input = received - reserve;
            if (input < units(policy.minimumBuyWei) || input > units(policy.maximumBuyWei))
              throw new Error('Realized ETH cannot satisfy buy and gas limits');
            const id = operationId(job.id, 'buy');
            const quote = await swap.quote({
              operationId: id,
              target,
              inputEthWei: input.toString(),
              maxSlippageBps: policy.maxSlippageBps,
            });
            fresh(quote);
            if (
              quote.chainId !== 4663 ||
              !sameAddress(quote.tokenAddress, target.tokenAddress) ||
              !sameAddress(quote.recipient, target.devWallet) ||
              quote.inputEthWei !== input.toString() ||
              !policy.allowedRouters.some((router) => sameAddress(router, quote.routerAddress))
            )
              throw new Error('Swap quote identity mismatch');
            const request: PogSwapRequest = {
              operationId: id,
              target,
              inputEthWei: input.toString(),
              quote,
              minimumTokenBaseUnits: minimum(quote.expectedTokenBaseUnits),
              maxGasWei: policy.maxTargetGasWei,
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
              proof.chainId !== 4663 ||
              !sameAddress(proof.tokenAddress, target.tokenAddress) ||
              proof.tokenCodeHash !== target.tokenCodeHash ||
              proof.tokenDecimals !== target.tokenDecimals ||
              !sameAddress(proof.from, target.devWallet) ||
              !sameAddress(proof.recipient, target.devWallet) ||
              !sameAddress(proof.routerAddress, request.quote.routerAddress)
            )
              throw new Error('Finalized swap identity mismatch');
            const spent = positive(proof.ethSpentWei),
              gas = units(proof.gasWei),
              tokens = positive(proof.tokenAmountBaseUnits);
            if (
              spent > units(request.inputEthWei) ||
              gas > units(request.maxGasWei) ||
              tokens < units(request.minimumTokenBaseUnits) ||
              spent + gas > units(job.receivedEthWei!)
            )
              throw new Error('Finalized swap exceeds policy');
            txHash(proof.transactionHash);
            identity(proof.evidenceId);
            commit(
              {
                ...job,
                phase: 'bought',
                ethSpentWei: spent.toString(),
                targetGasSpentWei: gas.toString(),
                swapGasWei: gas.toString(),
                residualEthWei: (units(job.receivedEthWei!) - spent - gas).toString(),
                purchasedTokenBaseUnits: tokens.toString(),
                residualTokenBaseUnits: tokens.toString(),
                buyReference: proof.transactionHash.toLowerCase(),
                targetVerifiedAt: new Date(now()).toISOString(),
              },
              'buy',
              [
                `buy:evidence:${proof.evidenceId}`,
                `transaction:4663:${proof.transactionHash.toLowerCase()}`,
              ],
            );
            break;
          }
          case 'bought': {
            if (units(job.residualEthWei!) < units(policy.maxTargetGasWei))
              throw new Error('Insufficient branch residual for bounded burn gas');
            const request: PogBurnRequest = {
              operationId: operationId(job.id, 'burn'),
              target,
              tokenAmountBaseUnits: job.purchasedTokenBaseUnits!,
              maxGasWei: policy.maxTargetGasWei,
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
              proof.chainId !== 4663 ||
              !sameAddress(proof.tokenAddress, target.tokenAddress) ||
              proof.tokenCodeHash !== target.tokenCodeHash ||
              !sameAddress(proof.from, target.devWallet) ||
              proof.amountBaseUnits !== request.tokenAmountBaseUnits
            )
              throw new Error('Finalized burn identity mismatch');
            const burned = positive(proof.amountBaseUnits),
              gas = units(proof.gasWei);
            if (
              units(proof.totalSupplyBefore) - units(proof.totalSupplyAfter) !== burned ||
              units(proof.walletBalanceBefore) - units(proof.walletBalanceAfter) !== burned ||
              gas > units(request.maxGasWei) ||
              gas > units(job.residualEthWei!)
            )
              throw new Error('Actual supply-reduction proof required');
            txHash(proof.transactionHash);
            identity(proof.evidenceId);
            commit(
              {
                ...job,
                phase: 'completed',
                targetGasSpentWei: (units(job.targetGasSpentWei!) + gas).toString(),
                burnGasWei: gas.toString(),
                burnedTokenBaseUnits: burned.toString(),
                residualTokenBaseUnits: (units(job.purchasedTokenBaseUnits!) - burned).toString(),
                residualEthWei: (units(job.residualEthWei!) - gas).toString(),
                burnReference: proof.transactionHash.toLowerCase(),
                completedAt: new Date(now()).toISOString(),
              },
              'burn',
              [
                `burn:evidence:${proof.evidenceId}`,
                `transaction:4663:${proof.transactionHash.toLowerCase()}`,
              ],
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
