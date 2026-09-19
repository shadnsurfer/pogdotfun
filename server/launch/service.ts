import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { OperationsService } from '../operations.ts';
import { LaunchError } from './types.ts';
import type {
  LaunchChain,
  LaunchChainResult,
  LaunchPrincipal,
  LaunchRecord,
  VerifiedLaunchInput,
} from './types.ts';
import { transactionSignature } from './pump-chain.ts';
import { abortableLaunchRead } from './reconciliation.ts';
import { isRecipientPlatformEnabled } from '../platform-policy.ts';
import { normalizeTokenXLink, TOKEN_WEBSITE } from './metadata-policy.ts';
import { normalizeInitialBuyLamports } from './initial-buy.ts';

export interface LaunchServiceConfig {
  launchesEnabled: boolean;
  transactionsEnabled: boolean;
  /** 32 bytes, stored separately from the database and its backups. Never sent to a client. */
  encryptionKey?: Uint8Array;
  chain?: LaunchChain;
  now?: () => number;
  reconciliationTimeoutMs?: number;
}

const keyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
function publicKey(value: string) {
  try {
    const result = new PublicKey(value);
    if (!PublicKey.isOnCurve(result.toBytes())) throw new Error();
    return result.toBase58();
  } catch {
    throw new LaunchError(400, 'A valid Solana wallet address is required.');
  }
}
function uri(value: string, maximum: number) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum)
    throw new LaunchError(400, 'Invalid asset URI.');
  try {
    const url = new URL(value);
    if (
      !['https:', 'ipfs:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      throw new Error();
    return value;
  } catch {
    throw new LaunchError(400, 'Use a verified HTTPS or IPFS asset URI.');
  }
}
function bytes(base64: string) {
  if (typeof base64 !== 'string' || base64.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new LaunchError(400, 'Invalid serialized Solana transaction.');
  const value = Buffer.from(base64, 'base64');
  if (value.toString('base64') !== base64 || value.length > 1232)
    throw new LaunchError(400, 'Invalid serialized Solana transaction.');
  return value;
}

/** Authentication, uploads and recipient lookup happen in the calling HTTP service. */
export function createPumpLaunchService(
  db: DatabaseSync,
  operations: Pick<OperationsService, 'registerToken'>,
  config: LaunchServiceConfig,
) {
  if (config.encryptionKey && config.encryptionKey.length !== 32)
    throw new LaunchError(503, 'Launch wallet encryption requires a 32-byte server key.');
  const secret = config.encryptionKey ? Buffer.from(config.encryptionKey) : undefined;
  const now = config.now ?? Date.now;
  const reconciliationTimeoutMs = config.reconciliationTimeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(reconciliationTimeoutMs) ||
    reconciliationTimeoutMs < 1 ||
    reconciliationTimeoutMs > 30_000
  )
    throw new LaunchError(503, 'Launch reconciliation timeout must be 1–30000 milliseconds.');
  let stopping = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS launch_intents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, mint TEXT NOT NULL UNIQUE, creator TEXT NOT NULL UNIQUE,
      signature TEXT UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(user_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS launch_secrets (
      intent_id TEXT NOT NULL, purpose TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
      encrypted TEXT NOT NULL, PRIMARY KEY(intent_id, purpose)
    );
    CREATE TABLE IF NOT EXISTS launch_reconciliation_checks (
      launch_id TEXT PRIMARY KEY, check_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS launch_reconciliation_order ON launch_reconciliation_checks(check_order);
    CREATE INDEX IF NOT EXISTS launch_intents_status ON launch_intents(status, created_at);
  `);
  const preparing = new Map<string, Promise<ReturnType<typeof view>>>();
  const submitting = new Map<string, Promise<ReturnType<typeof view>>>();
  const versions = new WeakMap<LaunchRecord, string>();
  const reconciling = new Map<
    string,
    Promise<{ record: LaunchRecord; result?: LaunchChainResult }>
  >();
  const operationControllers = new Set<AbortController>();
  let reconciliationRun: Promise<{ checked: number; confirmed: number }> | undefined;
  const time = () => new Date(now()).toISOString();
  const wallets = (who: LaunchPrincipal) =>
    who.walletAddresses ?? (who.walletAddress ? [who.walletAddress] : []);
  function ready() {
    if (stopping) throw new LaunchError(503, 'Launch service is stopping.');
    if (!config.launchesEnabled) throw new LaunchError(503, 'Token launching is not enabled yet.');
    if (!secret || !config.chain)
      throw new LaunchError(
        503,
        'Launch RPC and encrypted creator wallet storage must be configured.',
      );
  }
  function principal(value: LaunchPrincipal) {
    if (!value?.userId || value.userId.length > 200 || !wallets(value).length)
      throw new LaunchError(401, 'Sign in with a verified wallet.');
  }
  function read(id: string) {
    const row = db.prepare('SELECT payload FROM launch_intents WHERE id = ?').get(id);
    if (!row) throw new LaunchError(404, 'Launch not found.');
    const record = JSON.parse(row.payload as string) as LaunchRecord;
    versions.set(record, row.payload as string);
    return record;
  }
  function own(who: LaunchPrincipal, id: string) {
    principal(who);
    const value = read(id);
    if (value.userId !== who.userId) throw new LaunchError(404, 'Launch not found.');
    return value;
  }
  function write(value: LaunchRecord) {
    const previous = versions.get(value);
    if (previous === undefined) throw new Error('Launch state must be read before updating.');
    value.updatedAt = time();
    const payload = JSON.stringify(value);
    // Compare-and-swap prevents an in-flight RPC read from overwriting a newer
    // submission, signature, receipt or terminal state saved by another request.
    const changed = db
      .prepare(
        "UPDATE launch_intents SET status = ?, signature = ?, payload = ? WHERE id = ? AND payload = ? AND status NOT IN ('confirmed','failed')",
      )
      .run(value.status, value.signature ?? null, payload, value.launchId, previous).changes;
    if (Number(changed) === 1) {
      versions.set(value, payload);
      return true;
    }
    return false;
  }
  function encrypt(id: string, purpose: string, key: Keypair) {
    if (!secret) throw new LaunchError(503, 'Launch wallet encryption is not configured.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(Buffer.from(`${id}:${purpose}:${key.publicKey.toBase58()}`));
    const ciphertext = Buffer.concat([cipher.update(key.secretKey), cipher.final()]);
    return [nonce, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64'))
      .join('.');
  }
  function decrypt(id: string, purpose: string) {
    if (!secret) throw new LaunchError(503, 'Launch wallet encryption is not configured.');
    const row = db
      .prepare('SELECT address,encrypted FROM launch_secrets WHERE intent_id = ? AND purpose = ?')
      .get(id, purpose);
    if (!row) throw new LaunchError(503, 'The dedicated launch signer is unavailable.');
    try {
      const [nonce, tag, ciphertext] = (row.encrypted as string)
        .split('.')
        .map((value) => Buffer.from(value, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
      decipher.setAAD(Buffer.from(`${id}:${purpose}:${row.address}`));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const key = Keypair.fromSecretKey(Uint8Array.from(plaintext));
      plaintext.fill(0);
      if (key.publicKey.toBase58() !== row.address) throw new Error();
      return key;
    } catch {
      throw new LaunchError(
        503,
        'The launch signer could not be decrypted. Restore the matching server encryption key.',
      );
    }
  }
  function view(record: LaunchRecord) {
    return {
      launchId: record.launchId,
      walletAddress: record.walletAddress,
      status: record.status,
      transaction: record.status === 'prepared' ? (record.prepared?.transaction ?? null) : null,
      summary: {
        name: record.name,
        symbol: record.symbol,
        mint: record.mint,
        creatorAddress: record.creatorAddress,
        walletAddress: record.walletAddress,
        recipientPlatform: record.recipient.platform,
        recipientUsername: record.recipient.username,
        recipientId: record.recipient.id,
        channelUrl: record.recipient.channelUrl,
        chain: 'solana' as const,
        launchpad: 'pump' as const,
        networkFeeLamports: record.prepared?.networkFeeLamports ?? null,
        creatorReserveLamports: record.prepared?.creatorReserveLamports ?? null,
        estimatedTotalLamports: record.prepared?.estimatedTotalLamports ?? null,
        initialBuyLamports: record.initialBuyLamports ?? '0',
        feeSplit: { streamerPercent: 80, buybackPercent: 20 },
      },
      ...(record.signature
        ? {
            signature: record.signature,
            transactionUrl: `https://solscan.io/tx/${record.signature}`,
          }
        : {}),
      ...(record.tokenId ? { tokenId: record.tokenId } : {}),
      ...(record.slot ? { slot: record.slot } : {}),
      ...(record.error ? { error: record.error } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  function validate(who: LaunchPrincipal, input: VerifiedLaunchInput): VerifiedLaunchInput {
    principal(who);
    if (!input || typeof input !== 'object' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId))
      throw new LaunchError(400, 'Use a stable request ID for this launch.');
    const walletAddress = publicKey(input.walletAddress);
    if (!wallets(who).includes(walletAddress))
      throw new LaunchError(403, 'This wallet is not linked to the authenticated user.');
    if (
      typeof input.name !== 'string' ||
      input.name.trim().length < 2 ||
      Buffer.byteLength(input.name.trim()) > 32 ||
      /[\x00-\x1f]/.test(input.name)
    )
      throw new LaunchError(400, 'Use a token name of 2–32 UTF-8 bytes.');
    if (!/^[A-Z0-9]{2,10}$/.test(input.symbol))
      throw new LaunchError(400, 'Use 2–10 uppercase letters or numbers for the symbol.');
    if (typeof input.description !== 'string' || input.description.length > 500)
      throw new LaunchError(400, 'Use a description of up to 500 characters.');
    let initialBuyLamports: string | undefined;
    try {
      initialBuyLamports = normalizeInitialBuyLamports(input.initialBuyLamports);
    } catch {
      throw new LaunchError(400, 'Enter a valid initial buy amount in whole lamports.');
    }
    const recipient = input.recipient;
    if (recipient?.platform === 'kick' && !isRecipientPlatformEnabled(recipient.platform))
      throw new LaunchError(503, 'Choose a supported Twitch or Kick recipient.');
    if (
      !recipient ||
      !['twitch', 'kick'].includes(recipient.platform) ||
      typeof recipient.id !== 'string' ||
      !recipient.id.startsWith(`${recipient.platform}:`) ||
      recipient.id.length > 160 ||
      recipient.id.length <= recipient.platform.length + 1 ||
      recipient.verified !== true ||
      !/^[a-zA-Z0-9_]{3,25}$/.test(recipient.username)
    )
      throw new LaunchError(400, 'Verify a Twitch or Kick recipient before preparing a launch.');
    const checked = Date.parse(recipient.verifiedAt);
    if (!Number.isFinite(checked) || checked > now() + 5000 || now() - checked > 300_000)
      throw new LaunchError(400, 'Recipient verification expired. Look up the channel again.');
    const username = recipient.username.toLowerCase();
    const channelUrl = `https://${recipient.platform === 'twitch' ? 'www.twitch.tv' : 'kick.com'}/${username}`;
    if (input.website !== undefined && input.website !== TOKEN_WEBSITE)
      throw new LaunchError(400, 'New token websites must link to Pog.');
    let twitter: string | undefined;
    try {
      twitter = normalizeTokenXLink(input.twitter);
    } catch {
      throw new LaunchError(400, 'Use a full HTTPS X profile, community, or post link.');
    }
    return {
      requestId: input.requestId,
      name: input.name.trim(),
      symbol: input.symbol,
      description: input.description,
      walletAddress,
      metadataUri: uri(input.metadataUri, 200),
      imageUri: uri(input.imageUri, 2048),
      website: TOKEN_WEBSITE,
      ...(twitter ? { twitter } : {}),
      ...(initialBuyLamports ? { initialBuyLamports } : {}),
      recipient: {
        id: recipient.id,
        platform: recipient.platform,
        username,
        channelUrl,
        verified: true,
        verifiedAt: recipient.verifiedAt,
      },
    };
  }
  async function chainOperation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (stopping) throw new LaunchError(503, 'Launch service is stopping.');
    const controller = new AbortController();
    operationControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Launch operation timed out.')),
      30_000,
    );
    try {
      return await abortableLaunchRead(() => work(controller.signal), controller.signal);
    } finally {
      clearTimeout(timeout);
      operationControllers.delete(controller);
    }
  }
  async function finishPreparation(record: LaunchRecord) {
    try {
      const mint = decrypt(record.launchId, 'mint');
      try {
        record.prepared = await chainOperation((signal) =>
          config.chain!.prepare(record, mint, signal),
        );
      } finally {
        mint.secretKey.fill(0);
      }
      record.status = 'prepared';
      delete record.error;
      write(record);
      return view(record);
    } catch (error) {
      record.status = 'failed';
      record.error =
        error instanceof LaunchError
          ? error.message
          : 'Launch preparation could not be completed. No transaction was broadcast.';
      write(record);
      throw new LaunchError(error instanceof LaunchError ? error.status : 502, record.error);
    }
  }
  async function prepare(who: LaunchPrincipal, raw: VerifiedLaunchInput) {
    ready();
    const input = validate(who, raw);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ ...input, recipient: { ...input.recipient, verifiedAt: undefined } }),
      )
      .digest('hex');
    const prior = db
      .prepare('SELECT id,fingerprint FROM launch_intents WHERE user_id = ? AND request_id = ?')
      .get(who.userId, input.requestId);
    let record: LaunchRecord;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new LaunchError(409, 'This request ID already belongs to different launch details.');
      record = read(prior.id as string);
      if (record.status !== 'preparing') return view(record);
    } else {
      const active = db
        .prepare(
          "SELECT count(*) AS n FROM launch_intents WHERE user_id = ? AND status IN ('preparing','prepared','submitted','review')",
        )
        .get(who.userId)!.n as number;
      if (active >= 3)
        throw new LaunchError(
          409,
          'Previous launch transactions are still being checked automatically. Please wait and try again.',
        );
      const mint = Keypair.generate();
      const creator = Keypair.generate();
      const id = randomUUID();
      record = {
        ...input,
        launchId: id,
        userId: who.userId,
        mint: mint.publicKey.toBase58(),
        creatorAddress: creator.publicKey.toBase58(),
        status: 'preparing',
        createdAt: time(),
        updatedAt: time(),
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'INSERT INTO launch_intents(id,user_id,request_id,fingerprint,mint,creator,status,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          who.userId,
          input.requestId,
          fingerprint,
          record.mint,
          record.creatorAddress,
          record.status,
          record.createdAt,
          JSON.stringify(record),
        );
        const insert = db.prepare(
          'INSERT INTO launch_secrets(intent_id,purpose,address,encrypted) VALUES(?,?,?,?)',
        );
        insert.run(id, 'mint', record.mint, encrypt(id, 'mint', mint));
        insert.run(id, 'creator', record.creatorAddress, encrypt(id, 'creator', creator));
        db.exec('COMMIT');
        versions.set(record, JSON.stringify(record));
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        mint.secretKey.fill(0);
        creator.secretKey.fill(0);
      }
    }
    let pending = preparing.get(record.launchId);
    if (!pending) {
      pending = finishPreparation(record).finally(() => preparing.delete(record.launchId));
      preparing.set(record.launchId, pending);
    }
    return pending;
  }
  function reconcileAttempt(who: LaunchPrincipal, id: string) {
    return reconcileRecord(own(who, id));
  }
  function reconcileRecord(
    record: LaunchRecord,
  ): Promise<{ record: LaunchRecord; result?: LaunchChainResult }> {
    if (stopping) return Promise.reject(new LaunchError(503, 'Launch service is stopping.'));
    // An unsigned status read must not delay verification of a newly saved signature.
    const key = `${record.launchId}:${record.signature ?? 'unsigned'}`;
    const previous = reconciling.get(key);
    if (previous) return previous;
    const work = verifyRecord(record).finally(() => reconciling.delete(key));
    reconciling.set(key, work);
    return work;
  }
  async function verifyRecord(
    record: LaunchRecord,
  ): Promise<{ record: LaunchRecord; result?: LaunchChainResult }> {
    if (!record.prepared || ['confirmed', 'failed'].includes(record.status)) return { record };
    if (!config.chain) throw new LaunchError(503, 'The launch RPC is not configured.');
    let result: LaunchChainResult | undefined;
    const controller = new AbortController();
    operationControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Launch verification timed out.')),
      reconciliationTimeoutMs,
    );
    try {
      result = await abortableLaunchRead(
        () => config.chain!.reconcile(record, controller.signal),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (stopping) return { record: read(record.launchId) };
      if (result.status === 'confirmed') {
        if (!record.signature)
          throw new LaunchError(409, 'A finalized launch requires its signed transaction receipt.');
        const token = operations.registerToken(
          {
            name: record.name,
            symbol: record.symbol,
            mint: record.mint,
            creatorAddress: record.creatorAddress,
            chain: 'solana',
            launchpad: 'pump',
            recipientPlatform: record.recipient.platform,
            recipientUsername: record.recipient.username,
            recipientVerified: true,
            dedicatedCreatorVerified: true,
          },
          `launch:${record.userId}`,
        );
        record.tokenId = token.id;
        record.slot = result.slot;
        record.status = 'confirmed';
        delete record.error;
      } else if (result.status !== 'pending') {
        record.status = result.status;
        record.error = result.error;
      } else if (!record.signature) {
        record.status = 'prepared';
        delete record.error;
      }
      write(record);
    } catch {
      if (stopping || controller.signal.aborted) return { record: read(record.launchId) };
      result = undefined;
      record.status = 'review';
      record.error =
        'Chain verification or ledger registration is pending. Do not launch a replacement token.';
      write(record);
    } finally {
      clearTimeout(timeout);
      operationControllers.delete(controller);
    }
    return { record: read(record.launchId), result };
  }
  async function reconcile(who: LaunchPrincipal, id: string) {
    return view((await reconcileAttempt(who, id)).record);
  }
  async function broadcastSaved(who: LaunchPrincipal, record: LaunchRecord) {
    try {
      await chainOperation((signal) =>
        config.chain!.broadcast(record.signedTransaction!, record.signature!, signal),
      );
    } catch {
      record.status = 'review';
      record.error =
        'Broadcast outcome is uncertain. Check this existing signature; do not submit a new launch.';
      write(record);
    }
    return reconcile(who, record.launchId);
  }
  async function submit(who: LaunchPrincipal, id: string, signedTransaction: string) {
    ready();
    if (!config.transactionsEnabled)
      throw new LaunchError(503, 'Transaction broadcasting is disabled.');
    const record = own(who, id);
    if (!wallets(who).includes(record.walletAddress))
      throw new LaunchError(403, 'Reconnect the wallet that prepared this launch.');
    if (!isRecipientPlatformEnabled(record.recipient.platform))
      throw new LaunchError(
        503,
        'Recipient platform is unsupported. Existing launches can still be reconciled.',
      );
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(bytes(signedTransaction));
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw new LaunchError(400, 'Invalid serialized Solana transaction.');
    }
    if (
      !record.prepared ||
      tx.version !== 0 ||
      !Buffer.from(tx.message.serialize()).equals(Buffer.from(record.prepared.message, 'base64'))
    )
      throw new LaunchError(400, 'The signed transaction changes the approved launch.');
    if (
      tx.signatures.length !== tx.message.header.numRequiredSignatures ||
      tx.message.staticAccountKeys[0].toBase58() !== record.walletAddress
    )
      throw new LaunchError(400, 'The launch transaction has invalid signers.');
    for (let i = 0; i < tx.signatures.length; i++) {
      const key = createPublicKey({
        key: Buffer.concat([keyPrefix, tx.message.staticAccountKeys[i].toBuffer()]),
        format: 'der',
        type: 'spki',
      });
      if (!verify(null, tx.message.serialize(), key, tx.signatures[i]))
        throw new LaunchError(400, 'Every required wallet signature must be valid.');
    }
    const signature = transactionSignature(tx);
    if (record.signature) {
      if (record.signature !== signature || record.signedTransaction !== signedTransaction)
        throw new LaunchError(
          409,
          'A different signed transaction is already recorded for this launch.',
        );
      const active = submitting.get(id);
      if (active) return active;
      // A POST is the explicit authorization to recover a crash before broadcast.
      // GET only reconciles. Only an unexpired pending chain result permits sending
      // the existing durable bytes again; the transaction is never reconstructed.
      const recovery = (async () => {
        const checked = await reconcileAttempt(who, id);
        const current = checked.record;
        if (
          checked.result?.status !== 'pending' ||
          ['confirmed', 'failed'].includes(current.status)
        )
          return view(current);
        if (current.signature !== signature || current.signedTransaction !== signedTransaction)
          throw new LaunchError(409, 'Launch transaction changed. Check its confirmation.');
        current.status = 'submitted';
        delete current.error;
        if (!write(current)) return view(read(id));
        return broadcastSaved(who, current);
      })().finally(() => submitting.delete(id));
      submitting.set(id, recovery);
      return recovery;
    }
    if (!['prepared', 'review'].includes(record.status))
      throw new LaunchError(409, 'This launch is not ready for signing.');
    record.signature = signature;
    record.signedTransaction = signedTransaction;
    record.status = 'submitted';
    // No broadcast is allowed unless this exact identity won the durable update.
    if (!write(record))
      throw new LaunchError(
        409,
        'Launch status changed. Refresh this existing launch before retrying.',
      );
    const pending = broadcastSaved(who, record).finally(() => submitting.delete(id));
    submitting.set(id, pending);
    return pending;
  }
  async function cancel(who: LaunchPrincipal, id: string) {
    if (stopping) throw new LaunchError(503, 'Launch service is stopping.');
    const record = own(who, id);
    if (record.signature !== undefined || record.signedTransaction !== undefined)
      throw new LaunchError(409, 'This launch transaction cannot be cancelled after signing.');
    if (record.status === 'failed') return view(record);
    // Review may mean an externally submitted mint already exists. Only a
    // prepared, unsigned intent is known to be safe for immediate cancellation.
    if (record.status !== 'prepared')
      throw new LaunchError(
        409,
        'This launch must finish its transaction checks before cancellation.',
      );
    record.status = 'failed';
    record.error = 'Launch cancelled before submission. No transaction was broadcast.';
    if (!write(record))
      throw new LaunchError(409, 'Launch transaction changed. Check its confirmation.');
    return view(read(id));
  }
  function reconcilePending(): Promise<{ checked: number; confirmed: number }> {
    if (stopping || !config.chain) return Promise.resolve({ checked: 0, confirmed: 0 });
    if (reconciliationRun) return reconciliationRun;
    const work = (async () => {
      const rows = db
        .prepare(
          `SELECT l.payload FROM launch_intents l
        LEFT JOIN launch_reconciliation_checks c ON c.launch_id=l.id
        WHERE json_type(l.payload,'$.prepared')='object' AND (
          (l.status IN ('submitted','review') AND l.signature IS NOT NULL
            AND json_type(l.payload,'$.signature')='text' AND length(json_extract(l.payload,'$.signature'))>0
            AND json_type(l.payload,'$.signedTransaction')='text' AND length(json_extract(l.payload,'$.signedTransaction'))>0)
          OR (l.status IN ('prepared','review') AND l.signature IS NULL
            AND json_type(l.payload,'$.signature') IS NULL
            AND json_type(l.payload,'$.signedTransaction') IS NULL)
        )
        ORDER BY COALESCE(c.check_order,0),l.created_at,l.id LIMIT 24`,
        )
        .all();
      let cursor = 0,
        checked = 0,
        confirmed = 0;
      const nextOrder = db.prepare(
        'SELECT COALESCE(MAX(check_order),0)+1 AS value FROM launch_reconciliation_checks',
      );
      const mark =
        db.prepare(`INSERT INTO launch_reconciliation_checks(launch_id,check_order) VALUES(?,?)
        ON CONFLICT(launch_id) DO UPDATE SET check_order=excluded.check_order`);
      await Promise.all(
        Array.from({ length: Math.min(3, rows.length) }, async () => {
          while (!stopping && cursor < rows.length) {
            const record = JSON.parse(String(rows[cursor++].payload)) as LaunchRecord;
            mark.run(record.launchId, Number(nextOrder.get()!.value));
            checked++;
            try {
              const result = await reconcileRecord(read(record.launchId));
              if (result.record.status === 'confirmed') confirmed++;
            } catch {
              /* One unavailable receipt must not starve other signed launches. */
            }
          }
        }),
      );
      return { checked, confirmed };
    })();
    reconciliationRun = work;
    void work
      .finally(() => {
        if (reconciliationRun === work) reconciliationRun = undefined;
      })
      .catch(() => {});
    return work;
  }
  async function close() {
    stopping = true;
    for (const controller of operationControllers)
      controller.abort(new Error('Launch service is stopping.'));
    await Promise.allSettled([
      ...preparing.values(),
      ...submitting.values(),
      ...reconciling.values(),
      ...(reconciliationRun ? [reconciliationRun] : []),
    ]);
  }
  function catalog(
    options: { search?: string; limit?: number; sort?: 'newest' | 'highest_pog' } = {},
  ) {
    const search = options.search?.trim().toLowerCase().slice(0, 200) ?? '';
    const rows = db
      .prepare(
        "SELECT payload FROM launch_intents WHERE status = 'confirmed' ORDER BY created_at DESC",
      )
      .all();
    const tokens = rows
      .map((row) => {
        const record = JSON.parse(row.payload as string) as LaunchRecord;
        const pogCents = db
          .prepare(
            "SELECT COALESCE(SUM(amount_cents),0) AS n FROM ops_journal WHERE token_id = ? AND account = 'spent'",
          )
          .get(record.tokenId!)!.n as number;
        return {
          id: record.tokenId!,
          launchId: record.launchId,
          mint: record.mint,
          name: record.name,
          symbol: record.symbol,
          description: record.description,
          imageUri: record.imageUri,
          metadataUri: record.metadataUri,
          website: record.website ?? null,
          twitter: record.twitter ?? null,
          chain: 'solana' as const,
          launchpad: 'pump' as const,
          recipientPlatform: record.recipient.platform,
          recipientUsername: record.recipient.username,
          recipientId: record.recipient.id,
          channelUrl: record.recipient.channelUrl,
          createdAt: record.createdAt,
          confirmedAt: record.updatedAt,
          signature: record.signature!,
          transactionUrl: `https://solscan.io/tx/${record.signature}`,
          tradeUrl: `https://pump.fun/coin/${record.mint}`,
          supportSpendingCents: pogCents,
          donatedUsdCents: pogCents,
          marketCapUsd: null,
          volume24hUsd: null,
          marketDataStatus: 'not_indexed' as const,
        };
      })
      .filter(
        (record) =>
          !search ||
          [record.mint, record.name, record.symbol, record.recipientUsername].some((value) =>
            value.toLowerCase().includes(search),
          ),
      );
    if (options.sort === 'highest_pog')
      tokens.sort((a, b) => b.supportSpendingCents - a.supportSpendingCents);
    const limit = Number.isSafeInteger(options.limit)
      ? Math.max(1, Math.min(options.limit!, 100))
      : 50;
    return { tokens: tokens.slice(0, limit), total: tokens.length, dataMode: 'live' as const };
  }
  return {
    prepare,
    submit,
    cancel,
    retry: async (who: LaunchPrincipal, id: string) => {
      const record = own(who, id);
      if (!record.signedTransaction)
        throw new LaunchError(409, 'No signed transaction is saved for this launch.');
      return submit(who, id, record.signedTransaction);
    },
    reconcile,
    reconcilePending,
    close,
    catalog,
    allConfirmedMetadata: () =>
      db
        .prepare("SELECT payload FROM launch_intents WHERE status = 'confirmed'")
        .all()
        .map((row) => {
          const record = JSON.parse(row.payload as string) as LaunchRecord;
          return {
            id: record.tokenId!,
            recipientId: record.recipient.id,
            imageUri: record.imageUri,
            description: record.description,
            metadataUri: record.metadataUri,
            website: record.website ?? null,
            twitter: record.twitter ?? null,
          };
        }),
    recipientForToken: (tokenId: string) => {
      const rows = db
        .prepare("SELECT payload FROM launch_intents WHERE status = 'confirmed'")
        .all();
      const record = rows
        .map((row) => JSON.parse(row.payload as string) as LaunchRecord)
        .find((value) => value.tokenId === tokenId);
      return record?.recipient ?? null;
    },
    get: (who: LaunchPrincipal, id: string) => reconcile(who, id),
    signerForCreator: async (address: string) => {
      const row = db
        .prepare("SELECT id FROM launch_intents WHERE creator = ? AND status = 'confirmed'")
        .get(address);
      if (!row)
        throw new LaunchError(404, 'No finalized launch owns this dedicated creator wallet.');
      return decrypt(row.id as string, 'creator');
    },
    readiness: () => ({
      enabled: config.launchesEnabled,
      configured: Boolean(secret && config.chain),
      transactionsEnabled: config.transactionsEnabled,
    }),
  };
}
