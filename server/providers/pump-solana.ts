import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The SDK's ESM entry currently imports BN from Anchor incorrectly on Node.
// Its published CommonJS entry is supported and preserves the same typed API.
const {
  OnlinePumpSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  canonicalPumpPoolPda,
  creatorVaultPda,
} = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const { OnlinePumpAmmSdk, coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda } =
  require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Keypair, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import type {
  FinalizedTransferProof,
  FundingDestination,
  PreparedTransaction,
  SolUsdQuote,
  TokenFeeMapping,
  TransactionState,
} from './contracts.ts';
import { valueLamportsInUsdCents } from './contracts.ts';
import { boundedRpcFetch } from './bounded-rpc-fetch.ts';
import { inspectExpiredClaimBatch } from './claim-expiry-evidence.ts';

export interface PumpSolanaConfig {
  rpcUrl: string;
  expectedGenesisHash: string;
  mappings: readonly TokenFeeMapping[];
  signerForCreator: (creator: string) => Promise<Keypair>;
  transactionsEnabled: boolean;
  coinbaseAccountId: string;
  allowedCoinbaseAddresses: readonly string[];
  maxTopUpLamports: bigint;
  minimumWalletReserveLamports: bigint;
  priorityMicroLamports?: number;
  rpcTimeoutMs?: number;
  fetch?: typeof fetch;
}

export function validateMappings(mappings: readonly TokenFeeMapping[]) {
  const creators = new Set<string>();
  const mints = new Set<string>();
  const ids = new Set<string>();
  for (const mapping of mappings) {
    new PublicKey(mapping.mint);
    const creator = new PublicKey(mapping.creator);
    if (!PublicKey.isOnCurve(creator.toBytes()) || !mapping.dedicatedCreatorVerified) {
      throw new Error('Each mint requires an attested, dedicated creator wallet.');
    }
    if (
      !mapping.tokenId ||
      ids.has(mapping.tokenId) ||
      mints.has(mapping.mint) ||
      creators.has(mapping.creator)
    ) {
      throw new Error('Token IDs, mints and creator wallets must be unique.');
    }
    ids.add(mapping.tokenId);
    mints.add(mapping.mint);
    creators.add(mapping.creator);
  }
}

function safeLamports(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid RPC lamport precision.');
  return BigInt(value);
}

export class PumpSolanaProvider {
  readonly connection: Connection;
  private readonly pump: InstanceType<typeof OnlinePumpSdk>;
  private readonly amm: InstanceType<typeof OnlinePumpAmmSdk>;

  constructor(
    private readonly config: PumpSolanaConfig,
    connection?: Connection,
  ) {
    validateMappings(config.mappings);
    const rpcUrl = new URL(config.rpcUrl);
    if (rpcUrl.protocol !== 'https:' && rpcUrl.hostname !== '127.0.0.1') {
      throw new Error('The RPC must use HTTPS.');
    }
    if (!config.expectedGenesisHash)
      throw new Error('The expected Solana genesis hash is required.');
    if (
      config.maxTopUpLamports <= 0n ||
      config.minimumWalletReserveLamports < 10_000n ||
      !Number.isSafeInteger(config.priorityMicroLamports ?? 1000) ||
      (config.priorityMicroLamports ?? 1000) < 0 ||
      (config.priorityMicroLamports ?? 1000) > 1_000_000
    ) {
      throw new Error('Invalid transaction limits or network fee policy.');
    }
    this.connection =
      connection ??
      new Connection(config.rpcUrl, {
        commitment: 'finalized',
        disableRetryOnRateLimit: true,
        fetch: boundedRpcFetch({ timeoutMs: config.rpcTimeoutMs, fetch: config.fetch }),
      });
    this.pump = new OnlinePumpSdk(this.connection);
    this.amm = new OnlinePumpAmmSdk(this.connection);
  }

  private mapping(tokenId: string) {
    const mapping = this.config.mappings.find((item) => item.tokenId === tokenId);
    if (!mapping) throw new Error('Token has no verified fee routing configuration.');
    return mapping;
  }

  private async verifyNetwork() {
    if ((await this.connection.getGenesisHash()) !== this.config.expectedGenesisHash) {
      throw new Error('The RPC is connected to an unexpected Solana network.');
    }
  }

  async inspectFees(tokenId: string, quote: SolUsdQuote) {
    await this.verifyNetwork();
    const mapping = this.mapping(tokenId);
    const mint = new PublicKey(mapping.mint);
    const creator = new PublicKey(mapping.creator);
    const curve = await this.pump.fetchBondingCurve(mint);
    const poolAddress = canonicalPumpPoolPda(mint);
    const poolInfo = await this.connection.getAccountInfo(poolAddress, 'finalized');
    if (
      !curve.creator.equals(creator) ||
      curve.isCashbackCoin ||
      (!curve.quoteMint.equals(NATIVE_MINT) && !curve.quoteMint.equals(PublicKey.default))
    ) {
      throw new Error('This token is not configured for direct SOL creator fees.');
    }
    if (poolInfo) {
      if (!poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID))
        throw new Error('Invalid PumpSwap pool owner.');
      const pool = await this.amm.fetchPool(poolAddress);
      if (
        !pool.coinCreator.equals(creator) ||
        pool.isCashbackCoin ||
        !pool.quoteMint.equals(NATIVE_MINT)
      ) {
        throw new Error('PumpSwap fee recipient or quote does not match this token.');
      }
    } else if (curve.complete) {
      throw new Error('Graduated token has no supported canonical PumpSwap pool.');
    }
    const vault = await this.connection.getAccountInfo(creatorVaultPda(creator), 'finalized');
    if (
      vault &&
      !vault.owner.equals(PUMP_PROGRAM_ID) &&
      !vault.owner.equals(SystemProgram.programId)
    )
      throw new Error('Invalid creator vault owner.');
    const rent = vault
      ? await this.connection.getMinimumBalanceForRentExemption(vault.data.length)
      : 0;
    const bondingLamports = vault ? safeLamports(Math.max(0, vault.lamports - rent)) : 0n;
    const ammLamports = BigInt((await this.amm.getCoinCreatorVaultBalance(creator)).toString());
    const amountLamports = bondingLamports + ammLamports;
    const grossUsdCents = valueLamportsInUsdCents(amountLamports, quote);
    return {
      ...mapping,
      graduated: Boolean(poolInfo),
      bondingLamports: String(bondingLamports),
      ammLamports: String(ammLamports),
      amountLamports: String(amountLamports),
      grossUsdCents,
      eligible: grossUsdCents >= 5000,
      quote,
    };
  }

  private async prepare(
    id: string,
    mapping: TokenFeeMapping,
    kind: PreparedTransaction['kind'],
    instructions: TransactionInstruction[],
    extra: Pick<PreparedTransaction, 'amountLamports' | 'destination'> = {},
  ): Promise<PreparedTransaction> {
    if (!this.config.transactionsEnabled) throw new Error('Treasury transactions are disabled.');
    await this.verifyNetwork();
    const signer = await this.config.signerForCreator(mapping.creator);
    if (signer.publicKey.toBase58() !== mapping.creator)
      throw new Error('Signer does not match the verified creator.');
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('finalized');
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: kind === 'claim' ? 250_000 : 10_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.config.priorityMicroLamports ?? 1000,
        }),
        ...instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    const simulation = await this.connection.simulateTransaction(transaction, {
      sigVerify: true,
      commitment: 'finalized',
    });
    if (simulation.value.err)
      throw new Error('Transaction simulation failed; no transaction was broadcast.');
    const networkFee = await this.connection.getFeeForMessage(message, 'finalized');
    if (networkFee.value === null) throw new Error('Network fee estimate is unavailable.');
    return {
      id,
      kind,
      tokenId: mapping.tokenId,
      mint: mapping.mint,
      creator: mapping.creator,
      signature: bs58.encode(transaction.signatures[0]),
      signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
      blockhash,
      lastValidBlockHeight,
      createdAt: new Date().toISOString(),
      networkFeeLamports: String(safeLamports(networkFee.value)),
      ...extra,
    };
  }

  async prepareClaim(id: string, tokenId: string, quote: SolUsdQuote) {
    const balance = await this.inspectFees(tokenId, quote);
    if (!balance.eligible) throw new Error('Creator fees are below the $50 gross claim threshold.');
    const mapping = this.mapping(tokenId);
    const creator = new PublicKey(mapping.creator);
    // V2 includes bonding-curve and PumpSwap SOL fees; the SDK unwraps WSOL
    // because the dedicated creator is also the fee payer.
    const instructions = await this.pump.collectCoinCreatorFeeV2Instructions(
      creator,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      creator,
    );
    return this.prepare(id, mapping, 'claim', instructions);
  }

  async prepareTopUp(
    id: string,
    tokenId: string,
    destination: FundingDestination,
    lamports: bigint,
  ) {
    const mapping = this.mapping(tokenId);
    const recipient = new PublicKey(destination.address);
    const now = Date.now();
    const verified = Date.parse(destination.verifiedAt);
    const expires = Date.parse(destination.expiresAt);
    if (
      destination.network !== 'solana' ||
      destination.asset !== 'SOL' ||
      destination.accountId !== this.config.coinbaseAccountId ||
      !destination.reference ||
      !Number.isFinite(verified) ||
      verified > now + 5_000 ||
      now - verified > 60_000 ||
      !Number.isFinite(expires) ||
      expires <= now + 60_000 ||
      !this.config.allowedCoinbaseAddresses.includes(recipient.toBase58())
    ) {
      throw new Error(
        'A fresh Coinbase deposit binding and allowlisted SOL deposit address are required.',
      );
    }
    if (
      lamports <= 0n ||
      lamports > this.config.maxTopUpLamports ||
      recipient.toBase58() === mapping.creator
    ) {
      throw new Error('Top-up exceeds the configured amount or destination policy.');
    }
    const balance = safeLamports(
      await this.connection.getBalance(new PublicKey(mapping.creator), 'finalized'),
    );
    if (balance - lamports < this.config.minimumWalletReserveLamports)
      throw new Error('Insufficient SOL gas reserve.');
    return this.prepare(
      id,
      mapping,
      'topup',
      [
        SystemProgram.transfer({
          fromPubkey: new PublicKey(mapping.creator),
          toPubkey: recipient,
          lamports,
        }),
      ],
      { amountLamports: String(lamports), destination: recipient.toBase58() },
    );
  }

  async broadcast(transaction: PreparedTransaction, beforeSend?: () => void) {
    if (!this.config.transactionsEnabled) throw new Error('Treasury transactions are disabled.');
    await this.verifyNetwork();
    const signed = VersionedTransaction.deserialize(
      Buffer.from(transaction.signedTransactionBase64, 'base64'),
    );
    if (bs58.encode(signed.signatures[0]) !== transaction.signature)
      throw new Error('Stored signature mismatch.');
    // Network verification may outlive the caller's live-status observation.
    // Recheck authority after every await, in the same turn that begins the send.
    if (beforeSend !== undefined) {
      if (typeof beforeSend !== 'function')
        throw new Error('The final broadcast guard must be a synchronous function.');
      const permission: unknown = beforeSend();
      if (permission !== undefined) {
        // An accidental rejected async guard must not become an unhandled rejection.
        void Promise.resolve(permission).catch(() => {});
        throw new Error('The final broadcast guard must complete synchronously.');
      }
    }
    return this.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'finalized',
      maxRetries: 2,
    });
  }

  async reconcile(transaction: PreparedTransaction): Promise<TransactionState> {
    await this.verifyNetwork();
    const { value } = await this.connection.getSignatureStatuses([transaction.signature], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (status?.err && status.confirmationStatus === 'finalized') return 'failed';
    if (status?.confirmationStatus === 'finalized') return 'confirmed';
    if (status) return 'broadcast';
    const height = await this.connection.getBlockHeight('finalized');
    // Even after expiry, an archive/RPC inconsistency needs review. Do not
    // silently create a replacement transfer with a new transaction identity.
    return height > transaction.lastValidBlockHeight ? 'expired_review' : 'unknown';
  }

  /** Read-only evidence for an explicit operator-approved retry. */
  async reviewExpiredClaims(transactions: readonly PreparedTransaction[]) {
    const mainnet = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    if (
      this.config.expectedGenesisHash !== mainnet ||
      new URL(this.config.rpcUrl).hostname === 'api.mainnet-beta.solana.com'
    )
      throw new Error('Expiry review requires independent mainnet RPC sources.');
    for (const transaction of transactions) {
      const mapping = this.mapping(transaction.tokenId);
      if (mapping.creator !== transaction.creator || mapping.mint !== transaction.mint)
        throw new Error('Expired claim routing no longer matches its registered token.');
    }
    const independent = new Connection('https://api.mainnet-beta.solana.com', {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: boundedRpcFetch({ timeoutMs: 8_000, fetch: this.config.fetch }),
    });
    return inspectExpiredClaimBatch(transactions, mainnet, [
      { name: 'configured', connection: this.connection },
      { name: 'solana_public_mainnet', connection: independent },
    ]);
  }

  async finalizedProof(transaction: PreparedTransaction): Promise<FinalizedTransferProof> {
    if ((await this.reconcile(transaction)) !== 'confirmed')
      throw new Error('Transaction is not finalized.');
    const receipt = await this.connection.getTransaction(transaction.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!receipt?.meta || receipt.meta.err)
      throw new Error('Finalized transaction metadata is unavailable.');
    // Revenue and funding evidence must describe the exact durable transaction,
    // not an unrelated receipt returned for its signature by an inconsistent RPC.
    try {
      const stored = VersionedTransaction.deserialize(
        Buffer.from(transaction.signedTransactionBase64, 'base64'),
      );
      if (
        bs58.encode(stored.signatures[0]) !== transaction.signature ||
        receipt.transaction.signatures[0] !== transaction.signature ||
        !Buffer.from(stored.message.serialize()).equals(
          Buffer.from(receipt.transaction.message.serialize()),
        )
      )
        throw new Error();
    } catch {
      throw new Error(
        'Finalized transaction identity does not match the stored signed transaction.',
      );
    }
    const keys = receipt.transaction.message.getAccountKeys({
      accountKeysFromLookups: receipt.meta.loadedAddresses,
    });
    if (
      keys.get(0)?.toBase58() !== transaction.creator ||
      !receipt.transaction.message.isAccountSigner(0)
    )
      throw new Error('Finalized transaction fee payer does not match the dedicated creator.');
    const find = (address: string) => {
      for (let index = 0; index < keys.length; index++)
        if (keys.get(index)?.toBase58() === address) return index;
      return -1;
    };
    let amount: bigint;
    if (transaction.kind === 'topup') {
      const index = find(transaction.destination!);
      if (index < 0) throw new Error('Deposit address missing from finalized transaction.');
      amount =
        safeLamports(receipt.meta.postBalances[index]) -
        safeLamports(receipt.meta.preBalances[index]);
      if (amount !== BigInt(transaction.amountLamports!))
        throw new Error('Finalized top-up amount mismatch.');
    } else {
      const creator = new PublicKey(transaction.creator);
      const vaultIndex = find(creatorVaultPda(creator).toBase58());
      const bonding =
        vaultIndex < 0
          ? 0n
          : safeLamports(receipt.meta.preBalances[vaultIndex]) -
            safeLamports(receipt.meta.postBalances[vaultIndex]);
      const ata = coinCreatorVaultAtaPda(
        coinCreatorVaultAuthorityPda(creator),
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      );
      const ataIndex = find(ata.toBase58());
      const before = receipt.meta.preTokenBalances?.find(
        (item) => item.accountIndex === ataIndex && item.mint === NATIVE_MINT.toBase58(),
      );
      const after = receipt.meta.postTokenBalances?.find(
        (item) => item.accountIndex === ataIndex && item.mint === NATIVE_MINT.toBase58(),
      );
      const amm =
        BigInt(before?.uiTokenAmount.amount ?? '0') - BigInt(after?.uiTokenAmount.amount ?? '0');
      if (bonding < 0n || amm < 0n) throw new Error('Invalid fee vault movement.');
      amount = bonding + amm;
      const creatorNet =
        safeLamports(receipt.meta.postBalances[0]) - safeLamports(receipt.meta.preBalances[0]);
      if (creatorNet + safeLamports(receipt.meta.fee) < amount)
        throw new Error('Claimed fees were not received as SOL by the dedicated creator.');
    }
    if (amount <= 0n) throw new Error('Finalized transaction did not transfer a positive amount.');
    return {
      signature: transaction.signature,
      slot: receipt.slot,
      confirmation: 'finalized',
      amountLamports: String(amount),
      networkFeeLamports: String(safeLamports(receipt.meta.fee)),
    };
  }

  async finalizedFailureProof(transaction: PreparedTransaction) {
    if ((await this.reconcile(transaction)) !== 'failed')
      throw new Error('Only a definitively finalized failed transaction can be reconciled.');
    const receipt = await this.connection.getTransaction(transaction.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!receipt?.meta?.err || !receipt.blockTime)
      throw new Error('Finalized failure metadata is unavailable.');
    // Gas recovery may debit the testing budget, so prove the exact durable
    // transaction rather than accepting any failure paid by the same creator.
    try {
      const stored = VersionedTransaction.deserialize(
        Buffer.from(transaction.signedTransactionBase64, 'base64'),
      );
      if (
        bs58.encode(stored.signatures[0]) !== transaction.signature ||
        receipt.transaction.signatures[0] !== transaction.signature ||
        !Buffer.from(stored.message.serialize()).equals(
          Buffer.from(receipt.transaction.message.serialize()),
        )
      )
        throw new Error();
    } catch {
      throw new Error('Finalized failure identity does not match the stored signed transaction.');
    }
    const keys = receipt.transaction.message.getAccountKeys({
      accountKeysFromLookups: receipt.meta.loadedAddresses,
    });
    if (
      keys.get(0)?.toBase58() !== transaction.creator ||
      !receipt.transaction.message.isAccountSigner(0)
    )
      throw new Error('Failed transaction fee payer does not match the dedicated creator.');
    const fee = safeLamports(receipt.meta.fee);
    if (
      safeLamports(receipt.meta.preBalances[0]) - safeLamports(receipt.meta.postBalances[0]) !==
        fee ||
      receipt.meta.preBalances.some(
        (balance, index) => index > 0 && balance !== receipt.meta!.postBalances[index],
      )
    )
      throw new Error('Failed transaction contains unexpected balance movements.');
    return {
      signature: transaction.signature,
      networkFeeLamports: String(fee),
      slot: receipt.slot,
      confirmation: 'finalized_failure' as const,
      blockTime: receipt.blockTime,
    };
  }

  /** Verify a claim performed in Pump's UI before importing it into the ledger. */
  async verifyExternalClaim(input: { tokenId: string; signature: string }) {
    await this.verifyNetwork();
    if (bs58.decode(input.signature).length !== 64) throw new Error('Invalid claim signature.');
    const mapping = this.mapping(input.tokenId);
    const creator = new PublicKey(mapping.creator);
    const receipt = await this.connection.getTransaction(input.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!receipt?.meta || receipt.meta.err || !receipt.blockTime)
      throw new Error('Claim is not finalized with complete metadata.');
    const message = receipt.transaction.message;
    const keys = message.getAccountKeys({ accountKeysFromLookups: receipt.meta.loadedAddresses });
    if (!keys.get(0)?.equals(creator) || !message.isAccountSigner(0))
      throw new Error('The dedicated creator must authorize and pay for this claim.');
    const pumpVault = creatorVaultPda(creator);
    const ammVault = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthorityPda(creator),
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    );
    const creatorAta = getAssociatedTokenAddressSync(NATIVE_MINT, creator);
    const collectDiscriminators = [
      [20, 22, 86, 123, 198, 28, 219, 132],
      [207, 17, 138, 242, 4, 34, 19, 56],
    ];
    const ammDiscriminator = [160, 57, 89, 42, 181, 139, 43, 66];
    let hasCollection = false;
    for (const instruction of message.compiledInstructions) {
      const program = keys.get(instruction.programIdIndex)!;
      const accounts = instruction.accountKeyIndexes.map((index) => keys.get(index)!);
      const data = [...instruction.data];
      const equals = (bytes: number[]) =>
        bytes.length === data.length && bytes.every((byte, index) => data[index] === byte);
      if (
        program.equals(PUMP_PROGRAM_ID) &&
        collectDiscriminators.some(equals) &&
        accounts.some((key) => key.equals(creator)) &&
        accounts.some((key) => key.equals(pumpVault))
      ) {
        hasCollection = true;
        continue;
      }
      if (
        program.equals(PUMP_AMM_PROGRAM_ID) &&
        equals(ammDiscriminator) &&
        accounts.some((key) => key.equals(creator)) &&
        accounts.some((key) => key.equals(ammVault))
      ) {
        hasCollection = true;
        continue;
      }
      if (program.equals(ComputeBudgetProgram.programId)) continue;
      if (
        program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
        accounts.some((key) => key.equals(creatorAta)) &&
        accounts.some((key) => key.equals(creator)) &&
        accounts.some((key) => key.equals(NATIVE_MINT))
      )
        continue;
      if (
        program.equals(TOKEN_PROGRAM_ID) &&
        equals([9]) &&
        accounts[0]?.equals(creatorAta) &&
        accounts[1]?.equals(creator) &&
        accounts[2]?.equals(creator)
      )
        continue;
      throw new Error(
        'Claim contains unsupported or unrelated instructions. Import a dedicated SOL fee collection transaction.',
      );
    }
    if (!hasCollection) throw new Error('Transaction is not a Pump creator-fee collection.');
    const prepared: PreparedTransaction = {
      id: `external:${input.signature}`,
      kind: 'claim',
      tokenId: mapping.tokenId,
      mint: mapping.mint,
      creator: mapping.creator,
      signature: input.signature,
      // Retain the receipt whose instructions were verified so a second RPC read
      // cannot substitute a different transaction during finalized proof checks.
      signedTransactionBase64: Buffer.from(
        new VersionedTransaction(
          message,
          receipt.transaction.signatures.map((signature) => bs58.decode(signature)),
        ).serialize(),
      ).toString('base64'),
      blockhash: message.recentBlockhash,
      lastValidBlockHeight: 0,
      createdAt: new Date(receipt.blockTime * 1000).toISOString(),
    };
    const proof = await this.finalizedProof(prepared);
    const creatorNet =
      safeLamports(receipt.meta.postBalances[0]) - safeLamports(receipt.meta.preBalances[0]);
    if (creatorNet + BigInt(proof.networkFeeLamports) < BigInt(proof.amountLamports))
      throw new Error('Claimed fees were not received as SOL by the dedicated creator.');
    return { ...proof, blockTime: receipt.blockTime };
  }

  /** Independently validate a human-submitted funding signature, never trust form amounts. */
  async verifyExternalTopUp(input: {
    tokenId: string;
    signature: string;
    destination: string;
    amountLamports: string;
  }) {
    await this.verifyNetwork();
    const mapping = this.mapping(input.tokenId);
    if (!this.config.allowedCoinbaseAddresses.includes(input.destination))
      throw new Error('Deposit address is not allowlisted.');
    const receipt = await this.connection.getParsedTransaction(input.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!receipt?.meta || receipt.meta.err || !receipt.blockTime)
      throw new Error('Funding transaction is not finalized with complete metadata.');
    const instructions = receipt.transaction.message.instructions;
    const transfers = instructions.filter(
      (instruction) =>
        'parsed' in instruction &&
        instruction.programId.equals(SystemProgram.programId) &&
        instruction.parsed?.type === 'transfer',
    );
    if (
      transfers.length !== 1 ||
      instructions.some(
        (instruction) =>
          !instruction.programId.equals(ComputeBudgetProgram.programId) &&
          (!instruction.programId.equals(SystemProgram.programId) ||
            !('parsed' in instruction) ||
            instruction.parsed?.type !== 'transfer'),
      )
    )
      throw new Error(
        'Funding must be a single SOL transfer with optional compute-budget instructions.',
      );
    const transfer = transfers[0];
    if (!('parsed' in transfer)) throw new Error('Missing parsed transfer.');
    const info = transfer.parsed.info;
    if (
      info.source !== mapping.creator ||
      info.destination !== input.destination ||
      safeLamports(info.lamports) !== BigInt(input.amountLamports)
    )
      throw new Error('Funding source, destination or amount does not match the invoice.');
    const source = receipt.transaction.message.accountKeys.find(
      (key) => key.pubkey.toBase58() === mapping.creator,
    );
    if (!source?.signer) throw new Error('Creator did not authorize the funding transfer.');
    if (receipt.transaction.message.accountKeys[0].pubkey.toBase58() !== mapping.creator)
      throw new Error('Funding fee payer must be the registered creator.');
    return {
      signature: input.signature,
      amountLamports: input.amountLamports,
      networkFeeLamports: String(safeLamports(receipt.meta.fee)),
      slot: receipt.slot,
      confirmation: 'finalized' as const,
      blockTime: receipt.blockTime,
    };
  }
}
