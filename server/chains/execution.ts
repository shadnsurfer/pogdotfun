import { keccak256, parseTransaction, recoverTransactionAddress, toHex, isAddress } from 'viem';
import type { Address, Hex, TransactionSerializableLegacy, TransactionSerialized } from 'viem';

export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
export interface ChainRpc {
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
}
/** Implement using the encrypted service vault. Never return or persist a private key. */
export interface EncryptedSignerProvider {
  readonly address: Address;
  signTransaction(transaction: TransactionSerializableLegacy): Promise<Hex>;
}
export interface TransactionIntent {
  id: string;
  chainId: 56 | 4663;
  kind: 'launch' | 'claim';
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  feeRecipient: Address;
  token?: Address;
}
export interface JournalRecord {
  fingerprint: Hex;
  status: 'reserved' | 'signed';
  rawTransaction?: Hex;
  hash?: Hex;
  nonce?: number;
  tokenBinding?: { token: Address; feeRecipient: Address; launchHash: Hex; nativeQuote: true };
}
/** exclusive must serialize across processes; put must durably commit before resolving. */
export interface ExecutionJournal {
  exclusive<T>(scope: string, run: () => Promise<T>): Promise<T>;
  get(id: string): Promise<JournalRecord | undefined>;
  put(id: string, record: JournalRecord): Promise<void>;
}
export interface AdapterConfig {
  rpc: ChainRpc;
  signer: EncryptedSignerProvider;
  journal: ExecutionJournal;
  feeRecipient: Address;
  confirmations: number;
  maxValueWei: bigint;
  maxGas: bigint;
  maxGasPriceWei: bigint;
  deploymentCodeHashes: Record<string, Hex>;
  /** Pin upgradeable implementation slots as well as proxy runtime bytecode. */
  storagePins?: { address: Address; slot: Hex; value: Hex }[];
}
export interface ChainLog {
  address: Address;
  topics: [Hex, ...Hex[]];
  data: Hex;
  logIndex: Hex;
}
export interface ChainReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: Hex;
  from: Address;
  to: Address;
  logs: ChainLog[];
}
export interface Reconciliation {
  status: 'pending' | 'confirmed' | 'reverted';
  hash: Hex;
  token?: Address;
  feeAmountWei?: bigint;
  feeTokenAmount?: bigint;
  requiresPayoutEvidence?: boolean;
  evidenceId?: string;
}
export function equalAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
export function assertAddress(a: string) {
  if (!isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a))
    throw new Error('Invalid nonzero address');
}
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? { bigint: v.toString() } : v,
  );
}
export function fingerprint(intent: TransactionIntent): Hex {
  return keccak256(toHex(serialize(intent)));
}

export class EvmExecution {
  constructor(
    readonly chainId: 56 | 4663,
    readonly config: AdapterConfig,
    readonly validate: (intent: TransactionIntent) => void,
  ) {
    assertAddress(config.feeRecipient);
    assertAddress(config.signer.address);
    if (!equalAddress(config.feeRecipient, config.signer.address))
      throw new Error('Fee recipient must be controlled by configured signer');
    if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 2)
      throw new Error('At least two confirmations required');
    if (config.maxGas <= 0n || config.maxGasPriceWei <= 0n || config.maxValueWei < 0n)
      throw new Error('Invalid execution limits');
  }
  async verifyNetwork(addresses: Address[]) {
    if (Number(await this.config.rpc.request('eth_chainId')) !== this.chainId)
      throw new Error('RPC chain mismatch');
    for (const address of addresses) {
      const expected = this.config.deploymentCodeHashes[address.toLowerCase()];
      if (!expected) throw new Error('Reviewed deployment code hash is required');
      const code = (await this.config.rpc.request('eth_getCode', [address, 'latest'])) as Hex;
      if (!code || code === '0x' || keccak256(code) !== expected)
        throw new Error('Deployment bytecode hash mismatch');
    }
    for (const pin of (this.config.storagePins ?? []).filter((p) =>
      addresses.some((a) => equalAddress(a, p.address)),
    )) {
      const value = await this.config.rpc.request('eth_getStorageAt', [
        pin.address,
        pin.slot,
        'latest',
      ]);
      if (typeof value !== 'string' || value.toLowerCase() !== pin.value.toLowerCase())
        throw new Error('Deployment implementation storage mismatch');
      if (pin.slot === EIP1967_IMPLEMENTATION_SLOT) {
        const implementation = `0x${pin.value.slice(-40)}` as Address;
        assertAddress(implementation);
        const expected = this.config.deploymentCodeHashes[implementation.toLowerCase()];
        const code = (await this.config.rpc.request('eth_getCode', [
          implementation,
          'latest',
        ])) as Hex;
        if (!expected || !code || code === '0x' || keccak256(code) !== expected)
          throw new Error('Implementation bytecode hash mismatch');
      }
    }
  }
  assertIntent(intent: TransactionIntent) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(intent.id)) throw new Error('Invalid intent id');
    if (intent.chainId !== this.chainId) throw new Error('Intent chain mismatch');
    if (
      !equalAddress(intent.account, this.config.signer.address) ||
      !equalAddress(intent.feeRecipient, this.config.feeRecipient)
    )
      throw new Error('Intent account or fee recipient mismatch');
    if (intent.value < 0n || intent.value > this.config.maxValueWei)
      throw new Error('Intent value exceeds policy');
    this.validate(intent);
  }
  async simulate(intent: TransactionIntent) {
    this.assertIntent(intent);
    await this.verifyNetwork([intent.to]);
    const call = {
      from: intent.account,
      to: intent.to,
      data: intent.data,
      value: toHex(intent.value),
    };
    await this.config.rpc.request('eth_call', [call, 'pending']);
    const gas = BigInt((await this.config.rpc.request('eth_estimateGas', [call])) as string);
    if (gas <= 0n || gas > this.config.maxGas) throw new Error('Gas amount exceeds policy');
    return { gas };
  }
  async execute(intent: TransactionIntent): Promise<{ hash: Hex }> {
    this.assertIntent(intent);
    // The account lock covers nonce selection and durable signed bytes across all intents.
    return this.config.journal.exclusive(
      `${this.chainId}:${intent.account.toLowerCase()}`,
      async () => {
        const key = `${this.chainId}:${intent.id}`;
        const expected = fingerprint(intent);
        const prior = await this.config.journal.get(key);
        if (prior && prior.fingerprint !== expected)
          throw new Error('Intent id replay has different content');
        await this.verifyNetwork([intent.to]);
        if (prior) {
          if (!prior.rawTransaction || !prior.hash)
            throw new Error('Interrupted reserved intent requires manual reconciliation');
          await this.assertSigned(intent, prior.rawTransaction, prior.nonce);
          if (keccak256(prior.rawTransaction) !== prior.hash)
            throw new Error('Journal transaction hash mismatch');
          // Reconciliation, rather than resubmission, is the default replay operation.
          return { hash: prior.hash };
        }
        const { gas } = await this.simulate(intent);
        const gasPrice = BigInt((await this.config.rpc.request('eth_gasPrice')) as string);
        if (gasPrice <= 0n || gasPrice > this.config.maxGasPriceWei)
          throw new Error('Gas price exceeds policy');
        const nonce = Number(
          await this.config.rpc.request('eth_getTransactionCount', [intent.account, 'pending']),
        );
        if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid transaction nonce');
        const accountKey = `account:${this.chainId}:${intent.account.toLowerCase()}`;
        const accountState = await this.config.journal.get(accountKey);
        if (
          accountState &&
          (accountState.status === 'reserved' ||
            accountState.nonce === undefined ||
            nonce <= accountState.nonce)
        )
          throw new Error('Prior pending nonce requires reconciliation before another intent');
        await this.config.journal.put(accountKey, {
          fingerprint: expected,
          status: 'reserved',
          nonce,
        });
        await this.config.journal.put(key, { fingerprint: expected, status: 'reserved', nonce });
        const rawTransaction = await this.config.signer.signTransaction({
          type: 'legacy',
          chainId: this.chainId,
          nonce,
          gas,
          gasPrice,
          to: intent.to,
          data: intent.data,
          value: intent.value,
        });
        await this.assertSigned(intent, rawTransaction, nonce);
        const hash = keccak256(rawTransaction);
        await this.config.journal.put(key, {
          fingerprint: expected,
          status: 'signed',
          rawTransaction,
          hash,
          nonce,
        });
        await this.config.journal.put(accountKey, {
          fingerprint: expected,
          status: 'signed',
          rawTransaction,
          hash,
          nonce,
        });
        const returned = await this.config.rpc.request('eth_sendRawTransaction', [rawTransaction]);
        if (returned !== hash)
          throw new Error('RPC returned wrong transaction hash; reconcile persisted transaction');
        return { hash };
      },
    );
  }
  private async assertSigned(
    intent: TransactionIntent,
    raw: Hex,
    expectedNonce: number | undefined,
  ) {
    const tx = parseTransaction(raw);
    const from = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    });
    if (
      expectedNonce === undefined ||
      tx.nonce !== expectedNonce ||
      tx.chainId !== this.chainId ||
      !equalAddress(from, intent.account) ||
      !tx.to ||
      !equalAddress(tx.to, intent.to) ||
      tx.data !== intent.data ||
      (tx.value ?? 0n) !== intent.value ||
      !tx.gas ||
      tx.gas > this.config.maxGas ||
      !tx.gasPrice ||
      tx.gasPrice > this.config.maxGasPriceWei
    )
      throw new Error('Signed transaction violates intent policy');
  }
  /** Explicit recovery rebroadcasts the exact persisted bytes, never signs a replacement. */
  async rebroadcast(intent: TransactionIntent) {
    const { hash } = await this.execute(intent);
    const record = await this.config.journal.get(`${this.chainId}:${intent.id}`);
    if (!record?.rawTransaction) throw new Error('No signed transaction to rebroadcast');
    const returned = await this.config.rpc.request('eth_sendRawTransaction', [
      record.rawTransaction,
    ]);
    if (returned !== hash) throw new Error('RPC returned wrong transaction hash');
    return { hash };
  }
  async receipt(
    intent: TransactionIntent,
  ): Promise<{ result: Reconciliation; receipt?: ChainReceipt }> {
    this.assertIntent(intent);
    await this.verifyNetwork([intent.to]);
    const saved = await this.config.journal.get(`${this.chainId}:${intent.id}`);
    if (!saved?.hash || saved.fingerprint !== fingerprint(intent))
      throw new Error('Unknown or changed intent');
    const result: Reconciliation = { status: 'pending', hash: saved.hash };
    const r = (await this.config.rpc.request('eth_getTransactionReceipt', [
      saved.hash,
    ])) as ChainReceipt | null;
    if (!r) return { result };
    if (
      r.transactionHash !== saved.hash ||
      !equalAddress(r.to, intent.to) ||
      !equalAddress(r.from, intent.account)
    )
      throw new Error('Receipt transaction identity mismatch');
    const head = BigInt((await this.config.rpc.request('eth_blockNumber')) as string);
    if (head - BigInt(r.blockNumber) + 1n < BigInt(this.config.confirmations)) return { result };
    const block = (await this.config.rpc.request('eth_getBlockByNumber', [
      r.blockNumber,
      false,
    ])) as { hash: Hex } | null;
    if (!block || block.hash !== r.blockHash)
      throw new Error('Receipt block is not canonical (reorg)');
    if (r.status === '0x0') return { result: { ...result, status: 'reverted' } };
    if (r.status !== '0x1') throw new Error('Invalid receipt status');
    return { result: { ...result, status: 'confirmed' }, receipt: r };
  }
}
