import { Inject, Injectable, HttpException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { AdviceMapTileAction, AdviceMapTileResult } from '@trek/shared';
import { readEnv } from '../../app-config';
import { readCapped } from '../../utils/cappedFetch';
import { DatabaseService } from '../database/database.service';
import type { AdviceProviderPrincipal } from './plugin-shares.service';
import { PluginSharesService } from './plugin-shares.service';

export const ADVICE_MAP_FETCH = Symbol('ADVICE_MAP_FETCH');
const WEEK = 7 * 86400000;
const LIMIT = 256 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
interface CachedTile { bytes: Buffer; expires_at: number; etag: string | null; last_modified: string | null }

export function mapPoint(lat: number, lng: number, zoom: number) {
  const sine = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return { x: (lng + 180) / 360 * 2 ** zoom, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 2 ** zoom };
}

@Injectable()
export class AdviceMapProvider {
  private readonly loading = new Map<string, Promise<AdviceMapTileResult>>();
  constructor(private readonly db: DatabaseService, private readonly shares: PluginSharesService,
    @Inject(ADVICE_MAP_FETCH) private readonly fetcher: typeof fetch) {}

  async tile(principal: AdviceProviderPrincipal, action: AdviceMapTileAction): Promise<AdviceMapTileResult> {
    const projection = principal.kind === 'publicShare' ? this.shares.snapshot(principal) : this.shares.providerSnapshot(principal);
    const stay = projection.stays.find(stay => stay.days.some(day => day.key === action.dayKey));
    const day = stay?.days.find(day => day.key === action.dayKey);
    if (!day || !stay) throw new UnprocessableEntityException('Map day is unavailable');
    const shortlist = projection.shortlists.find(list => list.cityId === stay.cityId);
    const points = [...day.schedule.map(row => row.place), ...(shortlist?.see ?? []), ...(shortlist?.eat ?? [])]
      .flatMap(place => {
        const coordinates = 'coordinates' in place ? place.coordinates : 'lat' in place && 'lng' in place ? { lat: place.lat, lng: place.lng } : undefined;
        return coordinates && typeof coordinates.lat === 'number' && typeof coordinates.lng === 'number' ? [mapPoint(coordinates.lat, coordinates.lng, action.z)] : [];
      });
    // Only the displayed itinerary area, never a general-purpose tile proxy.
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const overview = maxX - minX <= 4.5 && maxY - minY <= 3
      && action.x >= Math.floor(minX) - 3 && action.x <= Math.floor(maxX) + 3
      && action.y >= Math.floor(minY) - 3 && action.y <= Math.floor(maxY) + 3;
    if (!overview && !points.some(p => Math.abs(action.x - Math.floor(p.x)) <= 3 && Math.abs(action.y - Math.floor(p.y)) <= 3)) {
      throw new UnprocessableEntityException('Tile is outside this day');
    }
    const key = `${action.z}/${action.x}/${action.y}`;
    const cached = this.db.get<CachedTile>('SELECT bytes, expires_at, etag, last_modified FROM plugin_advice_map_tiles WHERE tile_key = ?', key);
    if (cached && cached.expires_at > Date.now()) return this.result(cached.bytes);
    let pending = this.loading.get(key);
    if (!pending) {
      if (this.loading.size >= 4) throw new HttpException('Map is busy. Try again.', 429);
      pending = this.load(key, cached).finally(() => { this.loading.delete(key); });
      this.loading.set(key, pending);
    }
    const result = await pending;
    if (principal.kind === 'publicShare') this.shares.validatePrincipal(principal);
    else this.shares.validateProviderPrincipal(principal);
    return result;
  }

  private result(bytes: Buffer): AdviceMapTileResult { return { mimeType: 'image/png', bytesBase64: bytes.toString('base64') }; }

  private async load(key: string, cached?: CachedTile): Promise<AdviceMapTileResult> {
    const now = Date.now();
    let count = this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM plugin_advice_map_tiles')!.count;
    if (!cached && count + this.loading.size >= 512) {
      const stale = this.db.get<{ tile_key: string }>('SELECT tile_key FROM plugin_advice_map_tiles WHERE expires_at <= ? ORDER BY expires_at LIMIT 1', now);
      if (stale) { this.db.run('DELETE FROM plugin_advice_map_tiles WHERE tile_key = ?', stale.tile_key); count--; }
      if (count + this.loading.size >= 512) throw new ServiceUnavailableException('Map cache is full');
    }
    const origin = new URL(readEnv().app.appUrl || 'https://trips.unsold.group').origin;
    const headers: Record<string, string> = { 'User-Agent': 'TREK-TripAdvice/1.0 (+https://trips.unsold.group; contact: al@unsold.group)', Referer: origin + '/' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.last_modified) headers['If-Modified-Since'] = cached.last_modified;
    const response = await this.fetcher(`https://tile.openstreetmap.org/${key}.png`, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
    const maxAge = response.headers.get('cache-control')?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
    const headerExpiry = Date.parse(response.headers.get('expires') ?? '');
    const expires = maxAge ? now + Number(maxAge) * 1000 : Number.isFinite(headerExpiry) ? Math.max(now, headerExpiry) : now + WEEK;
    if (response.status === 304 && cached) {
      this.db.run('UPDATE plugin_advice_map_tiles SET expires_at = ? WHERE tile_key = ?', expires, key);
      return this.result(cached.bytes);
    }
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') {
      await response.body?.cancel();
      throw new ServiceUnavailableException('Map tiles are temporarily unavailable');
    }
    const { bytes, truncated } = await readCapped(response, LIMIT);
    if (truncated || !bytes.subarray(0, 8).equals(PNG)) throw new ServiceUnavailableException('Map tile is invalid');
    this.db.run(`INSERT OR REPLACE INTO plugin_advice_map_tiles (tile_key, bytes, expires_at, etag, last_modified) VALUES (?, ?, ?, ?, ?)`,
      key, bytes, expires, response.headers.get('etag'), response.headers.get('last-modified'));
    return this.result(bytes);
  }
}
