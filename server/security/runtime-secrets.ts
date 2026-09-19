import type { DatabaseSync } from 'node:sqlite';
import { SecretVault, type AgentRole } from './secret-vault.ts';
const credentials: Record<string, AgentRole> = {
  TWITCH_CLIENT_ID: 'identity',
  TWITCH_CLIENT_SECRET: 'identity',
  KICK_CLIENT_ID: 'identity',
  KICK_CLIENT_SECRET: 'identity',
  PRIVY_APP_SECRET: 'identity',
  PINATA_JWT: 'identity',
  PINATA_API_KEY: 'identity',
  PINATA_API_SECRET: 'identity',
  BROWSERBASE_API_KEY: 'browser',
  POG_COINBASE_KEY_NAME: 'settlement',
  POG_COINBASE_PRIVATE_KEY: 'settlement',
  POG_LAUNCH_ENCRYPTION_KEY: 'claims',
  POG_SOLANA_RPC_URL: 'claims',
};
/** Inject the wrapping key through a workload secret manager. Runtime secrets never enter public configuration. */
export function runtimeSecrets(db: DatabaseSync, configuration: NodeJS.ProcessEnv) {
  const env = { ...configuration };
  const key = env.POG_VAULT_KEY;
  for (const name of Object.keys(credentials)) {
    if (env[name])
      throw new Error(`Credential ${name} must be provisioned in the encrypted worker vault.`);
  }
  if (!key) return { env, vault: undefined };
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Invalid vault wrapping key.');
  const vault = new SecretVault(db, Buffer.from(key, 'hex'));
  for (const [name, role] of Object.entries(credentials)) {
    try {
      env[name] = vault.forRole(role).read(name);
    } catch {
      /* Unconfigured integrations remain disabled. */
    }
  }
  delete env.POG_VAULT_KEY;
  return { env, vault };
}
