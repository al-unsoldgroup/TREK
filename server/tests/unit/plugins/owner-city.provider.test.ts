import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerCityProvider, type OwnerCityFetch } from '../../../src/nest/plugin-shares/owner-city.provider';
import { PluginSharesRpc } from '../../../src/nest/plugin-shares/plugin-shares.rpc';

const baseEnv = {
  TREK_PLUGINS_ENABLED: 'true', TREK_PUBLIC_ADVICE_ENABLED: 'true', TREK_PUBLIC_ADVICE_GOOGLE_ENABLED: 'true',
  TREK_PUBLIC_ADVICE_GOOGLE_TERMS_URL: 'https://example.test/terms', TREK_PUBLIC_ADVICE_GOOGLE_PRIVACY_URL: 'https://example.test/privacy',
  TREK_PUBLIC_ADVICE_GOOGLE_BUDGET_CENTS: '500', PLACES_API_KEY: 'fixture-key',
};
const request = { tripId: 41, input: 'Mad', sessionToken: '11111111-1111-4111-8111-111111111111' };

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function dbFixture() {
  const usage = new Map<string, number>();
  return {
    get: vi.fn((sql: string, ...params: unknown[]) => sql.includes('SELECT attempts') ? { attempts: usage.get(`${String(params[0])}:${String(params[1])}`) ?? 0 } : undefined),
    run: vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO plugin_share_usage')) usage.set(`${String(params[0])}:${String(params[1])}`, (usage.get(`${String(params[0])}:${String(params[1])}`) ?? 0) + 1);
      return { changes: 1 };
    }),
    transaction: vi.fn((fn: () => unknown) => fn()),
  };
}

function sharesFixture() {
  return {
    requireNativeOwner: vi.fn(),
    addNativeCity: vi.fn((_tripId: number, _userId: number, _revision: number, city: unknown) => ({
      version: 2, config: null, legacy: false,
      draftConfig: { version: 2, showNotes: false, hiddenCityKeys: [], hiddenDayKeys: [], hiddenNoteDayKeys: [], hiddenPlaceKeys: [], hiddenIdeaKeys: [], addedCities: [city] },
      projection: { version: 2, revision: 'a'.repeat(64), title: 'Trip', cities: [], stays: [], shortlists: [] },
    })),
  };
}

function provider(fetcher: OwnerCityFetch, shares = sharesFixture()) {
  return { service: new OwnerCityProvider(dbFixture() as never, shares as never, fetcher), shares };
}

afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(baseEnv)) delete process.env[key];
});

describe('authenticated owner city search', () => {
  it('exposes city search only to an authenticated owner invocation', async () => {
    const cities = { autocomplete: vi.fn().mockResolvedValue({ suggestions: [] }), resolve: vi.fn() };
    const rpc = new PluginSharesRpc({} as never, undefined, cities as never);
    const params = { tripId: 41, input: 'Mad', sessionToken: request.sessionToken };
    expect(() => rpc.ownerCityAutocomplete(params, { pluginId: 'trip-advice', publicShare: { kind: 'publicShare' }, actingUserId: undefined } as never)).toThrow('Authenticated owner invocation required');
    await expect(rpc.ownerCityAutocomplete(params, { pluginId: 'trip-advice', actingUserId: 7 } as never)).resolves.toEqual({ suggestions: [] });
    expect(cities.autocomplete).toHaveBeenCalledWith(7, params);
  });

  it('returns at most five locality predictions and reuses one bounded Google session token through resolution', async () => {
    Object.assign(process.env, baseEnv);
    const suggestions = Array.from({ length: 7 }, (_, index) => ({ placePrediction: {
      placeId: `google-${index}`, types: ['locality'],
      structuredFormat: { mainText: { text: `Madrid ${index}` }, secondaryText: { text: 'Spain' } },
    } }));
    const fetcher = vi.fn<OwnerCityFetch>(async url => String(url).includes('autocomplete')
      ? response({ suggestions })
      : response({ id: 'google-0', types: ['locality'], displayName: { text: 'Madrid' },
        addressComponents: [{ shortText: 'ES', types: ['country'] }, { longText: 'Madrid', types: ['locality'] }],
        viewport: { low: { latitude: 40.31, longitude: -3.89 }, high: { latitude: 40.64, longitude: -3.52 } } }));
    const { service } = provider(fetcher);
    const first = await service.autocomplete(7, request);
    const second = await service.autocomplete(7, request);
    expect(first.suggestions).toHaveLength(5);
    expect(first.suggestions[0]?.predictionId).not.toContain('google-0');
    await service.resolve(7, { tripId: 41, sessionToken: request.sessionToken, predictionId: second.suggestions[0]!.predictionId, expectedRevision: 3 });
    const bodies = fetcher.mock.calls.slice(0, 2).map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0].includedPrimaryTypes).toEqual(['(cities)']);
    expect(bodies[0].sessionToken).toBe(bodies[1].sessionToken);
    expect(String(fetcher.mock.calls[2]?.[0])).toContain(`sessionToken=${encodeURIComponent(bodies[0].sessionToken)}`);
  });

  it('verifies locality, country and bounds before atomically adding a server-keyed city', async () => {
    Object.assign(process.env, baseEnv);
    const fetcher = vi.fn<OwnerCityFetch>(async url => String(url).includes('autocomplete')
      ? response({ suggestions: [{ placePrediction: { placeId: 'google-madrid', types: ['locality'], structuredFormat: { mainText: { text: 'Madrid' } } } }] })
      : response({ id: 'google-madrid', types: ['locality'], displayName: { text: 'Madrid' },
        addressComponents: [{ shortText: 'ES', types: ['country'] }, { longText: 'Madrid', types: ['locality'] }],
        viewport: { low: { latitude: 40.31, longitude: -3.89 }, high: { latitude: 40.64, longitude: -3.52 } } }));
    const { service, shares } = provider(fetcher);
    const found = await service.autocomplete(7, request);
    const result = await service.resolve(7, { tripId: 41, sessionToken: request.sessionToken, predictionId: found.suggestions[0]!.predictionId, expectedRevision: 9 });
    expect(result.city).toMatchObject({ key: expect.stringMatching(/^city-[0-9a-f-]{36}$/), label: 'Madrid', countryCodes: ['ES'], bounds: { south: 40.31, west: -3.89, north: 40.64, east: -3.52 } });
    expect(shares.addNativeCity).toHaveBeenCalledWith(41, 7, 9, result.city);
    expect(result.owner.draftConfig.addedCities).toContainEqual(result.city);
  });

  it.each([
    ['locality', { id: 'x', types: ['point_of_interest'], displayName: { text: 'Not a city' }, addressComponents: [{ shortText: 'ES', types: ['country'] }], viewport: { low: { latitude: 1, longitude: 1 }, high: { latitude: 2, longitude: 2 } } }],
    ['country', { id: 'x', types: ['locality'], displayName: { text: 'City' }, addressComponents: [{ longText: 'City', types: ['locality'] }], viewport: { low: { latitude: 1, longitude: 1 }, high: { latitude: 2, longitude: 2 } } }],
    ['bounds', { id: 'x', types: ['locality'], displayName: { text: 'City' }, addressComponents: [{ shortText: 'ES', types: ['country'] }, { longText: 'City', types: ['locality'] }] }],
  ])('rejects a result without verified %s before persistence', async (_field, details) => {
    Object.assign(process.env, baseEnv);
    const fetcher = vi.fn<OwnerCityFetch>(async url => String(url).includes('autocomplete')
      ? response({ suggestions: [{ placePrediction: { placeId: 'x', types: ['locality'], structuredFormat: { mainText: { text: 'City' } } } }] })
      : response(details));
    const { service, shares } = provider(fetcher);
    const found = await service.autocomplete(7, request);
    await expect(service.resolve(7, { tripId: 41, sessionToken: request.sessionToken, predictionId: found.suggestions[0]!.predictionId, expectedRevision: 0 })).rejects.toMatchObject({ status: 422 });
    expect(shares.addNativeCity).not.toHaveBeenCalled();
  });

  it('binds opaque predictions to the authenticated owner, trip and browser session', async () => {
    Object.assign(process.env, baseEnv);
    const fetcher = vi.fn<OwnerCityFetch>(async () => response({ suggestions: [{ placePrediction: { placeId: 'x', types: ['locality'], structuredFormat: { mainText: { text: 'City' } } } }] }));
    const { service, shares } = provider(fetcher);
    const found = await service.autocomplete(7, request);
    await expect(service.resolve(8, { tripId: 41, sessionToken: request.sessionToken, predictionId: found.suggestions[0]!.predictionId, expectedRevision: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(service.resolve(7, { tripId: 42, sessionToken: request.sessionToken, predictionId: found.suggestions[0]!.predictionId, expectedRevision: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(service.resolve(7, { tripId: 41, sessionToken: '22222222-2222-4222-8222-222222222222', predictionId: found.suggestions[0]!.predictionId, expectedRevision: 0 })).rejects.toMatchObject({ status: 422 });
    expect(shares.addNativeCity).not.toHaveBeenCalled();
  });

  it('fails closed before Google when the approved provider gate is disabled', async () => {
    Object.assign(process.env, baseEnv, { TREK_PUBLIC_ADVICE_GOOGLE_ENABLED: 'false' });
    const fetcher = vi.fn<OwnerCityFetch>();
    const { service } = provider(fetcher);
    await expect(service.autocomplete(7, request)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
