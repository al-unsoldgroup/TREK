import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { pluginDataDir, pluginDbFile, pluginsDataRoot } from '../paths';

/**
 * A plugin's own sqlite database (#plugins, db:own). The HOST owns the handle;
 * the plugin child never gets a path or a connection — it can only reach this
 * through RPC (db.exec / db.query / db.migrate). Because it is a SEPARATE FILE,
 * containment is a filesystem fact: the plugin physically cannot read trek.db,
 * and we don't have to police table-name prefixes in its SQL.
 *
 * A thin guard still rejects statements that would let a plugin escape its file
 * (ATTACH another db, VACUUM INTO elsewhere, PRAGMA fiddling) or DoS via
 * oversize SQL.
 */

const MAX_SQL_LENGTH = 100_000;
// RECURSIVE is the one construct that generates unbounded rows/CPU independent of
// the (capped) data size — a `WITH RECURSIVE …` can spin the synchronous host
// forever even with an empty database, which neither the size quota nor the
// result-row cap can stop (an aggregate over it never yields a first row). Refuse
// it outright; the row/size caps below bound everything else.
// load_extension is included as defense-in-depth: better-sqlite3 disables
// extension loading by default (so it's inert today), but banning it in the guard
// means a future connection-option slip can't turn it into an arbitrary-.so RCE.
const FORBIDDEN = /\b(ATTACH|DETACH|VACUUM|PRAGMA|RECURSIVE|LOAD_EXTENSION)\b/i;
// Transaction-control keywords, matched only at statement start (so CASE…END and
// identifiers are unaffected). Refused inside db.tx() so a plugin can't COMMIT the
// batch's earlier writes and then have the wrapper report failure — breaking atomicity.
const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i;
// Per-plugin on-disk quota. better-sqlite3 is synchronous and runs in the HOST
// process, so an unbounded plugin DB is both a disk-exhaustion DoS on the shared
// trek.db volume and (via a huge scan) an event-loop stall. max_page_count caps
// the file (writes past it fail SQLITE_FULL, contained to the plugin) and bounds
// the worst-case scan cost. Result sets are additionally row-capped below so a
// recursive CTE / cartesian product can't materialize an unbounded array.
const QUOTA_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 100_000;
// Cap statements per atomic batch so a single tx() can't monopolise the synchronous
// host — generous for real write batches, far below anything abusive.
const MAX_TX_OPS = 100;

/**
 * Plugin authors may pass bindings either as positional values or as one array,
 * matching better-sqlite3's public calling convention. RPC has already decoded
 * the outer argument list, so the latter arrives as a one-element nested array.
 * Keep this normalization at the database boundary so every host-backed surface,
 * including the public-share facade, applies the same binding semantics.
 */
function normalizeBindArgs(value: unknown): unknown[] {
  if (value === undefined) return [];
  const args = Array.isArray(value) ? value : [value];
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

// Every live per-plugin handle, so a backup can WAL-checkpoint them before archiving
// (the host keeps these open, so their .db files would otherwise be copied with recent
// commits still stranded in the -wal sidecar → a stale/torn snapshot in the backup).
const openDbs = new Set<PluginDataDb>();

/** Fold the WAL back into each open plugin.db so a subsequent file copy is a complete,
 * consistent snapshot — mirrors the wal_checkpoint the core backup runs on travel.db.
 * Best-effort per handle; never throws. */
export function checkpointAllPluginDataDbs(): void {
  for (const d of openDbs) {
    try { d.checkpoint(); } catch { /* a busy/closed handle is skipped, not fatal */ }
  }
}

export class PluginDataDb {
  private db: Db;
  readonly pluginId: string;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
    fs.mkdirSync(pluginDataDir(pluginId), { recursive: true });
    this.db = new Database(pluginDbFile(pluginId));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    openDbs.add(this);
    // Cap the file size (per-connection; not persisted, so set on every open).
    const pageSize = Number(this.db.pragma('page_size', { simple: true })) || 4096;
    this.db.pragma(`max_page_count = ${Math.max(1, Math.floor(QUOTA_BYTES / pageSize))}`);
    // Track applied migrations so db.migrate is idempotent per (plugin, id).
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _plugin_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)`,
    );
  }

  private guard(sql: string): void {
    if (typeof sql !== 'string') throw new Error('sql must be a string');
    if (sql.length > MAX_SQL_LENGTH) throw new Error('sql too long');
    if (FORBIDDEN.test(sql)) throw new Error('statement type not allowed for plugin databases');
  }

  /** Read query — returns rows up to MAX_ROWS. Single statement only. */
  query(sql: string, args: unknown[] = []): unknown[] {
    this.guard(sql);
    // iterate() pulls one row at a time, so a recursive CTE that would yield
    // unboundedly is halted at the cap instead of materializing via all().
    const rows: unknown[] = [];
    for (const row of this.db.prepare(sql).iterate(...(normalizeBindArgs(args) as never[]))) {
      rows.push(row);
      if (rows.length > MAX_ROWS) throw new Error(`query returned more than ${MAX_ROWS} rows`);
    }
    return rows;
  }

  /** Write statement(s). exec() allows multiple statements (e.g. a small setup script). */
  exec(sql: string, args: unknown[] = []): { changes: number } {
    this.guard(sql);
    const bindings = normalizeBindArgs(args);
    if (bindings.length > 0) {
      const info = this.db.prepare(sql).run(...(bindings as never[]));
      return { changes: info.changes };
    }
    this.db.exec(sql);
    return { changes: 0 };
  }

  /**
   * Atomic batch on the plugin's OWN db: every op runs in a single transaction, so
   * they all commit or all roll back — the primitive a plugin needs for a consistent
   * multi-write (e.g. move an item between two tables). Each op is ONE statement;
   * a read (SELECT/RETURNING) yields `{ rows }`, a write yields `{ changes }`, and
   * reads within the batch see the batch's own earlier writes (read-modify-write).
   */
  tx(ops: Array<{ sql: string; args?: unknown[] }>): { results: Array<{ changes?: number; rows?: unknown[] }> } {
    if (!Array.isArray(ops)) throw new Error('tx requires an array of { sql, args }');
    if (ops.length === 0) return { results: [] };
    if (ops.length > MAX_TX_OPS) throw new Error(`tx allows at most ${MAX_TX_OPS} statements`);
    for (const op of ops) {
      this.guard(op?.sql);
      // Reject transaction-control statements: a raw COMMIT/ROLLBACK inside the batch
      // would break atomicity — it commits the earlier writes even though the wrapper
      // then reports the tx as failed. Strip any LEADING comments/whitespace first so a
      // `/* */COMMIT` or `-- x\nCOMMIT` can't slip past the start-anchored check; these
      // keywords are only valid at statement start, so CASE ... END is unaffected.
      const head = String(op?.sql ?? '').replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
      if (TX_CONTROL.test(head)) throw new Error('transaction-control statements are not allowed inside tx()');
    }
    let batchRows = 0; // one row budget for the WHOLE batch, not per statement
    const run = this.db.transaction((batch: Array<{ sql: string; args?: unknown[] }>) => {
      const results: Array<{ changes?: number; rows?: unknown[] }> = [];
      for (const op of batch) {
        const stmt = this.db.prepare(op.sql);
        const args = normalizeBindArgs(op.args) as never[];
        if (stmt.reader) {
          const rows: unknown[] = [];
          for (const row of stmt.iterate(...args)) {
            rows.push(row);
            if (++batchRows > MAX_ROWS) throw new Error(`tx returned more than ${MAX_ROWS} rows in total`);
          }
          results.push({ rows });
        } else {
          results.push({ changes: stmt.run(...args).changes });
        }
      }
      return results;
    });
    return { results: run(ops) };
  }

  /** Run a migration once, keyed by id. Re-running with the same id is a no-op. */
  migrate(id: string, sql: string): { applied: boolean } {
    this.guard(sql);
    const seen = this.db.prepare('SELECT 1 FROM _plugin_migrations WHERE id = ?').get(id);
    if (seen) return { applied: false };
    this.db.transaction(() => {
      this.db.exec(sql);
      this.db.prepare('INSERT INTO _plugin_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
    })();
    return { applied: true };
  }

  /** Whether the underlying sqlite handle is still open (better-sqlite3 `.open`).
   * The host uses this to detect a handle closed by a terminal-failure dispose that
   * left the instance cached, so it can recreate it instead of throwing on reuse. */
  isOpen(): boolean {
    return this.db.open;
  }

  /** Fold the WAL back into the main db file (checkpoint TRUNCATE) so a file-level copy
   * is a complete snapshot. No-op on a closed handle. */
  checkpoint(): void {
    if (this.db.open) this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Write a fully-consistent copy of this DB to `destPath` via VACUUM INTO. Unlike a
   * file copy it folds in the WAL and reads a point-in-time snapshot, so the result is
   * correct even while the plugin is writing — no torn page, no separate -wal to keep in
   * sync. This is a host op on the host's own handle, not plugin SQL, so it bypasses the
   * FORBIDDEN guard by design. */
  snapshotInto(destPath: string): void {
    fs.rmSync(destPath, { force: true }); // VACUUM INTO fails if the target already exists
    this.db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
  }

  close(): void {
    try {
      openDbs.delete(this);
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** The RPC-visible subset of a plugin database. Kept structural so a public
 * share can receive a scoped facade without opening a second SQLite handle. */
export interface PluginDataDbAccess {
  query(sql: string, args?: unknown[]): unknown[];
  exec(sql: string, args?: unknown[]): { changes: number };
  migrate(id: string, sql: string): { applied: boolean };
  tx(ops: Array<{ sql: string; args?: unknown[] }>): { results: Array<{ changes?: number; rows?: unknown[] }> };
}

const PUBLIC_SHARE_TABLES = new Set([
  'advice_votes', 'advice_comments', 'advice_suggestions', 'advice_requests', 'advice_revisions',
]);
const PUBLIC_SQL_FORBIDDEN = /\b(?:ATTACH|DETACH|VACUUM|PRAGMA|RECURSIVE|LOAD_EXTENSION|CREATE|ALTER|DROP|REINDEX|ANALYZE)\b/i;
const PUBLIC_SQL_COMMENT = /(?:--|\/\*)/;
const PUBLIC_SQL_TRANSACTION = /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i;
// Only this reviewed upsert may update a conflict row. Its conflict key includes
// both host-bound identities, and its update cannot change either identity.
// Keep the real child-runtime vote test as the parity check with the addon.
const PUBLIC_VOTE_UPSERT = `INSERT INTO advice_votes (share_id, guest_id, place_key, value, version, updated_at)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (share_id, guest_id, place_key) DO UPDATE SET
  value = excluded.value, version = advice_votes.version + 1, updated_at = excluded.updated_at
  WHERE advice_votes.version = ? RETURNING place_key`.replace(/\s/g, '').toLowerCase();

/**
 * Replace SQL string and identifier literals with spaces while preserving every
 * character offset. Public-share authorization inspects SQL structure, not a
 * plugin's data: a value such as `'suggestion.create'` must not be mistaken for
 * a CREATE statement, and offsets must still line up with the original SQL when
 * inserting the host-owned binding.
 */
function sqlStructure(sql: string): string {
  let result = '';
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (quote !== undefined) {
      result += ' ';
      if (char === quote) {
        if (sql[index + 1] === quote) {
          result += ' ';
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function positionalBindingIndex(sql: string, end: number): number {
  let count = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < end; index += 1) {
    const char = sql[index];
    if (quote !== undefined) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '?') count += 1;
  }
  return count;
}

function topLevelKeyword(sql: string, keyword: string): number {
  const matcher = new RegExp(`\\b${keyword}\\b`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(sql)) !== null) {
    let depth = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (sql[index] === '(') depth += 1;
      else if (sql[index] === ')') depth -= 1;
    }
    if (depth === 0) return match.index;
  }
  return -1;
}

function scopeReadWriteSql(sql: string, structure: string, shareId: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (topLevelKeyword(structure, 'UNION') >= 0 || topLevelKeyword(structure, 'INTERSECT') >= 0 || topLevelKeyword(structure, 'EXCEPT') >= 0) {
    throw new Error('public share SQL is not allowed');
  }
  const whereAt = topLevelKeyword(structure, 'WHERE');
  const suffixes = ['ORDER\\s+BY', 'GROUP\\s+BY', 'LIMIT', 'RETURNING'];
  const suffixAt = suffixes
    .map(keyword => topLevelKeyword(structure, keyword))
    .filter(index => index >= 0)
    .reduce((first, index) => Math.min(first, index), sql.length);
  const head = sql.slice(0, suffixAt);
  const tail = sql.slice(suffixAt);
  const nextArgs = [...args];
  nextArgs.splice(positionalBindingIndex(sql, suffixAt), 0, shareId);
  if (whereAt < 0 || whereAt >= suffixAt) {
    return { sql: `${head} WHERE share_id = ?${tail}`, args: nextArgs };
  }
  // Always parenthesize the caller condition. `a OR b AND share_id = ?` scopes
  // only b, whereas `(a OR b) AND share_id = ?` scopes the entire statement.
  const beforeWhere = sql.slice(0, whereAt + 'WHERE'.length);
  const condition = sql.slice(whereAt + 'WHERE'.length, suffixAt);
  return { sql: `${beforeWhere} (${condition}) AND share_id = ?${tail}`, args: nextArgs };
}

/**
 * An INSERT cannot be safely repaired by adding a predicate after the fact.
 * The target identity has to be a direct host-verified binding in the target
 * column list. In particular, a matching value in an unrelated argument (or a
 * SELECT expression for another column) must not make a foreign row writable.
 */
function assertPublicInsertIdentity(sql: string, structure: string, args: unknown[], shareId: string, guestId?: string): void {
  const target = /\bINTO\s+[a-z_][a-z0-9_]*\s*\(([^)]*)\)/i.exec(structure);
  if (!target || target.index === undefined) throw new Error('public share INSERT must name its columns');
  const columns = target[1]!.split(',').map(column => column.trim().toLowerCase());
  const shareColumn = columns.indexOf('share_id');
  const guestColumn = columns.indexOf('guest_id');
  if (shareColumn < 0) throw new Error('public share INSERT must bind its share');
  if (guestColumn >= 0 && guestId === undefined) throw new Error('public share INSERT must bind its guest');

  const valuesAt = topLevelKeyword(structure, 'VALUES');
  const selectAt = topLevelKeyword(structure, 'SELECT');
  const sourceAt = valuesAt >= 0 ? valuesAt : selectAt;
  if (sourceAt < 0) throw new Error('public share INSERT source is not allowed');
  const sourceStart = sourceAt + (valuesAt >= 0 ? 'VALUES'.length : 'SELECT'.length);
  const openAt = valuesAt >= 0 ? structure.indexOf('(', sourceStart) : sourceStart;
  const closeAt = valuesAt >= 0 ? structure.indexOf(')', openAt + 1) : topLevelKeyword(structure, 'FROM');
  const sourceEnd = closeAt >= 0 ? closeAt : structure.length;
  const expressions = structure.slice(valuesAt >= 0 ? openAt + 1 : sourceStart, sourceEnd).split(',').map(value => value.trim());
  const expressionStart = valuesAt >= 0 ? openAt + 1 : sourceStart;
  if (expressions.length < columns.length) throw new Error('public share INSERT source is not allowed');

  const assertBinding = (column: number, value: string | undefined, message: string): void => {
    if (expressions[column] !== '?') throw new Error(message);
    let offset = expressionStart;
    for (let index = 0; index < column; index += 1) offset += expressions[index]!.length + 1;
    const questionAt = structure.indexOf('?', offset);
    if (questionAt < 0 || args[positionalBindingIndex(sql, questionAt)] !== value) throw new Error(message);
  };
  assertBinding(shareColumn, shareId, 'public share INSERT must bind its share');
  if (guestColumn >= 0) assertBinding(guestColumn, guestId, 'public share INSERT must bind its guest');
}

/**
 * Public feedback is allowed to use the addon's own SQL primitives, but never
 * as an unscoped database. Every read/update/delete gets a host-added share
 * predicate; inserts must bind the host share and guest identities. The
 * whitelist is intentionally limited to the reviewed trip-advice tables.
 */
export class PublicSharePluginDataDb implements PluginDataDbAccess {
  constructor(private readonly db: PluginDataDb, private readonly shareId: string, private readonly guestId?: string) {}

  private scoped(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
    if (typeof sql !== 'string' || sql.length > MAX_SQL_LENGTH) throw new Error('public share SQL is not allowed');
    const structure = sqlStructure(sql);
    if (PUBLIC_SQL_COMMENT.test(structure) || PUBLIC_SQL_FORBIDDEN.test(structure) || structure.includes(';') || PUBLIC_SQL_TRANSACTION.test(structure)) {
      throw new Error('public share SQL is not allowed');
    }
    const tables = [...structure.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]!.toLowerCase());
    const reviewedVoteUpsert = structure.replace(/\s/g, '').toLowerCase() === PUBLIC_VOTE_UPSERT;
    if (tables.some(table => !PUBLIC_SHARE_TABLES.has(table) && !(table === 'set' && reviewedVoteUpsert))) {
      throw new Error('public share table is not allowed');
    }
    if (tables.length === 0) throw new Error('public share table is required');
    const nextArgs = [...normalizeBindArgs(args)];
    for (const match of structure.matchAll(/\bshare_id\s*=\s*\?/gi)) {
      const index = positionalBindingIndex(sql, match.index ?? 0);
      if (nextArgs[index] !== this.shareId) throw new Error('public share SQL must bind its share');
    }
    const verb = structure.trimStart().slice(0, 12).toUpperCase();
    if (/^(SELECT|UPDATE|DELETE)\b/.test(verb)) {
      // The host-added outer predicate cannot constrain a scalar/subquery
      // expression: `SELECT (SELECT body FROM advice_comments ...) FROM ...`
      // would still disclose another share. Public reads and mutations do not
      // need subqueries, so reject them instead of pretending an outer WHERE is
      // a recursive SQL sandbox. INSERT ... SELECT is handled separately
      // because the reviewed vote idempotency record uses correlated counts.
      const selects = structure.match(/\bSELECT\b/gi)?.length ?? 0;
      if ((/^SELECT\b/.test(verb) && selects !== 1) || (!/^SELECT\b/.test(verb) && selects !== 0)) {
        throw new Error('public share SQL is not allowed');
      }
      return scopeReadWriteSql(sql, structure, this.shareId, nextArgs);
    }
    if (!/^INSERT\b/.test(verb)) throw new Error('public share SQL is not allowed');
    assertPublicInsertIdentity(sql, structure, nextArgs, this.shareId, this.guestId);
    return { sql, args: nextArgs };
  }

  query(sql: string, args: unknown[] = []): unknown[] {
    const scoped = this.scoped(sql, args);
    return this.db.query(scoped.sql, scoped.args);
  }

  exec(sql: string, args: unknown[] = []): { changes: number } {
    const scoped = this.scoped(sql, args);
    return this.db.exec(scoped.sql, scoped.args);
  }

  migrate(): { applied: boolean } {
    throw new Error('public share migrations are not allowed');
  }

  tx(ops: Array<{ sql: string; args?: unknown[] }>): { results: Array<{ changes?: number; rows?: unknown[] }> } {
    const scoped = ops.map(op => this.scoped(op.sql, op.args ?? []));
    return this.db.tx(scoped);
  }
}

/** Delete a plugin's data directory (uninstall "delete data"). */
export function removePluginData(pluginId: string): void {
  fs.rmSync(pluginDataDir(pluginId), { recursive: true, force: true });
}

/**
 * Copy every plugin's data dir into `destRoot` as a CONSISTENT snapshot, for a backup to
 * archive instead of the live tree. An open plugin.db is captured with VACUUM INTO (safe
 * under concurrent writes); a plugin with no live handle is copied as-is (no writer). The
 * -wal/-shm sidecars are never copied — the snapshot folds them in, and copying them out
 * of step with the .db is exactly what produced torn/corrupt restores when the archiver
 * read the live files lazily while a plugin kept writing. Blobs and any other files a
 * plugin wrote to its dir are copied verbatim. Best-effort per file; never throws.
 */
export function snapshotAllPluginDataDbs(destRoot: string): void {
  const root = pluginsDataRoot();
  if (!fs.existsSync(root)) return;
  const openById = new Map<string, PluginDataDb>();
  for (const d of openDbs) if (d.isOpen()) openById.set(d.pluginId, d);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(root, entry.name);
    const destDir = path.join(destRoot, entry.name);
    fs.mkdirSync(destDir, { recursive: true });
    const open = openById.get(entry.name);
    // Handle the live db up front so we know whether its WAL got folded in. If both
    // the VACUUM INTO snapshot and the checkpoint fail, the -wal/-shm are NOT folded,
    // so they must be copied alongside the .db — a .db stripped of an un-checkpointed
    // WAL loses committed transactions, whereas the .db + its WAL is a recoverable set.
    let foldedIn = false;
    if (open) {
      try { open.snapshotInto(path.join(destDir, 'plugin.db')); foldedIn = true; }
      catch {
        try { open.checkpoint(); foldedIn = true; } catch { /* WAL not folded — keep sidecars */ }
        try { fs.copyFileSync(path.join(srcDir, 'plugin.db'), path.join(destDir, 'plugin.db')); }
        catch { /* unreadable live db — best effort */ }
      }
    }
    for (const f of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (f.name === 'plugin.db' && open) continue; // already snapshotted above
      // Skip the .db sidecars only when the live handle's WAL was folded in — VACUUM
      // INTO / checkpoint absorbs them, and copying them out of step with a live writer
      // is what produced torn restores. For a plugin with NO open handle there is no
      // writer, so the -wal/-shm are a consistent set with the .db; copy them too, or an
      // unclean shutdown's committed-but-uncheckpointed transactions (still sitting in
      // the WAL) would be lost from the backup.
      if ((f.name.endsWith('-wal') || f.name.endsWith('-shm')) && foldedIn) continue;
      const src = path.join(srcDir, f.name);
      const dest = path.join(destDir, f.name);
      try {
        if (f.isDirectory()) fs.cpSync(src, dest, { recursive: true });
        else fs.copyFileSync(src, dest);
      } catch { /* skip an unreadable entry rather than fail the whole backup */ }
    }
  }
}
