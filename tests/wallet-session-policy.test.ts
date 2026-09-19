import assert from 'node:assert/strict';
import test from 'node:test';
import { externalSolanaAddresses, isPogWallet } from '../src/wallet-session-policy.ts';

test('legacy social accounts and embedded wallets cannot become a Pog wallet session', () => {
  assert.deepEqual(
    externalSolanaAddresses([
      { type: 'email', address: 'person@example.com' },
      { type: 'wallet', chainType: 'solana', address: 'embedded', connectorType: 'embedded' },
      { type: 'wallet', chainType: 'solana', address: 'privy', walletClientType: 'privy-v2' },
      { type: 'wallet', chainType: 'ethereum', address: 'evm', walletClientType: 'metamask' },
    ]),
    [],
  );
});

test('only verified external Solana accounts supply launch addresses', () => {
  assert.deepEqual(
    externalSolanaAddresses([
      { type: 'wallet', chainType: 'solana', address: 'phantom', walletClientType: 'phantom' },
      { type: 'wallet', chainType: 'solana', address: 'metamask', walletClientType: 'metamask' },
      { type: 'wallet', chainType: 'solana', address: 'phantom', walletClientType: 'phantom' },
      { type: 'wallet', chainType: 'solana', address: '' },
      null,
    ]),
    ['phantom', 'metamask'],
  );
  assert.equal(isPogWallet('Phantom'), true);
  assert.equal(isPogWallet('MetaMask'), true);
  assert.equal(isPogWallet('Solflare'), false);
  assert.equal(isPogWallet('Privy'), false);
});
