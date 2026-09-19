import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SecretVault } from '../server/security/secret-vault.ts';

test('credentials stay encrypted and are bound to their name and worker role', () => {
  const db = new DatabaseSync(':memory:');
  const vault = new SecretVault(db, Buffer.alloc(32, 7));
  vault.provision('coinbase', 'private-credential', ['settlement']);
  assert.equal(vault.forRole('settlement').read('coinbase'), 'private-credential');
  assert.throws(() => vault.forRole('browser').read('coinbase'));
  assert.ok(
    !JSON.stringify(db.prepare('SELECT * FROM agent_secrets').all()).includes('private-credential'),
  );
  db.exec("UPDATE agent_secrets SET name='different'");
  assert.throws(() => vault.forRole('settlement').read('different'));
  db.close();
});
test('wrong keys, malformed keys and modified permissions cannot decrypt', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => new SecretVault(db, Buffer.alloc(12)));
  const vault = new SecretVault(db, Buffer.alloc(32, 1));
  vault.provision('signer', 'secret', ['claims']);
  assert.throws(() => new SecretVault(db, Buffer.alloc(32, 2)).forRole('claims').read('signer'));
  db.exec(`UPDATE agent_secrets SET roles='["browser"]'`);
  assert.throws(() => vault.forRole('browser').read('signer'));
  db.close();
});

test('closed vault rejects provisioning and previously issued readers', () => {
  const db = new DatabaseSync(':memory:');
  const vault = new SecretVault(db, Buffer.alloc(32, 7));
  vault.provision('key', 'private-value', ['settlement']);
  const reader = vault.forRole('settlement');
  vault.close();
  assert.throws(() => reader.read('key'));
  assert.throws(() => vault.provision('after-close', 'private-value', ['settlement']));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM agent_secrets WHERE name='after-close'").get()!.n,
    0,
  );
  db.close();
});

test('ciphertext tampering fails authentication without releasing plaintext', () => {
  const db = new DatabaseSync(':memory:');
  const vault = new SecretVault(db, Buffer.alloc(32, 9));
  vault.provision('key', 'private-value', ['settlement']);
  const bytes = Buffer.from(
    db.prepare("SELECT ciphertext FROM agent_secrets WHERE name='key'").get()!
      .ciphertext as Uint8Array,
  );
  bytes[0] ^= 1;
  db.prepare("UPDATE agent_secrets SET ciphertext=? WHERE name='key'").run(bytes);
  assert.throws(
    () => vault.forRole('settlement').read('key'),
    (error) => error instanceof Error && !error.message.includes('private-value'),
  );
  db.close();
});

test('the POG dev-wallet key is available only to the treasury worker capability', () => {
  const db = new DatabaseSync(':memory:');
  const vault = new SecretVault(db, Buffer.alloc(32, 4));
  try {
    vault.provision('POG_DEV_WALLET_KEY', 'encrypted-dev-wallet-fixture', ['treasury']);
    assert.equal(
      vault.forRole('treasury').read('POG_DEV_WALLET_KEY'),
      'encrypted-dev-wallet-fixture',
    );
    for (const role of ['claims', 'settlement', 'browser', 'identity'] as const)
      assert.throws(() => vault.forRole(role).read('POG_DEV_WALLET_KEY'));
    assert.doesNotMatch(
      JSON.stringify(db.prepare('SELECT * FROM agent_secrets').all()),
      /encrypted-dev-wallet-fixture/,
    );
  } finally {
    vault.close();
    db.close();
  }
});
