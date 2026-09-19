export interface DisconnectableSolanaWallet {
  standardWallet: {
    name?: string;
    isPrivyWallet?: boolean;
    accounts?: readonly { address: string }[];
  };
  disconnect(): Promise<void>;
}

class WalletCleanupError extends Error {
  constructor(readonly pendingWallets: readonly DisconnectableSolanaWallet[]) {
    super('Wallet sign-out did not finish. Retry sign-out before connecting another wallet.');
    this.name = 'WalletCleanupError';
  }
}

/** Authentication and Wallet Standard connections have separate lifetimes in Privy. */
export async function disconnectWalletSession(
  wallets: readonly DisconnectableSolanaWallet[],
  logout: () => Promise<void>,
): Promise<void> {
  const distinct = [
    ...new Map(
      wallets
        .filter(
          (wallet) =>
            wallet.standardWallet.isPrivyWallet !== true &&
            wallet.standardWallet.name?.toLowerCase() !== 'privy',
        )
        .map((wallet) => [wallet.standardWallet, wallet]),
    ).values(),
  ];
  const results = await Promise.allSettled(
    distinct.map(async (wallet) => {
      await wallet.disconnect();
      if (wallet.standardWallet.accounts?.length) throw new Error('Wallet remained connected.');
    }),
  );
  const pending = distinct.filter((_, index) => results[index].status === 'rejected');
  // Revoke authentication even when an extension refuses to disconnect.
  let logoutFailed = false;
  try {
    await logout();
  } catch {
    logoutFailed = true;
  }
  if (pending.length || logoutFailed) throw new WalletCleanupError(pending);
}

export interface WalletSessionIdentity {
  userId: string | null;
  linkedAddresses: readonly string[];
  connectedAddresses: readonly string[];
}
export interface WalletSessionScope {
  signal: AbortSignal;
  assertCurrent(): void;
}
export class WalletSessionChangedError extends Error {
  constructor() {
    super('Your wallet session changed. Reopen this action with the connected wallet.');
    this.name = 'WalletSessionChangedError';
  }
}

/** Synchronous revocation also protects promises created by a previous React render. */
export class WalletSessionLifecycle {
  #generation = 0;
  #identity = '';
  #userId: string | null = null;
  #revokedUserId: string | null = null;
  #controller = new AbortController();
  #pending: Promise<void> | null = null;
  #cleanupRequired = false;
  #pendingWallets: readonly DisconnectableSolanaWallet[] = [];

  get generation() {
    return this.#generation;
  }
  get pending() {
    return this.#pending !== null;
  }
  get blocked() {
    return this.pending || this.#cleanupRequired || this.#revokedUserId !== null;
  }
  observe(identity: WalletSessionIdentity): number {
    const key = JSON.stringify([
      identity.userId,
      [...new Set(identity.linkedAddresses)].sort(),
      [...new Set(identity.connectedAddresses)].sort(),
    ]);
    if (key !== this.#identity) {
      this.#identity = key;
      this.#invalidate();
    }
    this.#userId = identity.userId;
    if (identity.userId !== this.#revokedUserId) this.#revokedUserId = null;
    return this.generation;
  }
  #invalidate() {
    this.#generation++;
    this.#controller.abort(new WalletSessionChangedError());
    this.#controller = new AbortController();
  }
  capture(generation: number, stillConnected: () => boolean = () => true): WalletSessionScope {
    const signal = this.#controller.signal;
    const assertCurrent = () => {
      if (
        generation !== this.generation ||
        signal.aborted ||
        this.blocked ||
        !this.#userId ||
        !stillConnected()
      ) {
        throw new WalletSessionChangedError();
      }
    };
    assertCurrent();
    return { signal, assertCurrent };
  }
  logout(
    wallets: readonly DisconnectableSolanaWallet[],
    logout: () => Promise<void>,
  ): Promise<void> {
    if (this.#pending) return this.#pending;
    this.#cleanupRequired = true;
    this.#revokedUserId = this.#userId;
    this.#invalidate();
    // A failed disconnect must remain retryable even after Privy clears its account list.
    const targets = [...this.#pendingWallets, ...wallets];
    this.#pending = Promise.resolve()
      .then(() => disconnectWalletSession(targets, logout))
      .then(
        () => {
          this.#pendingWallets = [];
          this.#cleanupRequired = false;
        },
        (error: unknown) => {
          this.#pendingWallets =
            error instanceof WalletCleanupError ? error.pendingWallets : targets;
          throw error;
        },
      )
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }
  dispose() {
    this.#invalidate();
  }
}

export async function walletSessionRequest<T>(
  scope: WalletSessionScope,
  getAccessToken: () => Promise<string | null>,
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  scope.assertCurrent();
  const token = await getAccessToken();
  scope.assertCurrent();
  if (!token) throw new Error('Connect your wallet to continue.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const signal = init.signal ? AbortSignal.any([init.signal, scope.signal]) : scope.signal;
  const response = await fetcher(path, { ...init, headers, signal });
  scope.assertCurrent();
  const result = await response
    .json()
    .catch(() => ({ error: 'The service returned an unreadable response.' }));
  scope.assertCurrent();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}

export async function walletSessionAction<T>(
  scope: WalletSessionScope,
  action: () => Promise<T>,
): Promise<T> {
  scope.assertCurrent();
  const result = await action();
  scope.assertCurrent();
  return result;
}
