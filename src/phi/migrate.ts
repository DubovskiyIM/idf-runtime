import type Database from 'better-sqlite3';

export function applyMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS phi_effects (
      id TEXT PRIMARY KEY,
      alpha TEXT NOT NULL,
      entity TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      confirmed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phi_effects_confirmed_at ON phi_effects(confirmed_at);
    CREATE INDEX IF NOT EXISTS idx_phi_effects_entity ON phi_effects(entity);

    CREATE TABLE IF NOT EXISTS phi_rejected (
      id TEXT PRIMARY KEY,
      alpha TEXT NOT NULL,
      entity TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      rejected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phi_rejected_at ON phi_rejected(rejected_at);

    CREATE TABLE IF NOT EXISTS world_snapshots (
      taken_at TEXT PRIMARY KEY,
      effect_count INTEGER NOT NULL,
      blob TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_state (
      rule_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      last_fired_at TEXT,
      PRIMARY KEY (rule_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS timer_queue (
      id TEXT PRIMARY KEY,
      fires_at TEXT NOT NULL,
      target_intent TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_timer_queue_fires_at ON timer_queue(fires_at);

    CREATE TABLE IF NOT EXISTS revocation_cache (
      membership_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      domain_slug TEXT NOT NULL,
      revoked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revocation_cache_user ON revocation_cache(user_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
