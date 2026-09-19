import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AgentRole = 'claims' | 'treasury' | 'settlement' | 'browser' | 'identity';
export interface SecretReader {
  read(name: string): string;
}
const roles = new Set<AgentRole>(['claims', 'treasury', 'settlement', 'browser', 'identity']);

/** Only the process composition root owns this object. Workers receive scoped readers.
 * AES-GCM binds ciphertext to name and role policy. The wrapping key is injected
 * by the service's secret manager and must never be kept beside this database.
 */
export class SecretVault {
  #key: Buffer;
  #closed = false;
  constructor(
    private readonly db: DatabaseSync,
    key: Uint8Array,
  ) {
    if (key.length !== 32) throw new Error('Vault requires a 32-byte wrapping key.');
    this.#key = Buffer.from(key);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_secrets (
      name TEXT PRIMARY KEY, roles TEXT NOT NULL, nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL, tag BLOB NOT NULL
    )`);
  }
  /** Provisioning API is deliberately absent from HTTP and worker capabilities. */
  provision(name: string, value: string, allowedRoles: readonly AgentRole[]) {
    if (this.#closed) throw new Error('Vault is closed.');
    if (
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(name) ||
      !value ||
      !allowedRoles.length ||
      allowedRoles.some((role) => !roles.has(role))
    )
      throw new Error('Invalid credential policy.');
    const policy = JSON.stringify([...new Set(allowedRoles)].sort());
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`pog:v1:${name}:${policy}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db
      .prepare(
        `INSERT INTO agent_secrets VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
      roles=excluded.roles, nonce=excluded.nonce, ciphertext=excluded.ciphertext, tag=excluded.tag`,
      )
      .run(name, policy, nonce, encrypted, cipher.getAuthTag());
  }
  forRole(role: AgentRole): SecretReader {
    if (!roles.has(role)) throw new Error('Invalid worker role.');
    return Object.freeze({
      read: (name: string) => {
        try {
          if (this.#closed) throw new Error();
          const row = this.db.prepare('SELECT * FROM agent_secrets WHERE name=?').get(name);
          if (!row || !(JSON.parse(String(row.roles)) as string[]).includes(role))
            throw new Error();
          const decipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce as Uint8Array);
          decipher.setAAD(Buffer.from(`pog:v1:${name}:${String(row.roles)}`));
          decipher.setAuthTag(row.tag as Uint8Array);
          return Buffer.concat([
            decipher.update(row.ciphertext as Uint8Array),
            decipher.final(),
          ]).toString('utf8');
        } catch {
          throw new Error('Worker credential unavailable.');
        }
      },
    });
  }
  close() {
    this.#closed = true;
    this.#key.fill(0);
  }
}
