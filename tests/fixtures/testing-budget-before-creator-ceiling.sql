CREATE TABLE IF NOT EXISTS worker_testing_budget_config (
        id INTEGER PRIMARY KEY CHECK(id=1), cap_cents INTEGER NOT NULL CHECK(cap_cents=30000),
        frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1)), freeze_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO worker_testing_budget_config(id,cap_cents) VALUES(1,30000);
      CREATE TABLE IF NOT EXISTS worker_testing_budget_costs (
        operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        max_cents INTEGER NOT NULL CHECK(max_cents>0 AND max_cents<=30000),
        state TEXT NOT NULL CHECK(state IN ('reserved','unresolved','settled','released')),
        attempt_id TEXT UNIQUE, actual_cents INTEGER, evidence_kind TEXT, evidence_id TEXT,
        release_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(evidence_kind,evidence_id),
        CHECK((state='settled' AND actual_cents>0 AND attempt_id IS NOT NULL AND evidence_id IS NOT NULL)
          OR (state!='settled' AND actual_cents IS NULL))
      );
      CREATE TABLE IF NOT EXISTS worker_testing_budget_events (
        id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, event TEXT NOT NULL,
        actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_cap_immutable
        BEFORE UPDATE ON worker_testing_budget_config WHEN NEW.cap_cents!=OLD.cap_cents OR NEW.id!=OLD.id
        BEGIN SELECT RAISE(ABORT,'Testing cap is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_config_no_delete
        BEFORE DELETE ON worker_testing_budget_config BEGIN SELECT RAISE(ABORT,'Testing cap is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_freeze_immutable
        BEFORE UPDATE ON worker_testing_budget_config WHEN OLD.frozen=1 AND NEW.frozen!=1
        BEGIN SELECT RAISE(ABORT,'Testing freeze is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_identity_immutable
        BEFORE UPDATE ON worker_testing_budget_costs
        WHEN NEW.operation_id!=OLD.operation_id OR NEW.kind!=OLD.kind OR NEW.max_cents!=OLD.max_cents
          OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id)
          OR OLD.state IN ('settled','released')
        BEGIN SELECT RAISE(ABORT,'Testing cost identity and terminal proof are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_costs_no_delete
        BEFORE DELETE ON worker_testing_budget_costs BEGIN SELECT RAISE(ABORT,'Testing costs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_events_no_update
        BEFORE UPDATE ON worker_testing_budget_events BEGIN SELECT RAISE(ABORT,'Testing events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_testing_budget_events_no_delete
        BEFORE DELETE ON worker_testing_budget_events BEGIN SELECT RAISE(ABORT,'Testing events are immutable'); END;
      CREATE TABLE IF NOT EXISTS worker_funding_recovery_grants (
        payment_id TEXT PRIMARY KEY, scope TEXT NOT NULL, freeze_fingerprint TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
        token_id TEXT NOT NULL, creator_address TEXT NOT NULL, budget_cents INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS worker_funding_recovery_no_update
        BEFORE UPDATE ON worker_funding_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Funding recovery grants are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_funding_recovery_no_delete
        BEFORE DELETE ON worker_funding_recovery_grants
        BEGIN SELECT RAISE(ABORT,'Funding recovery grants are immutable'); END;
      CREATE TABLE IF NOT EXISTS worker_creator_funding_authorizations (
        operation_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, token_id TEXT NOT NULL,
        budget_cents INTEGER NOT NULL CHECK(budget_cents>0),
        kind TEXT NOT NULL CHECK(kind IN ('gift','chain_fee','offramp_fee')),
        max_cents INTEGER NOT NULL CHECK(max_cents>0 AND max_cents<=30000),
        source_payload TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(payment_id,kind),
        CHECK(operation_id=CASE kind WHEN 'gift' THEN 'gift:' || payment_id
          WHEN 'chain_fee' THEN 'gas:funding:' || payment_id
          WHEN 'offramp_fee' THEN 'offramp:' || payment_id END)
      );
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_reclassification
        BEFORE INSERT ON worker_creator_funding_authorizations
        WHEN EXISTS(SELECT 1 FROM worker_testing_budget_costs WHERE operation_id=NEW.operation_id)
        BEGIN SELECT RAISE(ABORT,'Existing testing costs cannot be reclassified'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_update
        BEFORE UPDATE ON worker_creator_funding_authorizations
        BEGIN SELECT RAISE(ABORT,'Creator funding authorizations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS worker_creator_funding_no_delete
        BEFORE DELETE ON worker_creator_funding_authorizations
        BEGIN SELECT RAISE(ABORT,'Creator funding authorizations are immutable'); END;
