import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return { testDb: db, dbMock: {
    db, canAccessTrip: (tripId: number | string, userId: number) => db.prepare('SELECT id, user_id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
    isOwner: () => false, getPlaceWithTags: () => null,
  } };
});
vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({ JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2', updateJwtSecret: () => {} }));

import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { DatabaseService } from '../../src/nest/database/database.service';
import { PermissionsService } from '../../src/nest/permissions/permissions.service';
import { RateLimitService } from '../../src/nest/common/rate-limit.service';
import { PluginShareProjectionService } from '../../src/nest/plugin-shares/plugin-share-projection.service';
import { PluginSharesService, ADVICE_COOKIE } from '../../src/nest/plugin-shares/plugin-shares.service';
import { PluginShareLifecycleService } from '../../src/nest/plugin-shares/plugin-share-lifecycle.service';
import { PluginShareOwnerController, PluginSharePublicController } from '../../src/nest/plugin-shares/plugin-shares.controller';
import { PluginRuntimeService } from '../../src/nest/plugins/plugin-runtime.service';
import { SharedController } from '../../src/nest/share/share.controller';
import { ShareService } from '../../src/nest/share/share.service';
import { StorageService } from '../../src/nest/storage/storage.service';
import { GlobalAuthGuard } from '../../src/nest/auth/global-auth.guard';
import { ZodValidationPipe } from '../../src/nest/common/zod-validation.pipe';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';
import { validateBodyContracts } from '../../src/nest/common/validate-body-contracts';
import { validateRouteGuards, PUBLIC_ROUTE_ALLOW_LIST } from '../../src/nest/common/validate-route-guards';
import { createUser, createTrip, createDay, createPlace, createDayAssignment, createCategory } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import type { AdviceReadResult, AdviceShareConfig } from '@trek/shared';
import type { PublicSharePrincipal } from '../../src/nest/plugins/protocol/envelope';
import type { User } from '../../src/types';

const db = new DatabaseService(testDb);
const permissions = new PermissionsService(db);
const permission = vi.spyOn(permissions, 'checkPermission');
const limiter = new RateLimitService();
const projection = new PluginShareProjectionService(db);
const shares = new PluginSharesService(db, permissions, projection, limiter);
const invoke = vi.fn(async (principal: PublicSharePrincipal): Promise<unknown> => ({
  projection: shares.snapshot(principal), feedbackRevision: 0, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null,
}));
const legacyRead = vi.fn();
let app: INestApplication;
let tripId: number;
let owner: User;
let config: AdviceShareConfig;
let assignmentId: number;
let categoryId: number;
let scheduledPlaceId: number;
let shortlistPlaceId: number;
let dayId: number;
const ownerPath = () => `/api/trips/${tripId}/share-link/plugins/trip-advice`;
const publicPath = (token: string) => `/api/shared/${token}/plugins/trip-advice`;
const origin = { Origin: 'https://trek.example.test', 'Sec-Fetch-Site': 'same-origin' };

beforeAll(async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  createTables(testDb); runMigrations(testDb); runMigrations(testDb);
  log.mockRestore();
  const module = await Test.createTestingModule({
    controllers: [PluginShareOwnerController, PluginSharePublicController, SharedController],
    providers: [
      { provide: PluginSharesService, useValue: shares },
      { provide: PluginRuntimeService, useValue: { isActive: () => true, grantsOf: () => new Set(['share:guest']), invokePublicShare: invoke } },
      { provide: ShareService, useValue: { getSharedTripData: legacyRead, getSharedPlacePhotoKey: () => null } },
      { provide: StorageService, useValue: {} },
    ],
  }).compile();
  app = module.createNestApplication();
  app.use(cookieParser());
  app.useGlobalGuards(new GlobalAuthGuard(new Reflector()));
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new TrekExceptionFilter());
  await app.init();
});
beforeEach(() => {
  vi.stubEnv('TREK_PUBLIC_ADVICE_ENABLED', 'true'); vi.stubEnv('TREK_PLUGINS_ENABLED', 'true'); vi.stubEnv('APP_URL', origin.Origin);
  testDb.exec('DELETE FROM trips; DELETE FROM users; DELETE FROM plugins; DELETE FROM plugin_share_lifecycle_outbox;');
  limiter.reset(); permission.mockReturnValue(true); legacyRead.mockReset().mockReturnValue(null); invoke.mockClear();
  owner = createUser(testDb).user as User;
  tripId = createTrip(testDb, owner.id).id;
  categoryId = createCategory(testDb).id;
  dayId = createDay(testDb, tripId, { date: '2026-10-09' }).id;
  const returnDay = createDay(testDb, tripId, { date: '2026-10-23' }).id;
  scheduledPlaceId = createPlace(testDb, tripId).id;
  shortlistPlaceId = createPlace(testDb, tripId).id;
  assignmentId = createDayAssignment(testDb, dayId, scheduledPlaceId).id;
  db.run('UPDATE places SET notes = ?, reservation_notes = ?, phone = ?, website = ? WHERE trip_id = ?', 'PRIVATE-CANARY', 'PRIVATE-CANARY', 'PRIVATE-CANARY', 'https://private.invalid', tripId);
  db.run('UPDATE days SET notes = ? WHERE trip_id = ?', 'PRIVATE-CANARY', tripId);
  db.run('UPDATE day_assignments SET assignment_time = ?, notes = ? WHERE id = ?', '12:30', 'PRIVATE-CANARY', assignmentId);
  db.run(`INSERT INTO plugins (id, name, enabled, status, permissions, granted_permissions, capabilities)
    VALUES ('trip-advice', 'Trip advice', 1, 'active', '["share:guest"]', '["share:guest"]', '{"publicShare":{"version":1,"entry":"guest.html"}}')`);
  config = { version: 1, publicTitle: 'Public Japan',
    cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'], bounds: { south: 35, north: 36, west: 139, east: 140 } }],
    stays: [{ id: 'first', cityId: 'tokyo', dayIds: [dayId] }, { id: 'return', cityId: 'tokyo', dayIds: [returnDay] }],
    schedule: [{ assignmentId, publicTitle: 'Museum', category: 'see' }],
    shortlist: [{ placeId: shortlistPlaceId, cityId: 'tokyo', category: 'eat', publicTitle: 'Cafe', locality: 'Tokyo', countryCode: 'JP' }],
  };
});
afterAll(async () => { await app.close(); testDb.close(); vi.unstubAllEnvs(); });
const publish = () => shares.write(tripId, owner, { config, expectedRevision: 0, enabled: true, expiresInDays: 10 });

describe('advice authority and public HTTP', () => {
  it('returns owner-only setup candidates before a share exists without leaking private fields', () => {
    const otherOwner = createUser(testDb).user as User;
    const otherTrip = createTrip(testDb, otherOwner.id).id;
    createPlace(testDb, otherTrip, { name: 'OTHER-TRIP-CANARY' });
    const result = shares.ownerCandidates(tripId, owner.id);
    expect(result.days).toContainEqual({ id: dayId, date: '2026-10-09' });
    expect(result.schedule).toEqual([expect.objectContaining({ assignmentId, dayId, placeId: scheduledPlaceId })]);
    expect(result.shortlist).toEqual([expect.objectContaining({ placeId: shortlistPlaceId })]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-CANARY');
    expect(JSON.stringify(result)).not.toContain('OTHER-TRIP-CANARY');
    expect(shares.getOwner(tripId, owner)).toBeNull();
    expect(() => shares.ownerCandidates(tripId, otherOwner.id)).toThrow('Trip not found');
    permission.mockReturnValue(false);
    expect(() => shares.ownerCandidates(tripId, owner.id)).toThrow('No permission');
  });
  it('satisfies route and body ratchets for the assembled controllers', () => {
    const ids = ['SharedController.read', 'SharedController.placePhotoBytes', 'PluginSharePublicController.session', 'PluginSharePublicController.action', 'PluginSharePublicController.photo'];
    expect(PUBLIC_ROUTE_ALLOW_LIST).toEqual(expect.arrayContaining(ids));
    expect(() => validateRouteGuards(app, ids, [])).not.toThrow();
    expect(() => validateBodyContracts(app, [])).not.toThrow();
  });
  it('requires member authentication and the real share_manage permission; checks revisions', async () => {
    await request(app.getHttpServer()).get(ownerPath()).expect(401);
    permission.mockReturnValue(false);
    await request(app.getHttpServer()).get(ownerPath()).set('Cookie', authCookie(owner.id)).expect(403);
    expect(permission).toHaveBeenCalledWith('share_manage', owner.role, owner.id, owner.id, false);
    permission.mockReturnValue(true);
    const body = { config, expectedRevision: 0, enabled: true, expiresInDays: 10 };
    await request(app.getHttpServer()).put(ownerPath()).set('Cookie', authCookie(owner.id)).send(body).expect(200);
    await request(app.getHttpServer()).put(ownerPath()).set('Cookie', authCookie(owner.id)).send(body).expect(409);
  });
  it('separates bootstrap from legacy projection and refuses legacy tokens on advice', async () => {
    const link = publish();
    expect(db.get('SELECT 1 FROM share_tokens WHERE token = ?', link.token)).toBeUndefined();
    const result = await request(app.getHttpServer()).get(`/api/shared/${link.token}`).expect(200);
    expect(result.body.plugin).toEqual({ id: 'trip-advice', entry: 'guest.html', protocolVersion: 1 });
    expect(result.headers['cache-control']).toBe('no-store'); expect(legacyRead).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(`${publicPath('L'.repeat(32))}/session`).set(origin).send({}).expect(404);
    await request(app.getHttpServer()).get(`/api/shared/${link.token}/place-photo/${shortlistPlaceId}/bytes`).expect(204);
    await request(app.getHttpServer()).get('/api/shared/legacy-token').expect(404);
    expect(legacyRead).toHaveBeenCalledWith('legacy-token');
  });
  it('mints only same-origin scoped cookies and never delegates member identity', async () => {
    const link = publish();
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/session`).send({}).expect(403);
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/session`).set({ ...origin, Origin: 'https://evil.test' }).send({}).expect(403);
    const session = await request(app.getHttpServer()).post(`${publicPath(link.token)}/session`).set(origin).send({}).expect(200);
    const cookie = session.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain(`Path=${publicPath(link.token)}`);
    const credentials = `${cookie.split(';')[0]}; ${authCookie(owner.id)}`;
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin).set('Cookie', credentials).send({ version: 1, kind: 'read' }).expect(403);
    const result = await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin).set('Cookie', credentials)
      .set('X-Trek-Advice-CSRF', session.body.csrfToken).send({ version: 1, kind: 'read' }).expect(200);
    expect(invoke.mock.calls[0]![0]).toMatchObject({ kind: 'publicShare', pluginId: 'trip-advice' });
    expect(invoke.mock.calls[0]![0]).not.toHaveProperty('actingUserId');
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE-CANARY|private.invalid|confirmation_number|reservation_notes|user_id/);
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin).set('Cookie', credentials)
      .set('X-Trek-Advice-CSRF', session.body.csrfToken).send({ version: 1, kind: 'read', actingUserId: owner.id }).expect(400);
  });
  it('preserves session identity across reloads and rejects cross-share/ambiguous cookies', () => {
    const a = publish(); const first = shares.session(a.token, undefined, '127.0.0.1');
    expect(shares.session(a.token, first.credential, '127.0.0.1')).toEqual(first);
    expect(() => shares.credential(`${ADVICE_COOKIE}=${first.credential}; ${ADVICE_COOKIE}=${first.credential}`)).toThrow();
    const other = createTrip(testDb, owner.id).id;
    const b = shares.write(other, owner, { expectedRevision: 0, enabled: true, expiresInDays: 10, config: { ...config, stays: [], schedule: [], shortlist: [] } });
    expect(() => shares.authorize(b.token, first.credential, first.csrfToken)).toThrow();
    expect(db.get<{ credential_hash: string }>('SELECT credential_hash FROM plugin_share_sessions')!.credential_hash).not.toBe(first.credential);
  });
  it('revokes old sessions on rotation, config change, disable and expiry', () => {
    const link = publish(); const s = shares.session(link.token, undefined, 'ip');
    const principal = shares.authorize(link.token, s.credential, s.csrfToken);
    const rotated = shares.revoke(tripId, owner, link.revision, true);
    expect(rotated.token).not.toBe(link.token);
    expect(() => shares.validatePrincipal(principal)).toThrow();
    expect(() => shares.bootstrap(link.token)).toThrow();
    const current = shares.session(rotated.token, undefined, 'ip');
    const live = shares.authorize(rotated.token, current.credential, current.csrfToken);
    shares.write(tripId, owner, { config, expectedRevision: rotated.revision, enabled: false, expiresInDays: 10 });
    expect(() => shares.validatePrincipal(live)).toThrow();
    db.run('UPDATE plugin_share_links SET enabled = 1, expires_at = ?', '2000-01-01T00:00:00.000Z');
    expect(() => shares.bootstrap(rotated.token)).toThrow();
  });
  it.each(['configuration', 'rotation'] as const)('preserves feedback on %s changes while revoking guest authority', change => {
    const link = publish();
    const guest = shares.session(link.token, undefined, 'preserve-feedback');
    const principal = shares.authorize(link.token, guest.credential, guest.csrfToken);
    const lifecycle = new PluginShareLifecycleService(db);
    const managed = new PluginSharesService(db, permissions, projection, limiter, lifecycle);
    const updated = change === 'rotation'
      ? managed.revoke(tripId, owner, link.revision, true)
      : managed.write(tripId, owner, { config: { ...config, publicTitle: 'Updated public title' }, expectedRevision: link.revision, enabled: true, expiresInDays: 10 });
    expect(updated.revision).toBe(link.revision + 1);
    expect(() => managed.validatePrincipal(principal)).toThrow();
    expect(db.all('SELECT method FROM plugin_share_lifecycle_outbox WHERE share_id = ?', link.shareId)).toEqual([]);
  });
  it.each(['disable', 'delete'] as const)('still queues cleanup for explicit %s', change => {
    const link = publish();
    const lifecycle = new PluginShareLifecycleService(db);
    const managed = new PluginSharesService(db, permissions, projection, limiter, lifecycle);
    if (change === 'delete') managed.revoke(tripId, owner, link.revision, false);
    else managed.write(tripId, owner, { config, expectedRevision: link.revision, enabled: false, expiresInDays: 10 });
    expect(db.all('SELECT method FROM plugin_share_lifecycle_outbox WHERE share_id = ?', link.shareId)).toEqual([{ method: 'purge' }]);
  });
  it('revokes erased guest credentials server-side while preserving another guest session', async () => {
    const link = publish();
    const erased = shares.session(link.token, undefined, 'erase-ip');
    const other = shares.session(link.token, undefined, 'other-ip');
    invoke.mockResolvedValueOnce({ version: 1, kind: 'session.erase', data: { erased: true } });
    const result = await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin)
      .set('Cookie', `${ADVICE_COOKIE}=${erased.credential}`).set('X-Trek-Advice-CSRF', erased.csrfToken)
      .send({ version: 1, kind: 'session.erase', requestId: '11111111-1111-4111-8111-111111111111' }).expect(200);
    expect(result.headers['set-cookie'][0]).toContain(`${ADVICE_COOKIE}=;`);
    expect(() => shares.authorize(link.token, erased.credential, erased.csrfToken)).toThrow();
    expect(() => shares.authorize(link.token, other.credential, other.csrfToken)).not.toThrow();
  });
  it('keeps the guest session when erasure is not acknowledged', async () => {
    const link = publish();
    const session = shares.session(link.token, undefined, 'erase-ip');
    invoke.mockResolvedValueOnce({ version: 1, kind: 'session.erase', data: { erased: false } });
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin)
      .set('Cookie', `${ADVICE_COOKIE}=${session.credential}`).set('X-Trek-Advice-CSRF', session.csrfToken)
      .send({ version: 1, kind: 'session.erase', requestId: '11111111-1111-4111-8111-111111111111' }).expect(503);
    expect(() => shares.authorize(link.token, session.credential, session.csrfToken)).not.toThrow();
  });
  it('durably queues residual guest cleanup with server-side revocation', () => {
    const link = publish();
    const session = shares.session(link.token, undefined, 'erase-ip');
    const principal = shares.authorize(link.token, session.credential, session.csrfToken);
    const lifecycle = new PluginShareLifecycleService(db);
    const lifecycleShares = new PluginSharesService(db, permissions, projection, limiter, lifecycle);
    lifecycleShares.completeGuestErasure(principal);
    expect(() => shares.validatePrincipal(principal)).toThrow();
    expect(db.all('SELECT method, share_id, guest_id FROM plugin_share_lifecycle_outbox')).toEqual([
      { method: 'erase_guest', share_id: principal.shareId, guest_id: principal.guestId },
    ]);
  });
  it('discards a result completed after share revocation', async () => {
    const link = publish(); const session = shares.session(link.token, undefined, 'ip');
    invoke.mockImplementationOnce(async principal => {
      const result: AdviceReadResult = {
        projection: shares.snapshot(principal), feedbackRevision: 0, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null,
      };
      shares.revoke(tripId, owner, link.revision, false);
      return result;
    });
    await request(app.getHttpServer()).post(`${publicPath(link.token)}/actions`).set(origin)
      .set('Cookie', `${ADVICE_COOKIE}=${session.credential}`).set('X-Trek-Advice-CSRF', session.csrfToken)
      .send({ version: 1, kind: 'read' }).expect(404);
  });
  it('cascades link and session authority on trip deletion', () => {
    const link = publish(); const s = shares.session(link.token, undefined, 'ip');
    const principal = shares.authorize(link.token, s.credential, s.csrfToken);
    db.run('DELETE FROM trips WHERE id = ?', tripId);
    expect(db.get('SELECT 1 FROM plugin_share_links')).toBeUndefined();
    expect(db.get('SELECT 1 FROM plugin_share_sessions')).toBeUndefined();
    expect(() => shares.validatePrincipal(principal)).toThrow();
  });
  it('durably records cascading trip cleanup until the addon acknowledges it', async () => {
    const link = publish();
    db.run('DELETE FROM trips WHERE id = ?', tripId);
    expect(db.all('SELECT method, share_id, guest_id FROM plugin_share_lifecycle_outbox')).toEqual([
      { method: 'purge', share_id: link.shareId, guest_id: '' },
    ]);
    const lifecycle = new PluginShareLifecycleService(db);
    const invokeLifecycle = vi.fn().mockResolvedValue({ ok: true });
    lifecycle.bind(invokeLifecycle);
    await vi.waitFor(() => expect(invokeLifecycle).toHaveBeenCalledWith('invoke.publicShare.purge', { shareId: link.shareId }));
    expect(db.all('SELECT * FROM plugin_share_lifecycle_outbox')).toEqual([]);
  });
  it('fails closed on flag, plugin disable, grant withdrawal and malformed capability', () => {
    const link = publish();
    for (const value of ['', 'false', 'garbage']) { vi.stubEnv('TREK_PUBLIC_ADVICE_ENABLED', value); expect(() => shares.bootstrap(link.token)).toThrow(); }
    vi.stubEnv('TREK_PUBLIC_ADVICE_ENABLED', 'true');
    db.run("UPDATE plugins SET granted_permissions = '[]'"); expect(() => shares.bootstrap(link.token)).toThrow();
    db.run("UPDATE plugins SET granted_permissions = '[\"share:guest\"]', enabled = 0"); expect(() => shares.bootstrap(link.token)).toThrow();
    db.run("UPDATE plugins SET enabled = 1, capabilities = '{}'"); expect(() => shares.bootstrap(link.token)).toThrow();
  });
  it('limits anonymous session minting without growing unbounded key maps', () => {
    const link = publish();
    for (let i = 0; i < 5; i++) shares.session(link.token, undefined, 'same-ip');
    expect(() => shares.session(link.token, undefined, 'same-ip')).toThrow();
    const small = new RateLimitService();
    expect(small.check('b', 'a', 5, 1000, 1, 1)).toBe(true);
    expect(small.check('b', 'b', 5, 1000, 1, 1)).toBe(false);
    expect(small.check('b', 'b', 5, 1000, 1001, 1)).toBe(true);
  });
});

describe('native advice projection', () => {
  it('imports an accepted suggestion once under the owner and immutable identity', () => {
    const input = {
      tripId, externalKey: 'share-id/suggestion-id', expectedPayloadHash: 'a'.repeat(64),
      place: { name: 'Accepted place', googlePlaceId: 'google-accepted', address: 'Tokyo', categoryId },
    };
    const first = shares.importSuggestion(tripId, owner.id, input);
    const retry = shares.importSuggestion(tripId, owner.id, input);
    expect(first).toEqual({ placeId: retry.placeId, created: true });
    expect(retry.created).toBe(false);
    expect(db.all('SELECT * FROM plugin_place_imports')).toHaveLength(1);
    expect(db.all('SELECT * FROM day_assignments WHERE place_id = ?', first.placeId)).toHaveLength(0);
    expect(() => shares.importSuggestion(tripId, owner.id, { ...input, expectedPayloadHash: 'b'.repeat(64) })).toThrow('Import identity was reused');
  });

  it('keeps a single shortlist across return stays and empty days; times do not imply booked', () => {
    const result = projection.build(tripId, config, true);
    expect(result.stays).toHaveLength(2); expect(result.stays[1]!.days[0]!.schedule).toEqual([]);
    expect(result.shortlists.filter(s => s.cityId === 'tokyo')).toHaveLength(1);
    expect(result.shortlists.at(-1)!.cityId).toBe('elsewhere');
    expect(result.stays[0]!.days[0]!.schedule[0]).toMatchObject({ time: '12:30', booked: false });
    expect(result.shortlists[0]!.eat[0]!.mapsUrl).toContain('api=1');
    expect(result.shortlists[0]!.eat[0]!.mapsUrl).not.toContain('query_place_id');
  });
  it('uses only live confirmed reservation records for booking badges', () => {
    db.run("INSERT INTO reservations (trip_id, assignment_id, title, status, type, confirmation_number) VALUES (?, ?, 'PRIVATE-CANARY', 'confirmed', 'activity', 'PRIVATE-CANARY')", tripId, assignmentId);
    const booked = () => projection.build(tripId, config).stays[0]!.days[0]!.schedule[0]!.booked;
    expect(booked()).toBe(true);
    db.run("UPDATE reservations SET ingest_state = 'staged'"); expect(booked()).toBe(false);
    db.run("UPDATE reservations SET ingest_state = 'live', status = 'cancelled'"); expect(booked()).toBe(false);
  });
  it('rejects cross-trip IDs, excludes lodging and stops voting after scheduling', () => {
    const other = createTrip(testDb, owner.id).id;
    const place = createPlace(testDb, other).id;
    expect(() => projection.build(tripId, { ...config, shortlist: [{ ...config.shortlist[0]!, placeId: place }] }, true)).toThrow();
    db.run("INSERT INTO reservations (trip_id, place_id, title, type) VALUES (?, ?, 'PRIVATE-CANARY', 'hotel')", tripId, shortlistPlaceId);
    expect(() => projection.build(tripId, config, true)).toThrow();
    expect(projection.build(tripId, config).shortlists[0]!.eat).toEqual([]);
    db.run('DELETE FROM reservations');
    createDayAssignment(testDb, dayId, shortlistPlaceId);
    expect(projection.build(tripId, config).shortlists[0]!.eat).toEqual([]);
  });
  it('excludes native accommodation places even without reservation rows', () => {
    db.run('INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id) VALUES (?, ?, ?, ?)', tripId, shortlistPlaceId, dayId, dayId);
    expect(() => projection.build(tripId, config, true)).toThrow();
    expect(projection.build(tripId, config).shortlists[0]!.eat).toEqual([]);
  });
});
