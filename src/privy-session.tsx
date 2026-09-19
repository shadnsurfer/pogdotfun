import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PrivyProvider, useLinkAccount, useLogin, usePrivy } from '@privy-io/react-auth';
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
  useSignTransaction,
  useWallets,
} from '@privy-io/react-auth/solana';
import { SessionContext } from './auth';
import type { PublicConfig, Session } from './auth';
import { normalizeWalletTransaction } from './wallet-transaction';
import { externalSolanaAddresses, isPogWallet } from './wallet-session-policy';
import { initializeMetaMaskSolana } from './metamask-solana';
import {
  WalletSessionLifecycle,
  walletSessionAction,
  walletSessionRequest,
} from './wallet-session-lifecycle';
import './privy-theme.css';
const solanaRpcs = defaultSolanaRpcsPlugin();
const walletOptions = {
  walletChainType: 'solana-only' as const,
  walletList: ['phantom', 'metamask'] as ('phantom' | 'metamask')[],
};
function SessionBridge({
  children,
  config,
  onSession,
}: {
  children?: ReactNode;
  config: PublicConfig;
  onSession?: (session: Session | null) => void;
}) {
  const { ready, authenticated, user, logout: privyLogout, getAccessToken } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const [error, setError] = useState('');
  const [loginQueued, setLoginQueued] = useState(false);
  const loginIntent = useRef(false);
  const [, redraw] = useState(0);
  const [lifecycle] = useState(() => new WalletSessionLifecycle());
  const loginFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const { login } = useLogin({
    onComplete: () => setError(''),
    onError: () => setError('Wallet sign-in was not completed. You can try again.'),
  });
  const { linkWallet } = useLinkAccount({
    onSuccess: () => setError(''),
    onError: () => setError('Wallet connection was not completed. You can try again.'),
  });
  const verifiedAddresses = externalSolanaAddresses(user?.linkedAccounts ?? []);
  const externalWallets = wallets.filter((wallet) => isPogWallet(wallet.standardWallet.name));
  const generation = lifecycle.observe({
    userId: authenticated ? (user?.id ?? null) : null,
    linkedAddresses: verifiedAddresses,
    connectedAddresses: externalWallets.map(
      (wallet) => `${wallet.standardWallet.name}:${wallet.address}`,
    ),
  });
  const sessionReady = ready && walletsReady && !lifecycle.pending && !loginQueued;
  const walletSession = authenticated && verifiedAddresses.length > 0 && !lifecycle.blocked;
  const connectedWallets = externalWallets.filter((wallet) =>
    verifiedAddresses.includes(wallet.address),
  );
  // Read the provider's current accounts too: Wallet Standard events may precede a React render.
  const providers = [...new Set(externalWallets.map((wallet) => wallet.standardWallet))];
  const providerAccounts = providers.map((wallet) =>
    wallet.accounts
      .map((account) => account.address)
      .sort()
      .join(','),
  );
  const stillConnected = () =>
    providers.every(
      (wallet, index) =>
        wallet.accounts
          .map((account) => account.address)
          .sort()
          .join(',') === providerAccounts[index],
    );
  useEffect(() => {
    mounted.current = true;
    // Also refresh after React's development-only effect cleanup/replay.
    redraw((value) => value + 1);
    return () => {
      mounted.current = false;
      lifecycle.dispose();
    };
  }, [lifecycle]);
  useEffect(() => {
    // Privy's login callback captures the user from its render. Use it only after
    // logout has reached a fresh unauthenticated render, never the old callback.
    if (
      !loginQueued ||
      !loginIntent.current ||
      authenticated ||
      user ||
      !ready ||
      !walletsReady ||
      lifecycle.blocked
    )
      return;
    loginIntent.current = false;
    setLoginQueued(false);
    try {
      login({ loginMethods: ['wallet'], walletChainType: 'solana-only' });
    } catch {
      setError('Wallet connection could not start. Please try again.');
    }
  }, [loginQueued, authenticated, user, ready, walletsReady, lifecycle, login]);
  async function endSession() {
    setError('');
    const operation = lifecycle.logout(wallets, privyLogout);
    redraw((value) => value + 1);
    try {
      await operation;
    } catch (cause) {
      if (mounted.current)
        setError(
          'Wallet sign-out did not finish. Retry sign-out before connecting another wallet.',
        );
      throw cause;
    } finally {
      if (mounted.current) redraw((value) => value + 1);
    }
  }
  function logout() {
    loginIntent.current = false;
    setLoginQueued(false);
    return endSession();
  }
  function startWalletLogin() {
    if (loginFlight.current || loginIntent.current || !ready || !walletsReady || lifecycle.pending)
      return;
    loginIntent.current = true;
    setError('');
    // Clear an old/cancelled provider connection before starting a fresh authentication flow.
    loginFlight.current = endSession()
      .then(() => {
        if (mounted.current && loginIntent.current) setLoginQueued(true);
      })
      .catch(() => {
        loginIntent.current = false;
        if (mounted.current)
          setError(
            'Wallet connection could not start. Retry sign-out, then connect your wallet again.',
          );
      })
      .finally(() => {
        loginFlight.current = null;
      });
  }
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!sessionReady || !walletSession)
      throw new Error('Connect Phantom or MetaMask to continue.');
    return walletSessionRequest<T>(
      lifecycle.capture(generation, stillConnected),
      getAccessToken,
      path,
      init,
    );
  }
  async function sign(transaction: string, address: string) {
    if (!sessionReady || !walletSession)
      throw new Error('Connect Phantom or MetaMask to continue.');
    const scope = lifecycle.capture(generation, stillConnected);
    const wallet = connectedWallets.find((item) => item.address === address);
    if (!wallet || !wallet.standardWallet.accounts.some((account) => account.address === address)) {
      throw new Error('Reconnect the wallet selected for this launch.');
    }
    const original = Uint8Array.from(atob(transaction), (char) => char.charCodeAt(0));
    const { signedTransaction } = await walletSessionAction(scope, () =>
      signTransaction({
        transaction: original,
        wallet,
        chain: 'solana:mainnet',
      }),
    );
    const wire = normalizeWalletTransaction(original, signedTransaction, address);
    return btoa(Array.from(wire, (byte) => String.fromCharCode(byte)).join(''));
  }
  const session: Session = {
    config,
    ready: sessionReady,
    generation,
    authenticated: walletSession,
    userId: walletSession ? (user?.id ?? null) : null,
    wallets: walletSession ? connectedWallets.map((w) => w.address) : [],
    login: () => {
      void startWalletLogin();
    },
    connectWallet: () => {
      if (!sessionReady) return;
      setError('');
      if (!walletSession) {
        startWalletLogin();
        return;
      }
      try {
        lifecycle.capture(generation, stillConnected).assertCurrent();
        linkWallet({
          ...walletOptions,
          description: 'Connect Phantom or MetaMask to your Pog account.',
        });
      } catch {
        setError('Wallet connection could not start. Please try again.');
      }
    },
    logout,
    request,
    sign,
    error,
  };
  // The public app is a stable sibling of the wallet provider. Publish after
  // commit, including changed account/generation guards, before the next paint.
  useLayoutEffect(() => {
    onSession?.(session);
  });
  useLayoutEffect(
    () => () => {
      onSession?.(null);
    },
    [onSession],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
export default function ConnectedServices({
  children,
  config,
  onSession,
}: {
  children?: ReactNode;
  config: PublicConfig & { privyAppId: string };
  onSession?: (session: Session | null) => void;
}) {
  const [connectors, setConnectors] = useState<ReturnType<typeof toSolanaWalletConnectors> | null>(
    null,
  );
  const [connectorError, setConnectorError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    initializeMetaMaskSolana().then(
      () => {
        if (active) setConnectors(toSolanaWalletConnectors({ shouldAutoConnect: false }));
      },
      () => {
        if (active) setConnectorError(new Error('Wallet connection could not load.'));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (connectorError) throw connectorError;
  if (!connectors) return children ?? null;
  return (
    <PrivyProvider
      appId={config.privyAppId}
      config={{
        plugins: [solanaRpcs],
        appearance: {
          ...walletOptions,
          theme: '#16161a',
          accentColor: '#53fc18',
          logo: <img src="/assets/brand/mark.svg" alt="Pog" className="pog-privy-logo" />,
          landingHeader: 'Connect wallet',
          loginMessage: 'Connect Phantom or MetaMask to continue.',
          showWalletLoginFirst: true,
        },
        loginMethods: ['wallet'],
        externalWallets: { solana: { connectors } },
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
      }}
    >
      <SessionBridge config={config} onSession={onSession}>
        {children}
      </SessionBridge>
    </PrivyProvider>
  );
}
