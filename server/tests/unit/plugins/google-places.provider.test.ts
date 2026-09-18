import { describe, expect, it, vi, afterEach } from 'vitest';
import Sqlite from 'better-sqlite3';
import { GooglePlacesProvider, GooglePlacesRateLimitException, type GooglePlacesFetch } from '../../../src/nest/plugin-shares/google-places.provider';
import { PluginSharePublicController } from '../../../src/nest/plugin-shares/plugin-shares.controller';
import { PluginSharesRpc } from '../../../src/nest/plugin-shares/plugin-shares.rpc';
import type { PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';
import type { OwnerAdvicePrincipal } from '../../../src/nest/plugin-shares/plugin-shares.service';

const principal: PublicSharePrincipal = { kind: 'publicShare', pluginId: 'trip-advice', shareId: 'share-a', epoch: 2, sessionId: 'session-a', guestId: 'guest-a' };
const actionId = '11111111-1111-4111-8111-111111111111';
const searchAction = { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' } as const;
const baseEnv = {
  TREK_PLUGINS_ENABLED: 'true', TREK_PUBLIC_ADVICE_ENABLED: 'true', TREK_PUBLIC_ADVICE_GOOGLE_ENABLED: 'true',
  TREK_PUBLIC_ADVICE_GOOGLE_TERMS_URL: 'https://example.test/terms', TREK_PUBLIC_ADVICE_GOOGLE_PRIVACY_URL: 'https://example.test/privacy',
  TREK_PUBLIC_ADVICE_GOOGLE_BUDGET_CENTS: '100', PLACES_API_KEY: 'fixture-key',
};

function response(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}
function dbFixture(usage = new Map<string, number>()) {
  return {
    get: vi.fn((sql: string, ...params: unknown[]) => sql.includes('SELECT attempts') ? { attempts: usage.get(`${String(params[0])}:${String(params[1])}`) ?? 0 } : undefined),
    run: vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO plugin_share_usage')) usage.set(`${String(params[0])}:${String(params[1])}`, (usage.get(`${String(params[0])}:${String(params[1])}`) ?? 0) + 1);
      return { changes: 1 };
    }),
    transaction: vi.fn((fn: () => unknown) => fn()),
  };
}
function sharesFixture(validate = vi.fn()) {
  const cities = [
    { id: 'madrid', label: 'Madrid', countryCodes: ['ES'], bounds: { south: 40, west: -4, north: 41, east: -3 } },
    { id: 'paris', label: 'Paris', countryCodes: ['FR'], bounds: { south: 48, west: 2, north: 49, east: 3 } },
  ];
  return { validatePrincipal: validate, publicCities: vi.fn(() => cities), publicCity: vi.fn(() => ({ bounds: cities[0].bounds })), snapshot: vi.fn(() => ({ shortlists: [] })) };
}
function provider(fetcher: GooglePlacesFetch, db = dbFixture(), shares = sharesFixture()) {
  return new GooglePlacesProvider(db as never, shares as never, fetcher);
}

afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(baseEnv)) delete process.env[key];
});

describe('published place metadata', () => {
  it('keeps authenticated owner search handles separate from guest and other owner authority', async () => {
    Object.assign(process.env, baseEnv);
    const owner: OwnerAdvicePrincipal = { kind: 'adviceOwner', pluginId: 'trip-advice', tripId: 1, userId: 7, shareId: 'private-share', sessionId: 'owner:1:7', guestId: 'owner:1:7', epoch: 1, preview: false };
    const shares = { ...sharesFixture(), validateProviderPrincipal: vi.fn(), providerCities: () => [], providerSnapshot: () => ({ cities: [], stays: [], shortlists: [] }) };
    const fetcher: GooglePlacesFetch = async url => String(url).includes('autocomplete')
      ? response({ suggestions: [{ placePrediction: { placeId: 'google-owner', structuredFormat: { mainText: { text: 'Garden' } } } }] })
      : response({ id: 'google-owner', displayName: { text: 'Garden' }, primaryTypeDisplayName: { text: 'Botanical garden' }, location: { latitude: 35.7, longitude: 139.7 }, addressComponents: [{ shortText: 'JP', types: ['country'] }] });
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never, fetcher);
    const found = await service.autocomplete(owner, searchAction);
    const action = { version: 1 as const, kind: 'places.resolve' as const, searchId: actionId, predictionId: found.data.suggestions[0]!.predictionId };
    await expect(service.resolveAction({ ...owner, userId: 8, sessionId: 'owner:1:8', guestId: 'owner:1:8' }, action)).rejects.toMatchObject({ status: 422 });
    await expect(service.resolveAction(principal, action)).rejects.toMatchObject({ status: 422 });
    const selected = await service.resolveActionV2(owner, action);
    expect(selected.data.place).toMatchObject({ lat: 35.7, lng: 139.7, primaryType: 'Botanical garden' });
    expect(shares.validateProviderPrincipal).toHaveBeenCalled();
  });
  it('accepts non-prefix Google autocomplete match ranges', async () => {
    Object.assign(process.env, baseEnv);
    const service = provider(async () => response({ suggestions: [{ placePrediction: { placeId: 'google-one', structuredFormat: {
      mainText: { text: 'Tokyo Art Museum', matches: [{ startOffset: 6, endOffset: 9 }] }
    } } }] }));
    const result = await service.autocomplete(principal, searchAction);
    expect(result.data.suggestions[0]?.mainText).toBe('Tokyo Art Museum');
  });

  it('keeps the versioned provider action envelope at the public HTTP seam', async () => {
    const shares = { requireOrigin: vi.fn(), credential: vi.fn(), authorize: vi.fn(() => principal), validatePrincipal: vi.fn() };
    const runtime = { isActive: () => true, grantsOf: () => new Set(['share:guest']), invokePublicShare: vi.fn() };
    const expected = { version: 1, kind: 'places.autocomplete', data: { suggestions: [] } };
    const places = { autocomplete: vi.fn(async () => expected) };
    const controller = new PluginSharePublicController(shares as never, runtime as never, places as never);
    const result = await controller.action('private-token', searchAction, { get: () => undefined } as never, { set: vi.fn() } as never);
    expect(result).toEqual(expected);
    expect(runtime.invokePublicShare).not.toHaveBeenCalled();
  });

  it.each(['places.metadata', 'map.tile'] as const)('routes passive %s through the media budget only', async kind => {
    const shares = { requireOrigin: vi.fn(), credential: vi.fn(), authorize: vi.fn(), authorizeMedia: vi.fn(() => principal), validatePrincipal: vi.fn() };
    const runtime = { isActive: () => true, grantsOf: () => new Set(['share:guest']), invokePublicShare: vi.fn() };
    const places = { metadata: vi.fn(async () => ({ version: 1, kind: 'places.metadata', data: { placeKey: 'p:1' } })) };
    const maps = { tile: vi.fn(async () => ({ mimeType: 'image/png', bytesBase64: 'iVBORw0KGgo=' })) };
    const controller = new PluginSharePublicController(shares as never, runtime as never, places as never, maps as never);
    const action = kind === 'places.metadata'
      ? { version: 1 as const, kind, placeKey: 'p:1' }
      : { version: 1 as const, kind, dayKey: 'd:1', z: 2, x: 1, y: 1 };
    const result = await controller.action('private-token', action, { get: () => undefined } as never, { set: vi.fn() } as never);
    expect(result).toMatchObject({ version: 1, kind });
    expect(shares.authorizeMedia).toHaveBeenCalledOnce();
    expect(shares.authorize).not.toHaveBeenCalled();
    expect(runtime.invokePublicShare).not.toHaveBeenCalled();
  });

  it('charges every item in a metadata batch to the guest media quota', async () => {
    const shares = { requireOrigin: vi.fn(), credential: vi.fn(), authorize: vi.fn(), authorizeMedia: vi.fn(() => principal), validatePrincipal: vi.fn() };
    const runtime = { isActive: () => true, grantsOf: () => new Set(['share:guest']), invokePublicShare: vi.fn() };
    const places = { metadataBatch: vi.fn(async () => ({ version: 1, kind: 'places.metadata.batch', data: {
      places: [{ placeKey: 'p:1' }, { placeKey: 'p:2' }, { placeKey: 'p:3' }],
    } })) };
    const controller = new PluginSharePublicController(shares as never, runtime as never, places as never);
    const action = { version: 1 as const, kind: 'places.metadata.batch' as const, placeKeys: ['p:1', 'p:2', 'p:3'] };

    await expect(controller.action('private-token', action, { get: () => undefined } as never, { set: vi.fn() } as never))
      .resolves.toEqual({ version: 1, kind: action.kind, data: { places: [{ placeKey: 'p:1' }, { placeKey: 'p:2' }, { placeKey: 'p:3' }] } });
    expect(shares.authorizeMedia).toHaveBeenCalledTimes(3);
    expect(places.metadataBatch).toHaveBeenCalledOnce();
    expect(runtime.invokePublicShare).not.toHaveBeenCalled();
  });

  it('routes an owner metadata batch through the passive native provider path', async () => {
    const owner: OwnerAdvicePrincipal = { kind: 'adviceOwner', pluginId: 'trip-advice', tripId: 41, userId: 7, shareId: 'share-a', sessionId: 'owner:41:7', guestId: 'owner:41:7', epoch: 2, preview: false };
    const shares = { ownerPrincipal: vi.fn(() => owner), validateProviderPrincipal: vi.fn() };
    const places = { metadataBatch: vi.fn(async () => ({ version: 1, kind: 'places.metadata.batch', data: {
      places: [{ placeKey: 'p:1', placeType: 'Museum' }, { placeKey: 'p:2' }],
    } })) };
    const rpc = new PluginSharesRpc(shares as never, places as never);
    const result = await rpc.ownerNativeAction({ tripId: 41, action: { version: 2, kind: 'places.metadata.batch', placeKeys: ['p:1', 'p:2'] } },
      { pluginId: 'trip-advice', actingUserId: 7 } as never);

    expect(shares.ownerPrincipal).toHaveBeenCalledWith(41, 7, true);
    expect(places.metadataBatch).toHaveBeenCalledWith(owner, { version: 1, kind: 'places.metadata.batch', placeKeys: ['p:1', 'p:2'] });
    expect(result).toEqual({ providerResult: { version: 2, kind: 'places.metadata.batch', data: {
      places: [{ placeKey: 'p:1', primaryType: 'Museum' }, { placeKey: 'p:2' }],
    } } });
  });

  it('exposes the bounded upstream Retry-After through the public action response', async () => {
    const shares = { requireOrigin: vi.fn(), credential: vi.fn(), authorizeMedia: vi.fn(() => principal), validatePrincipal: vi.fn() };
    const runtime = { isActive: () => true, grantsOf: () => new Set(['share:guest']) };
    const places = { metadata: vi.fn(async () => { throw new GooglePlacesRateLimitException(17); }) };
    const res = { set: vi.fn() };
    const controller = new PluginSharePublicController(shares as never, runtime as never, places as never);

    await expect(controller.action('private-token', { version: 1, kind: 'places.metadata', placeKey: 'p:1' },
      { get: () => undefined } as never, res as never)).rejects.toMatchObject({ status: 429 });
    expect(res.set).toHaveBeenCalledWith('Retry-After', '17');
  });

  it('returns transient Google type and photo handles only for a published native place', async () => {
    Object.assign(process.env, baseEnv);
    const shares = sharesFixture();
    const snapshot = { cities: [{ id: 'madrid', countryCodes: ['ES'] }], stays: [], shortlists: [{ see: [{ key: 'p:1', googlePlaceId: 'google-one' }], eat: [] }] };
    const scopedShares = { ...shares, snapshot: vi.fn(() => snapshot) };
    const fetcher = vi.fn<GooglePlacesFetch>(async () => response({ id: 'google-one', displayName: { text: 'Museum' }, primaryTypeDisplayName: { text: 'Art museum', languageCode: 'en' }, photos: [{ name: 'places/google-one/photos/one', googleMapsUri: 'https://maps.google.com/photo/one' }] }));
    const service = new GooglePlacesProvider(dbFixture() as never, scopedShares as never, fetcher);
    await expect(service.metadata(principal, { version: 1, kind: 'places.metadata', placeKey: 'p:99' })).rejects.toMatchObject({ status: 422 });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await service.metadata(principal, { version: 1, kind: 'places.metadata', placeKey: 'p:1' });
    expect(result.data).toMatchObject({ placeKey: 'p:1', placeType: 'Art museum', photoHandle: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('places/google-one/photos');
    await expect(service.photo({ ...principal, guestId: 'other-guest' }, result.data.photoHandle!)).rejects.toMatchObject({ status: 422 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy single metadata request timeout at five seconds', async () => {
    Object.assign(process.env, baseEnv);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const shares = { ...sharesFixture(), snapshot: () => ({ cities: [], stays: [], shortlists: [{ see: [{ key: 'p:1', googlePlaceId: 'google-one' }], eat: [] }] }) };
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never,
      async () => response({ id: 'google-one', displayName: { text: 'One' } }));

    await service.metadata(principal, { version: 1, kind: 'places.metadata', placeKey: 'p:1' });

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(5000);
    timeout.mockRestore();
  });

  it('resolves one projection and one upstream detail call per unique Google place in a batch', async () => {
    Object.assign(process.env, baseEnv);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const snapshot = vi.fn(() => ({ cities: [], stays: [], shortlists: [{ see: [
      { key: 'p:1', googlePlaceId: 'google-one' }, { key: 'p:2', googlePlaceId: 'google-one' },
    ], eat: [{ key: 'p:3', googlePlaceId: 'google-two' }] }] }));
    const shares = { ...sharesFixture(), snapshot };
    const fetcher = vi.fn<GooglePlacesFetch>(async url => {
      const id = decodeURIComponent(String(url).split('/v1/places/')[1]!.split('?')[0]!);
      return response({ id, displayName: { text: id }, primaryTypeDisplayName: { text: `${id} type` } });
    });
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never, fetcher);

    const result = await service.metadataBatch(principal, { version: 1, kind: 'places.metadata.batch', placeKeys: ['p:2', 'p:3', 'p:1'] });

    expect(result.data.places).toEqual([
      { placeKey: 'p:2', placeType: 'google-one type' },
      { placeKey: 'p:3', placeType: 'google-two type' },
      { placeKey: 'p:1', placeType: 'google-one type' },
    ]);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('/v1/places/google-one?'), expect.stringContaining('/v1/places/google-two?'),
    ]);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(750);
    timeout.mockRestore();
  });

  it('returns an empty per-place presentation after an isolated detail failure and continues the batch', async () => {
    Object.assign(process.env, baseEnv);
    const shares = { ...sharesFixture(), snapshot: () => ({ cities: [], stays: [], shortlists: [{ see: [
      { key: 'p:1', googlePlaceId: 'google-one' }, { key: 'p:2', googlePlaceId: 'google-two' },
    ], eat: [] }] }) };
    const fetcher = vi.fn<GooglePlacesFetch>(async url => String(url).includes('google-one')
      ? new Response('', { status: 503 })
      : response({ id: 'google-two', displayName: { text: 'Two' }, primaryTypeDisplayName: { text: 'Museum' } }));
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never, fetcher);

    await expect(service.metadataBatch(principal, { version: 1, kind: 'places.metadata.batch', placeKeys: ['p:1', 'p:2'] }))
      .resolves.toMatchObject({ data: { places: [{ placeKey: 'p:1' }, { placeKey: 'p:2', placeType: 'Museum' }] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors a bounded Google Retry-After cooldown without retries or extra budget charges', async () => {
    Object.assign(process.env, baseEnv);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    const usage = new Map<string, number>();
    const shares = { ...sharesFixture(), snapshot: () => ({ cities: [], stays: [], shortlists: [{ see: [{ key: 'p:1', googlePlaceId: 'google-one' }], eat: [] }] }) };
    const fetcher = vi.fn<GooglePlacesFetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '172800' } }))
      .mockResolvedValueOnce(response({ id: 'google-one', displayName: { text: 'Place' } }));
    const service = new GooglePlacesProvider(dbFixture(usage) as never, shares as never, fetcher);
    const action = { version: 1 as const, kind: 'places.metadata' as const, placeKey: 'p:1' };

    await expect(service.metadata(principal, action)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 172800 });
    await expect(service.metadata(principal, action)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(usage.get('share-a:details')).toBe(1);
    vi.advanceTimersByTime(172_800_000);
    await expect(service.metadata(principal, action)).resolves.toMatchObject({ data: { placeKey: 'p:1' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(usage.get('share-a:details')).toBe(2);
  });

  it('preserves the disabled provider gate for metadata', async () => {
    Object.assign(process.env, baseEnv, { TREK_PUBLIC_ADVICE_GOOGLE_ENABLED: 'false' });
    const shares = { ...sharesFixture(), snapshot: () => ({ stays: [], shortlists: [{ see: [{ key: 'p:1', googlePlaceId: 'google-one' }], eat: [] }] }) };
    const fetcher = vi.fn<GooglePlacesFetch>();
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never, fetcher);
    await expect(service.metadata(principal, { version: 1, kind: 'places.metadata', placeKey: 'p:1' })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows a visible city without bounds but refuses a hidden city before billing', async () => {
    Object.assign(process.env, baseEnv);
    const shares = { ...sharesFixture(), publicCity: () => null, snapshot: () => ({ cities: [{ id: 'visible-city' }], stays: [], shortlists: [] }) };
    const fetcher = vi.fn<GooglePlacesFetch>(async () => response({ suggestions: [] }));
    const service = new GooglePlacesProvider(dbFixture() as never, shares as never, fetcher);
    await service.autocomplete(principal, { ...searchAction, cityId: 'visible-city' });
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(request.locationBias).toBeUndefined();
    await expect(service.autocomplete(principal, { ...searchAction, cityId: 'hidden-city' })).rejects.toMatchObject({ status: 422 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Google Places monthly spending reservations', () => {
  function fixture() {
    Object.assign(process.env, baseEnv, { TREK_PUBLIC_ADVICE_GOOGLE_BUDGET_CENTS: '500' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const sql = new Sqlite(':memory:');
    sql.exec(`CREATE TABLE plugin_share_usage (
      scope_id TEXT NOT NULL, operation TEXT NOT NULL, usage_day TEXT NOT NULL,
      attempts INTEGER NOT NULL CHECK(attempts >= 0), PRIMARY KEY(scope_id, operation, usage_day)
    )`);
    const db = {
      get: (query: string, ...args: unknown[]) => sql.prepare(query).get(...args),
      run: (query: string, ...args: unknown[]) => sql.prepare(query).run(...args),
      transaction: (fn: () => unknown) => sql.transaction(fn)(),
    };
    const make = (fetcher: GooglePlacesFetch) => new GooglePlacesProvider(db as never, sharesFixture() as never, fetcher);
    const seed = (day: string, attempts: number, operation = 'autocomplete') =>
      db.run('INSERT INTO plugin_share_usage VALUES (?, ?, ?, ?)', '__instance__', operation, day, attempts);
    return { sql, make, seed };
  }

  it('shares the US$5 cap across days, shares and provider restarts, reserving before fetch', async () => {
    const { sql, make, seed } = fixture();
    try {
      seed('2026-09-01', 499);
      const fetcher = vi.fn<GooglePlacesFetch>(async () => response({ suggestions: [] }));
      await make(fetcher).autocomplete(principal, searchAction);
      await expect(make(fetcher).autocomplete({ ...principal, shareId: 'share-b' }, searchAction)).rejects.toMatchObject({ status: 429 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(sql.prepare('SELECT SUM(attempts) AS total FROM plugin_share_usage WHERE scope_id = ?').get('__instance__')).toEqual({ total: 500 });
    } finally { sql.close(); }
  });

  it('counts uncertain upstream failures and resets only at the next UTC month', async () => {
    const { sql, make, seed } = fixture();
    try {
      seed('2026-09-01', 499);
      const fetcher = vi.fn<GooglePlacesFetch>(async () => { throw new Error('upstream timeout'); });
      await expect(make(fetcher).autocomplete(principal, searchAction)).rejects.toThrow('upstream timeout');
      vi.setSystemTime(new Date('2026-09-30T23:59:59Z'));
      await expect(make(fetcher).autocomplete(principal, searchAction)).rejects.toMatchObject({ status: 429 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      await expect(make(fetcher).autocomplete(principal, searchAction)).rejects.toThrow('upstream timeout');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { sql.close(); }
  });

  it('does not let concurrent requests reserve the same final cent', async () => {
    const { sql, make, seed } = fixture();
    try {
      seed('2026-09-01', 499);
      let release!: (value: Response) => void;
      const pending = new Promise<Response>(resolve => { release = resolve; });
      const fetcher = vi.fn<GooglePlacesFetch>(() => pending);
      const first = make(fetcher).autocomplete(principal, searchAction);
      await expect(make(fetcher).autocomplete({ ...principal, sessionId: 'session-b' }, searchAction)).rejects.toMatchObject({ status: 429 });
      release(response({ suggestions: [] }));
      await first;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { sql.close(); }
  });

  it('combines autocomplete, details and photo charges in the same cap', async () => {
    const { sql, make, seed } = fixture();
    try {
      seed('2026-09-01', 496);
      const fetcher = vi.fn<GooglePlacesFetch>(async url => {
        if (String(url).includes('autocomplete')) return response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] });
        if (String(url).includes('/media')) return response({ photoUri: 'https://lh3.googleusercontent.com/photo' });
        if (String(url).includes('googleusercontent')) return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
        return response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', googleMapsUri: 'https://www.google.com/maps/photo' }] });
      });
      const places = make(fetcher);
      const found = await places.autocomplete(principal, searchAction);
      const resolved = await places.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: found.data.suggestions[0].predictionId });
      expect(await places.photo(principal, resolved.data.place.photoHandle!)).toMatchObject({ state: 'available' });
      await expect(places.photo(principal, resolved.data.place.photoHandle!)).rejects.toMatchObject({ status: 429 });
      await expect(places.autocomplete(principal, searchAction)).rejects.toMatchObject({ status: 429 });
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally { sql.close(); }
  });
});

describe('GooglePlacesProvider', () => {
  it.each([
    ['madrid', { latitude: 40.4, longitude: -3.7 }, 'ES', 'madrid'],
    ['madrid', { latitude: 48.85, longitude: 2.35 }, 'FR', 'paris'],
    ['madrid', { latitude: 51.5, longitude: -0.1 }, 'GB', 'elsewhere'],
    ['madrid', { latitude: 40.4, longitude: -3.7 }, 'FR', 'elsewhere'],
    ['madrid', undefined, 'ES', 'elsewhere'],
    ['elsewhere', { latitude: 48.85, longitude: 2.35 }, 'FR', 'paris'],
  ])('assigns a %s search result at %j in %s to %s using verified geography', async (origin, location, country, expectedCity) => {
    Object.assign(process.env, baseEnv);
    const places = provider(async url => String(url).includes('autocomplete')
      ? response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] })
      : response({ id: 'ChIJplace', displayName: { text: 'Place' }, location,
        addressComponents: [{ shortText: country, types: ['country'] }, { longText: 'Actual locality', types: ['locality'] }] }));
    const autocomplete = await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: origin, category: 'see', input: 'Place', locale: 'en' });
    const resolved = await places.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
    expect(resolved.data.place).toMatchObject({ cityId: expectedCity, countryCode: country, locality: 'Actual locality' });
    expect(await places.resolveSelection(principal, resolved.data.selectionId)).toMatchObject({ cityId: expectedCity });
  });

  it('sends a soft geometry bias and never a hard country restriction', async () => {
    Object.assign(process.env, baseEnv);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const places = provider(async (url, init) => { calls.push({ url: String(url), init }); return response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' }, secondaryText: { text: 'City' } } } }] }); });
    const result = await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'madrid', category: 'see', input: 'Place', locale: 'en' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.locationBias.rectangle).toEqual({ low: { latitude: 40, longitude: -4 }, high: { latitude: 41, longitude: -3 } });
    expect(body).not.toHaveProperty('includedRegionCodes');
    expect(body.sessionToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.data.suggestions).toHaveLength(1);
  });

  it('rejects prediction handles from another share/session and revokes after an await', async () => {
    Object.assign(process.env, baseEnv);
    const fetcher = vi.fn<GooglePlacesFetch>(async () => response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] }));
    const places = provider(fetcher);
    const autocomplete = await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'eat', input: 'Place', locale: 'en' });
    const handle = autocomplete.data.suggestions[0].predictionId;
    const other: PublicSharePrincipal = { ...principal, shareId: 'share-b' };
    await expect(places.resolveAction(other, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: handle })).rejects.toMatchObject({ status: 422 });
    const otherSession: PublicSharePrincipal = { ...principal, sessionId: 'session-b' };
    await expect(places.resolveAction(otherSession, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: handle })).rejects.toMatchObject({ status: 422 });

    let release!: () => void;
    const gate = new Promise<Response>(resolve => { release = () => resolve(response({ suggestions: [] })); });
    const validate = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('revoked'); });
    const revoked = provider(() => gate, dbFixture(), sharesFixture(validate));
    const pending = revoked.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    release();
    await expect(pending).rejects.toThrow('revoked');
  });

  it('persists and enforces quota reservations before the provider call', async () => {
    Object.assign(process.env, baseEnv);
    const usage = new Map([[`${principal.shareId}:autocomplete`, 500]]);
    const fetcher = vi.fn<GooglePlacesFetch>(async () => response({ suggestions: [] }));
    const places = provider(fetcher, dbFixture(usage));
    await expect(places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' })).rejects.toMatchObject({ status: 429 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns genuine attributed photo bytes and preserves an explicit no-photo state', async () => {
    Object.assign(process.env, baseEnv);
    const calls: string[] = [];
    const places = provider(async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] });
      if (calls.length === 2) return response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', googleMapsUri: 'https://www.google.com/maps/photo', flagContentUri: 'https://www.google.com/maps/report', authorAttributions: [{ displayName: 'Author', uri: 'https://example.test/author' }] }] });
      if (calls.length === 3) return response({ name: 'places/ChIJplace/photos/photo-1/media', photoUri: 'https://lh3.googleusercontent.com/photo' });
      return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const autocomplete = await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const resolved = await places.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
    expect(resolved.data.place.photoHandle).toBeTypeOf('string');
    const photo = await places.photo(principal, resolved.data.place.photoHandle!);
    expect(photo).toMatchObject({ state: 'available', mimeType: 'image/jpeg', googleAttribution: 'Google Maps', googleMapsUri: 'https://www.google.com/maps/photo', authors: [{ displayName: 'Author', uri: 'https://example.test/author' }] });

    let noPhotoStep = 0;
    const noPhoto = provider(async (url) => {
      noPhotoStep++;
      return noPhotoStep === 1
        ? response({ suggestions: [{ placePrediction: { placeId: 'ChIJno-photo', structuredFormat: { mainText: { text: 'No photo' } } } }] })
        : response({ id: 'ChIJno-photo', displayName: { text: 'No photo' }, addressComponents: [{ shortText: 'ES', types: ['country'] }] });
    });
    const noPhotoAutocomplete = await noPhoto.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'No photo', locale: 'en' });
    const noPhotoResolved = await noPhoto.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: noPhotoAutocomplete.data.suggestions[0].predictionId });
    expect(noPhotoResolved.data.place).not.toHaveProperty('photoHandle');
  });

  it.each([undefined, 'http://www.google.com/maps/photo', 'https://user:password@www.google.com/maps/photo'])(
    'withholds a photo handle when its source URL is missing or unsafe: %s', async googleMapsUri => {
      Object.assign(process.env, baseEnv);
      const fetcher = vi.fn<GooglePlacesFetch>(async url => String(url).includes('autocomplete')
        ? response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] })
        : response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', ...(googleMapsUri ? { googleMapsUri } : {}) }] }));
      const places = provider(fetcher);
      const autocomplete = await places.autocomplete(principal, searchAction);
      const resolved = await places.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
      expect(resolved.data.place).not.toHaveProperty('photoHandle');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('fails closed for malicious photo URLs and oversized media', async () => {
    Object.assign(process.env, baseEnv);
    const malicious = provider(async (url) => String(url).includes('autocomplete') ? response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] }) : String(url).includes('/media') ? response({ photoUri: 'https://evil.example.test/photo' }) : response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', googleMapsUri: 'https://www.google.com/maps/photo', authorAttributions: [] }] }));
    const autocomplete = await malicious.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const resolved = await malicious.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
    expect(await malicious.photo(principal, resolved.data.place.photoHandle!)).toMatchObject({ state: 'unavailable' });

    let step = 0;
    const oversized = provider(async (url) => {
      step++;
      if (step === 1) return response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] });
      if (step === 2) return response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', googleMapsUri: 'https://www.google.com/maps/photo', authorAttributions: [] }] });
      if (step === 3) return response({ photoUri: 'https://lh3.googleusercontent.com/photo' });
      return new Response(new Uint8Array(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const oversizedAutocomplete = await oversized.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const oversizedResolved = await oversized.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: oversizedAutocomplete.data.suggestions[0].predictionId });
    expect(await oversized.photo(principal, oversizedResolved.data.place.photoHandle!)).toMatchObject({ state: 'unavailable' });
  });
});
