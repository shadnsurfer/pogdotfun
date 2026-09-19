import { PrivyClient } from '@privy-io/node';

export class PublicError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface PublicPrincipal {
  userId: string;
  walletAddresses: string[];
}
export interface IdentityProvider {
  verify(token: string): Promise<string>;
  getUser(id: string): Promise<{ id: string; linked_accounts: unknown[] }>;
}
export function createPublicIdentity(provider?: IdentityProvider, env = process.env) {
  let configured = provider;
  if (!configured && env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
    const client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
    configured = {
      verify: async (token) => (await client.utils().auth().verifyAccessToken(token)).user_id,
      getUser: (id) => client.users()._get(id, { timeout: 10_000, maxRetries: 0 }),
    };
  }
  return {
    configured: !!configured,
    async authorize(header: string | undefined): Promise<PublicPrincipal> {
      if (!header || header.length > 8192 || !/^Bearer [A-Za-z0-9._~-]+$/.test(header))
        throw new PublicError(401, 'Connect your wallet to continue.');
      if (!configured) throw new PublicError(503, 'Wallet sign-in is not connected yet.');
      let userId: string;
      try {
        userId = await configured.verify(header.slice(7));
      } catch {
        throw new PublicError(
          401,
          'Your wallet sign-in has expired or is invalid. Please reconnect your wallet.',
        );
      }
      try {
        const user = await configured.getUser(userId);
        if (!userId.startsWith('did:privy:') || user.id !== userId) throw Error('subject mismatch');
        const walletAddresses = user.linked_accounts.flatMap((account) => {
          const a = account as Record<string, unknown>;
          // Privy external wallet brands and connector types are optional. Exclude
          // embedded accounts without treating a client-reported brand as ownership proof.
          return a?.type === 'wallet' &&
            a.chain_type === 'solana' &&
            typeof a.address === 'string' &&
            a.address.length > 0 &&
            a.connector_type !== 'embedded' &&
            a.wallet_client_type !== 'privy' &&
            a.wallet_client_type !== 'privy-v2' &&
            a.wallet_client !== 'privy' &&
            a.wallet_client !== 'privy-v2'
            ? [a.address]
            : [];
        });
        if (!walletAddresses.length)
          throw new PublicError(403, 'Connect and verify an external Solana wallet to continue.');
        return { userId, walletAddresses: [...new Set(walletAddresses)] };
      } catch (error) {
        if (error instanceof PublicError) throw error;
        throw new PublicError(503, 'We could not verify your wallet account. Please try again.');
      }
    },
  };
}
