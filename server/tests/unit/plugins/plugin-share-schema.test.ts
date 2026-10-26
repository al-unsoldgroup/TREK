import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensurePluginShareSchema } from '../../../src/nest/plugin-shares/plugin-share.schema';
import { createSnapshotTestDb } from '../../helpers/db-mock';
import { createTrip, createUser } from '../../helpers/factories';

const OBJECTS = [
  'plugin_share_links', 'plugin_share_sessions', 'plugin_share_sessions_scope', 'plugin_share_sessions_expiry',
  'plugin_place_imports', 'plugin_share_usage', 'plugin_share_usage_day', 'plugin_share_lifecycle_outbox',
  'plugin_share_links_purge_outbox', 'plugin_share_retention', 'plugin_advice_map_tiles',
];

/** A fresh core database, migrated by MikroORM: none of the advice objects yet. */
function coreDb(): Database.Database {
  return createSnapshotTestDb();
}

const schemaOf = (db: Database.Database) =>
  db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN (${OBJECTS.map(() => '?').join(',')}) ORDER BY name`).all(...OBJECTS);

describe('ensurePluginShareSchema (kept out of the positional migrations, UNS-1689)', () => {
  it('leaves the core migration count untouched', () => {
    const db = coreDb();
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM mikro_orm_migrations').get();
    const before = count();
    ensurePluginShareSchema(db);
    expect(count()).toEqual(before);
  });

  it('creates every advice object on a fresh database and is a no-op on the next boot', () => {
    const db = coreDb();
    ensurePluginShareSchema(db);
    const first = schemaOf(db);
    expect(first.map(o => (o as { name: string }).name)).toEqual([...OBJECTS].sort());

    const user = createUser(db).user;
    const trip = createTrip(db, user.id);
    db.prepare("INSERT INTO plugin_share_links (id, trip_id, token, created_by, enabled, config_json, expires_at) VALUES ('s1', ?, 't1', ?, 0, '{}', '2030-01-01T00:00:00.000Z')").run(trip.id, user.id);
    ensurePluginShareSchema(db);

    expect(schemaOf(db)).toEqual(first);
    // The retention backfill belongs to the moment the column appears, not to every boot.
    expect(db.prepare("SELECT retention_started_at FROM plugin_share_links WHERE id = 's1'").get()).toEqual({ retention_started_at: null });
  });

  it('adds the retention columns to a pre-retention table and backfills disabled links once', () => {
    const db = coreDb();
    db.exec(`CREATE TABLE plugin_share_links (
        id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), epoch INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1, config_json TEXT NOT NULL, expires_at TEXT NOT NULL
      );`);
    const user = createUser(db).user;
    const trip = createTrip(db, user.id);
    db.prepare("INSERT INTO plugin_share_links (id, trip_id, token, created_by, enabled, config_json, expires_at) VALUES ('s1', ?, 't1', ?, 0, '{}', '2020-01-01T00:00:00.000Z')").run(trip.id, user.id);

    ensurePluginShareSchema(db);

    expect(db.prepare("SELECT retention_started_at, feedback_purge_queued FROM plugin_share_links WHERE id = 's1'").get())
      .toEqual({ retention_started_at: '2020-01-01T00:00:00.000Z', feedback_purge_queued: 0 });
  });
});
