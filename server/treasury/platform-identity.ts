/** Official POG identity is an EVM target on Robinhood Chain. Legacy Solana
 * treasury rows cannot establish this binding. Authentication is performed by
 * the trusted buyback worker; this module validates its public evidence shape. */
export interface PlatformIdentity {
  chain: 'robinhood';
  chainId: 4663;
  address: `0x${string}`;
  devWallet: `0x${string}`;
  tokenCodeHash: `0x${string}`;
  tokenDecimals: number;
  verifiedAt: string;
}
export function validPlatformTarget(target: {
  chainId: number;
  tokenAddress: string;
  devWallet: string;
  tokenCodeHash: string;
  tokenDecimals: number;
}): boolean {
  return (
    target.chainId === 4663 &&
    /^0x[0-9a-fA-F]{40}$/.test(target.tokenAddress) &&
    !/^0x0{40}$/.test(target.tokenAddress) &&
    /^0x[0-9a-fA-F]{40}$/.test(target.devWallet) &&
    !/^0x0{40}$/.test(target.devWallet) &&
    /^0x[0-9a-fA-F]{64}$/.test(target.tokenCodeHash) &&
    !/^0x0{64}$/.test(target.tokenCodeHash) &&
    Number.isInteger(target.tokenDecimals) &&
    target.tokenDecimals >= 0 &&
    target.tokenDecimals <= 36
  );
}
