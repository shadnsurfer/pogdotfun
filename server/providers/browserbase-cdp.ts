import type { Browser, BrowserContext, Page } from 'playwright-core';
import { TwitchCheckoutError } from './twitch-checkout.ts';

/** Private server contract. This does not confer permission to purchase anything. */
export interface OwnedBrowserLease {
  paymentId: string;
  sessionId: string;
  contextId: string;
  browserAttemptId: string;
  /** Provider generation metadata; absent only for legacy generation zero. */
  providerAttemptId?: string;
  leaseId: string;
}

export interface OwnedPage {
  page: Page;
  context: BrowserContext;
  /** Opaque diagnostic provenance only; never confers browser or purchase authority. */
  diagnosticIdentity?: string;
  /** Drivers must call immediately before an action and await every action they start. */
  assertOwned(): void;
}

const messages = {
  configuration_invalid: 'Browser transport configuration is invalid.',
  lease_lost: 'Exclusive browser ownership could not be verified.',
  already_connected: 'This browser already has an active or unresolved connection.',
  session_invalid: 'The recorded browser session could not be verified for attachment.',
  session_unavailable: 'The recorded browser session is unavailable.',
  connection_invalid: 'The browser connection endpoint could not be verified.',
  connect_failed: 'Browser attachment failed. Reconcile the existing session before retrying.',
  page_unavailable: 'The browser has no unambiguous existing context and page.',
  driver_failed: 'Browser work did not finish successfully. Reconcile before retrying.',
  disconnect_failed: 'Browser disconnection is unresolved. Retain exclusive ownership.',
} as const;

export class BrowserCdpError extends Error {
  readonly status = 503;
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'driver_failed';
    super(messages[safeCode]);
    this.code = safeCode;
    this.name = 'BrowserCdpError';
  }
}

interface Config {
  apiKey: string;
  projectId: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  actionTimeoutMs?: number;
  disconnectTimeoutMs?: number;
}

interface Dependencies {
  /** Must synchronously check the exact live driver_active lease in the durable store. */
  ownsLease(lease: Readonly<OwnedBrowserLease>): boolean;
  fetch?: typeof fetch;
  connect?: (endpoint: string, options: { timeout: number; noDefaults: true }) => Promise<Browser>;
  now?: () => number;
}

// Process-local duplicate attachment protection supplements (never replaces) the DB lease.
// An uncertain disconnect is intentionally retained for the lifetime of this process.
const attachedSessions = new Set<string>();

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new BrowserCdpError('configuration_invalid');
  return value;
}

function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 100 || result > 30_000)
    throw new BrowserCdpError('configuration_invalid');
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserCdpError('session_invalid');
  return value as Record<string, unknown>;
}

function endpoint(value: unknown, sessionId: string, signingKey: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value))
      throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^connect(?:\.[a-z0-9-]+)?\.browserbase\.com$/.test(url.hostname)
    )
      throw new Error();
    const ids = url.searchParams.getAll('sessionId');
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== sessionId)) throw new Error();
    const keys = url.searchParams.getAll('signingKey');
    if (
      keys.length > 0 &&
      (keys.length !== 1 ||
        typeof signingKey !== 'string' ||
        !signingKey ||
        /[\s\x00-\x1f\x7f]/.test(signingKey) ||
        keys[0] !== signingKey ||
        [...url.searchParams.keys()].some((key) => key !== 'signingKey' && key !== 'sessionId'))
    )
      throw new Error();
    // A bare / endpoint with only an API key can CREATE a paid session. A signing
    // capability is accepted only from the exact REST session verified below.
    const signedBinding = url.pathname === '/' && keys.length === 1;
    const queryBinding = url.pathname === '/' && ids.length === 1;
    const debugBinding = new RegExp(`^/debug/${sessionId}/devtools/browser/[a-zA-Z0-9_-]+$`).test(
      url.pathname,
    );
    if (!signedBinding && !queryBinding && !debugBinding) throw new Error();
    return url.href;
  } catch {
    throw new BrowserCdpError('connection_invalid');
  }
}

function rejectDebugLogging(): void {
  // Playwright protocol/API debug logs can include the capability URL and account contents.
  // Do not silently change process-wide logging; require an explicitly quiet worker process.
  if (process.env.DEBUG || process.env.PWDEBUG) throw new BrowserCdpError('configuration_invalid');
}

/**
 * Attach to a lifecycle-worker-owned, keep-alive browser. No create/release REST requests,
 * context creation, navigation, selectors, cookie/storage reads, or financial actions live here.
 * Scope/results are private driver objects, never public API DTOs. Drivers must not retain them.
 */
export class BrowserbaseCdpConnector {
  #config: Required<Config>;
  #dependencies: Dependencies;
  constructor(config: Config, dependencies: Dependencies) {
    if (
      !config.apiKey ||
      /[\r\n]/.test(config.apiKey) ||
      typeof dependencies.ownsLease !== 'function'
    )
      throw new BrowserCdpError('configuration_invalid');
    this.#config = {
      apiKey: config.apiKey,
      projectId: identifier(config.projectId),
      requestTimeoutMs: timeout(config.requestTimeoutMs, 10_000),
      connectTimeoutMs: timeout(config.connectTimeoutMs, 15_000),
      actionTimeoutMs: timeout(config.actionTimeoutMs, 10_000),
      disconnectTimeoutMs: timeout(config.disconnectTimeoutMs, 5_000),
    };
    this.#dependencies = { ...dependencies };
  }

  hasActiveConnection(sessionId: string): boolean {
    return attachedSessions.has(`${this.#config.projectId}:${identifier(sessionId)}`);
  }

  #assertLease(lease: Readonly<OwnedBrowserLease>): void {
    try {
      if (this.#dependencies.ownsLease(lease) !== true) throw new Error();
    } catch {
      throw new BrowserCdpError('lease_lost');
    }
  }

  async #session(lease: Readonly<OwnedBrowserLease>) {
    let payload: unknown;
    try {
      const response = await (this.#dependencies.fetch ?? fetch)(
        `https://api.browserbase.com/v1/sessions/${lease.sessionId}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: { 'X-BB-API-Key': this.#config.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        },
      );
      if (!response.ok) throw new Error();
      payload = await response.json();
    } catch {
      throw new BrowserCdpError('session_unavailable');
    }
    this.#assertLease(lease);
    const data = object(payload),
      metadata = object(data.userMetadata);
    const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    if (
      data.id !== lease.sessionId ||
      data.projectId !== this.#config.projectId ||
      data.contextId !== lease.contextId ||
      metadata.pogAttemptId !== (lease.providerAttemptId ?? lease.browserAttemptId) ||
      data.status !== 'RUNNING' ||
      data.keepAlive !== true ||
      !Number.isFinite(expiresAt)
    )
      throw new BrowserCdpError('session_invalid');
    return {
      expiresAt,
      connectUrl: endpoint(data.connectUrl, lease.sessionId, data.signingKey),
    };
  }

  async withOwnedPage<T>(
    input: OwnedBrowserLease,
    work: (scope: OwnedPage) => Promise<T>,
  ): Promise<T> {
    const lease = Object.freeze({
      paymentId: identifier(input.paymentId),
      sessionId: identifier(input.sessionId),
      contextId: identifier(input.contextId),
      browserAttemptId: identifier(input.browserAttemptId),
      ...(input.providerAttemptId === undefined
        ? {}
        : { providerAttemptId: identifier(input.providerAttemptId) }),
      leaseId: identifier(input.leaseId),
    });
    rejectDebugLogging();
    this.#assertLease(lease);
    const key = `${this.#config.projectId}:${lease.sessionId}`;
    if (attachedSessions.has(key)) throw new BrowserCdpError('already_connected');
    attachedSessions.add(key);
    let browser: Browser | undefined;
    try {
      const session = await this.#session(lease);
      const assertOwned = () => {
        this.#assertLease(lease);
        const now = (this.#dependencies.now ?? Date.now)();
        if (!Number.isFinite(now) || session.expiresAt <= now)
          throw new BrowserCdpError('session_invalid');
      };
      assertOwned();
      try {
        const connect =
          this.#dependencies.connect ??
          (async (url, options) => {
            // Import only after the logging/lease checks; playwright-core installs no browser binary.
            const { chromium } = await import('playwright-core');
            assertOwned();
            rejectDebugLogging();
            return chromium.connectOverCDP(url, options);
          });
        browser = await connect(session.connectUrl, {
          timeout: this.#config.connectTimeoutMs,
          noDefaults: true,
        });
      } catch {
        throw new BrowserCdpError('connect_failed');
      }
      assertOwned();
      const contexts = browser.contexts();
      if (!browser.isConnected() || contexts.length !== 1)
        throw new BrowserCdpError('page_unavailable');
      const context = contexts[0];
      const pages = context.pages().filter((candidate) => !candidate.isClosed());
      if (pages.length !== 1) throw new BrowserCdpError('page_unavailable');
      const page = pages[0];
      page.setDefaultTimeout(this.#config.actionTimeoutMs);
      page.setDefaultNavigationTimeout(this.#config.actionTimeoutMs);
      assertOwned();
      const result = await work({ page, context, assertOwned });
      assertOwned();
      return result;
    } catch (error) {
      // Even a trusted driver's errors may contain DOM/card contents or a capability URL.
      if (error instanceof TwitchCheckoutError)
        throw new TwitchCheckoutError(error.code, error.phase);
      throw new BrowserCdpError(error instanceof BrowserCdpError ? error.code : 'driver_failed');
    } finally {
      let disconnected = browser === undefined;
      if (browser) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            browser.close(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new BrowserCdpError('disconnect_failed')),
                this.#config.disconnectTimeoutMs,
              );
            }),
          ]);
        } catch {
          /* Check transport status, never log provider output. */
        } finally {
          clearTimeout(timer);
        }
        try {
          disconnected = !browser.isConnected();
        } catch {
          disconnected = false;
        }
      }
      if (disconnected) attachedSessions.delete(key);
      else throw new BrowserCdpError('disconnect_failed');
    }
  }
}
