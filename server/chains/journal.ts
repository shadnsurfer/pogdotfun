import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionJournal, JournalRecord } from './execution.ts';

/** Local durable journal. A crash-held lock fails closed until investigated and removed. */
export class FileExecutionJournal implements ExecutionJournal {
  constructor(private readonly directory: string) {}
  private name(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  async exclusive<T>(scope: string, run: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, `${this.name(scope)}.lock`);
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Chain signer is locked; reconcile prior worker before retrying');
      throw error;
    }
    try {
      return await run();
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  async get(id: string): Promise<JournalRecord | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.directory, `${this.name(id)}.json`), 'utf8'),
      ) as JournalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async put(id: string, record: JournalRecord) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${this.name(id)}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const dir = await open(this.directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

/** Persisted lock rows intentionally survive a process crash. No automatic expiry. */
export class SqliteExecutionJournal implements ExecutionJournal {
  constructor(private readonly db: import('node:sqlite').DatabaseSync) {
    db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS chain_execution_journal(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_execution_locks(scope TEXT PRIMARY KEY, owner TEXT NOT NULL);`);
  }
  async exclusive<T>(scope: string, run: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const result = this.db
      .prepare('INSERT OR IGNORE INTO chain_execution_locks(scope,owner) VALUES (?,?)')
      .run(scope, owner);
    if (!result.changes)
      throw new Error('Chain signer is locked; reconcile prior worker before retrying');
    try {
      return await run();
    } finally {
      this.db
        .prepare('DELETE FROM chain_execution_locks WHERE scope=? AND owner=?')
        .run(scope, owner);
    }
  }
  async get(id: string): Promise<JournalRecord | undefined> {
    const row = this.db.prepare('SELECT payload FROM chain_execution_journal WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.payload)) as JournalRecord) : undefined;
  }
  async put(id: string, record: JournalRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO chain_execution_journal(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(id, JSON.stringify(record));
  }
}
