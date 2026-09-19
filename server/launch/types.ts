import type { Keypair } from '@solana/web3.js';

export class LaunchError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface LaunchPrincipal {
  userId: string;
  walletAddress?: string;
  walletAddresses?: string[];
}
/** These values come from the authenticated upload/streamer services, never unchecked browser fields. */
export interface VerifiedLaunchInput {
  requestId: string;
  name: string;
  symbol: string;
  description: string;
  walletAddress: string;
  metadataUri: string;
  imageUri: string;
  /** Optional SOL purchase in lamports, included atomically with token creation. */
  initialBuyLamports?: string;
  website?: string;
  twitter?: string;
  recipient: {
    id: string;
    platform: 'twitch' | 'kick';
    username: string;
    channelUrl: string;
    verified: true;
    verifiedAt: string;
  };
}
export type LaunchStatus =
  'preparing' | 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'review';
export interface LaunchPlan extends VerifiedLaunchInput {
  launchId: string;
  mint: string;
  creatorAddress: string;
}
export interface PreparedLaunch {
  transaction: string;
  message: string;
  blockhash: string;
  lastValidBlockHeight: number;
  networkFeeLamports: string;
  creatorReserveLamports: string;
  estimatedTotalLamports: string;
}
export interface LaunchRecord extends LaunchPlan {
  userId: string;
  status: LaunchStatus;
  createdAt: string;
  updatedAt: string;
  prepared?: PreparedLaunch;
  signedTransaction?: string;
  signature?: string;
  tokenId?: string;
  slot?: number;
  error?: string;
}
export type LaunchChainResult =
  | { status: 'pending' | 'review' | 'failed'; error?: string }
  | { status: 'confirmed'; slot: number };
export interface LaunchChain {
  prepare(plan: LaunchPlan, mint: Keypair, signal?: AbortSignal): Promise<PreparedLaunch>;
  broadcast(signedTransaction: string, signature: string, signal?: AbortSignal): Promise<void>;
  reconcile(record: LaunchRecord, signal?: AbortSignal): Promise<LaunchChainResult>;
}
