import { describe, expect, it, vi, afterEach } from 'vitest';
import Sqlite from 'better-sqlite3';
import { GooglePlacesProvider, type GooglePlacesFetch } from '../../../src/nest/plugin-shares/google-places.provider';
import type { PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';

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
    expect(result.data.suggestions).toHaveLength(1);
  });

  it('keeps the session token within the 36 characters Google accepts', async () => {
    Object.assign(process.env, baseEnv);
    const calls: Array<{ init?: RequestInit }> = [];
    const places = provider(async (_url, init) => { calls.push({ init }); return response({ suggestions: [] }); });
    await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const { sessionToken } = JSON.parse(String(calls[0].init?.body));
    expect(sessionToken.length).toBeLessThanOrEqual(36);
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
