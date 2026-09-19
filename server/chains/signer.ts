import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { EncryptedSignerProvider } from './execution.ts';
import { assertAddress, equalAddress } from './execution.ts';

/** Inject a claims-scoped vault reader; decrypt only for the duration of signing. */
export function createVaultEvmSigner(
  reader: { read(name: string): string },
  secretName: string,
  expectedAddress: Address,
): EncryptedSignerProvider {
  assertAddress(expectedAddress);
  return {
    address: expectedAddress,
    async signTransaction(transaction) {
      const key = reader.read(secretName);
      if (!/^0x[0-9a-fA-F]{64}$/.test(key))
        throw new Error('Invalid encrypted EVM signer credential');
      const account = privateKeyToAccount(key as Hex);
      if (!equalAddress(account.address, expectedAddress))
        throw new Error('Vault signer address does not match policy');
      return account.signTransaction(transaction);
    },
  };
}
