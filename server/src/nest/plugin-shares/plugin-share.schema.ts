import type Database from 'better-sqlite3';

/**
 * Core-database tables owned by the trip-advice host (USG-213/216/217).
 *
 * This is deliberately NOT a step in db/migrations.ts. That array is
 * index-addressed against schema_version, so a locally appended step takes a
 * slot upstream fills later and the upstream step at that index is then
 * silently skipped (UNS-1689). Instead PluginShareDb runs it on a
 * connection's first use, and every statement is idempotent: a database
 * that already has the objects (one that ran the former migration steps) is
 * left untouched, a fresh one gets them.
 *
 * The DDL is byte-for-byte what the former migration steps created.
 */

export function ensurePluginShareSchema(db: Database.Database): void {
  db.transaction(() => {
    // USG-213: advice authority is separate from legacy public-share tokens.
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_share_links (
        id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), epoch INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL, expires_at TEXT NOT NULL
      );`);
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_share_sessions (
        id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES plugin_share_links(id) ON DELETE CASCADE,
        epoch INTEGER NOT NULL, guest_id TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL
      );`);
    db.exec('CREATE INDEX IF NOT EXISTS plugin_share_sessions_scope ON plugin_share_sessions(share_id, epoch)');
    db.exec('CREATE INDEX IF NOT EXISTS plugin_share_sessions_expiry ON plugin_share_sessions(expires_at)');

    // USG-216/218: immutable host identity for accepted advice imports.
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_place_imports (
        plugin_id TEXT NOT NULL, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        external_key TEXT NOT NULL, payload_hash TEXT NOT NULL, native_place_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (plugin_id, trip_id, external_key),
        UNIQUE (plugin_id, trip_id, native_place_id)
      );`);

    // USG-217: durable bounded Google Places attempt reservations. Provider
    // values and photo names remain transient in the host process only.
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_share_usage (
        scope_id TEXT NOT NULL, operation TEXT NOT NULL, usage_day TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        PRIMARY KEY (scope_id, operation, usage_day)
      );`);
    db.exec('CREATE INDEX IF NOT EXISTS plugin_share_usage_day ON plugin_share_usage(usage_day)');

    // USG-213: share data lives in the addon, so cleanup must survive a process
    // crash and a cascading trip delete. The outbox intentionally has no foreign
    // key: a link's delete trigger is its producer, and cascading that row away
    // would lose the only identifiers the addon needs to purge its own database.
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_share_lifecycle_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL CHECK(method IN ('purge', 'erase_guest')),
        share_id TEXT NOT NULL, guest_id TEXT NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(method, share_id, guest_id)
      );`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS plugin_share_links_purge_outbox
        BEFORE DELETE ON plugin_share_links BEGIN
          INSERT OR IGNORE INTO plugin_share_lifecycle_outbox(method, share_id, guest_id) VALUES ('purge', OLD.id, '');
        END;`);

    // USG-213: retain owner feedback for 90 days after expiry or first disable.
    // The backfill belongs to the moment the column appears: afterwards the
    // service stamps retention_started_at itself, so it must not re-run per boot.
    const columns = db.prepare('PRAGMA table_info(plugin_share_links)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'retention_started_at')) {
      db.exec('ALTER TABLE plugin_share_links ADD COLUMN retention_started_at TEXT');
      db.exec("UPDATE plugin_share_links SET retention_started_at = MIN(expires_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE enabled = 0 AND retention_started_at IS NULL");
    }
    if (!columns.some(column => column.name === 'feedback_purge_queued')) db.exec('ALTER TABLE plugin_share_links ADD COLUMN feedback_purge_queued INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS plugin_share_retention ON plugin_share_links(feedback_purge_queued, COALESCE(retention_started_at, expires_at))');

    db.exec(`CREATE TABLE IF NOT EXISTS plugin_advice_map_tiles (
        tile_key TEXT PRIMARY KEY, bytes BLOB NOT NULL, expires_at INTEGER NOT NULL,
        etag TEXT, last_modified TEXT
      )`);
  })();
}
