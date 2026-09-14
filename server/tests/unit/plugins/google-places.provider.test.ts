import { describe, expect, it, vi, afterEach } from 'vitest';
import { GooglePlacesProvider, type GooglePlacesFetch } from '../../../src/nest/plugin-shares/google-places.provider';
import type { PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';

const principal: PublicSharePrincipal = { kind: 'publicShare', pluginId: 'trip-advice', shareId: 'share-a', epoch: 2, sessionId: 'session-a', guestId: 'guest-a' };
const actionId = '11111111-1111-4111-8111-111111111111';
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
  return { validatePrincipal: validate, publicCity: vi.fn(() => ({ bounds: { south: 40, west: -4, north: 41, east: -3 } })), snapshot: vi.fn(() => ({ shortlists: [] })) };
}
function provider(fetcher: GooglePlacesFetch, db = dbFixture(), shares = sharesFixture()) {
  return new GooglePlacesProvider(db as never, shares as never, fetcher);
}

afterEach(() => {
  for (const key of Object.keys(baseEnv)) delete process.env[key];
});

describe('GooglePlacesProvider', () => {
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
      if (calls.length === 2) return response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', authorAttributions: [{ displayName: 'Author', uri: 'https://example.test/author' }] }] });
      if (calls.length === 3) return response({ photoUri: 'https://lh3.googleusercontent.com/photo' });
      return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const autocomplete = await places.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const resolved = await places.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
    expect(resolved.data.place.photoHandle).toBeTypeOf('string');
    const photo = await places.photo(principal, resolved.data.place.photoHandle!);
    expect(photo).toMatchObject({ state: 'available', mimeType: 'image/jpeg', googleAttribution: '© Google', authors: [{ displayName: 'Author', uri: 'https://example.test/author' }] });

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

  it('fails closed for malicious photo URLs and oversized media', async () => {
    Object.assign(process.env, baseEnv);
    const malicious = provider(async (url) => String(url).includes('autocomplete') ? response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] }) : String(url).includes('/media') ? response({ photoUri: 'https://evil.example.test/photo' }) : response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', authorAttributions: [] }] }));
    const autocomplete = await malicious.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const resolved = await malicious.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: autocomplete.data.suggestions[0].predictionId });
    expect(await malicious.photo(principal, resolved.data.place.photoHandle!)).toMatchObject({ state: 'unavailable' });

    let step = 0;
    const oversized = provider(async (url) => {
      step++;
      if (step === 1) return response({ suggestions: [{ placePrediction: { placeId: 'ChIJplace', structuredFormat: { mainText: { text: 'Place' } } } }] });
      if (step === 2) return response({ id: 'ChIJplace', displayName: { text: 'Place' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], photos: [{ name: 'places/ChIJplace/photos/photo-1', authorAttributions: [] }] });
      if (step === 3) return response({ photoUri: 'https://lh3.googleusercontent.com/photo' });
      return new Response(new Uint8Array(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const oversizedAutocomplete = await oversized.autocomplete(principal, { version: 1, kind: 'places.autocomplete', searchId: actionId, cityId: 'elsewhere', category: 'see', input: 'Place', locale: 'en' });
    const oversizedResolved = await oversized.resolveAction(principal, { version: 1, kind: 'places.resolve', searchId: actionId, predictionId: oversizedAutocomplete.data.suggestions[0].predictionId });
    expect(await oversized.photo(principal, oversizedResolved.data.place.photoHandle!)).toMatchObject({ state: 'unavailable' });
  });
});
