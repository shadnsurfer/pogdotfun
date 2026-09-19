/** Narrow, documented REST surface. No CDP execution, model actions or purchases. */
export interface BrowserSession {
  id: string;
  projectId: string;
  contextId: string;
  status: 'PENDING' | 'RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED';
  expiresAt: string;
  attemptId: string;
}

export interface BrowserSessionProvider {
  createSession(contextId: string, attemptId: string): Promise<BrowserSession>;
  findSessions(attemptId: string): Promise<BrowserSession[]>;
  getSession(id: string): Promise<BrowserSession>;
  liveView(id: string): Promise<string>;
  releaseSession(id: string): Promise<BrowserSession>;
}

export interface BrowserbaseConfig {
  apiKey: string;
  projectId: string;
  region?: 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';
  timeoutSeconds?: number;
}

export class BrowserProviderError extends Error {
  readonly status = 502;
  constructor(
    message = 'Browser provider request failed. Reconcile the existing attempt before retrying.',
  ) {
    super(message);
  }
}

export function browserIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new BrowserProviderError(
      'Browser configuration or response contains an invalid identifier.',
    );
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserProviderError();
  return value as Record<string, unknown>;
}

export class BrowserbaseProvider implements BrowserSessionProvider {
  private readonly config: Required<BrowserbaseConfig>;
  constructor(
    config: BrowserbaseConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!config.apiKey || /[\r\n]/.test(config.apiKey))
      throw new BrowserProviderError('Browserbase credentials are not configured.');
    const timeoutSeconds = config.timeoutSeconds ?? 1800;
    const region = config.region ?? 'us-west-2';
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 60 ||
      timeoutSeconds > 21600 ||
      !['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1'].includes(region)
    )
      throw new BrowserProviderError('Browserbase region or session timeout is invalid.');
    this.config = {
      ...config,
      projectId: browserIdentifier(config.projectId),
      timeoutSeconds,
      region,
    };
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    // Fixed origin and redirect rejection prevent credential forwarding. No automatic retries.
    try {
      const response = await this.fetcher(`https://api.browserbase.com/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { 'X-BB-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new BrowserProviderError();
      return await response.json();
    } catch {
      // Provider error bodies can contain URLs, account details or credentials.
      throw new BrowserProviderError();
    }
  }

  private session(value: unknown): BrowserSession {
    const data = record(value);
    const metadata = record(data.userMetadata);
    if (
      data.projectId !== this.config.projectId ||
      !['PENDING', 'RUNNING', 'ERROR', 'TIMED_OUT', 'COMPLETED'].includes(String(data.status)) ||
      typeof data.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(data.expiresAt))
    )
      throw new BrowserProviderError('Browser session ownership or schema could not be verified.');
    // Discard connectUrl, signingKey, wsUrl, page titles, URLs and other provider data.
    return {
      id: browserIdentifier(data.id),
      projectId: this.config.projectId,
      contextId: browserIdentifier(data.contextId),
      status: data.status as BrowserSession['status'],
      expiresAt: data.expiresAt,
      attemptId: browserIdentifier(metadata.pogAttemptId),
    };
  }

  async createSession(contextId: string, attemptId: string): Promise<BrowserSession> {
    const result = this.session(
      await this.request('/sessions', {
        projectId: this.config.projectId,
        browserSettings: {
          context: { id: browserIdentifier(contextId), persist: true },
          viewport: { width: 1440, height: 1000 },
          recordSession: false,
          logSession: false,
          solveCaptchas: false,
          advancedStealth: false,
          ignoreCertificateErrors: false,
        },
        timeout: this.config.timeoutSeconds,
        keepAlive: true,
        proxies: false,
        region: this.config.region,
        userMetadata: { pogAttemptId: browserIdentifier(attemptId) },
      }),
    );
    if (result.contextId !== contextId || result.attemptId !== attemptId)
      throw new BrowserProviderError('Browser session binding could not be verified.');
    return result;
  }

  async findSessions(attemptId: string): Promise<BrowserSession[]> {
    const query = `user_metadata['pogAttemptId']:'${browserIdentifier(attemptId)}'`;
    const result = await this.request(`/sessions?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(result)) throw new BrowserProviderError();
    const sessions = result.map((value) => this.session(value));
    if (sessions.some((value) => value.attemptId !== attemptId)) throw new BrowserProviderError();
    return sessions;
  }

  async getSession(id: string): Promise<BrowserSession> {
    const session = this.session(await this.request(`/sessions/${browserIdentifier(id)}`));
    if (session.id !== id) throw new BrowserProviderError();
    return session;
  }

  async liveView(id: string): Promise<string> {
    const data = record(await this.request(`/sessions/${browserIdentifier(id)}/debug`));
    try {
      const url = new URL(String(data.debuggerFullscreenUrl));
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === 'browserbase.com' || url.hostname.endsWith('.browserbase.com'))
      )
        throw new BrowserProviderError();
      return url.href;
    } catch {
      throw new BrowserProviderError('Browser live view URL could not be verified.');
    }
  }

  async releaseSession(id: string): Promise<BrowserSession> {
    const session = this.session(
      await this.request(`/sessions/${browserIdentifier(id)}`, { status: 'REQUEST_RELEASE' }),
    );
    if (session.id !== id) throw new BrowserProviderError();
    return session;
  }
}
