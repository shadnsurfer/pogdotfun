/** Keep legacy embedded/social accounts out of the external-wallet launch flow. */
export function externalSolanaAddresses(accounts: readonly unknown[]): string[] {
  return [
    ...new Set(
      accounts.flatMap((account) => {
        if (!account || typeof account !== 'object') return [];
        const a = account as Record<string, unknown>;
        return a.type === 'wallet' &&
          a.chainType === 'solana' &&
          typeof a.address === 'string' &&
          a.address.length > 0 &&
          a.connectorType !== 'embedded' &&
          a.walletClientType !== 'privy' &&
          a.walletClientType !== 'privy-v2'
          ? [a.address]
          : [];
      }),
    ),
  ];
}

export function isPogWallet(name: string): boolean {
  return name.toLowerCase() === 'phantom' || name.toLowerCase() === 'metamask';
}
