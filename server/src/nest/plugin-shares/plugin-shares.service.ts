import { Injectable, NotFoundException, ForbiddenException, ConflictException, UnauthorizedException, HttpException, Optional } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ADVICE_PLUGIN_ID, ADVICE_SHARE_PERMISSION, adviceBootstrapSchema, adviceNativeImportSchema, adviceOwnerWriteSchema, adviceShareConfigSchema } from '@trek/shared';
import type { AdviceNativeImportResult } from '@trek/shared';
import { readEnv } from '../../app-config';
import { DatabaseService } from '../database/database.service';
import { PermissionsService } from '../permissions/permissions.service';
import { RateLimitService } from '../common/rate-limit.service';
import { PluginShareProjectionService } from './plugin-share-projection.service';
import type { PublicSharePrincipal } from '../plugins/protocol/envelope';
import type { User } from '../../types';
import { PluginShareLifecycleService } from './plugin-share-lifecycle.service';

interface Link { id: string; trip_id: number; token: string; enabled: number; epoch: number; revision: number; config_json: string; expires_at: string }
interface Session { id: string; share_id: string; epoch: number; guest_id: string; credential_hash: string; expires_at: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const csrf = (s: string) => createHmac('sha256', s).update('trek-advice-csrf-v1').digest('base64url');
export const ADVICE_COOKIE = '__Secure-trek-advice';

@Injectable()
export class PluginSharesService {
  constructor(private readonly db: DatabaseService, private readonly permissions: PermissionsService,
    private readonly projection: PluginShareProjectionService, private readonly limiter: RateLimitService,
    @Optional() private readonly lifecycle?: PluginShareLifecycleService) {}

  private unavailable(): never { throw new NotFoundException('Invalid or expired link'); }
  private available() {
    if (!readEnv().plugins.publicAdvice || !readEnv().plugins.enabled) this.unavailable();
    const row = this.db.get<{ enabled: number; status: string; granted_permissions: string; capabilities: string }>(
      'SELECT enabled, status, granted_permissions, capabilities FROM plugins WHERE id = ?', ADVICE_PLUGIN_ID);
    if (!row || !row.enabled || row.status !== 'active') this.unavailable();
    try {
      const granted = z.array(z.string()).parse(JSON.parse(row.granted_permissions));
      const cap = z.object({ publicShare: z.strictObject({ version: z.literal(1), entry: z.literal('guest.html') }) }).parse(JSON.parse(row.capabilities));
      if (!granted.includes(ADVICE_SHARE_PERMISSION) || !cap.publicShare) this.unavailable();
    } catch { this.unavailable(); }
  }
  private live(row: Link | undefined): Link {
    this.available();
    if (!row || !row.enabled || !Number.isFinite(Date.parse(row.expires_at))) this.unavailable();
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.lifecycle?.enqueuePurge(row.id);
      void this.lifecycle?.flush();
      this.unavailable();
    }
    // An epoch-changing owner action must not expose a new guest session until
    // the old share's addon rows have been purged. The durable outbox closes the
    // crash window between revocation and child delivery.
    if (this.lifecycle?.hasPendingPurge(row.id)) this.unavailable();
    return row;
  }
  private byToken(token: string) {
    if (!/^ta_[A-Za-z0-9_-]{32}$/.test(token)) this.unavailable();
    return this.live(this.db.get<Link>('SELECT * FROM plugin_share_links WHERE token = ?', token));
  }
  ownsToken(token: string) { return !!this.db.get('SELECT 1 FROM plugin_share_links WHERE token = ?', token); }
  bootstrap(token: string) {
    const row = this.byToken(token);
    const config = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    return adviceBootstrapSchema.parse({ kind: 'plugin-share', version: 1, title: config.publicTitle,
      expiresAt: row.expires_at, plugin: { id: ADVICE_PLUGIN_ID, entry: 'guest.html', protocolVersion: 1 } });
  }
  requireManage(tripId: number, user: User) {
    const trip = this.db.canAccessTrip(tripId, user.id);
    if (!trip) throw new NotFoundException('Trip not found');
    if (!this.permissions.checkPermission('share_manage', user.role, trip.user_id, user.id, trip.user_id !== user.id)) throw new ForbiddenException('No permission');
  }
  getOwner(tripId: number, user: User) {
    this.requireManage(tripId, user);
    const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
    return row ? { shareId: row.id, token: row.token, enabled: !!row.enabled, revision: row.revision,
      expiresAt: row.expires_at, config: adviceShareConfigSchema.parse(JSON.parse(row.config_json)) } : null;
  }
  write(tripId: number, user: User, input: z.infer<typeof adviceOwnerWriteSchema>) {
    this.requireManage(tripId, user);
    const body = adviceOwnerWriteSchema.parse(input);
    const preview = this.projection.build(tripId, body.config, true);
    if (body.enabled && body.previewRevision !== undefined && body.previewRevision !== preview.revision) {
      throw new ConflictException('Advice preview is stale');
    }
    if (body.enabled) this.available();
    const result = this.db.transaction(() => {
      const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
      if ((row?.revision ?? 0) !== body.expectedRevision) throw new ConflictException('Advice configuration changed');
      const expires = new Date(Date.now() + body.expiresInDays * 86400000).toISOString();
      if (row) {
        this.lifecycle?.enqueuePurge(row.id);
        this.db.run('UPDATE plugin_share_links SET config_json = ?, enabled = ?, expires_at = ?, revision = revision + 1, epoch = epoch + 1 WHERE id = ?', JSON.stringify(body.config), Number(body.enabled), expires, row.id);
        this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
      } else {
        this.db.run('INSERT INTO plugin_share_links (id, trip_id, token, created_by, config_json, enabled, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          randomUUID(), tripId, this.newToken(), user.id, JSON.stringify(body.config), Number(body.enabled), expires);
      }
      return this.getOwner(tripId, user)!;
    });
    void this.lifecycle?.flush();
    return result;
  }
  preview(tripId: number, user: User, config: unknown) {
    this.requireManage(tripId, user);
    return this.projection.build(tripId, adviceShareConfigSchema.parse(config), true);
  }

  ownerConfig(tripId: number, userId: number) {
    const owner = this.actor(userId);
    const result = this.getOwner(tripId, owner);
    if (!result) return null;
    const { token: _token, ...config } = result;
    return config;
  }

  ownerPreview(tripId: number, userId: number, config: unknown) {
    return this.preview(tripId, this.actor(userId), config);
  }

  ownerConfigure(tripId: number, userId: number, input: unknown) {
    return this.write(tripId, this.actor(userId), adviceOwnerWriteSchema.parse(input));
  }

  /**
   * Import one accepted suggestion under the authenticated share manager. The
   * identity row and native place are committed together, so a retry after a
   * child crash returns the same place and cannot create a duplicate. No day
   * assignment or scheduling side effect is reachable here.
   */
  importSuggestion(tripId: number, userId: number, input: unknown): AdviceNativeImportResult {
    const actor = this.actor(userId);
    this.requireManage(tripId, actor);
    const trip = this.db.canAccessTrip(tripId, actor.id);
    if (!trip) throw new NotFoundException('Trip not found');
    if (!this.permissions.checkPermission('place_edit', actor.role, trip.user_id, actor.id, trip.user_id !== actor.id)) {
      throw new ForbiddenException('No permission');
    }
    const body = adviceNativeImportSchema.parse(input);
    if (body.tripId !== tripId) throw new ForbiddenException('Trip does not match owner context');
    const payloadHash = body.expectedPayloadHash ?? createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = this.db.transaction(() => {
      const existing = this.db.get<{ payload_hash: string; native_place_id: number }>(
        'SELECT payload_hash, native_place_id FROM plugin_place_imports WHERE plugin_id = ? AND trip_id = ? AND external_key = ?',
        ADVICE_PLUGIN_ID, tripId, body.externalKey,
      );
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ConflictException('Import identity was reused with different data');
        return { placeId: existing.native_place_id, created: false };
      }
      let placeId = body.existingPlaceId;
      let created = false;
      if (placeId !== undefined) {
        const linked = this.db.get<{ id: number }>('SELECT id FROM places WHERE id = ? AND trip_id = ?', placeId, tripId);
        if (!linked) throw new NotFoundException('Place not found');
      } else {
        const matching = this.db.get<{ id: number }>('SELECT id FROM places WHERE trip_id = ? AND google_place_id = ? ORDER BY id LIMIT 1', tripId, body.place.googlePlaceId);
        if (matching) placeId = matching.id;
      }
      if (placeId === undefined) {
        const result = this.db.run(`INSERT INTO places (trip_id, name, address, category_id, google_place_id, transport_mode)
          VALUES (?, ?, ?, ?, ?, ?)`, tripId, body.place.name, body.place.address ?? null,
        body.place.categoryId, body.place.googlePlaceId, 'walking');
        placeId = Number(result.lastInsertRowid);
        created = true;
      }
      this.db.run(`INSERT INTO plugin_place_imports (plugin_id, trip_id, external_key, payload_hash, native_place_id)
        VALUES (?, ?, ?, ?, ?)`, ADVICE_PLUGIN_ID, tripId, body.externalKey, payloadHash, placeId);
      return { placeId, created };
    });
    return result;
  }
  revoke(tripId: number, user: User, revision: number, rotate: boolean) {
    this.requireManage(tripId, user);
    const result = this.db.transaction(() => {
      const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
      if (!row) this.unavailable();
      if (row.revision !== revision) throw new ConflictException('Advice configuration changed');
      this.lifecycle?.enqueuePurge(row.id);
      this.db.run('UPDATE plugin_share_links SET token = ?, enabled = ?, epoch = epoch + 1, revision = revision + 1 WHERE id = ?', rotate ? this.newToken() : row.token, rotate ? row.enabled : 0, row.id);
      this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
      return this.getOwner(tripId, user)!;
    });
    void this.lifecycle?.flush();
    return result;
  }
  private newToken() {
    for (let i = 0; i < 5; i++) {
      // Separate namespace from legacy 32-character share credentials.
      const token = `ta_${randomBytes(24).toString('base64url')}`;
      if (!this.ownsToken(token) && !this.db.get('SELECT 1 FROM share_tokens WHERE token = ?', token)) return token;
    }
    throw new ConflictException('Could not create advice link');
  }

  private actor(userId: number): User {
    const user = this.db.get<User>('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw new UnauthorizedException('Authenticated user required');
    return user;
  }
  requireOrigin(origin: string | undefined, site: string | undefined) {
    const configured = readEnv().app.appUrl;
    if (!configured || !origin || site !== 'same-origin') throw new ForbiddenException('Same-origin request required');
    let expected: URL;
    try { expected = new URL(configured); } catch { throw new ForbiddenException('Same-origin request required'); }
    if (expected.protocol !== 'https:' || expected.origin !== origin) throw new ForbiddenException('Same-origin request required');
  }
  cookiePath(token: string) { return `/api/shared/${token}/plugins/${ADVICE_PLUGIN_ID}`; }
  credential(cookieHeader: string | undefined): string | undefined {
    const values = (cookieHeader ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${ADVICE_COOKIE}=`));
    if (values.length > 1) throw new UnauthorizedException('Ambiguous advice session');
    const value = values[0]?.slice(ADVICE_COOKIE.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  private limit(bucket: string, key: string, max: number) {
    if (!this.limiter.check(`advice-${bucket}`, hash(key), max, 60000, Date.now(), 10000)) throw new HttpException('Advice request limit reached', 429);
  }
  session(token: string, credential: string | undefined, ip: string) {
    const row = this.byToken(token);
    this.limit('session-ip', ip, 5); this.limit('session-share', row.id, 100);
    const existing = credential && this.db.get<Session>('SELECT * FROM plugin_share_sessions WHERE credential_hash = ? AND share_id = ? AND epoch = ? AND expires_at > ?', hash(credential), row.id, row.epoch, new Date().toISOString());
    if (existing) return { credential, csrfToken: csrf(credential), expiresAt: existing.expires_at };
    return this.db.transaction(() => {
      this.db.run('DELETE FROM plugin_share_sessions WHERE expires_at <= ?', new Date().toISOString());
      const count = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM plugin_share_sessions WHERE share_id = ?', row.id)!.n;
      if (count >= 200) throw new HttpException('Advice session limit reached', 429);
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Math.min(Date.parse(row.expires_at), Date.now() + 30 * 86400000)).toISOString();
      this.db.run('INSERT INTO plugin_share_sessions (id, share_id, epoch, guest_id, credential_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), row.id, row.epoch, randomUUID(), hash(secret), expiresAt);
      return { credential: secret, csrfToken: csrf(secret), expiresAt };
    });
  }
  authorize(token: string, credential: string | undefined, csrfToken: string | undefined): PublicSharePrincipal {
    const row = this.byToken(token);
    if (!credential) throw new UnauthorizedException('Advice session required');
    const expected = Buffer.from(csrf(credential));
    const supplied = Buffer.from(csrfToken ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ForbiddenException('Invalid advice CSRF token');
    const session = this.db.get<Session>('SELECT * FROM plugin_share_sessions WHERE share_id = ? AND credential_hash = ?', row.id, hash(credential));
    if (!session) throw new UnauthorizedException('Advice session required');
    const principal: PublicSharePrincipal = { kind: 'publicShare', pluginId: ADVICE_PLUGIN_ID, shareId: row.id, epoch: row.epoch, sessionId: session.id, guestId: session.guest_id };
    this.validatePrincipal(principal);
    this.limit('action-session', session.id, 30); this.limit('action-share', row.id, 300);
    return principal;
  }
  authorizePhoto(token: string, credential: string | undefined, csrfToken: string | undefined): PublicSharePrincipal {
    const row = this.byToken(token);
    if (!credential) throw new UnauthorizedException('Advice session required');
    const expected = Buffer.from(csrf(credential));
    const supplied = Buffer.from(csrfToken ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ForbiddenException('Invalid advice CSRF token');
    const session = this.db.get<Session>('SELECT * FROM plugin_share_sessions WHERE share_id = ? AND credential_hash = ?', row.id, hash(credential));
    if (!session) throw new UnauthorizedException('Advice session required');
    const principal: PublicSharePrincipal = { kind: 'publicShare', pluginId: ADVICE_PLUGIN_ID, shareId: row.id, epoch: row.epoch, sessionId: session.id, guestId: session.guest_id };
    this.validatePrincipal(principal);
    return principal;
  }
  validatePrincipal(scope: PublicSharePrincipal) {
    if (scope.pluginId !== ADVICE_PLUGIN_ID) this.unavailable();
    const row = this.live(this.db.get<Link>('SELECT * FROM plugin_share_links WHERE id = ?', scope.shareId));
    const session = this.db.get<Session>('SELECT * FROM plugin_share_sessions WHERE id = ? AND share_id = ?', scope.sessionId, scope.shareId);
    if (row.epoch !== scope.epoch || !session || session.epoch !== scope.epoch || session.guest_id !== scope.guestId || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) this.unavailable();
    return row;
  }
  snapshot(scope: PublicSharePrincipal) {
    const row = this.validatePrincipal(scope);
    return this.projection.build(row.trip_id, adviceShareConfigSchema.parse(JSON.parse(row.config_json)));
  }
  /** Host-derived city geometry for the provider's soft bias. No country code
   * is sent as an includedRegionCodes restriction: configured geography is only
   * a ranking hint, and the guest cannot supply a rectangle. */
  publicCity(scope: PublicSharePrincipal, cityId: string) {
    const row = this.validatePrincipal(scope);
    const config = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    const city = config.cities.find(candidate => candidate.id === cityId);
    return city ? { bounds: city.bounds } : null;
  }
}
