import { Injectable, NotFoundException, ForbiddenException, ConflictException, UnauthorizedException, HttpException, Optional } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ADVICE_PLUGIN_ID, ADVICE_SHARE_PERMISSION, adviceBootstrapSchema, adviceNativeImportSchema, adviceOwnerWriteSchema, adviceShareConfigSchema, advicePublicShareCapabilitySchema, adviceShareConfigV2Schema, adviceOwnerWriteV2Schema } from '@trek/shared';
import type { AdviceNativeImportResult, AdviceAddedCity } from '@trek/shared';
import { canonicalWebOrigin, readEnv } from '../../app-config';
import { DatabaseService } from '../database/database.service';
import { PermissionsService } from '../permissions/permissions.service';
import { RateLimitService } from '../common/rate-limit.service';
import { PluginShareProjectionService } from './plugin-share-projection.service';
import type { PublicSharePrincipal } from '../plugins/protocol/envelope';
import type { User } from '../../types';
import { PluginShareLifecycleService } from './plugin-share-lifecycle.service';

interface Link { id: string; trip_id: number; token: string; enabled: number; epoch: number; revision: number; config_json: string; expires_at: string; retention_started_at: string | null }
interface Session { id: string; share_id: string; epoch: number; guest_id: string; credential_hash: string; expires_at: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const csrf = (s: string) => createHmac('sha256', s).update('trek-advice-csrf-v1').digest('base64url');
export const ADVICE_COOKIE = '__Secure-trek-advice';
export interface OwnerAdvicePrincipal { kind: 'adviceOwner'; pluginId: 'trip-advice'; tripId: number; userId: number;
  shareId: string; sessionId: string; guestId: string; epoch: number; preview: boolean }
export type AdviceProviderPrincipal = PublicSharePrincipal | OwnerAdvicePrincipal;

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
      const cap = z.object({ publicShare: advicePublicShareCapabilitySchema }).parse(JSON.parse(row.capabilities));
      if (!granted.includes(ADVICE_SHARE_PERMISSION) || !cap.publicShare) this.unavailable();
      return cap.publicShare;
    } catch { this.unavailable(); }
  }
  private live(row: Link | undefined): Link {
    this.available();
    if (!row || !row.enabled || !Number.isFinite(Date.parse(row.expires_at))) this.unavailable();
    if (Date.parse(row.expires_at) <= Date.now()) {
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
  socialMetadata(token: string) {
    const row = this.byToken(token);
    const trip = this.db.get<{ title: string; description: string | null; cover_image: string | null }>(
      'SELECT title, description, cover_image FROM trips WHERE id = ?', row.trip_id);
    if (!trip) this.unavailable();
    const native = adviceShareConfigV2Schema.safeParse(JSON.parse(row.config_json));
    if (native.success) {
      if (this.available().version !== 2) this.unavailable();
      return { title: this.projection.buildV2(row.trip_id, native.data).title, description: trip.description, coverImage: trip.cover_image };
    }
    const config = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    return { title: config.source === 'trip' ? trip.title : config.publicTitle, description: null, coverImage: null };
  }
  bootstrap(token: string) {
    const row = this.byToken(token);
    const native = adviceShareConfigV2Schema.safeParse(JSON.parse(row.config_json));
    if (native.success && this.available().version !== 2) this.unavailable();
    if (native.success) return adviceBootstrapSchema.parse({ kind: 'plugin-share', version: 2,
      title: this.projection.buildV2(row.trip_id, native.data).title, expiresAt: row.expires_at,
      plugin: { id: ADVICE_PLUGIN_ID, surface: 'native', protocolVersion: 2 } });
    const config = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    const title = config.source === 'trip'
      ? this.db.get<{ title: string }>('SELECT title FROM trips WHERE id = ?', row.trip_id)?.title.slice(0, 200)
      : config.publicTitle;
    return adviceBootstrapSchema.parse({ kind: 'plugin-share', version: 1, title,
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

  private ownerResult(row: Link) {
    return { shareId: row.id, token: row.token, enabled: !!row.enabled, revision: row.revision,
      expiresAt: row.expires_at, config: z.union([adviceShareConfigSchema, adviceShareConfigV2Schema]).parse(JSON.parse(row.config_json)) };
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
        this.lifecycle?.enqueueDue(row.id);
        const retentionStart = body.enabled ? null : row.retention_started_at ?? new Date(Math.min(Date.now(), Date.parse(row.expires_at))).toISOString();
        this.db.run('UPDATE plugin_share_links SET config_json = ?, enabled = ?, expires_at = ?, retention_started_at = ?, feedback_purge_queued = CASE WHEN ? THEN 0 ELSE feedback_purge_queued END, revision = revision + 1, epoch = epoch + 1 WHERE id = ?', JSON.stringify(body.config), Number(body.enabled), expires, retentionStart, Number(body.enabled), row.id);
        this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
      } else {
        this.db.run('INSERT INTO plugin_share_links (id, trip_id, token, created_by, config_json, enabled, expires_at, retention_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          randomUUID(), tripId, this.newToken(), user.id, JSON.stringify(body.config), Number(body.enabled), expires, body.enabled ? null : new Date(Date.now()).toISOString());
      }
      return this.getOwner(tripId, user)!;
    });
    this.lifecycle?.flushInBackground();
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
    return result;
  }

  ownerCandidates(tripId: number, userId: number) {
    this.requireManage(tripId, this.actor(userId));
    return this.projection.candidates(tripId);
  }

  ownerPreview(tripId: number, userId: number, config: unknown) {
    return this.preview(tripId, this.actor(userId), config);
  }

  ownerConfigure(tripId: number, userId: number, input: unknown) {
    return this.write(tripId, this.actor(userId), adviceOwnerWriteSchema.parse(input));
  }

  private legacyHash(row: Link) {
    const config = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    return hash(JSON.stringify({ config, projection: this.projection.build(row.trip_id, config) }));
  }

  private nativeConfig(row: Link) {
    const stored = z.union([adviceShareConfigSchema, adviceShareConfigV2Schema]).parse(JSON.parse(row.config_json));
    const native = adviceShareConfigV2Schema.safeParse(stored);
    return native.success ? native.data : this.projection.migrateV1(row.trip_id, adviceShareConfigSchema.parse(stored));
  }

  ownerNative(tripId: number, userId: number) {
    this.requireManage(tripId, this.actor(userId));
    const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
    const stored = row ? z.union([adviceShareConfigSchema, adviceShareConfigV2Schema]).parse(JSON.parse(row.config_json)) : null;
    const native = adviceShareConfigV2Schema.safeParse(stored);
    const draftConfig = native.success ? native.data : this.projection.migrateV1(tripId, row ? adviceShareConfigSchema.parse(stored) : this.projection.preset(tripId));
    return { version: 2 as const, config: row ? { shareId: row.id, token: row.token, enabled: !!row.enabled, revision: row.revision, expiresAt: row.expires_at, config: stored } : null,
      legacy: !!row && !native.success, ...(row && !native.success ? { upgradeRevision: this.legacyHash(row) } : {}),
      draftConfig, projection: this.projection.buildV2(tripId, draftConfig, true) };
  }

  ownerNativeConfigure(tripId: number, userId: number, input: unknown) {
    const actor = this.actor(userId);
    this.requireManage(tripId, actor);
    const body = adviceOwnerWriteV2Schema.parse(input);
    this.projection.buildV2(tripId, body.config);
    if (body.enabled && this.available().version !== 2) throw new ConflictException('Native advice plugin upgrade required');
    this.db.transaction(() => {
      const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
      if ((row?.revision ?? 0) !== body.expectedRevision) throw new ConflictException('Advice configuration changed');
      const stored = row ? JSON.parse(row.config_json) : null;
      const native = adviceShareConfigV2Schema.safeParse(stored);
      if (row && !native.success && (!body.upgradeToV2 || body.upgradeToV2.expectedLegacyHash !== this.legacyHash(row))) throw new ConflictException('Review the native advice upgrade before saving');
      const existingCities = native.success ? native.data.addedCities : [];
      if (body.config.addedCities.some(city => !existingCities.some(existing => JSON.stringify(existing) === JSON.stringify(city)))) throw new ForbiddenException('Resolve added cities through the owner city search');
      const expires = new Date(Date.now() + body.expiresInDays * 86400000).toISOString();
      if (row) {
        this.lifecycle?.enqueueDue(row.id);
        const retentionStart = body.enabled ? null : row.retention_started_at ?? new Date(Math.min(Date.now(), Date.parse(row.expires_at))).toISOString();
        this.db.run('UPDATE plugin_share_links SET config_json = ?, enabled = ?, expires_at = ?, retention_started_at = ?, feedback_purge_queued = CASE WHEN ? THEN 0 ELSE feedback_purge_queued END, revision = revision + 1, epoch = epoch + 1 WHERE id = ?', JSON.stringify(body.config), Number(body.enabled), expires, retentionStart, Number(body.enabled), row.id);
        if (body.enabled) {
          // Visibility autosaves change the share epoch so every subsequent
          // action is checked against the new projection. Preserve each guest's
          // identity by advancing its bound session to that same epoch.
          this.db.run('UPDATE plugin_share_sessions SET epoch = (SELECT epoch FROM plugin_share_links WHERE id = ?) WHERE share_id = ?', row.id, row.id);
        } else {
          this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
        }
      } else {
        this.db.run('INSERT INTO plugin_share_links (id, trip_id, token, created_by, config_json, enabled, expires_at, retention_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          randomUUID(), tripId, this.newToken(), userId, JSON.stringify(body.config), Number(body.enabled), expires, body.enabled ? null : new Date().toISOString());
      }
    });
    this.lifecycle?.flushInBackground();
    return this.ownerNative(tripId, userId);
  }

  ownerNativePreview(tripId: number, userId: number, input: unknown) {
    this.requireManage(tripId, this.actor(userId));
    return this.projection.buildV2(tripId, adviceShareConfigV2Schema.parse(input));
  }

  requireNativeOwner(tripId: number, userId: number) {
    const actor = this.actor(userId);
    this.requireManage(tripId, actor);
    return actor;
  }

  ownerPrincipal(tripId: number, userId: number, passive = false): OwnerAdvicePrincipal {
    this.requireNativeOwner(tripId, userId);
    const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
    if (!row) throw new ConflictException('Create the advice link first');
    const preview = !adviceShareConfigV2Schema.safeParse(JSON.parse(row.config_json)).success;
    this.nativeConfig(row);
    const sessionId = `owner:${tripId}:${userId}`;
    this.limit(passive ? 'media-session' : 'action-session', sessionId, passive ? 120 : 30);
    this.limit(passive ? 'media-share' : 'action-share', row.id, passive ? 600 : 300);
    return { kind: 'adviceOwner', pluginId: ADVICE_PLUGIN_ID, tripId, userId, shareId: row.id, sessionId, guestId: sessionId, epoch: row.revision, preview };
  }

  validateProviderPrincipal(principal: AdviceProviderPrincipal) {
    if (principal.kind === 'publicShare') return this.validatePrincipal(principal);
    this.requireNativeOwner(principal.tripId, principal.userId);
    const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ? AND id = ?', principal.tripId, principal.shareId);
    if (!row || row.revision !== principal.epoch) throw new ConflictException('Advice configuration changed');
    return row;
  }

  providerSnapshot(principal: AdviceProviderPrincipal) {
    if (principal.kind === 'publicShare') return this.snapshot(principal);
    const row = this.validateProviderPrincipal(principal);
    return this.projection.buildV2(principal.tripId, this.nativeConfig(row), true);
  }

  providerCities(principal: AdviceProviderPrincipal) {
    if (principal.kind === 'publicShare') return this.publicCities(principal);
    const row = this.validateProviderPrincipal(principal);
    const config = this.nativeConfig(row);
    const projectedIds = new Set(this.projection.buildV2(principal.tripId, config, true).cities.map(city => city.id));
    return [...this.projection.preset(principal.tripId).cities,
      ...config.addedCities.map(city => ({ id: city.key, label: city.label, countryCodes: city.countryCodes, bounds: city.bounds }))]
      .filter(city => projectedIds.has(city.id))
      .flatMap(city => city.bounds && city.countryCodes.length ? [{ ...city, bounds: city.bounds }] : []);
  }

  addNativeCity(tripId: number, userId: number, expectedRevision: number, city: AdviceAddedCity) {
    this.requireNativeOwner(tripId, userId);
    this.db.transaction(() => {
      const row = this.db.get<Link>('SELECT * FROM plugin_share_links WHERE trip_id = ?', tripId);
      if (!row || row.revision !== expectedRevision) throw new ConflictException('Advice configuration changed');
      const config = adviceShareConfigV2Schema.parse(JSON.parse(row.config_json));
      if (config.addedCities.some(existing => existing.key === city.key) || this.projection.preset(tripId).cities.some(existing => existing.id === city.key)) throw new ConflictException('City already exists');
      const updated = adviceShareConfigV2Schema.parse({ ...config, addedCities: [...config.addedCities, city] });
      this.projection.buildV2(tripId, updated);
      this.db.run('UPDATE plugin_share_links SET config_json = ?, revision = revision + 1, epoch = epoch + 1 WHERE id = ?', JSON.stringify(updated), row.id);
      this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
    });
    return this.ownerNative(tripId, userId);
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
      if (!rotate) this.lifecycle?.enqueuePurge(row.id);
      this.db.run('UPDATE plugin_share_links SET token = ?, enabled = ?, epoch = epoch + 1, revision = revision + 1 WHERE id = ?', rotate ? this.newToken() : row.token, rotate ? row.enabled : 0, row.id);
      this.db.run('DELETE FROM plugin_share_sessions WHERE share_id = ?', row.id);
      return this.ownerResult(this.db.get<Link>('SELECT * FROM plugin_share_links WHERE id = ?', row.id)!);
    });
    this.lifecycle?.flushInBackground();
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
    if (expected.protocol !== 'https:' || expected.origin !== canonicalWebOrigin(origin)) throw new ForbiddenException('Same-origin request required');
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
    const principal = this.authorizeSession(token, credential, csrfToken);
    this.limit('action-session', principal.sessionId, 30); this.limit('action-share', principal.shareId, 300);
    return principal;
  }
  authorizeMedia(token: string, credential: string | undefined, csrfToken: string | undefined): PublicSharePrincipal {
    const principal = this.authorizeSession(token, credential, csrfToken);
    this.limit('media-session', principal.sessionId, 120); this.limit('media-share', principal.shareId, 600);
    return principal;
  }
  authorizePhoto(token: string, credential: string | undefined, csrfToken: string | undefined): PublicSharePrincipal {
    return this.authorizeSession(token, credential, csrfToken);
  }
  private authorizeSession(token: string, credential: string | undefined, csrfToken: string | undefined): PublicSharePrincipal {
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
  completeGuestErasure(scope: PublicSharePrincipal): void {
    this.db.transaction(() => {
      this.validatePrincipal(scope);
      this.lifecycle?.enqueueEraseGuest(scope.shareId, scope.guestId);
      this.db.run('DELETE FROM plugin_share_sessions WHERE id = ? AND share_id = ? AND guest_id = ?',
        scope.sessionId, scope.shareId, scope.guestId);
    });
    this.lifecycle?.flushInBackground();
  }
  snapshot(scope: PublicSharePrincipal) {
    const row = this.validatePrincipal(scope);
    const stored = JSON.parse(row.config_json);
    const native = adviceShareConfigV2Schema.safeParse(stored);
    return native.success ? this.projection.buildV2(row.trip_id, native.data) : this.projection.build(row.trip_id, adviceShareConfigSchema.parse(stored));
  }
  filterSuggestionKeys(scope: PublicSharePrincipal, keys: string[]) {
    const row = this.validatePrincipal(scope);
    const config = adviceShareConfigV2Schema.safeParse(JSON.parse(row.config_json));
    return config.success ? keys.filter(key => !config.data.hiddenIdeaKeys.includes(key)) : keys;
  }
  /** Host-derived city geometry for the provider's soft bias. No country code
   * is sent as an includedRegionCodes restriction: configured geography is only
   * a ranking hint, and the guest cannot supply a rectangle. */
  publicCity(scope: PublicSharePrincipal, cityId: string) {
    const city = this.publicCities(scope).find(candidate => candidate.id === cityId);
    return city ? { bounds: city.bounds } : null;
  }

  publicCities(scope: PublicSharePrincipal) {
    const row = this.validatePrincipal(scope);
    const native = adviceShareConfigV2Schema.safeParse(JSON.parse(row.config_json));
    if (native.success) {
      const visible = new Set(this.projection.buildV2(row.trip_id, native.data).cities.map(city => city.id));
      return [...this.projection.preset(row.trip_id).cities,
        ...native.data.addedCities.map(city => ({ id: city.key, label: city.label, countryCodes: city.countryCodes, bounds: city.bounds }))]
        .flatMap(city => visible.has(city.id) && city.bounds && city.countryCodes.length ? [{ ...city, bounds: city.bounds }] : []);
    }
    const stored = adviceShareConfigSchema.parse(JSON.parse(row.config_json));
    const config = stored.source === 'trip' ? this.projection.preset(row.trip_id, stored.hidden) : stored;
    return config.cities.flatMap(city => city.bounds && city.countryCodes.length ? [{ ...city, bounds: city.bounds }] : []);
  }
}
