import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalFeeLot,
  NATIVE_STREAMER_VERSION,
  type AutonomousPipeline,
  type FeeLot,
} from './pipeline.ts';

export interface NativeFeeSplit {
  version: typeof NATIVE_STREAMER_VERSION;
  original: FeeLot;
  streamer: FeeLot;
  buyback: FeeLot | null;
  createdAt: string;
}

/** Trusted finalized fee intake only. The pipeline must use this same database,
 * so allocation, streamer intake, and buyback outbox commit as one transaction.
 * Acknowledgement means durable buyback worker intake, never a completed buy/burn.
 */
export function createNativeFeeRouter(
  db: DatabaseSync,
  pipeline: Pick<AutonomousPipeline, 'recordClaim'>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_native_fee_splits (
  id TEXT PRIMARY KEY, claim_identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS agent_native_buyback_outbox (
  id TEXT PRIMARY KEY, split_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, acknowledged_at TEXT
 );
 CREATE TRIGGER IF NOT EXISTS agent_native_splits_no_update BEFORE UPDATE ON agent_native_fee_splits BEGIN SELECT RAISE(ABORT,'immutable native split'); END;
 CREATE TRIGGER IF NOT EXISTS agent_native_splits_no_delete BEFORE DELETE ON agent_native_fee_splits BEGIN SELECT RAISE(ABORT,'immutable native split'); END;
 CREATE TRIGGER IF NOT EXISTS agent_native_outbox_no_identity_update BEFORE UPDATE OF id,split_id,payload ON agent_native_buyback_outbox BEGIN SELECT RAISE(ABORT,'immutable native allocation'); END;
 CREATE TRIGGER IF NOT EXISTS agent_native_outbox_no_delete BEFORE DELETE ON agent_native_buyback_outbox BEGIN SELECT RAISE(ABORT,'immutable native allocation'); END;`);
  return {
    recordClaim(input: FeeLot): void {
      const original = canonicalFeeLot(input);
      const identity = JSON.stringify([original.chain, original.claimReference, original.tokenId]);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db
          .prepare('SELECT payload FROM agent_native_fee_splits WHERE id=? OR claim_identity=?')
          .all(original.id, identity);
        if (previous.length) {
          if (
            previous.length !== 1 ||
            JSON.stringify((JSON.parse(String(previous[0].payload)) as NativeFeeSplit).original) !==
              JSON.stringify(original)
          )
            throw Error('Conflicting native fee identity.');
          db.exec('COMMIT');
          return;
        }
        const units = BigInt(original.amountBaseUnits);
        const reserve = units / 5n;
        const streamer: FeeLot = {
          ...original,
          id: `${original.id}:streamer`,
          amountBaseUnits: String(units - reserve),
        };
        const buyback: FeeLot | null =
          reserve === 0n
            ? null
            : { ...original, id: `${original.id}:buyback`, amountBaseUnits: String(reserve) };
        const split: NativeFeeSplit = {
          version: NATIVE_STREAMER_VERSION,
          original,
          streamer,
          buyback,
          createdAt: new Date().toISOString(),
        };
        db.prepare('INSERT INTO agent_native_fee_splits VALUES(?,?,?)').run(
          original.id,
          identity,
          JSON.stringify(split),
        );
        if (buyback)
          db.prepare('INSERT INTO agent_native_buyback_outbox VALUES(?,?,?,NULL)').run(
            buyback.id,
            original.id,
            JSON.stringify(buyback),
          );
        pipeline.recordClaim(streamer);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    buybackLots(): FeeLot[] {
      return db
        .prepare(
          'SELECT payload FROM agent_native_buyback_outbox WHERE acknowledged_at IS NULL ORDER BY rowid',
        )
        .all()
        .map((row) => JSON.parse(String(row.payload)) as FeeLot);
    },
    acknowledgeBuyback(id: string): void {
      const result = db
        .prepare(
          'UPDATE agent_native_buyback_outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?',
        )
        .run(new Date().toISOString(), id);
      if (result.changes !== 1) throw Error('Unknown native buyback allocation.');
    },
    splits(): NativeFeeSplit[] {
      return db
        .prepare('SELECT payload FROM agent_native_fee_splits ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(String(row.payload)) as NativeFeeSplit);
    },
  };
}
