import {
  BrowserProviderError,
  browserIdentifier,
  type BrowserSession,
  type BrowserSessionProvider,
} from './browserbase.ts';
import {
  TESTING_CAP_USD_CENTS,
  TestingBudget,
  TestingBudgetError,
} from '../workers/testing-budget.ts';

export interface BrowserCostConfig {
  /** Reviewed maximum USD cost of one session at the underlying provider's
   * configured timeout, including rounding/tax. No pricing or plan is inferred. */
  maxSessionCostUsdCents: number;
  actor?: string;
}

/** Produced only before any provider create call and after checking durable
 * budget state. Generic provider errors must never be converted to this signal. */
export class BrowserCreationNotStartedError extends BrowserProviderError {
  constructor() {
    super('The testing budget cap prevents browser creation. No provider request was sent.');
  }
}

/** Gates billable provisioning only. Session completion is not billing evidence. */
export class BudgetedBrowserProvider implements BrowserSessionProvider {
  private readonly actor: string;
  constructor(
    private readonly provider: BrowserSessionProvider,
    private readonly budget: TestingBudget,
    private readonly config: BrowserCostConfig,
  ) {
    if (
      !Number.isSafeInteger(config.maxSessionCostUsdCents) ||
      config.maxSessionCostUsdCents < 1 ||
      config.maxSessionCostUsdCents > TESTING_CAP_USD_CENTS
    )
      throw new BrowserProviderError(
        'A reviewed positive integer session cost ceiling is required.',
      );
    this.actor = config.actor ?? 'browser-provider';
  }

  private matching(session: BrowserSession, contextId: string, attemptId: string) {
    if (session.contextId !== contextId || session.attemptId !== attemptId)
      throw new BrowserProviderError('Reconcile the original browser attempt and context.');
    browserIdentifier(session.id);
    return session;
  }

  async createSession(contextId: string, attemptId: string): Promise<BrowserSession> {
    browserIdentifier(contextId);
    browserIdentifier(attemptId);
    const operationId = `browser:${attemptId}`;
    let gate: ReturnType<TestingBudget['begin']>;
    try {
      this.budget.reserve(
        { operationId, kind: 'browser_fee', maxUsdCents: this.config.maxSessionCostUsdCents },
        this.actor,
      );
      gate = this.budget.begin(operationId, `browser-create:${attemptId}`, this.actor);
    } catch (error) {
      let neverAuthorized = false;
      try {
        const saved = this.budget.get(operationId);
        neverAuthorized = !saved || (saved.state === 'reserved' && !saved.attemptId);
      } catch {
        // An unreadable journal is not proof that a paid request never started.
      }
      if (neverAuthorized) throw new BrowserCreationNotStartedError();
      if (error instanceof TestingBudgetError) throw error;
      throw new BrowserProviderError('Reconcile the original browser attempt and its held cost.');
    }
    if (!gate.execute) {
      try {
        const existing = await this.provider.findSessions(attemptId);
        if (existing.length !== 1) throw new BrowserProviderError();
        return this.matching(existing[0], contextId, attemptId);
      } catch {
        throw new BrowserProviderError(
          'Reconcile the original browser attempt. Its cost remains held; a replacement session is not authorized.',
        );
      }
    }
    // begin has committed the unresolved cost before this sole paid request.
    // Even a response lost before the provider accepted it cannot authorize a retry.
    try {
      return this.matching(
        await this.provider.createSession(contextId, attemptId),
        contextId,
        attemptId,
      );
    } catch {
      throw new BrowserProviderError(
        'Browser creation outcome is unknown. Reconcile the original attempt before continuing.',
      );
    }
  }

  getSession(id: string) {
    return this.provider.getSession(id);
  }
  findSessions(attemptId: string) {
    return this.provider.findSessions(attemptId);
  }
  liveView(id: string) {
    return this.provider.liveView(id);
  }
  releaseSession(id: string) {
    return this.provider.releaseSession(id);
  }
}
