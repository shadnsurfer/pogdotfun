import {
  Component,
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { nextCatalogRefreshMs, refreshCatalog } from './data';
import { startCatalogPolling } from './catalog-polling';
export interface PublicConfig {
  privyAppId: string | null;
  launchesEnabled: boolean;
  chain: 'solana:mainnet';
  providers: { twitch: boolean; kick: boolean };
}
export interface Session {
  config: PublicConfig | null;
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  generation: number;
  wallets: string[];
  login: () => void;
  connectWallet: () => void;
  logout: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  sign: (transaction: string, address: string) => Promise<string>;
  error: string;
}
const unavailable = async (): Promise<never> => {
  throw new Error('Wallet connection is temporarily unavailable.');
};
const fallback: Session = {
  config: null,
  ready: false,
  authenticated: false,
  userId: null,
  generation: 0,
  wallets: [],
  login: () => {},
  connectWallet: () => {},
  logout: unavailable,
  request: unavailable,
  sign: unavailable,
  error: '',
};
export const SessionContext = createContext<Session>(fallback);
export const useSession = () => useContext(SessionContext);
const ConnectedServices = lazy(() => import('./privy-session'));

// Only the visible outlet subscribes. Publishing wallet state must not render
// the wallet runtime again or replace the app while its providers initialize.
function createSessionFeed() {
  let session: Session | null = null;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => session,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (next: Session | null) => {
      if (session === next) return;
      session = next;
      for (const listener of listeners) listener();
    },
  };
}
function SessionOutlet({
  feed,
  unavailableSession,
  children,
}: {
  feed: ReturnType<typeof createSessionFeed>;
  unavailableSession: Session;
  children: ReactNode;
}) {
  const session = useSyncExternalStore(feed.subscribe, feed.snapshot, () => null);
  return (
    <SessionContext.Provider value={session ?? unavailableSession}>
      {children}
    </SessionContext.Provider>
  );
}
class WalletBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function PublicServices({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [feed] = useState(createSessionFeed);
  const walletFailed = useCallback(() => {
    feed.publish(null);
    setError(
      'The wallet service could not load. Refresh the page to retry; the public catalog remains available.',
    );
  }, [feed]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Wallet service is temporarily unavailable.');
        const value = await response.json();
        if (!controller.signal.aborted) setConfig(value);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    const polling = startCatalogPolling({
      visible: () => !document.hidden,
      refresh: refreshCatalog,
      delay: nextCatalogRefreshMs,
    });
    const refreshVisibleCatalog = polling.wake;
    window.addEventListener('focus', refreshVisibleCatalog);
    document.addEventListener('visibilitychange', refreshVisibleCatalog);
    return () => {
      controller.abort();
      polling.stop();
      window.removeEventListener('focus', refreshVisibleCatalog);
      document.removeEventListener('visibilitychange', refreshVisibleCatalog);
    };
  }, []);
  const unavailableSession: Session = {
    ...fallback,
    config,
    ready: loaded && (!config?.privyAppId || Boolean(error)),
    error:
      error || (loaded && !config?.privyAppId ? 'Wallet connection is not available yet.' : ''),
  };
  return (
    <>
      <SessionOutlet feed={feed} unavailableSession={unavailableSession}>
        {children}
      </SessionOutlet>
      {config?.privyAppId && (
        <WalletBoundary onError={walletFailed}>
          <Suspense fallback={null}>
            <ConnectedServices
              config={{ ...config, privyAppId: config.privyAppId }}
              onSession={feed.publish}
            />
          </Suspense>
        </WalletBoundary>
      )}
    </>
  );
}
