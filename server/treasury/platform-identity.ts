import bs58 from 'bs58';
import { publicAddresses } from './public-addresses.ts';

/** Public shape of the verified Solana $POG mint and buyback wallet. */
export interface PlatformIdentity {
  chain: 'solana';
  address: string;
  devWallet: string;
  tokenProgramId: string;
  tokenDecimals: number;
  verifiedAt: string;
}

export function validSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bytes.some((byte) => byte !== 0) && bs58.encode(bytes) === value;
  } catch {
    return false;
  }
}

export function validPlatformTarget(target: {
  chain: string;
  mintAddress: string;
  devWallet: string;
  tokenProgramId: string;
  tokenDecimals: number;
}): boolean {
  return (
    target.chain === 'solana' &&
    validSolanaAddress(target.mintAddress) &&
    target.devWallet === publicAddresses.buybackWallet &&
    validSolanaAddress(target.tokenProgramId) &&
    Number.isInteger(target.tokenDecimals) &&
    target.tokenDecimals >= 0 &&
    target.tokenDecimals <= 18
  );
}
