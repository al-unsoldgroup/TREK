import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRpcHost } from '../../../src/nest/plugins/host/rpc-host';
import { PluginController, PluginMethod } from '../../../src/nest/plugins/host/rpc-kit/decorators';
import { createTestPluginRegistry } from '../../../src/nest/plugins/host/rpc-kit/testing';
import { KNOWN_METHODS, KNOWN_PERMISSIONS, UNCONDITIONAL_METHODS, type PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';
import type { PluginRpcContext } from '../../../src/nest/plugins/host/rpc-kit/types';
import { createPluginContext } from '../../../src/nest/plugins/runtime/plugin-sdk';
import { PluginSupervisor } from '../../../src/nest/plugins/supervisor/plugin-supervisor';
import { RpcRateLimiter } from '../../../src/nest/plugins/host/rate-limit';
import { makeDeps } from '../../helpers/rpc-host-deps';
import { DbRpc } from '../../../src/nest/plugins/host/rpc/db.rpc';
import { PluginDataDb, PublicSharePluginDataDb } from '../../../src/nest/plugins/host/plugin-data.service';

const scope: PublicSharePrincipal = { kind: 'publicShare', pluginId: 'trip-advice', shareId: 'share-scope', epoch: 1, sessionId: 'session', guestId: 'guest' };
@PluginController()
class ProjectionRpc {
  @PluginMethod('publicShare.snapshot', { permission: 'share:guest' })
  snapshot(_params: Record<string, unknown>, ctx: PluginRpcContext) { return { actor: ctx.actingUserId, scope: ctx.publicShare }; }
  @PluginMethod('publicShare.resolveSelection', { permission: 'share:guest' })
  resolveSelection() { throw new Error('selection unavailable'); }
  @PluginMethod('publicShare.filterSuggestionKeys', { permission: 'share:guest' })
  filterSuggestionKeys(params: { keys?: string[] }) { return params.keys ?? []; }
}
const call = (method: string) => ({ k: 'req' as const, id: 'r', method, params: { _inv: 'host-invocation' } });
describe('public invocation confinement', () => {
  it('binds scope with no actor; denies every other method even with all grants', async () => {
    const deps = { ...makeDeps(), validatePublicShare: vi.fn() };
    const host = new PluginRpcHost('trip-advice', new Set(KNOWN_PERMISSIONS), deps, createTestPluginRegistry([new ProjectionRpc()]));
    expect(await host.dispatch(call('publicShare.snapshot'), undefined, scope)).toMatchObject({ ok: true, result: { actor: undefined, scope } });
    for (const method of [...KNOWN_METHODS, ...UNCONDITIONAL_METHODS].filter(m => !['publicShare.snapshot', 'publicShare.resolveSelection', 'publicShare.filterSuggestionKeys'].includes(m))) {
      expect(await host.dispatch(call(method), undefined, scope)).toMatchObject({ ok: false, error: { code: 'RESOURCE_FORBIDDEN' } });
    }
    expect(deps.data.exec).not.toHaveBeenCalled();
    expect(deps.callPlugin).not.toHaveBeenCalled();
    expect(deps.emitPluginEvent).not.toHaveBeenCalled();
  });
  it('fails closed without validator, with actor, or after revoke', async () => {
    const deps = { ...makeDeps(), validatePublicShare: vi.fn(() => { throw new Error('revoked'); }) };
    const registry = createTestPluginRegistry([new ProjectionRpc()]);
    const host = new PluginRpcHost('trip-advice', new Set(['share:guest']), deps, registry);
    expect(await host.dispatch(call('publicShare.snapshot'), undefined, scope)).toMatchObject({ ok: false });
    expect(await host.dispatch(call('publicShare.snapshot'), 42, scope)).toMatchObject({ ok: false });
    const noValidator = new PluginRpcHost('trip-advice', new Set(['share:guest']), makeDeps(), registry);
    expect(await noValidator.dispatch(call('publicShare.snapshot'), undefined, scope)).toMatchObject({ ok: false });
  });
  it('permits only the scoped addon database through the real public dispatch path', async () => {
    const query = vi.fn(() => [{ share_id: scope.shareId }]);
    const data = { query, exec: vi.fn(() => ({ changes: 1 })), migrate: vi.fn(), tx: vi.fn(() => ({ results: [] })) };
    const deps = { ...makeDeps(), validatePublicShare: vi.fn(), publicShareData: vi.fn(() => data) };
    const registry = createTestPluginRegistry([new ProjectionRpc(), new DbRpc({} as never)]);
    const host = new PluginRpcHost('trip-advice', new Set(['share:guest', 'db:own']), deps, registry);
    expect(await host.dispatch({ ...call('db.query'), params: { sql: 'SELECT * FROM advice_votes WHERE share_id = ?', args: [scope.shareId], _inv: 'host-invocation' } }, undefined, scope)).toMatchObject({ ok: true });
    expect(await host.dispatch(call('trips.getById'), undefined, scope)).toMatchObject({ ok: false, error: { code: 'RESOURCE_FORBIDDEN' } });
    expect(query).toHaveBeenCalled();
  });
  it('adds the host share predicate and rejects foreign or unreviewed tables', () => {
    const backing = { query: vi.fn(() => []), exec: vi.fn(() => ({ changes: 0 })), migrate: vi.fn(), tx: vi.fn(() => ({ results: [] })) };
    const db = new PublicSharePluginDataDb(backing as never, scope.shareId, scope.guestId);
    db.query('SELECT * FROM advice_comments WHERE guest_id = ?', [scope.guestId]);
    expect(backing.query).toHaveBeenCalledWith(expect.stringContaining('share_id = ?'), [scope.guestId, scope.shareId]);
    expect(() => db.query('SELECT * FROM advice_votes', [])).not.toThrow();
    db.exec('DELETE FROM advice_comments WHERE share_id = ?', [scope.shareId]);
    // Two bindings are correct: the host cannot trust the caller's share binding, so it adds its own guard.
    expect(backing.exec).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM advice_comments WHERE ( share_id = ?) AND share_id = ?',
      [scope.shareId, scope.shareId],
    );
    db.exec('DELETE FROM advice_comments WHERE share_id = ? AND guest_id = ?', [scope.shareId, scope.guestId]);
    expect(backing.exec).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM advice_comments WHERE ( share_id = ? AND guest_id = ?) AND share_id = ?',
      [scope.shareId, scope.guestId, scope.shareId],
    );
    expect(() => db.query('SELECT * FROM sqlite_master')).toThrow('public share table is not allowed');
    expect(() => db.exec('DELETE FROM advice_comments WHERE share_id = ?', ['other-share'])).toThrow('public share SQL must bind its share');
  });
  it('distinguishes SQL structure from literal data without weakening the keyword guard', () => {
    const backing = { query: vi.fn(() => []), exec: vi.fn(() => ({ changes: 1 })), migrate: vi.fn(), tx: vi.fn(() => ({ results: [] })) };
    const db = new PublicSharePluginDataDb(backing as never, scope.shareId, scope.guestId);
    expect(() => db.exec(
      "INSERT OR IGNORE INTO advice_requests (share_id, guest_id, operation) VALUES (?, ?, 'suggestion.create')",
      [scope.shareId, scope.guestId],
    )).not.toThrow();
    expect(() => db.exec('CREATE TABLE advice_requests_copy (id INTEGER)')).toThrow('public share SQL is not allowed');
  });
  it('requires the host identities in their INSERT target columns', () => {
    const backing = { query: vi.fn(() => []), exec: vi.fn(() => ({ changes: 1 })), migrate: vi.fn(), tx: vi.fn(() => ({ results: [] })) };
    const db = new PublicSharePluginDataDb(backing as never, scope.shareId, scope.guestId);
    expect(() => db.exec(
      'INSERT INTO advice_votes (share_id, guest_id, value) VALUES (?, ?, ?)',
      ['foreign-share', scope.guestId, scope.shareId],
    )).toThrow('public share INSERT must bind its share');
    expect(() => db.exec(
      'INSERT INTO advice_votes (share_id, guest_id, value) VALUES (?, ?, ?)',
      [scope.shareId, 'foreign-guest', scope.guestId],
    )).toThrow('public share INSERT must bind its guest');
  });
  it('permits only the reviewed vote upsert with host-bound identities', () => {
    const backing = { query: vi.fn(() => []), exec: vi.fn(() => ({ changes: 1 })), migrate: vi.fn(), tx: vi.fn(() => ({ results: [] })) };
    const db = new PublicSharePluginDataDb(backing as never, scope.shareId, scope.guestId);
    const sql = `INSERT INTO advice_votes (share_id, guest_id, place_key, value, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (share_id, guest_id, place_key) DO UPDATE SET
      value = excluded.value, version = advice_votes.version + 1, updated_at = excluded.updated_at
      WHERE advice_votes.version = ? RETURNING place_key`;
    const args = [scope.shareId, scope.guestId, 'p:1', 1, 1, 1, 0];
    expect(() => db.exec(sql, args)).not.toThrow();
    expect(() => db.exec(sql, ['foreign-share', ...args.slice(1)])).toThrow('public share INSERT must bind its share');
    expect(() => db.exec(sql, [scope.shareId, 'foreign-guest', ...args.slice(2)])).toThrow('public share INSERT must bind its guest');
    for (const changed of [
      sql.replace('value = excluded.value', 'share_id = excluded.value'),
      sql.replace('value = excluded.value', 'guest_id = excluded.value'),
      sql.replace('ON CONFLICT (share_id, guest_id, place_key)', 'ON CONFLICT (place_key)'),
      sql.replace('value = excluded.value', 'value = (SELECT value FROM advice_votes LIMIT 1)'),
    ]) expect(() => db.exec(changed, args)).toThrow('public share table is not allowed');
    expect(backing.exec).toHaveBeenCalledTimes(1);
  });
  it('enforces the share scope against a real SQLite database', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-public-share-'));
    const previous = process.env.TREK_PLUGINS_DATA_DIR;
    process.env.TREK_PLUGINS_DATA_DIR = root;
    const backing = new PluginDataDb('trip-advice');
    try {
      backing.migrate('001', `CREATE TABLE advice_votes (
        id INTEGER PRIMARY KEY,
        share_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        value INTEGER NOT NULL
      )`);
      backing.migrate('002', `CREATE TABLE advice_comments (
        id TEXT PRIMARY KEY,
        share_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        display_name TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`);
      const current = new PublicSharePluginDataDb(backing, 'share-current', 'guest-current');
      const other = new PublicSharePluginDataDb(backing, 'share-other', 'guest-other');
      current.exec('INSERT INTO advice_votes (share_id, guest_id, value) VALUES (?, ?, ?)', [['share-current', 'guest-current', 1]]);
      other.exec('INSERT INTO advice_votes (share_id, guest_id, value) VALUES (?, ?, ?)', ['share-other', 'guest-other', -1]);
      current.exec('INSERT INTO advice_comments (id, share_id, guest_id, body, created_at) VALUES (?, ?, ?, ?, ?)', [
        'comment-current', 'share-current', 'guest-current', 'A comment', 1,
      ]);

      expect(current.query('SELECT share_id, guest_id, value FROM advice_votes')).toEqual([
        { share_id: 'share-current', guest_id: 'guest-current', value: 1 },
      ]);
      // The host predicate precedes LIMIT, so its binding must precede the limit binding too.
      expect(current.query('SELECT share_id, guest_id, value FROM advice_votes WHERE share_id = ? ORDER BY id LIMIT ?', ['share-current', 1])).toEqual([
        { share_id: 'share-current', guest_id: 'guest-current', value: 1 },
      ]);
      expect(current.query('SELECT id, guest_id, display_name, body, created_at, deleted_at FROM advice_comments WHERE share_id = ? AND guest_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT ?', ['share-current', 'guest-current', 1])).toEqual([
        { id: 'comment-current', guest_id: 'guest-current', display_name: null, body: 'A comment', created_at: 1, deleted_at: null },
      ]);
      expect(() => current.query('SELECT * FROM advice_votes WHERE share_id = ?', ['share-other'])).toThrow('public share SQL must bind its share');
      expect(() => current.exec('UPDATE advice_votes SET value = ? WHERE share_id = ?', [0, 'share-other'])).toThrow('public share SQL must bind its share');
      // Parenthesizing the caller predicate is load-bearing: SQL gives AND
      // precedence over OR, so appending an ungrouped predicate leaks rows.
      expect(current.query('SELECT share_id FROM advice_votes WHERE 1 = 1 OR 0 = 1')).toEqual([{ share_id: 'share-current' }]);
      expect(() => current.query('SELECT (SELECT guest_id FROM advice_votes LIMIT 1) AS leaked FROM advice_votes')).toThrow('public share SQL is not allowed');
      expect(other.query('SELECT value FROM advice_votes')).toEqual([{ value: -1 }]);
    } finally {
      backing.close();
      if (previous === undefined) delete process.env.TREK_PLUGINS_DATA_DIR;
      else process.env.TREK_PLUGINS_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('tags own DB and open calls too, without cross-invocation bleed', async () => {
    const rpc = vi.fn(async () => ({}));
    const t = { rpc, emit: vi.fn() };
    const a = createPluginContext('trip-advice', {}, t, 'a');
    const b = createPluginContext('trip-advice', {}, t, 'b');
    await a.db.query('SELECT 1'); await b.db.exec('DELETE FROM feedback');
    await a.publicShare.snapshot(); await b.settings.get('secret');
    expect(rpc.mock.calls.map((args: unknown[]) => (args[1] as { _inv: string })._inv)).toEqual(['a', 'b', 'a', 'b']);
  });
  it('rejects a stale or forged invocation instead of falling back to a userless call', async () => {
    const dispatch = vi.fn(async () => ({ k: 'res', id: 'r', ok: true, result: {} }));
    const send = vi.fn();
    const supervisor = new PluginSupervisor(() => { throw new Error('No process should be spawned'); });
    const state = { status: 'active', child: { send }, rpcHost: { dispatch },
      rpcLimiter: new RpcRateLimiter({ burst: 10, perSec: 1, maxInFlight: 10 }, Date.now()),
      invocations: new Map([['live', { publicShare: scope }]]),
    };
    const internals = supervisor as unknown as { onMessage(state: unknown, request: unknown): Promise<void> };
    await internals.onMessage(state, call('publicShare.snapshot'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'RESOURCE_FORBIDDEN' }) }));
    await internals.onMessage(state, { ...call('publicShare.snapshot'), params: { _inv: 'live', actingUserId: 42 } });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), undefined, scope);
    state.invocations.clear();
    await internals.onMessage(state, { ...call('publicShare.snapshot'), params: { _inv: 'live' } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // A retained startup context is forbidden while a real public invocation is
    // live, because it would otherwise bypass that invocation's guest scope.
    state.invocations.set('live', { publicShare: scope });
    await internals.onMessage(state, { ...call('publicShare.snapshot'), params: {} });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'RESOURCE_FORBIDDEN', message: 'Invocation authority is required' }) }));
    await expect(supervisor.invoke('trip-advice', 'invoke.publicShare', {})).rejects.toThrow('principal required');
  });
});
