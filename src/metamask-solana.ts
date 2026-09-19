let initialization: Promise<void> | undefined;

/** Register MetaMask before constructing Privy's Solana wallet connectors. */
export function initializeMetaMaskSolana(): Promise<void> {
  // Avoid importing the browser wallet SDK during server rendering.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve();
  }

  initialization ??= import('@metamask/connect-solana')
    .then(async ({ createSolanaClient }) => {
      const client = await createSolanaClient({
        dapp: {
          name: 'Pog',
          url: window.location.origin,
          iconUrl: new URL('/assets/brand/mark.svg', window.location.origin).href,
        },
        api: { supportedNetworks: { mainnet: 'https://api.mainnet-beta.solana.com' } },
        analytics: { enabled: false },
        // The SDK's automatic registration is deferred until after creation resolves.
        skipAutoRegister: true,
      });
      await client.registerWallet();
    })
    .catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });

  return initialization;
}
