import { HttpException, Inject, Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  adviceAddedCitySchema,
  adviceNativeOwnerResponseSchema,
  adviceOwnerCityAutocompleteResultSchema,
  adviceOwnerCityResolveResultSchema,
  type AdviceOwnerCityAutocomplete,
  type AdviceOwnerCityAutocompleteResult,
  type AdviceOwnerCityResolve,
} from '@trek/shared';
import { readEnv } from '../../app-config';
import { discardBody, readCappedJson } from '../../utils/cappedFetch';
import { DatabaseService } from '../database/database.service';
import { readInstanceApiKey } from '../settings/instance-api-keys';
import { GOOGLE_PLACES_FETCH } from './google-places.provider';
import { PluginSharesService } from './plugin-shares.service';

export type OwnerCityFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const UPSTREAM = 'https://places.googleapis.com';
const HANDLE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 1000;
const MAX_PREDICTIONS = 5000;
const MAX_INFLIGHT_PER_OWNER = 4;
const MAX_INFLIGHT = 64;
const ATTEMPT_CENTS = { autocomplete: 1, details: 2 } as const;
const text = (max: number) => z.string().min(1).max(max);
const googleText = z.strictObject({ text: text(300), matches: z.array(z.strictObject({ startOffset: z.number().int().min(0).max(300).optional(), endOffset: z.number().int().min(0).max(300) })).max(50).optional() });
const autocompleteBody = z.strictObject({ suggestions: z.array(z.strictObject({ placePrediction: z.strictObject({
  placeId: text(256), types: z.array(text(80)).max(20).optional(),
  structuredFormat: z.strictObject({ mainText: googleText, secondaryText: googleText.optional() }),
}) })).max(20).optional() });
const point = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const detailsBody = z.strictObject({
  id: text(256), types: z.array(text(80)).max(20), displayName: googleText.extend({ languageCode: text(35).optional() }),
  addressComponents: z.array(z.strictObject({ longText: text(200).optional(), shortText: text(20).optional(), languageCode: text(35).optional(), types: z.array(text(80)).max(20) })).max(100),
  viewport: z.strictObject({ low: point, high: point }),
});
const ownerCityHostResultSchema = adviceOwnerCityResolveResultSchema.extend({
  owner: adviceNativeOwnerResponseSchema.omit({ inbox: true }),
});

type SearchSession = { ownerId: number; tripId: number; clientToken: string; googleToken: string; expiresAt: number };
type Prediction = SearchSession & { placeId: string };

@Injectable()
export class OwnerCityProvider {
  private readonly sessions = new Map<string, SearchSession>();
  private readonly predictions = new Map<string, Prediction>();
  private readonly inflight = new Map<number, number>();
  private totalInflight = 0;

  constructor(private readonly db: DatabaseService, private readonly shares: PluginSharesService,
    @Inject(GOOGLE_PLACES_FETCH) private readonly fetcher: OwnerCityFetch = globalThis.fetch.bind(globalThis)) {}

  private configReady(): string {
    const config = readEnv();
    const google = config.plugins.googlePlaces;
    let terms: URL;
    let privacy: URL;
    try { terms = new URL(google.termsUrl ?? ''); privacy = new URL(google.privacyUrl ?? ''); }
    catch { throw new HttpException({ error: 'Google Places is not configured' }, 503); }
    const key = config.maps.placesApiKey ?? readInstanceApiKey(this.db, 'maps_api_key');
    if (!config.plugins.enabled || !config.plugins.publicAdvice || !google.enabled || !key || google.budgetCents < 1 ||
      terms.protocol !== 'https:' || privacy.protocol !== 'https:' || terms.username || terms.password || privacy.username || privacy.password) {
      throw new HttpException({ error: 'Google Places is not configured' }, 503);
    }
    return key;
  }

  private prune(now = Date.now()): void {
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
    for (const [key, value] of this.predictions) if (value.expiresAt <= now) this.predictions.delete(key);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.sessions.delete(oldest);
    }
    while (this.predictions.size > MAX_PREDICTIONS) {
      const oldest = this.predictions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.predictions.delete(oldest);
    }
    for (const [key, value] of this.predictions) {
      if (!this.sessions.has(this.sessionKey(value.ownerId, value.tripId, value.clientToken))) this.predictions.delete(key);
    }
  }

  private sessionKey(ownerId: number, tripId: number, clientToken: string): string {
    return `${ownerId}:${tripId}:${clientToken}`;
  }

  private session(ownerId: number, input: AdviceOwnerCityAutocomplete): SearchSession {
    this.prune();
    const id = this.sessionKey(ownerId, input.tripId, input.sessionToken);
    const current = this.sessions.get(id);
    if (current) return current;
    const session = { ownerId, tripId: input.tripId, clientToken: input.sessionToken, googleToken: randomBytes(32).toString('base64url'), expiresAt: Date.now() + HANDLE_TTL_MS };
    this.sessions.set(id, session);
    this.prune();
    return session;
  }

  private enter(ownerId: number): () => void {
    const current = this.inflight.get(ownerId) ?? 0;
    if (current >= MAX_INFLIGHT_PER_OWNER || this.totalInflight >= MAX_INFLIGHT) throw new HttpException('Advice provider is busy', 429);
    this.inflight.set(ownerId, current + 1); this.totalInflight++;
    return () => { const remaining = (this.inflight.get(ownerId) ?? 1) - 1; if (remaining) this.inflight.set(ownerId, remaining); else this.inflight.delete(ownerId); this.totalInflight--; };
  }

  private reserve(tripId: number, operation: keyof typeof ATTEMPT_CENTS, tripMax: number, instanceMax: number): void {
    const day = new Date().toISOString().slice(0, 10);
    const month = `${day.slice(0, 7)}-01`;
    const budgetCents = readEnv().plugins.googlePlaces.budgetCents;
    const scope = `owner:${tripId}`;
    this.db.transaction(() => {
      this.db.run('DELETE FROM plugin_share_usage WHERE usage_day < ?', month);
      const spent = this.db.get<{ cents: number }>(`SELECT COALESCE(SUM(attempts * CASE operation
        WHEN 'autocomplete' THEN ? WHEN 'details' THEN ? WHEN 'photo' THEN ? ELSE ? END), 0) AS cents
        FROM plugin_share_usage WHERE scope_id = '__instance__' AND usage_day >= ?`, 1, 2, 1, budgetCents + 1, month)?.cents ?? 0;
      if (spent + ATTEMPT_CENTS[operation] > budgetCents) throw new HttpException('Monthly Google Places budget reached', 429);
      const rows = [scope, '__instance__'].map(scopeId => this.db.get<{ attempts: number }>(
        'SELECT attempts FROM plugin_share_usage WHERE scope_id = ? AND operation = ? AND usage_day = ?', scopeId, operation, day));
      if ((rows[0]?.attempts ?? 0) >= tripMax || (rows[1]?.attempts ?? 0) >= instanceMax) throw new HttpException('Advice provider quota reached', 429);
      for (const scopeId of [scope, '__instance__']) this.db.run(`INSERT INTO plugin_share_usage (scope_id, operation, usage_day, attempts) VALUES (?, ?, ?, 1)
        ON CONFLICT(scope_id, operation, usage_day) DO UPDATE SET attempts = attempts + 1`, scopeId, operation, day);
    });
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    if (!url.startsWith(`${UPSTREAM}/`)) throw new ServiceUnavailableException('Google Places endpoint is unavailable');
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok || response.status >= 300) { discardBody(response); throw new ServiceUnavailableException('Google Places provider is unavailable'); }
    const body = await readCappedJson<unknown>(response, 256 * 1024);
    if (body === undefined) throw new ServiceUnavailableException('Google Places provider returned an invalid response');
    return body;
  }

  async autocomplete(ownerId: number, input: AdviceOwnerCityAutocomplete): Promise<AdviceOwnerCityAutocompleteResult> {
    this.shares.requireNativeOwner(input.tripId, ownerId);
    if (input.input.trim().length < 2) throw new UnprocessableEntityException('City search needs at least two characters');
    const release = this.enter(ownerId);
    try {
      const key = this.configReady();
      this.reserve(input.tripId, 'autocomplete', 500, 5000);
      const session = this.session(ownerId, input);
      const raw = autocompleteBody.parse(await this.json(`${UPSTREAM}/v1/places:autocomplete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.types,suggestions.placePrediction.structuredFormat' },
        body: JSON.stringify({ input: input.input.trim(), includedPrimaryTypes: ['(cities)'], sessionToken: session.googleToken }),
      }));
      this.shares.requireNativeOwner(input.tripId, ownerId);
      for (const [predictionId, value] of this.predictions) {
        if (value.googleToken === session.googleToken) this.predictions.delete(predictionId);
      }
      const suggestions = (raw.suggestions ?? []).filter(item => item.placePrediction.types?.includes('locality')).slice(0, 5).map(item => {
        const prediction = item.placePrediction;
        const predictionId = randomBytes(32).toString('base64url');
        this.predictions.set(predictionId, { ...session, placeId: prediction.placeId });
        return { predictionId, mainText: prediction.structuredFormat.mainText.text.slice(0, 200), secondaryText: prediction.structuredFormat.secondaryText?.text.slice(0, 300) ?? '' };
      });
      return adviceOwnerCityAutocompleteResultSchema.parse({ suggestions });
    } finally { release(); }
  }

  async resolve(ownerId: number, input: AdviceOwnerCityResolve): Promise<z.infer<typeof ownerCityHostResultSchema>> {
    this.shares.requireNativeOwner(input.tripId, ownerId);
    this.prune();
    const prediction = this.predictions.get(input.predictionId);
    if (!prediction || prediction.ownerId !== ownerId || prediction.tripId !== input.tripId || prediction.clientToken !== input.sessionToken) {
      throw new UnprocessableEntityException('City prediction is unavailable');
    }
    const release = this.enter(ownerId);
    try {
      const key = this.configReady();
      this.reserve(input.tripId, 'details', 100, 1000);
      const rawValue = await this.json(`${UPSTREAM}/v1/places/${encodeURIComponent(prediction.placeId)}?languageCode=en&sessionToken=${encodeURIComponent(prediction.googleToken)}`, {
        method: 'GET', headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,types,displayName,addressComponents,viewport' },
      });
      const parsedDetails = detailsBody.safeParse(rawValue);
      if (!parsedDetails.success) throw new UnprocessableEntityException('Google result has no usable locality bounds');
      const raw = parsedDetails.data;
      this.shares.requireNativeOwner(input.tripId, ownerId);
      const locality = raw.addressComponents.find(component => component.types.includes('locality'))?.longText;
      const countryCode = raw.addressComponents.find(component => component.types.includes('country'))?.shortText?.toUpperCase();
      if (!raw.types.includes('locality') || !locality || !countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
        throw new UnprocessableEntityException('Google result is not a verified locality');
      }
      const parsedCity = adviceAddedCitySchema.safeParse({ key: `city-${randomUUID()}`, label: raw.displayName.text.slice(0, 100), countryCodes: [countryCode],
        bounds: { south: raw.viewport.low.latitude, west: raw.viewport.low.longitude, north: raw.viewport.high.latitude, east: raw.viewport.high.longitude } });
      if (!parsedCity.success) throw new UnprocessableEntityException('Google result has no usable locality bounds');
      const city = parsedCity.data;
      const owner = await this.shares.addNativeCity(input.tripId, ownerId, input.expectedRevision, city);
      return ownerCityHostResultSchema.parse({ city, owner });
    } finally {
      for (const [key, value] of this.predictions) if (value.googleToken === prediction.googleToken) this.predictions.delete(key);
      this.sessions.delete(this.sessionKey(ownerId, input.tripId, input.sessionToken));
      release();
    }
  }
}
