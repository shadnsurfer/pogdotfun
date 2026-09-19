import { createRequire } from 'node:module';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import type { Keypair, VersionedTransactionResponse } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getMint,
  getExtensionTypes,
  ExtensionType,
  getAssociatedTokenAddressSync,
  createBurnCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import type { SolUsdQuote } from '../providers/contracts.ts';
const require = createRequire(import.meta.url);
const {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  canonicalPumpPoolPda,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
} = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput } =
  require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');
const { BN } = require('@coral-xyz/anchor') as typeof import('@coral-xyz/anchor');

export interface TreasuryChainConfig {
  rpcUrl: string;
  genesisHash: string;
  mint: string;
  platformCreator: string;
  slippageBps: number;
  minimumWalletReserveLamports: string;
  signerForCreator: (creator: string) => Promise<Keypair>;
}
export interface TreasuryTransaction {
  id: string;
  kind: 'Buyback' | 'Burn' | 'Transfer';
  transferFrom?: string;
  transferLamports?: string;
  creator: string;
  mint: string;
  ata: string;
  tokenProgram: string;
  signature: string;
  signedTransactionBase64: string;
  lastValidBlockHeight: number;
  maxCostLamports: string;
  minimumTokenBaseUnits: string;
  tokenDecimals: number;
  createdAt: string;
  valuationQuote?: SolUsdQuote;
}
export interface TreasuryChainProof {
  transferredLamports?: string;
  signature: string;
  slot: number;
  failed: boolean;
  consumedLamports: string;
  networkFeeLamports: string;
  tokenBaseUnits: string;
  tokenDecimals: number;
}
export interface TreasuryProvider {
  verifyPlatform(): Promise<void>;
  prepareTransfer?(input: {
    id: string;
    creator: string;
    sourceCreator: string;
    transferLamports: string;
    maxCostLamports: string;
  }): Promise<TreasuryTransaction>;
  prepareBuy(input: {
    id: string;
    creator: string;
    buyLamports: string;
    maxCostLamports: string;
  }): Promise<TreasuryTransaction>;
  prepareBurn(input: {
    id: string;
    creator: string;
    tokenBaseUnits: string;
    maxCostLamports: string;
  }): Promise<TreasuryTransaction>;
  broadcast(transaction: TreasuryTransaction): Promise<string>;
  reconcile(
    transaction: TreasuryTransaction,
  ): Promise<{ state: 'pending' | 'expired_review' | 'finalized'; proof?: TreasuryChainProof }>;
}
function exact(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid RPC balance precision.');
  return BigInt(value);
}
function simulationPayerBalance(value: object, accountCount: number, after: number, incoming = 0n) {
  // Newer RPCs return transaction balances and fee even though this web3
  // version does not type them. Prefer this same-bank evidence when available.
  const data = value as { preBalances?: unknown; postBalances?: unknown; fee?: unknown };
  if (!Object.hasOwn(data, 'preBalances') && !Object.hasOwn(data, 'postBalances')) return undefined;
  const validBalance = (amount: unknown): amount is number =>
    typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0;
  if (
    !Array.isArray(data.preBalances) ||
    !Array.isArray(data.postBalances) ||
    data.preBalances.length !== accountCount ||
    data.postBalances.length !== accountCount ||
    !data.preBalances.every(validBalance) ||
    !data.postBalances.every(validBalance) ||
    !validBalance(data.fee) ||
    data.postBalances[0] !== after ||
    BigInt(data.preBalances[0]) + incoming - BigInt(data.postBalances[0]) < BigInt(data.fee)
  )
    throw new Error('Invalid or inconsistent treasury simulation cost metadata.');
  return data.preBalances[0] as number;
}
/** Proof requires the exact locally persisted message and signer; an explorer URL is never sufficient. */
export function verifyTreasuryTransaction(
  transaction: TreasuryTransaction,
  response: VersionedTransactionResponse,
): TreasuryChainProof {
  const local = VersionedTransaction.deserialize(
    Buffer.from(transaction.signedTransactionBase64, 'base64'),
  );
  if (
    response.transaction.signatures[0] !== transaction.signature ||
    bs58.encode(local.signatures[0]) !== transaction.signature ||
    !Buffer.from(response.transaction.message.serialize()).equals(
      Buffer.from(local.message.serialize()),
    )
  )
    throw new Error('Treasury transaction identity mismatch.');
  const keys = response.transaction.message.getAccountKeys({
    accountKeysFromLookups: response.meta?.loadedAddresses,
  });
  if (keys.get(0)?.toBase58() !== transaction.creator || !response.meta)
    throw new Error('Treasury fee payer mismatch.');
  const meta = response.meta;
  const consumed = exact(meta.preBalances[0]) - exact(meta.postBalances[0]);
  const fee = exact(meta.fee);
  if (transaction.kind === 'Transfer') {
    if (
      response.transaction.signatures.length !== local.signatures.length ||
      response.transaction.signatures.some(
        (signature, index) => signature !== bs58.encode(local.signatures[index]),
      )
    )
      throw new Error('Treasury transfer signature identity mismatch.');
    const amount = BigInt(transaction.transferLamports ?? '0');
    const sourceIndex = Array.from({ length: keys.length }, (_, i) => i).find(
      (i) => keys.get(i)?.toBase58() === transaction.transferFrom,
    );
    if (
      amount <= 0n ||
      sourceIndex === undefined ||
      sourceIndex === 0 ||
      !local.message.isAccountSigner(sourceIndex)
    )
      throw new Error('Invalid treasury transfer source or amount.');
    const failed = meta.err !== null;
    const transferred = failed ? 0n : amount;
    if (
      exact(meta.preBalances[sourceIndex]) - exact(meta.postBalances[sourceIndex]) !==
        transferred ||
      consumed + transferred !== fee
    )
      throw new Error('Finalized transfer debit, credit or fee mismatch.');
    return {
      signature: transaction.signature,
      slot: response.slot,
      failed,
      consumedLamports: String(fee),
      networkFeeLamports: String(fee),
      tokenBaseUnits: '0',
      tokenDecimals: transaction.tokenDecimals,
      transferredLamports: String(transferred),
    };
  }
  if (consumed < fee)
    throw new Error('Finalized treasury cost is inconsistent with its network fee.');
  const balance = (entries: typeof meta.preTokenBalances) => {
    const rows = (entries ?? []).filter(
      (b) => keys.get(b.accountIndex)?.toBase58() === transaction.ata,
    );
    if (rows.length > 1) throw new Error('Ambiguous token receipt.');
    if (!rows.length) return 0n;
    const b = rows[0];
    if (
      b.mint !== transaction.mint ||
      b.owner !== transaction.creator ||
      b.programId !== transaction.tokenProgram ||
      b.uiTokenAmount.decimals !== transaction.tokenDecimals
    )
      throw new Error('Treasury token receipt identity mismatch.');
    return BigInt(b.uiTokenAmount.amount);
  };
  const delta = balance(meta.postTokenBalances) - balance(meta.preTokenBalances);
  const failed = meta.err !== null;
  if (failed) {
    if (consumed !== fee || delta !== 0n)
      throw new Error('Failed treasury transaction has inconsistent balance changes.');
  } else if (transaction.kind === 'Buyback') {
    if (delta < BigInt(transaction.minimumTokenBaseUnits))
      throw new Error('Buyback did not receive its minimum tokens.');
  } else if (delta !== -BigInt(transaction.minimumTokenBaseUnits))
    throw new Error('Burn did not consume the exact purchased tokens.');
  return {
    signature: transaction.signature,
    slot: response.slot,
    failed,
    consumedLamports: String(consumed),
    networkFeeLamports: String(fee),
    tokenBaseUnits: failed ? '0' : String(transaction.kind === 'Buyback' ? delta : -delta),
    tokenDecimals: transaction.tokenDecimals,
  };
}

/** Uses the installed official Pump SDK builders; supports its native SOL curve and canonical PumpSwap route. */
export class PumpTreasuryProvider implements TreasuryProvider {
  readonly connection: Connection;
  private readonly pump: InstanceType<typeof OnlinePumpSdk>;
  private readonly amm: InstanceType<typeof OnlinePumpAmmSdk>;
  constructor(
    private readonly config: TreasuryChainConfig,
    connection?: Connection,
  ) {
    if (config.genesisHash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
      throw new Error('Treasury requires the explicitly pinned Solana mainnet genesis hash.');
    if (
      !Number.isSafeInteger(config.slippageBps) ||
      config.slippageBps < 1 ||
      config.slippageBps > 500
    )
      throw new Error('Buyback slippage must be explicitly bounded to 1–500 basis points.');
    this.connection = connection ?? new Connection(config.rpcUrl, 'confirmed');
    this.pump = new OnlinePumpSdk(this.connection);
    this.amm = new OnlinePumpAmmSdk(this.connection);
  }
  private async state() {
    if ((await this.connection.getGenesisHash()) !== this.config.genesisHash)
      throw new Error('Treasury network identity mismatch.');
    const mint = new PublicKey(this.config.mint);
    const info = await this.connection.getAccountInfo(mint, 'finalized');
    if (
      !info ||
      (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new Error('Official mint is not a supported SPL token.');
    const mintInfo = await getMint(this.connection, mint, 'finalized', info.owner);
    const allowed = [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata];
    if (
      mintInfo.freezeAuthority ||
      getExtensionTypes(mintInfo.tlvData).some((x) => !allowed.includes(x))
    )
      throw new Error('Official mint has unsupported transfer, freeze or authority extensions.');
    const curveAccount = await this.connection.getAccountInfo(bondingCurvePda(mint), 'finalized');
    if (!curveAccount?.owner.equals(PUMP_PROGRAM_ID))
      throw new Error('Official mint curve program identity mismatch.');
    // Decode the account whose finalized owner was verified above. SDK convenience
    // fetches use the connection's lower default commitment and would read it again.
    const curve = PUMP_SDK.decodeBondingCurve(curveAccount);
    if (
      curve.creator.toBase58() !== this.config.platformCreator ||
      curve.isMayhemMode ||
      curve.isCashbackCoin ||
      (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(NATIVE_MINT))
    )
      throw new Error('Official mint creator or native SOL trading configuration mismatch.');
    return { mint, tokenProgram: info.owner, mintInfo, curve };
  }
  async verifyPlatform() {
    const state = await this.state();
    if (state.curve.complete) {
      const address = canonicalPumpPoolPda(state.mint);
      const info = await this.connection.getAccountInfo(address, 'finalized');
      if (!info?.owner.equals(PUMP_AMM_PROGRAM_ID))
        throw new Error('Canonical PumpSwap route identity mismatch.');
      const pool = PUMP_AMM_SDK.decodePool(info);
      if (
        !pool.baseMint.equals(state.mint) ||
        !pool.quoteMint.equals(NATIVE_MINT) ||
        pool.coinCreator.toBase58() !== this.config.platformCreator ||
        pool.isMayhemMode ||
        pool.isCashbackCoin
      )
        throw new Error('Canonical PumpSwap route identity mismatch.');
    }
  }
  private async sign(
    input: {
      id: string;
      creator: string;
      kind: 'Buyback' | 'Burn' | 'Transfer';
      transferFrom?: string;
      transferLamports?: string;
      maxCostLamports: string;
      minimumTokenBaseUnits: string;
      tokenDecimals: number;
      tokenProgram: PublicKey;
    },
    instructions: TransactionInstruction[],
  ): Promise<TreasuryTransaction> {
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.id))
      throw new Error('Treasury transaction requires a bounded non-secret job identifier.');
    const signer = await this.config.signerForCreator(input.creator);
    if (signer.publicKey.toBase58() !== input.creator)
      throw new Error('Treasury signer identity mismatch.');
    const block = await this.connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: block.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
        ...instructions,
        new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from(input.id, 'utf8'),
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const signers = [signer];
    if (input.transferFrom) {
      const source = await this.config.signerForCreator(input.transferFrom);
      if (source.publicKey.toBase58() !== input.transferFrom)
        throw new Error('Treasury transfer source signer mismatch.');
      signers.push(source);
    }
    tx.sign(signers);
    const incoming = BigInt(input.transferLamports ?? '0');
    let verifiedCost = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let before = await this.connection.getBalanceAndContext(signer.publicKey, 'confirmed');
      const simulation = await this.connection.simulateTransaction(tx, {
        sigVerify: true,
        commitment: 'confirmed',
        minContextSlot: before.context.slot,
        accounts: { encoding: 'base64', addresses: [input.creator] },
      });
      if (simulation.value.err) throw new Error('Treasury transaction simulation failed.');
      const after = simulation.value.accounts?.[0]?.lamports;
      if (after === undefined)
        throw new Error('Simulated treasury spending exceeds the source reserve.');
      let payerBefore = simulationPayerBalance(
        simulation.value,
        message.staticAccountKeys.length,
        after,
        incoming,
      );
      if (payerBefore === undefined) {
        // Older RPCs need a real balance from the simulation's frozen confirmed
        // bank. Credits/debits at another slot cannot establish transaction cost.
        if (before.context.slot !== simulation.context.slot)
          before = await this.connection.getBalanceAndContext(signer.publicKey, {
            commitment: 'confirmed',
            minContextSlot: simulation.context.slot,
          });
        if (before.context.slot !== simulation.context.slot) continue;
        payerBefore = before.value;
      }
      if (
        exact(payerBefore) <
        BigInt(input.maxCostLamports) + BigInt(this.config.minimumWalletReserveLamports)
      )
        throw new Error('Insufficient wallet funding above the required operating reserve.');
      const consumed = exact(payerBefore) + incoming - exact(after);
      if (consumed < 0n || consumed > BigInt(input.maxCostLamports))
        throw new Error('Simulated treasury spending exceeds the source reserve.');
      verifiedCost = true;
      break;
    }
    if (!verifiedCost)
      throw new Error('Treasury spending could not be verified at the same confirmed slot.');
    return {
      id: input.id,
      kind: input.kind,
      ...(input.transferFrom
        ? { transferFrom: input.transferFrom, transferLamports: input.transferLamports }
        : {}),
      creator: input.creator,
      mint: this.config.mint,
      ata: getAssociatedTokenAddressSync(
        new PublicKey(this.config.mint),
        signer.publicKey,
        false,
        input.tokenProgram,
      ).toBase58(),
      tokenProgram: input.tokenProgram.toBase58(),
      signature: bs58.encode(tx.signatures[0]),
      signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      lastValidBlockHeight: block.lastValidBlockHeight,
      maxCostLamports: input.maxCostLamports,
      minimumTokenBaseUnits: input.minimumTokenBaseUnits,
      tokenDecimals: input.tokenDecimals,
      createdAt: new Date().toISOString(),
    };
  }
  async prepareTransfer(input: {
    id: string;
    creator: string;
    sourceCreator: string;
    transferLamports: string;
    maxCostLamports: string;
  }): Promise<TreasuryTransaction> {
    if ((await this.connection.getGenesisHash()) !== this.config.genesisHash)
      throw new Error('Treasury network identity mismatch.');
    if (input.creator === input.sourceCreator)
      throw new Error('Treasury transfer requires distinct source and destination wallets.');
    if (
      !/^\d+$/.test(input.transferLamports) ||
      BigInt(input.transferLamports) < 1n ||
      BigInt(input.transferLamports) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid treasury transfer amount.');
    // The dev wallet pays gas; the dedicated creator sends its exact allocated principal.
    return this.sign(
      {
        ...input,
        kind: 'Transfer',
        transferFrom: input.sourceCreator,
        minimumTokenBaseUnits: '0',
        tokenDecimals: 0,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      [
        SystemProgram.transfer({
          fromPubkey: new PublicKey(input.sourceCreator),
          toPubkey: new PublicKey(input.creator),
          lamports: BigInt(input.transferLamports),
        }),
      ],
    );
  }
  async prepareBuy(input: {
    id: string;
    creator: string;
    buyLamports: string;
    maxCostLamports: string;
  }) {
    const { mint, tokenProgram, mintInfo, curve } = await this.state();
    const user = new PublicKey(input.creator);
    let minimum: InstanceType<typeof BN>;
    let instructions: TransactionInstruction[];
    if (curve.complete) {
      const poolAddress = canonicalPumpPoolPda(mint);
      const state = await this.amm.swapSolanaState(poolAddress, user);
      if (
        !state.poolAccountInfo?.owner.equals(PUMP_AMM_PROGRAM_ID) ||
        !state.pool.baseMint.equals(mint) ||
        !state.pool.quoteMint.equals(NATIVE_MINT) ||
        state.pool.coinCreator.toBase58() !== this.config.platformCreator ||
        state.pool.isMayhemMode ||
        state.pool.isCashbackCoin
      )
        throw new Error('Canonical PumpSwap buy route mismatch.');
      if (state.userQuoteAccountInfo)
        throw new Error(
          'Reconcile existing wrapped SOL in the source wallet before a treasury buy.',
        );
      const quote = buyQuoteInput({
        quote: new BN(input.buyLamports),
        slippage: 0,
        baseReserve: state.poolBaseAmount,
        quoteReserve: state.poolQuoteAmount,
        virtualQuoteReserves: state.pool.virtualQuoteReserves,
        globalConfig: state.globalConfig,
        baseMintAccount: state.baseMintAccount,
        baseMint: mint,
        coinCreator: state.pool.coinCreator,
        creator: state.pool.creator,
        feeConfig: state.feeConfig,
        quoteMint: state.pool.quoteMint,
        isMayhemMode: state.pool.isMayhemMode,
        creatorFeeBps: state.pool.creatorFeeBps,
      });
      minimum = quote.base.muln(10000 - this.config.slippageBps).divn(10000);
      instructions = await PUMP_AMM_SDK.buyInstructions(state, minimum, new BN(input.buyLamports));
    } else {
      const [state, global, feeConfig] = await Promise.all([
        this.pump.fetchBuyState(mint, user, tokenProgram),
        this.pump.fetchGlobal(),
        this.pump.fetchFeeConfig(),
      ]);
      if (
        !state.bondingCurveAccountInfo.owner.equals(PUMP_PROGRAM_ID) ||
        state.bondingCurve.creator.toBase58() !== this.config.platformCreator ||
        state.bondingCurve.complete ||
        !state.quoteMint.equals(NATIVE_MINT)
      )
        throw new Error('Pump curve buy route changed; prepare a new request before spending.');
      const expected = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: new BN(String(mintInfo.supply)),
        bondingCurve: state.bondingCurve,
        amount: new BN(input.buyLamports),
        quoteMint: state.quoteMint,
      });
      minimum = expected.muln(10000 - this.config.slippageBps).divn(10000);
      instructions = await PUMP_SDK.buyV2Instructions({
        ...state,
        global,
        mint,
        user,
        amount: minimum,
        quoteAmount: new BN(input.buyLamports),
        slippage: 0,
        tokenProgram,
      });
    }
    if (minimum.lten(0)) throw new Error('Buyback output rounds to zero.');
    return this.sign(
      {
        ...input,
        kind: 'Buyback',
        minimumTokenBaseUnits: minimum.toString(),
        tokenDecimals: mintInfo.decimals,
        tokenProgram,
      },
      instructions,
    );
  }
  async prepareBurn(input: {
    id: string;
    creator: string;
    tokenBaseUnits: string;
    maxCostLamports: string;
  }) {
    const { mint, tokenProgram, mintInfo } = await this.state();
    const creator = new PublicKey(input.creator);
    const ata = getAssociatedTokenAddressSync(mint, creator, false, tokenProgram);
    if (BigInt(input.tokenBaseUnits) < 1n)
      throw new Error('Burn requires a positive confirmed token receipt.');
    return this.sign(
      {
        ...input,
        kind: 'Burn',
        minimumTokenBaseUnits: input.tokenBaseUnits,
        tokenDecimals: mintInfo.decimals,
        tokenProgram,
      },
      [
        createBurnCheckedInstruction(
          ata,
          mint,
          creator,
          BigInt(input.tokenBaseUnits),
          mintInfo.decimals,
          [],
          tokenProgram,
        ),
      ],
    );
  }
  async broadcast(transaction: TreasuryTransaction) {
    if ((await this.connection.getGenesisHash()) !== this.config.genesisHash)
      throw new Error('Treasury network identity mismatch.');
    return this.connection.sendRawTransaction(
      Buffer.from(transaction.signedTransactionBase64, 'base64'),
      { skipPreflight: false, maxRetries: 0 },
    );
  }
  async reconcile(
    transaction: TreasuryTransaction,
  ): Promise<{ state: 'pending' | 'expired_review' | 'finalized'; proof?: TreasuryChainProof }> {
    if ((await this.connection.getGenesisHash()) !== this.config.genesisHash)
      throw new Error('Treasury network identity mismatch.');
    const result = await this.connection.getTransaction(transaction.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (result)
      return { state: 'finalized', proof: verifyTreasuryTransaction(transaction, result) };
    return {
      state:
        (await this.connection.getBlockHeight('finalized')) > transaction.lastValidBlockHeight
          ? 'expired_review'
          : 'pending',
    };
  }
}
