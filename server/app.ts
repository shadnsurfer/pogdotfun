import type { WorkerBindings } from './worker-bindings.ts';
import { runtimeSecrets } from './security/runtime-secrets.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOperations, OperationsError } from './operations.ts';
import { createServices, ServiceError } from './services.ts';
import type { ServiceOptions } from './services.ts';
import { isProductionEnvironment } from './runtime-config.ts';
import { PublicError } from './public/identity.ts';
import { isRecipientPlatformEnabled } from './platform-policy.ts';
import { createPublicServices, type PublicServiceOptions } from './public/service.ts';
import { publicCatalog } from './public/catalog.ts';
import { DexScreenerMarketData } from './public/market-data.ts';
import { UnclaimedFeeCache } from './public/unclaimed-fees.ts';
import { GeckoTerminalTokenChart } from './public/token-chart.ts';
import { createPumpLaunchService, type LaunchServiceConfig } from './launch/service.ts';
import { PumpLaunchChain } from './launch/pump-chain.ts';
import { LaunchError } from './launch/types.ts';
import { StreamerDirectory } from './public/streamers.ts';
import { StreamerLiveGate, LiveGateError, type LiveRecipient } from './workers/streamer-live.ts';
export interface TokenDraftInput {
  name: string;
  symbol: string;
  description: string;
  launchpad: 'pump' | 'pons';
  recipientPlatform: 'twitch' | 'kick';
  recipientUsername: string;
  imageDataUrl?: string;
  website?: string;
}

export interface TokenDraft extends TokenDraftInput {
  id: string;
  createdAt: string;
  status: 'draft';
}

class HttpError extends Error {
  status: number;
  fields?: Record<string, string>;

  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const IMAGE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_BODY_LIMIT = 3 * 1024 * 1024;
const draftKeys = new Set([
  'name',
  'symbol',
  'description',
  'launchpad',
  'recipientPlatform',
  'recipientUsername',
  'imageDataUrl',
  'website',
]);

function isRasterImage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > IMAGE_LIMIT || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png')
    return (
      bytes.length > 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  if (match[1] === 'jpeg')
    return (
      bytes.length > 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217
    );
  return (
    bytes.length > 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

function validateDraft(value: unknown): TokenDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object containing token draft fields.');
  }
  const input = value as Record<string, unknown>;
  const fields: Record<string, string> = Object.create(null);
  for (const key of Object.keys(input)) {
    if (!draftKeys.has(key)) fields[key] = 'Unknown field.';
  }
  const text = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  const name = text('name');
  const symbol = text('symbol');
  const description = text('description');
  const recipientUsername = text('recipientUsername');
  if (name.length < 2 || name.length > 32 || /[\u0000-\u001f]/.test(name))
    fields.name = 'Use 2–32 characters.';
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) fields.symbol = 'Use 2–10 uppercase letters or numbers.';
  if (typeof input.description !== 'string' || input.description.length > 500)
    fields.description = 'Use a description of up to 500 characters.';
  if (input.launchpad !== 'pump')
    fields.launchpad = 'Only Pump.fun on Solana is available. Other launchpads are coming soon.';
  if (!isRecipientPlatformEnabled(input.recipientPlatform))
    fields.recipientPlatform = 'Choose Twitch or Kick.';
  if (!/^[A-Za-z0-9_]{3,25}$/.test(recipientUsername))
    fields.recipientUsername = 'Use 3–25 letters, numbers or underscores.';
  if (input.imageDataUrl !== undefined && !isRasterImage(input.imageDataUrl)) {
    fields.imageDataUrl = 'Upload a PNG, JPEG or WebP image no larger than 2 MiB.';
  }
  if (input.website !== undefined) {
    try {
      if (typeof input.website !== 'string' || input.website.length > 2048)
        throw new Error('Invalid URL');
      const url = new URL(input.website);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
        throw new Error('Invalid URL');
    } catch {
      fields.website = 'Use a full HTTPS URL without embedded credentials.';
    }
  }
  if (Object.keys(fields).length)
    throw new HttpError(400, 'Please check the highlighted fields.', fields);
  return {
    name,
    symbol,
    description,
    recipientUsername,
    launchpad: input.launchpad as TokenDraftInput['launchpad'],
    recipientPlatform: input.recipientPlatform as TokenDraftInput['recipientPlatform'],
    ...(input.imageDataUrl !== undefined ? { imageDataUrl: input.imageDataUrl as string } : {}),
    ...(input.website !== undefined ? { website: input.website as string } : {}),
  };
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new HttpError(415, 'Send this request as application/json.');
  }
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new HttpError(413, 'Request body is too large.');
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, 'Request was interrupted.')));
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** Persistent operations API. The unauthenticated draft workspace is local-only. */
export function createApp(
  options: {
    dbPath?: string;
    bodyLimitBytes?: number;
    allowedOrigins?: string[];
    services?: ServiceOptions;
    workerBindings?: WorkerBindings;
    production?: boolean;
    publicServices?: PublicServiceOptions;
    launches?: LaunchServiceConfig;
  } = {},
) {
  const production = options.production ?? isProductionEnvironment();
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes <= 0)
    throw new RangeError('Invalid request body limit.');
  const dbPath = options.dbPath ?? process.env.POG_DB_PATH ?? resolve('.data/pog.db');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS token_drafts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const listDrafts = db.prepare(
    'SELECT payload FROM token_drafts ORDER BY created_at DESC, rowid DESC',
  );
  const insertDraft = db.prepare(
    'INSERT INTO token_drafts (id, created_at, payload) VALUES (?, ?, ?)',
  );
  const operations = createOperations(db);
  const { env, vault } = runtimeSecrets(db, options.publicServices?.env ?? process.env);
  const publicServices = createPublicServices(db, { ...options.publicServices, env });
  const marketData = new DexScreenerMarketData({ fetch: options.publicServices?.fetch });
  const tokenCharts = new GeckoTerminalTokenChart({ fetch: options.publicServices?.fetch });
  const chartToken = db.prepare('SELECT mint FROM ops_tokens WHERE id = ?');
  const encryptionKey = env.POG_LAUNCH_ENCRYPTION_KEY;
  if (encryptionKey && !/^[a-fA-F0-9]{64}$/.test(encryptionKey))
    throw new Error('Launch encryption key must contain exactly 32 bytes encoded as hex.');
  const launches = createPumpLaunchService(
    db,
    operations,
    options.launches ?? {
      launchesEnabled: env.POG_LAUNCHES_ENABLED === 'true',
      transactionsEnabled: env.POG_TRANSACTIONS_ENABLED === 'true',
      encryptionKey: encryptionKey ? Buffer.from(encryptionKey, 'hex') : undefined,
      chain:
        env.POG_SOLANA_RPC_URL && env.POG_SOLANA_GENESIS_HASH
          ? new PumpLaunchChain({
              rpcUrl: env.POG_SOLANA_RPC_URL,
              expectedGenesisHash: env.POG_SOLANA_GENESIS_HASH,
              transactionsEnabled: env.POG_TRANSACTIONS_ENABLED === 'true',
              lookupTableAddress: env.POG_LAUNCH_LOOKUP_TABLE,
            })
          : undefined,
    },
  );
  const streamDirectory = new StreamerDirectory(env, options.publicServices?.fetch);
  const streamerLive = new StreamerLiveGate(db, {
    lookup: (recipient) =>
      streamDirectory.liveStatus(recipient.platform, recipient.providerId, recipient.username),
  });
  const recipientForToken =
    options.services?.recipientForToken ??
    ((tokenId: string): LiveRecipient | null => {
      const recipient = launches.recipientForToken(tokenId);
      return recipient
        ? { platform: recipient.platform, username: recipient.username, providerId: recipient.id }
        : null;
    });
  const services = createServices(db, operations, {
    ...options.workerBindings?.({
      db,
      env,
      secrets: Object.freeze({
        forRole: (role) =>
          vault?.forRole(role) ??
          Object.freeze({
            read: () => {
              throw new Error('Worker credential unavailable.');
            },
          }),
      }),
    }),
    ...options.services,
    env,
    liveGate: options.services?.liveGate ?? streamerLive,
    recipientForToken,
    launchSigner: launches.readiness().configured ? launches.signerForCreator : undefined,
  });
  const feeAccrual = new UnclaimedFeeCache(services.readFeesForDisplay);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/api/config' && request.method === 'GET') {
        const ready = launches.readiness();
        json(response, 200, {
          ...publicServices.config(),
          launchesEnabled: ready.enabled && ready.configured && ready.transactionsEnabled,
        });
      } else if (/^\/api\/token-images\/[a-f0-9]{64}$/.test(path)) {
        if (request.method !== 'GET') throw new PublicError(405, 'Token images require GET.');
        if (url.search)
          throw new PublicError(400, 'Token image requests do not accept parameters.');
        const asset = publicServices.imageAsset(path.split('/').at(-1)!);
        if (!asset) throw new PublicError(404, 'Token image not found.');
        response.writeHead(200, {
          'content-type': asset.mime,
          'content-length': asset.bytes.byteLength,
          'x-content-type-options': 'nosniff',
          etag: `"${asset.id}"`,
          'cache-control': 'public, max-age=31536000, immutable',
          'cdn-cache-control': 'public, max-age=31536000, immutable',
          'vercel-cdn-cache-control': 'public, max-age=31536000, immutable',
        });
        response.end(asset.bytes);
      } else if (path === '/api/catalog' && request.method === 'GET') {
        const catalog = services.projectCatalog(
          publicCatalog(operations, launches, publicServices.recipients(), {
            streamerStatuses: streamerLive.list(),
          }),
        );
        const catalogTokens = feeAccrual.snapshot(catalog.tokens).map((token) => ({
          ...token,
          image: publicServices.imageAssetUrl(token.image),
        }));
        // This market reader is Solana-specific. Official Robinhood $POG evidence
        // comes from the treasury projection, never a Solana mint lookup.
        const market = marketData.snapshot(catalogTokens);
        json(response, 200, {
          ...catalog,
          tokens: market.tokens,
          marketData: market.marketData,
        });
      } else if (
        /^\/api\/tokens\/(?:platform-pog|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/chart$/.test(
          path,
        )
      ) {
        if (request.method !== 'GET') throw new PublicError(405, 'Chart requests must use GET.');
        const ranges = url.searchParams.getAll('range');
        const range = ranges[0] ?? '24h';
        if (
          ranges.length > 1 ||
          [...url.searchParams.keys()].some((key) => key !== 'range') ||
          (range !== '24h' && range !== '7d' && range !== '30d')
        )
          throw new PublicError(400, 'Choose one chart range: 24h, 7d or 30d.');
        const tokenId = path.split('/')[3];
        const token = chartToken.get(tokenId);
        if (!token) throw new PublicError(404, 'Token not found.');
        json(response, 200, await tokenCharts.get(tokenId, String(token.mint), range));
      } else if (
        [
          '/api/me',
          '/api/streamers/lookup',
          '/api/uploads/token-image',
          '/api/launches/prepare',
        ].includes(path) ||
        /^\/api\/launches\/[a-f0-9-]{36}(?:\/(?:submit|cancel))?$/.test(path)
      ) {
        const principal = await publicServices.identity.authorize(request.headers.authorization);
        publicServices.rateLimit(principal.userId, 'api', 600);
        if (path === '/api/me' && request.method === 'GET') json(response, 200, principal);
        else if (path === '/api/streamers/lookup' && request.method === 'GET')
          json(response, 200, {
            streamer: await publicServices.lookup(
              principal,
              url.searchParams.get('platform'),
              url.searchParams.get('username'),
            ),
          });
        else if (path === '/api/uploads/token-image' && request.method === 'POST')
          json(
            response,
            201,
            await publicServices.image(principal, await readJson(request, bodyLimitBytes)),
          );
        else if (path === '/api/launches/prepare' && request.method === 'POST') {
          const ready = launches.readiness();
          if (!ready.enabled || !ready.configured || !ready.transactionsEnabled)
            throw new PublicError(503, 'Token launching is not enabled yet.');
          const verified = await publicServices.verifiedLaunch(
            principal,
            await readJson(request, bodyLimitBytes),
          );
          json(response, 201, await launches.prepare(principal, verified));
        } else {
          const match = /^\/api\/launches\/([a-f0-9-]{36})(?:\/(submit|cancel))?$/.exec(path);
          if (match && !match[2] && request.method === 'GET')
            json(response, 200, await launches.get(principal, match[1]));
          else if (match?.[2] === 'cancel' && request.method === 'POST') {
            request.resume();
            json(response, 200, await launches.cancel(principal, match[1]));
          } else if (match?.[2] === 'submit' && request.method === 'POST') {
            const body = (await readJson(request, 4096)) as {
              signedTransaction?: unknown;
              retry?: unknown;
            };
            if (body?.retry === true && body.signedTransaction === undefined) {
              json(response, 200, await launches.retry(principal, match[1]));
              return;
            }
            if (typeof body?.signedTransaction !== 'string' || body.retry !== undefined)
              throw new PublicError(400, 'A signed transaction is required.');
            json(response, 200, await launches.submit(principal, match[1], body.signedTransaction));
          } else json(response, 405, { error: 'Method not allowed.' });
        }
      } else if (path === '/api/donations' && request.method === 'GET') {
        json(response, 200, {
          donations: services.publicDonations(),
          ledger: services.publicLedger(),
          nativeBuybackLedger: services.publicNativeBuybacks(),
          agentPayments: services.publicPayments(),
        });
      } else if (path === '/api/health' && request.method === 'GET') {
        db.prepare('SELECT 1').get();
        json(response, 200, {
          status: 'ok',
          mode: production ? 'operations' : 'demo',
          scope: 'api-and-database',
          providersConnected: production ? null : false,
          providerReadiness: services.status(),
          transactionsEnabled: env.POG_TRANSACTIONS_ENABLED === 'true',
          automationEnabled: env.POG_AUTOMATION_ENABLED === 'true',
        });
      } else if (production && (path === '/api/drafts' || path.startsWith('/api/drafts/'))) {
        request.resume();
        json(response, 503, {
          error: 'Token drafts are not supported. Use Launch to create a token.',
        });
      } else if (path === '/api/drafts' && request.method === 'GET') {
        json(response, 200, {
          drafts: listDrafts.all().map((row) => JSON.parse(row.payload as string)),
        });
      } else if (path === '/api/drafts' && request.method === 'POST') {
        const input = validateDraft(await readJson(request, bodyLimitBytes));
        const draft: TokenDraft = {
          ...input,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          status: 'draft',
        };
        insertDraft.run(draft.id, draft.createdAt, JSON.stringify(draft));
        json(response, 201, { draft });
      } else if (path === '/api/drafts' || path === '/api/health') {
        response.setHeader('allow', path === '/api/drafts' ? 'GET, POST' : 'GET');
        json(response, 405, { error: 'Method not allowed.' });
      } else {
        json(response, 404, { error: 'This API route does not exist.' });
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (
        error instanceof HttpError ||
        error instanceof OperationsError ||
        error instanceof ServiceError ||
        error instanceof PublicError ||
        error instanceof LaunchError ||
        error instanceof LiveGateError
      ) {
        json(response, error.status, {
          error: error.message,
          ...(error instanceof HttpError && error.fields ? { fields: error.fields } : {}),
        });
      } else {
        console.error('Pog API request failed. Inspect private service diagnostics.');
        json(response, 500, { error: 'The request could not be completed.' });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let closing: Promise<void> | undefined;
  let streamCheckRun: Promise<{ checked: number; becameLive: boolean }> | undefined;
  function runStreamerChecks() {
    if (closing) return Promise.resolve({ checked: 0, becameLive: false });
    if (streamCheckRun) return streamCheckRun;
    const work = (async () => {
      for (const token of operations.snapshot().tokens) {
        if (!isRecipientPlatformEnabled(token.recipientPlatform)) continue;
        const recipient = recipientForToken(token.id);
        if (recipient) streamerLive.watch(recipient);
      }
      const before = new Map(streamerLive.list().map((row) => [row.providerId, row.status]));
      const result = await streamerLive.pollDue();
      const becameLive = streamerLive
        .list()
        .some((row) => row.status === 'live' && before.get(row.providerId) !== 'live');
      if (!closing && becameLive && env.POG_AUTOMATION_ENABLED === 'true') {
        try {
          await services.runOnce();
        } catch (error) {
          if (!(error instanceof ServiceError && error.status === 409)) throw error;
        }
      }
      return { ...result, becameLive };
    })();
    streamCheckRun = work;
    void work
      .finally(() => {
        if (streamCheckRun === work) streamCheckRun = undefined;
      })
      .catch(() => {});
    return work;
  }
  function close(): Promise<void> {
    closing ??= new Promise((resolveClose, reject) => {
      server.close(async (error) => {
        try {
          await marketData.close();
          await feeAccrual.close();
          await launches.close();
          await streamerLive.close();
          await streamCheckRun?.catch(() => {});
          await services.close();
          vault?.close();
          db.close();
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
            reject(error);
          else resolveClose();
        } catch (closeError) {
          try {
            vault?.close();
            db.close();
          } catch {
            /* Already closed. */
          }
          reject(closeError);
        }
      });
      server.closeAllConnections();
    });
    return closing;
  }
  return {
    server,
    close,
    runLedger: async () => {
      const ledger = await services.runOnce();
      return { ledger };
    },
    runLaunchReconciliation: () =>
      closing ? Promise.resolve({ checked: 0, confirmed: 0 }) : launches.reconcilePending(),
    runStreamerChecks,
  };
}
