import { Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { PERMISSION_ACTIONS, evaluatePermission, type PermissionLevel } from '@trek/shared';
import { getRawConnection } from '../../db/database';
import { decrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { ensurePluginShareSchema } from './plugin-share.schema';

/** Handles whose advice tables are known to exist; a restore's new handle is checked again. */
const ensured = new WeakSet<Database.Database>();

/**
 * Raw-SQL access for the local trip-advice host overlay.
 *
 * v5 deleted DatabaseService: core tables belong to MikroORM. The plugin_share_*
 * tables are local (not ORM entities, created by ensurePluginShareSchema), and the
 * overlay's services are synchronous by design: their invariants rely on
 * better-sqlite3 transactions that cannot span an await. So they keep the same
 * handle the ORM driver binds, resolved per call so a restore's swap is seen.
 * The local tables are ensured on a handle's first use (kept out of the core
 * migrations, UNS-1689), so nothing touches the database at construction.
 */
@Injectable()
export class PluginShareDb {
  get connection(): Database.Database {
    const conn = getRawConnection();
    if (!ensured.has(conn)) {
      ensurePluginShareSchema(conn);
      ensured.add(conn);
    }
    return conn;
  }

  prepare(sql: string): Database.Statement {
    return this.connection.prepare(sql);
  }

  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }

  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.connection.prepare(sql).run(...params);
  }

  transaction<T>(fn: (conn: Database.Database) => T): T {
    const conn = this.connection;
    return conn.transaction(() => fn(conn))();
  }

  /** readInstanceApiKey, synchronously: the instance-wide key in cleartext, or null. */
  instanceApiKey(name: 'maps_api_key'): string | null {
    const value = this.get<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', name)?.value;
    return value ? decrypt_api_key(value) || null : null;
  }

  /** Owner or member, the same rows TripsRepository.findAccessible matches. */
  canAccessTrip(tripId: number | string, userId: number): { id: number; user_id: number } | undefined {
    return this.get(
      `SELECT t.id, t.user_id FROM trips t
       LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
       WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`,
      userId, tripId, userId,
    );
  }

  /**
   * PermissionsService.checkPermission, synchronously: same perm_* rows, same
   * defaults, same shared rule. Read uncached, so an admin change applies at once.
   */
  checkPermission(actionKey: string, userRole: string, tripUserId: number | null, userId: number, isMember: boolean): boolean {
    if (userRole === 'admin') return true;
    const action = PERMISSION_ACTIONS.find((a) => a.key === actionKey);
    const stored = this.get<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', `perm_${actionKey}`)?.value;
    const level: PermissionLevel = action && stored && (action.allowedLevels as readonly string[]).includes(stored)
      ? (stored as PermissionLevel)
      : (action?.defaultLevel ?? 'trip_owner');
    return evaluatePermission(level, { isAdmin: false, isOwner: tripUserId !== null && tripUserId === userId, isMember });
  }
}

/**
 * Fixed-window limiter for the public advice endpoints. Synchronous (the v5
 * RateLimitService is async) and bounded: a bucket refuses new keys past maxKeys
 * so a flood of distinct addresses cannot grow it without limit.
 */
@Injectable()
export class AdviceRateLimiter {
  private readonly buckets = new Map<string, Map<string, { count: number; first: number }>>();
  private readonly lastSweep = new Map<string, number>();

  check(bucket: string, key: string, max: number, windowMs: number, now: number, maxKeys = Infinity): boolean {
    let store = this.buckets.get(bucket);
    if (!store) { store = new Map(); this.buckets.set(bucket, store); }
    if (now - (this.lastSweep.get(bucket) ?? 0) >= windowMs) {
      for (const [k, r] of store) if (now - r.first >= windowMs) store.delete(k);
      this.lastSweep.set(bucket, now);
    }
    const record = store.get(key);
    if (!record && store.size >= maxKeys) return false;
    if (record && record.count >= max && now - record.first < windowMs) return false;
    if (!record || now - record.first >= windowMs) store.set(key, { count: 1, first: now });
    else record.count++;
    return true;
  }

  /** Test helper: forget every count. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep.clear();
  }
}
