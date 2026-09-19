import { createRequire } from 'node:module';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { LaunchError } from './types.ts';
import { abortableLaunchRead } from './reconciliation.ts';
import { normalizeInitialBuyLamports } from './initial-buy.ts';
import type {
  LaunchChain,
  LaunchPlan,
  LaunchRecord,
  PreparedLaunch,
  LaunchChainResult,
} from './types.ts';

const require = createRequire(import.meta.url);
const {
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  getBuyTokenAmountFromSolAmount,
  bondingCurvePda,
  canonicalPumpPoolPda,
} = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { BN } = require('@coral-xyz/anchor') as typeof import('@coral-xyz/anchor');
const { PUMP_AMM_SDK } =
  require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');

export interface PumpLaunchChainConfig {
  rpcUrl: string;
  expectedGenesisHash: string;
  transactionsEnabled: boolean;
  creatorReserveLamports?: number;
  maximumLaunchLamports?: number;
  priorityMicroLamports?: number;
  /** Shared table compresses locally built addresses only; it never supplies instructions. */
  lookupTableAddress?: string;
  /** Injectable read transport for deterministic verification tests. */
  fetch?: typeof fetch;
}
function amount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new LaunchError(502, 'RPC returned an invalid lamport amount.');
  return BigInt(value);
}

export class PumpLaunchChain implements LaunchChain {
  private readonly injectedConnection?: Connection;
  private readonly reserve: number;
  private readonly maximum: number;
  private readonly priority: number;
  private readonly lookupTable: PublicKey | undefined;
  constructor(
    private readonly config: PumpLaunchChainConfig,
    connection?: Connection,
  ) {
    if (new URL(config.rpcUrl).protocol !== 'https:' || !config.expectedGenesisHash)
      throw new LaunchError(503, 'An HTTPS RPC and verified Solana network are required.');
    this.injectedConnection = connection;
    this.reserve = config.creatorReserveLamports ?? 2_000_000;
    this.maximum = config.maximumLaunchLamports ?? 100_000_000;
    this.priority = config.priorityMicroLamports ?? 1000;
    // Public mainnet table verified on 2026-09-16. Operators may replace it with
    // their own table. Every preparation rechecks its owner and active state.
    // Source: github.com/Based-LTD/prooflaunch/blob/main/src/services/pumpfun.ts
    const lookupAddress =
      config.lookupTableAddress ??
      (config.expectedGenesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        ? '9TaT2hRwB4TnvpWz5eJ6kDtuHzagzWV2uUhReeVd6rsk'
        : undefined);
    try {
      this.lookupTable = lookupAddress ? new PublicKey(lookupAddress) : undefined;
    } catch {
      throw new LaunchError(503, 'The launch address lookup table is invalid.');
    }
    if (
      ![this.reserve, this.maximum, this.priority].every(Number.isSafeInteger) ||
      this.reserve < 100_000 ||
      this.reserve > 10_000_000 ||
      this.maximum < this.reserve ||
      this.maximum > 1_000_000_000 ||
      this.priority < 0 ||
      this.priority > 1_000_000
    )
      throw new LaunchError(503, 'Invalid launch fee limits.');
  }
  private connectionFor(signal: AbortSignal) {
    return (
      this.injectedConnection ??
      new Connection(this.config.rpcUrl, {
        commitment: 'finalized',
        disableRetryOnRateLimit: true,
        fetch: async (input, init) => {
          signal.throwIfAborted();
          return (this.config.fetch ?? fetch)(input, {
            ...init,
            redirect: 'error',
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          });
        },
      })
    );
  }
  private async network(connection: Connection, signal: AbortSignal) {
    if (
      (await abortableLaunchRead(() => connection.getGenesisHash(), signal)) !==
      this.config.expectedGenesisHash
    )
      throw new LaunchError(503, 'The RPC does not match the configured Solana network.');
  }
  async prepare(
    plan: LaunchPlan,
    mint: Keypair,
    signal = AbortSignal.timeout(30_000),
  ): Promise<PreparedLaunch> {
    signal.throwIfAborted();
    return abortableLaunchRead(
      () => this.prepareWithConnection(plan, mint, this.connectionFor(signal), signal),
      signal,
    );
  }
  private async prepareWithConnection(
    plan: LaunchPlan,
    mint: Keypair,
    connection: Connection,
    signal: AbortSignal,
  ): Promise<PreparedLaunch> {
    const read = <T>(work: () => Promise<T>) => abortableLaunchRead(work, signal);
    await this.network(connection, signal);
    if (mint.publicKey.toBase58() !== plan.mint)
      throw new LaunchError(409, 'The mint signer does not match this launch.');
    const payer = new PublicKey(plan.walletAddress);
    const creator = new PublicKey(plan.creatorAddress);
    let initialBuy: bigint;
    try {
      initialBuy = BigInt(normalizeInitialBuyLamports(plan.initialBuyLamports) ?? '0');
    } catch {
      throw new LaunchError(400, 'Enter a valid initial buy amount in whole lamports.');
    }
    const existing = await read(() =>
      connection.getMultipleAccountsInfo([mint.publicKey, creator], 'finalized'),
    );
    if (existing.some(Boolean))
      throw new LaunchError(
        409,
        'Launch addresses already exist. Reconcile this intent before continuing.',
      );
    const create = await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey,
      name: plan.name,
      symbol: plan.symbol,
      uri: plan.metadataUri,
      creator,
      user: payer,
      mayhemMode: false,
      cashback: false,
      holderReward: false,
    });
    const payerBefore = await read(() => connection.getBalance(payer, 'finalized'));
    if (amount(payerBefore) < initialBuy + BigInt(this.reserve))
      throw new LaunchError(
        400,
        'Your wallet needs enough SOL for the initial buy and launch fees. Check your balance.',
      );
    const launchInstructions = [create];
    const lookupTables: AddressLookupTableAccount[] = [];
    if (initialBuy > 0n) {
      if (!this.lookupTable)
        throw new LaunchError(
          503,
          'An address lookup table is required for an atomic launch and initial buy.',
        );
      const tableInfo = await read(() => connection.getAccountInfo(this.lookupTable!, 'finalized'));
      if (!tableInfo || !tableInfo.owner.equals(AddressLookupTableProgram.programId))
        throw new LaunchError(
          503,
          'The launch address lookup table is unavailable. Please try again later.',
        );
      let table: AddressLookupTableAccount;
      try {
        table = new AddressLookupTableAccount({
          key: this.lookupTable,
          state: AddressLookupTableAccount.deserialize(tableInfo.data),
        });
      } catch {
        throw new LaunchError(503, 'The launch address lookup table is invalid.');
      }
      if (!table.isActive())
        throw new LaunchError(
          503,
          'The launch address lookup table is inactive. Please try again later.',
        );
      lookupTables.push(table);
      const globalInfo = await read(() => connection.getAccountInfo(GLOBAL_PDA, 'finalized'));
      const feeInfo = await read(() => connection.getAccountInfo(PUMP_FEE_CONFIG_PDA, 'finalized'));
      if (!globalInfo?.owner.equals(PUMP_PROGRAM_ID) || !feeInfo?.owner.equals(PUMP_FEE_PROGRAM_ID))
        throw new LaunchError(
          502,
          'The Pump pricing accounts could not be verified. Please try again.',
        );
      const global = PUMP_SDK.decodeGlobal(globalInfo);
      const feeConfig = PUMP_SDK.decodeFeeConfig(feeInfo);
      const budget = new BN(initialBuy.toString());
      const tokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: budget,
        quoteMint: NATIVE_MINT,
      });
      if (tokens.isZero())
        throw new LaunchError(
          400,
          'The initial buy is too small to receive tokens. Increase it or leave it empty.',
        );
      if (tokens.gte(global.initialRealTokenReserves))
        throw new LaunchError(
          400,
          'The initial buy is too large: it would complete the bonding curve before launch registration. Choose a smaller amount.',
        );
      const buybackFeeRecipient = global.buybackFeeRecipients.find(
        (key) => !key.equals(PublicKey.default),
      );
      if (!buybackFeeRecipient)
        throw new LaunchError(
          502,
          'The Pump buy fee recipient could not be verified. Please try again.',
        );
      launchInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          getAssociatedTokenAddressSync(mint.publicKey, payer, false, TOKEN_2022_PROGRAM_ID),
          payer,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        // The convenience create-and-buy builder adds 1% to the SOL cap. A raw
        // buy keeps the user's chosen budget exact, including Pump trading fees.
        await PUMP_SDK.getBuyInstructionRaw({
          user: payer,
          mint: mint.publicKey,
          creator,
          amount: tokens,
          solAmount: budget,
          feeRecipient: global.feeRecipient,
          buybackFeeRecipient,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        }),
      );
    }
    const latest = await read(() => connection.getLatestBlockhash('finalized'));
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: initialBuy > 0n ? 500_000 : 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priority }),
        ...launchInstructions,
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: creator, lamports: this.reserve }),
      ],
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    let serialized: Uint8Array;
    try {
      tx.sign([mint]);
      serialized = tx.serialize();
    } catch {
      throw new LaunchError(
        400,
        'The launch transaction is too large. Shorten the token name or metadata URI.',
      );
    }
    if (serialized.length > 1232)
      throw new LaunchError(
        400,
        'The launch transaction is too large. Shorten the token name or metadata URI.',
      );
    const simulate = (replaceRecentBlockhash = false) =>
      read(() =>
        connection.simulateTransaction(tx, {
          sigVerify: false,
          commitment: 'finalized',
          replaceRecentBlockhash,
          accounts: { encoding: 'base64', addresses: [payer.toBase58()] },
        }),
      );
    let simulation = await simulate();
    // A load-balanced RPC can simulate against a bank behind its blockhash
    // endpoint. Retry once with a simulation-only hash; the saved transaction,
    // fee lookup, signature and original expiry remain unchanged.
    if (simulation.value.err === 'BlockhashNotFound') simulation = await simulate(true);
    if (simulation.value.err)
      throw new LaunchError(
        400,
        'Pump launch simulation failed. Check wallet SOL balance and retry with a new launch request.',
      );
    const payerAfter = simulation.value.accounts?.[0]?.lamports;
    const fee = await read(() => connection.getFeeForMessage(message, 'finalized'));
    if (payerAfter === undefined || payerAfter === null || fee.value === null)
      throw new LaunchError(502, 'The launch cost could not be estimated.');
    const minimum = initialBuy + amount(fee.value) + BigInt(this.reserve);
    const delta = amount(payerBefore) - amount(payerAfter);
    const estimated = delta > minimum ? delta : minimum;
    if (estimated > initialBuy + BigInt(this.maximum) || estimated > amount(payerBefore))
      throw new LaunchError(
        400,
        'The estimated launch cost exceeds the configured limit or wallet balance.',
      );
    return {
      transaction: Buffer.from(serialized).toString('base64'),
      message: Buffer.from(message.serialize()).toString('base64'),
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      networkFeeLamports: String(fee.value),
      creatorReserveLamports: String(this.reserve),
      estimatedTotalLamports: String(estimated),
    };
  }
  async broadcast(serialized: string, signature: string, signal = AbortSignal.timeout(30_000)) {
    signal.throwIfAborted();
    const connection = this.connectionFor(signal);
    if (!this.config.transactionsEnabled)
      throw new LaunchError(503, 'Transaction broadcasting is disabled.');
    await this.network(connection, signal);
    const actual = await abortableLaunchRead(
      () =>
        connection.sendRawTransaction(Buffer.from(serialized, 'base64'), {
          skipPreflight: false,
          preflightCommitment: 'finalized',
          maxRetries: 0,
        }),
      signal,
    );
    if (actual !== signature)
      throw new LaunchError(
        502,
        'RPC returned a different transaction signature. Reconciliation is required.',
      );
  }
  async reconcile(
    record: LaunchRecord,
    signal = AbortSignal.timeout(10_000),
  ): Promise<LaunchChainResult> {
    signal.throwIfAborted();
    const connection = this.connectionFor(signal);
    return abortableLaunchRead(() => this.inspect(record, connection, signal), signal);
  }
  private async inspect(
    record: LaunchRecord,
    connection: Connection,
    signal: AbortSignal,
  ): Promise<LaunchChainResult> {
    const read = <T>(work: () => Promise<T>) => abortableLaunchRead(work, signal);
    if ((await read(() => connection.getGenesisHash())) !== this.config.expectedGenesisHash)
      throw new LaunchError(503, 'The RPC does not match the configured Solana network.');
    if (!record.prepared) throw new LaunchError(409, 'No prepared launch transaction is recorded.');
    if (!record.signature) {
      if (
        (await read(() => connection.getBlockHeight('finalized'))) <=
        record.prepared.lastValidBlockHeight
      )
        return { status: 'pending' };
      const mint = await read(() =>
        connection.getAccountInfo(new PublicKey(record.mint), 'finalized'),
      );
      return mint
        ? {
            status: 'review',
            error:
              'This mint exists on-chain. Supply the original signed launch for reconciliation; do not create a replacement.',
          }
        : {
            status: 'failed',
            error:
              'The signing window expired and this mint does not exist on the finalized chain. Start a new launch request.',
          };
    }
    const status = (
      await read(() =>
        connection.getSignatureStatuses([record.signature!], {
          searchTransactionHistory: true,
        }),
      )
    ).value[0];
    if (!status || status.confirmationStatus !== 'finalized') {
      if (
        (await read(() => connection.getBlockHeight('finalized'))) >
        record.prepared.lastValidBlockHeight
      )
        return {
          status: 'review',
          error:
            'The signing window expired without a finalized receipt. Do not submit a replacement until chain history is reconciled.',
        };
      return { status: 'pending' };
    }
    if (status.err)
      return {
        status: 'failed',
        error:
          'The launch transaction finalized with an error. Network fees may still have been charged.',
      };
    const tx = await read(() =>
      connection.getTransaction(record.signature!, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (
      !tx?.meta ||
      tx.meta.err ||
      !Buffer.from(tx.transaction.message.serialize()).equals(
        Buffer.from(record.prepared.message, 'base64'),
      ) ||
      tx.transaction.signatures[0] !== record.signature
    )
      return {
        status: 'review',
        error: 'The finalized transaction does not match the recorded launch.',
      };
    const mint = new PublicKey(record.mint);
    const curveInfo = await read(() =>
      connection.getAccountInfo(bondingCurvePda(mint), 'finalized'),
    );
    if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID))
      return {
        status: 'review',
        error: 'The finalized Pump bonding curve is unavailable or has an unexpected owner.',
      };
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (
      !curve.creator.equals(new PublicKey(record.creatorAddress)) ||
      curve.isCashbackCoin ||
      curve.isMayhemMode ||
      curve.isHolderReward ||
      (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(NATIVE_MINT))
    )
      return {
        status: 'review',
        error: 'The token fee recipient or SOL trading mode differs from the launch intent.',
      };
    const poolInfo = await read(() =>
      connection.getAccountInfo(canonicalPumpPoolPda(mint), 'finalized'),
    );
    if (poolInfo) {
      if (!poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID))
        return { status: 'review', error: 'The canonical PumpSwap pool has an unexpected owner.' };
      const pool = PUMP_AMM_SDK.decodePool(poolInfo);
      if (
        !pool.coinCreator.equals(new PublicKey(record.creatorAddress)) ||
        pool.isCashbackCoin ||
        !pool.quoteMint.equals(NATIVE_MINT)
      )
        return {
          status: 'review',
          error: 'The graduated token no longer routes SOL fees to the dedicated creator.',
        };
    } else if (curve.complete)
      return {
        status: 'review',
        error: 'The graduated token has no supported canonical PumpSwap pool.',
      };
    const minted = await read(() => getMint(connection, mint, 'finalized', TOKEN_2022_PROGRAM_ID));
    const metadata = await read(() =>
      getTokenMetadata(connection, mint, 'finalized', TOKEN_2022_PROGRAM_ID),
    );
    if (
      !minted.isInitialized ||
      minted.decimals !== 6 ||
      !metadata ||
      metadata.name !== record.name ||
      metadata.symbol !== record.symbol ||
      metadata.uri !== record.metadataUri
    )
      return {
        status: 'review',
        error: 'The finalized mint or metadata differs from the launch intent.',
      };
    const payerIndex = tx.transaction.message.staticAccountKeys.findIndex(
      (key) => key.toBase58() === record.walletAddress,
    );
    const creatorIndex = tx.transaction.message.staticAccountKeys.findIndex(
      (key) => key.toBase58() === record.creatorAddress,
    );
    if (
      payerIndex !== 0 ||
      creatorIndex < 0 ||
      BigInt(tx.meta.postBalances[creatorIndex] - tx.meta.preBalances[creatorIndex]) !==
        BigInt(record.prepared.creatorReserveLamports)
    )
      return {
        status: 'review',
        error: 'The creator gas reserve transfer does not match the approved launch.',
      };
    return { status: 'confirmed', slot: tx.slot };
  }
}

export function transactionSignature(transaction: VersionedTransaction) {
  return bs58.encode(transaction.signatures[0]);
}
