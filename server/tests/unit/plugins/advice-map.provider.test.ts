import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { AdviceMapProvider, mapPoint } from '../../../src/nest/plugin-shares/advice-map.provider';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';

const principal: PublicSharePrincipal = { kind: 'publicShare', pluginId: 'trip-advice', shareId: 'share-a', epoch: 1, sessionId: 'session-a', guestId: 'guest-a' };
const coordinates = { lat: 35.7, lng: 139.7 };
const position = mapPoint(coordinates.lat, coordinates.lng, 12);
const action = { version: 1, kind: 'map.tile', dayKey: 'd:1', z: 12, x: Math.floor(position.x), y: Math.floor(position.y) } as const;
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const connections: Sqlite.Database[] = [];
function fixture(fetcher = vi.fn<typeof fetch>(async () => new Response(png, { headers: { 'content-type': 'image/png', etag: 'fixture-etag' } }))) {
  const sql = new Sqlite(':memory:'); connections.push(sql);
  sql.exec('CREATE TABLE plugin_advice_map_tiles(tile_key TEXT PRIMARY KEY, bytes BLOB, expires_at INTEGER, etag TEXT, last_modified TEXT)');
  const shares = { snapshot: vi.fn(() => ({ stays: [{ cityId: 'tokyo', days: [{ key: 'd:1', schedule: [{ place: { coordinates } }] }] }], shortlists: [] })), validatePrincipal: vi.fn() };
  return { provider: new AdviceMapProvider(new DatabaseService(sql), shares as never, fetcher), fetcher, shares, sql };
}
afterEach(() => { connections.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });
describe('scoped OSM map tiles', () => {
  it('fetches only the pinned HTTPS provider with stable identification and no token referrer', async () => {
    vi.stubEnv('APP_URL', 'https://trips.example.test');
    const { provider, fetcher } = fixture();
    const result = await provider.tile(principal, action);
    expect(result.mimeType).toBe('image/png');
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://tile.openstreetmap.org/12/${action.x}/${action.y}.png`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { Referer: 'https://trips.example.test/', 'User-Agent': expect.stringContaining('TREK-TripAdvice') } });
  });
  it('caches successful tiles durably for seven days when upstream gives no cache lifetime', async () => {
    const { provider, fetcher, sql } = fixture();
    await provider.tile(principal, action); await provider.tile(principal, action);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const row = sql.prepare('SELECT expires_at FROM plugin_advice_map_tiles').get() as { expires_at: number };
    expect(row.expires_at).toBeGreaterThan(Date.now() + 6.9 * 86400000);
  });
  it('rejects unknown days and unrelated map areas before fetching', async () => {
    const { provider, fetcher } = fixture();
    await expect(provider.tile(principal, { ...action, dayKey: 'd:99' })).rejects.toThrow('Map day');
    await expect(provider.tile(principal, { ...action, x: 1, y: 1 })).rejects.toThrow('outside this day');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses conditional revalidation of expired cached tiles', async () => {
    const { provider, fetcher, sql } = fixture();
    await provider.tile(principal, action); sql.prepare('UPDATE plugin_advice_map_tiles SET expires_at = 0').run();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await provider.tile(principal, action);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'If-None-Match': 'fixture-etag' });
  });
  it('keeps unrelated stale cache entries available for conditional revalidation', async () => {
    const { provider, sql } = fixture();
    sql.prepare('INSERT INTO plugin_advice_map_tiles VALUES (?, ?, ?, ?, ?)').run('2/1/1', png, 0, 'old-etag', null);
    await provider.tile(principal, action);
    expect(sql.prepare('SELECT etag FROM plugin_advice_map_tiles WHERE tile_key = ?').get('2/1/1')).toEqual({ etag: 'old-etag' });
  });
  it('honors the upstream cache lifetime rather than downloading again on another view', async () => {
    const { provider, fetcher, sql } = fixture();
    fetcher.mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=864000' } }));
    await provider.tile(principal, action);
    const row = sql.prepare('SELECT expires_at FROM plugin_advice_map_tiles').get() as { expires_at: number };
    expect(row.expires_at).toBeGreaterThan(Date.now() + 9.9 * 86400000);
  });
  it('refuses non-image and oversized provider bodies', async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(new Response('<html/>', { headers: { 'content-type': 'text/html' } }));
    await expect(provider.tile(principal, action)).rejects.toThrow('temporarily unavailable');
    fetcher.mockResolvedValueOnce(new Response(Buffer.alloc(300000), { headers: { 'content-type': 'image/png' } }));
    await expect(provider.tile(principal, action)).rejects.toThrow('invalid');
  });
  it('revalidates guest authority after the provider response', async () => {
    const { provider, shares } = fixture(); shares.validatePrincipal.mockImplementation(() => { throw new Error('Expired guest'); });
    await expect(provider.tile(principal, action)).rejects.toThrow('Expired guest');
  });
});
