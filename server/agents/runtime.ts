import type { DatabaseSync } from 'node:sqlite';
import type { PumpSolanaProvider } from '../providers/pump-solana.ts';
import { CoinbaseProvider } from '../providers/coinbase.ts';
import {
  CoinbaseCardReadiness,
  type CoinbaseCardEvidenceSource,
} from '../providers/coinbase-card.ts';
import { KickCheckoutDriver, type KickSelectorContract } from '../providers/kick-checkout.ts';
import type { StreamerLiveGate } from '../workers/streamer-live.ts';
import {
  AgentBrowserRunner,
  type AgentBrowserOptions,
  type BrowserGiftAccount,
} from './browser.ts';
import { createCoinbaseSettlement, type CoinbaseSettlementRoute } from './settlement.ts';
import { solanaSettlementTransfer } from './solana-transfer.ts';
import type { FeeLot, PipelineAdapters } from './pipeline.ts';
export type FeeRouteCandidate = Pick<FeeLot, 'chain' | 'recipient'>;
export type WorkerRuntimeAdapters = PipelineAdapters & {
  feeRouteReady(candidate: FeeRouteCandidate): boolean;
};

/** Provider-specific evidence readers are trusted application code. No public evidence ingestion. */
export interface WorkerIntegrations {
  cardEvidence: CoinbaseCardEvidenceSource;
  readGiftEvidence: NonNullable<AgentBrowserOptions['readEvidence']>;
  kickContract?: KickSelectorContract;
  routes?: Partial<Record<'bnb' | 'robinhood', CoinbaseSettlementRoute>>;
}
export function autonomousRuntime(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv,
  provider: () => PumpSolanaProvider,
  liveGate: StreamerLiveGate,
  integrations?: WorkerIntegrations,
): WorkerRuntimeAdapters | undefined {
  // Deployment bindings may be JavaScript: TypeScript interfaces alone cannot
  // prevent funding a route whose independent evidence readers are missing.
  if (
    !integrations ||
    typeof integrations !== 'object' ||
    Array.isArray(integrations) ||
    typeof integrations.readGiftEvidence !== 'function' ||
    !integrations.cardEvidence ||
    typeof integrations.cardEvidence.readBalance !== 'function' ||
    typeof integrations.cardEvidence.readCharge !== 'function' ||
    !env.POG_COINBASE_KEY_NAME ||
    !env.POG_COINBASE_PRIVATE_KEY ||
    !env.BROWSERBASE_API_KEY ||
    !env.BROWSERBASE_PROJECT_ID ||
    !env.POG_COINBASE_ACCOUNT_ID ||
    !env.POG_COINBASE_SOL_ADDRESS
  )
    return undefined;
  const accounts: Partial<Record<'twitch' | 'kick', BrowserGiftAccount>> = {};
  for (const platform of ['twitch', 'kick'] as const) {
    const prefix = `POG_${platform.toUpperCase()}`;
    if (
      env[`${prefix}_ACCOUNT_ID`] &&
      env[`${prefix}_CONTEXT_ID`] &&
      env.POG_CARD_ACCOUNT_ID &&
      env.POG_CARD_LAST4
    ) {
      accounts[platform] = {
        accountId: env[`${prefix}_ACCOUNT_ID`]!,
        contextId: env[`${prefix}_CONTEXT_ID`]!,
        cardAccountId: env.POG_CARD_ACCOUNT_ID,
        cardLast4: env.POG_CARD_LAST4,
        giftUnits: Number(env.POG_GIFT_UNITS ?? 10),
        maxSpendUsdCents: Number(env.POG_MAX_GIFT_USD_CENTS ?? 50000),
      };
    }
  }
  const browser = new AgentBrowserRunner(db, {
    browserbase: { apiKey: env.BROWSERBASE_API_KEY, projectId: env.BROWSERBASE_PROJECT_ID },
    accounts,
    liveGate,
    readEvidence: integrations.readGiftEvidence,
    kickContract: integrations.kickContract,
  });
  const coinbase = new CoinbaseProvider({
    getCredentials: async () => ({
      keyName: env.POG_COINBASE_KEY_NAME!,
      privateKey: env.POG_COINBASE_PRIVATE_KEY!,
    }),
  });
  const settlement = createCoinbaseSettlement(db, {
    coinbase,
    routes: {
      solana: {
        accountId: env.POG_COINBASE_ACCOUNT_ID,
        address: env.POG_COINBASE_SOL_ADDRESS,
        asset: 'SOL',
        network: 'solana',
      },
      ...integrations.routes,
    },
    transfer: solanaSettlementTransfer(db, provider),
    card: new CoinbaseCardReadiness(integrations.cardEvidence),
    cardAccounts: { twitch: accounts.twitch?.cardAccountId, kick: accounts.kick?.cardAccountId },
    browser,
    live: async (lot) => {
      try {
        await liveGate.requireLive(lot.recipient);
        return true;
      } catch {
        return false;
      }
    },
  });
  const kickDriver = new KickCheckoutDriver(integrations.kickContract);
  const feeRouteReady = (candidate: FeeRouteCandidate) => {
    const account = accounts[candidate.recipient.platform];
    if (
      !account ||
      !/^[a-z0-9_]{3,25}$/.test(account.accountId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(account.contextId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(account.cardAccountId) ||
      !/^\d{4}$/.test(account.cardLast4) ||
      !Number.isSafeInteger(account.giftUnits) ||
      account.giftUnits < 1 ||
      account.giftUnits > 100 ||
      !Number.isSafeInteger(account.maxSpendUsdCents) ||
      account.maxSpendUsdCents < 1
    )
      return false;
    if (candidate.recipient.platform === 'kick' && !kickDriver.configured()) return false;
    if (candidate.chain !== 'solana') {
      const route = integrations.routes?.[candidate.chain];
      if (
        !route?.bridgeTransfer ||
        !route.accountId ||
        !route.address ||
        !route.network ||
        !/^[A-Z0-9]{2,12}$/.test(route.asset) ||
        typeof route.bridgeTransfer.send !== 'function' ||
        typeof route.bridgeTransfer.reconcile !== 'function'
      )
        return false;
    }
    return true;
  };
  return {
    ...settlement,
    feeRouteReady,
    async deposit(lot) {
      if (!feeRouteReady(lot)) throw new Error('Recipient funding route is not configured.');
      return settlement.deposit(lot);
    },
  };
}
