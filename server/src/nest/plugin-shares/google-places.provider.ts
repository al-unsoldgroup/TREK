import { Inject, Injectable, Optional, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  advicePlacesAutocompleteResultSchema, advicePlacesResolveResultSchema, advicePhotoResultSchema, advicePlacesMetadataResultSchema,
  type AdvicePlacesAutocompleteAction, type AdvicePlacesResolveAction,
  type AdvicePlacesAutocompleteResult, type AdvicePlacesResolveResult,
  type AdvicePlacesMetadataAction, type AdvicePlacesMetadataResult,
  advicePlacesResolveResultV2Schema,
} from '@trek/shared';
import { readEnv } from '../../app-config';
import { readInstanceApiKey } from '../settings/instance-api-keys';
import { readCappedJson, readCapped, exceedsDeclaredLength, discardBody } from '../../utils/cappedFetch';
import { DatabaseService } from '../database/database.service';
import type { AdviceProviderPrincipal } from './plugin-shares.service';
import { PluginSharesService } from './plugin-shares.service';

export const GOOGLE_PLACES_FETCH = Symbol('GOOGLE_PLACES_FETCH');
export type GooglePlacesFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const UPSTREAM = 'https://places.googleapis.com';
const JSON_LIMIT = 256 * 1024;
const PHOTO_LIMIT = 512 * 1024;
const HANDLE_TTL_MS = 10 * 60 * 1000;
const MAX_HANDLES_PER_SESSION = 100;
const MAX_HANDLES = 5000;
const MAX_SEARCH_SESSIONS = 1000;
const MAX_INFLIGHT_PER_SESSION = 4;
const MAX_INFLIGHT = 64;
const FETCH_TIMEOUT_MS = 5000;
// Conservative whole USD cents per attempt, without free-tier/session discounts.
// Google global list checked 2026-09-13: $2.83/$17/$7 per 1,000 requests.
// https://developers.google.com/maps/billing-and-pricing/pricing
// Keep these ceilings at least as high as every price charged this UTC month.
const ATTEMPT_CENTS = { autocomplete: 1, details: 2, photo: 1 } as const;
const PHOTO_HOSTS = new Set(['lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com']);

const text = (max: number) => z.string().min(1).max(max);
const googleText = z.strictObject({ text: text(300), matches: z.array(z.strictObject({ startOffset: z.number().int().min(0).max(300).optional(), endOffset: z.number().int().min(0).max(300) })).max(50).optional() });
const autocompleteBody = z.strictObject({
  suggestions: z.array(z.union([
    z.strictObject({ placePrediction: z.strictObject({ placeId: text(256), structuredFormat: z.strictObject({ mainText: googleText, secondaryText: googleText.optional() }) }) }),
    z.strictObject({ queryPrediction: z.strictObject({ text: googleText, structuredFormat: z.strictObject({ mainText: googleText, secondaryText: googleText.optional() }) }) }),
  ])).max(20).optional(),
});
const detailsBody = z.strictObject({
  primaryTypeDisplayName: z.strictObject({ text: text(200), languageCode: text(35).optional() }).optional(),
  location: z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  id: text(256), displayName: googleText.extend({ languageCode: text(35).optional() }), formattedAddress: text(500).optional(), googleMapsUri: z.string().url().max(2000).optional(),
  addressComponents: z.array(z.strictObject({ longText: text(200).optional(), shortText: text(20).optional(), languageCode: text(35).optional(), types: z.array(text(80)).max(20) })).max(100).optional(),
  photos: z.array(z.strictObject({ name: text(500), widthPx: z.number().int().positive().optional(), heightPx: z.number().int().positive().optional(), googleMapsUri: z.string().url().max(2000).optional(), flagContentUri: z.string().url().max(2000).optional(), authorAttributions: z.array(z.strictObject({ displayName: text(200), uri: z.string().url().max(2000), photoUri: z.string().url().max(2000).optional() })).max(20).optional() })).max(20).optional(),
});
const mediaBody = z.strictObject({ name: text(512).optional(), photoUri: z.string().url().max(4096) });

type City = { bounds: { south: number; west: number; north: number; east: number } };
type HandleBase = { shareId: string; sessionId: string; guestId: string; epoch: number; expiresAt: number };
type PredictionHandle = HandleBase & { kind: 'prediction'; searchId: string; sessionToken: string; placeId: string; cityId: string };
type SelectionHandle = HandleBase & { kind: 'selection'; googlePlaceId: string; cityId: string; title: string; locality: string; countryCode: string; photoHandle?: string; placeType?: string; lat?: number; lng?: number; native?: boolean };
type PhotoHandle = HandleBase & { kind: 'photo'; photoName: string; googleMapsUri: string; authors: Array<{ displayName: string; uri: string }> };
type Handle = PredictionHandle | SelectionHandle | PhotoHandle;

function opaque(): string { return randomBytes(32).toString('base64url'); }
function isPrincipal(value: AdviceProviderPrincipal): boolean { return (value.kind === 'publicShare' || value.kind === 'adviceOwner') && value.pluginId === 'trip-advice'; }
function isImageMime(value: string | null): value is 'image/jpeg' | 'image/png' | 'image/webp' {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp';
}
function hasImageSignature(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}
function safeHttpsUrl(raw: string, hosts?: Set<string>): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 4096) return null;
    if (hosts && !hosts.has(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch { return null; }
}

@Injectable()
export class GooglePlacesProvider {
  private readonly handles = new Map<string, Handle>();
  private readonly searchSessions = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, number>();
  private totalInflight = 0;

  constructor(private readonly db: DatabaseService, private readonly shares: PluginSharesService,
    @Optional() @Inject(GOOGLE_PLACES_FETCH) private readonly fetcher: GooglePlacesFetch = globalThis.fetch.bind(globalThis)) {}

  private validate(principal: AdviceProviderPrincipal) {
    return principal.kind === 'publicShare' ? this.shares.validatePrincipal(principal) : this.shares.validateProviderPrincipal(principal);
  }
  private snapshot(principal: AdviceProviderPrincipal) {
    return principal.kind === 'publicShare' ? this.shares.snapshot(principal) : this.shares.providerSnapshot(principal);
  }
  private cities(principal: AdviceProviderPrincipal) {
    return principal.kind === 'publicShare' ? this.shares.publicCities(principal) : this.shares.providerCities(principal);
  }

  private configReady(): string {
    const config = readEnv();
    const google = config.plugins.googlePlaces;
    let terms: URL;
    let privacy: URL;
    try { terms = new URL(google.termsUrl ?? ''); privacy = new URL(google.privacyUrl ?? ''); } catch { throw new HttpException({ error: 'Google Places is not configured' }, 503); }
    if (!config.plugins.enabled || !config.plugins.publicAdvice || !google.enabled || config.maps.placesApiKey === undefined && !readInstanceApiKey(this.db, 'maps_api_key') || google.budgetCents < 1 || terms.protocol !== 'https:' || privacy.protocol !== 'https:' || terms.username || privacy.username || terms.password || privacy.password) {
      throw new HttpException({ error: 'Google Places is not configured' }, 503);
    }
    return config.maps.placesApiKey || readInstanceApiKey(this.db, 'maps_api_key') || '';
  }

  private prune(now = Date.now()): void {
    for (const [key, handle] of this.handles) if (handle.expiresAt <= now) this.handles.delete(key);
    for (const [key, session] of this.searchSessions) if (session.expiresAt <= now) this.searchSessions.delete(key);
    while (this.handles.size > MAX_HANDLES) {
      const first = this.handles.keys().next().value;
      if (typeof first !== 'string') break;
      this.handles.delete(first);
    }
    while (this.searchSessions.size > MAX_SEARCH_SESSIONS) {
      const first = this.searchSessions.keys().next().value;
      if (typeof first !== 'string') break;
      this.searchSessions.delete(first);
    }
  }

  private handleKey(principal: AdviceProviderPrincipal): string { return `${principal.shareId}:${principal.sessionId}`; }
  private enter(principal: AdviceProviderPrincipal): () => void {
    const key = this.handleKey(principal);
    const current = this.inflight.get(key) ?? 0;
    if (current >= MAX_INFLIGHT_PER_SESSION || this.totalInflight >= MAX_INFLIGHT) throw new HttpException('Advice provider is busy', 429);
    this.inflight.set(key, current + 1); this.totalInflight++;
    return () => { const remaining = (this.inflight.get(key) ?? 1) - 1; if (remaining) this.inflight.set(key, remaining); else this.inflight.delete(key); this.totalInflight--; };
  }

  private addHandle(handle: Handle): string {
    this.prune();
    let count = 0;
    for (const value of this.handles.values()) if (value.sessionId === handle.sessionId) count++;
    if (count >= MAX_HANDLES_PER_SESSION) {
      for (const [key, value] of this.handles) if (value.sessionId === handle.sessionId) { this.handles.delete(key); break; }
    }
    const key = opaque();
    this.handles.set(key, handle);
    return key;
  }

  private searchToken(principal: AdviceProviderPrincipal, searchId: string): string {
    this.prune();
    const key = `${this.handleKey(principal)}:${searchId}`;
    const current = this.searchSessions.get(key);
    if (current) return current.token;
    // Google Places rejects session tokens longer than 36 characters. Opaque
    // handles remain 43-character base64url values, but the upstream billing
    // session token follows Google's narrower contract.
    const token = randomUUID();
    this.searchSessions.set(key, { token, expiresAt: Date.now() + HANDLE_TTL_MS });
    return token;
  }

  private scoped<T extends Handle>(principal: AdviceProviderPrincipal, key: string, kind: T['kind']): T {
    this.prune();
    const value = this.handles.get(key);
    if (!value || value.kind !== kind || value.shareId !== principal.shareId || value.sessionId !== principal.sessionId || value.guestId !== principal.guestId || value.epoch !== principal.epoch) {
      throw new HttpException('Place handle is unavailable', 422);
    }
    return value as T;
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    if (!url.startsWith(`${UPSTREAM}/`)) throw new ServiceUnavailableException('Google Places endpoint is unavailable');
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok || response.status >= 300) { discardBody(response); throw new ServiceUnavailableException('Google Places provider is unavailable'); }
    const body = await readCappedJson<unknown>(response, JSON_LIMIT);
    if (body === undefined) throw new ServiceUnavailableException('Google Places provider returned an invalid response');
    return body;
  }

  private reserve(principal: AdviceProviderPrincipal, operation: keyof typeof ATTEMPT_CENTS, shareMax: number, instanceMax: number): void {
    const day = new Date().toISOString().slice(0, 10);
    const month = `${day.slice(0, 7)}-01`;
    const budgetCents = readEnv().plugins.googlePlaces.budgetCents;
    this.db.transaction(() => {
      // Retain the entire month, including failed attempts and deleted shares.
      // The instance rows survive provider restarts and are shared by all links.
      this.db.run('DELETE FROM plugin_share_usage WHERE usage_day < ?', month);
      const spent = this.db.get<{ cents: number }>(`SELECT COALESCE(SUM(attempts * CASE operation
        WHEN 'autocomplete' THEN ? WHEN 'details' THEN ? WHEN 'photo' THEN ? ELSE ? END), 0) AS cents
        FROM plugin_share_usage WHERE scope_id = '__instance__' AND usage_day >= ?`,
      ATTEMPT_CENTS.autocomplete, ATTEMPT_CENTS.details, ATTEMPT_CENTS.photo, budgetCents + 1, month)?.cents ?? 0;
      if (spent + ATTEMPT_CENTS[operation] > budgetCents) throw new HttpException('Monthly Google Places budget reached', 429);
      const rows = [principal.shareId, '__instance__'].map(scopeId => this.db.get<{ attempts: number }>(
        'SELECT attempts FROM plugin_share_usage WHERE scope_id = ? AND operation = ? AND usage_day = ?', scopeId, operation, day));
      if ((rows[0]?.attempts ?? 0) >= shareMax || (rows[1]?.attempts ?? 0) >= instanceMax) throw new HttpException('Advice provider quota reached', 429);
      for (const scopeId of [principal.shareId, '__instance__']) {
        this.db.run(`INSERT INTO plugin_share_usage (scope_id, operation, usage_day, attempts) VALUES (?, ?, ?, 1)
          ON CONFLICT(scope_id, operation, usage_day) DO UPDATE SET attempts = attempts + 1`, scopeId, operation, day);
      }
    });
  }

  private city(principal: AdviceProviderPrincipal, cityId: string): City | null {
    const config = principal.kind === 'publicShare' ? this.shares.publicCity(principal, cityId) : this.cities(principal).find(city => city.id === cityId);
    if (!config) return null;
    return config;
  }

  async autocomplete(principal: AdviceProviderPrincipal, action: AdvicePlacesAutocompleteAction): Promise<{ version: 1; kind: 'places.autocomplete'; data: AdvicePlacesAutocompleteResult }> {
    if (!isPrincipal(principal)) throw new HttpException('Invalid public share', 404);
    this.validate(principal);
    const release = this.enter(principal);
    try {
      const key = this.configReady();
      const city = action.cityId === 'elsewhere' ? null : this.city(principal, action.cityId);
      if (action.cityId !== 'elsewhere' && !city && !this.snapshot(principal).cities.some(item => item.id === action.cityId)) throw new HttpException('Place city is unavailable', 422);
      this.reserve(principal, 'autocomplete', 500, 5000);
      const sessionToken = this.searchToken(principal, action.searchId);
      const body: Record<string, unknown> = { input: action.input.trim(), languageCode: action.locale, sessionToken };
      if (city) body.locationBias = { rectangle: { low: { latitude: city.bounds.south, longitude: city.bounds.west }, high: { latitude: city.bounds.north, longitude: city.bounds.east } } };
      const raw = autocompleteBody.parse(await this.json(`${UPSTREAM}/v1/places:autocomplete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat' }, body: JSON.stringify(body),
      }));
      this.validate(principal);
      const suggestions = (raw.suggestions ?? []).flatMap(item => {
        if (!('placePrediction' in item)) return [];
        const prediction = item.placePrediction;
        const predictionId = this.addHandle({ ...principal, kind: 'prediction', expiresAt: Date.now() + HANDLE_TTL_MS, searchId: action.searchId, sessionToken, placeId: prediction.placeId, cityId: action.cityId });
        return [{ predictionId, mainText: prediction.structuredFormat.mainText.text.slice(0, 200), secondaryText: prediction.structuredFormat.secondaryText?.text ?? '' }];
      }).slice(0, 5);
      return { version: 1, kind: 'places.autocomplete', data: advicePlacesAutocompleteResultSchema.parse({ suggestions }) };
    } finally { release(); }
  }

  async resolveAction(principal: AdviceProviderPrincipal, action: AdvicePlacesResolveAction): Promise<{ version: 1; kind: 'places.resolve'; data: AdvicePlacesResolveResult }> {
    if (!isPrincipal(principal)) throw new HttpException('Invalid public share', 404);
    this.validate(principal);
    const prediction = this.scoped<PredictionHandle>(principal, action.predictionId, 'prediction');
    if (prediction.searchId !== action.searchId) throw new HttpException('Place handle is unavailable', 422);
    const release = this.enter(principal);
    try {
      const key = this.configReady();
      this.reserve(principal, 'details', 100, 1000);
      const url = `${UPSTREAM}/v1/places/${encodeURIComponent(prediction.placeId)}?languageCode=en&sessionToken=${encodeURIComponent(prediction.sessionToken)}`;
      let raw: z.infer<typeof detailsBody>;
      try { raw = detailsBody.parse(await this.json(url, { method: 'GET', headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,addressComponents,location,googleMapsUri,photos,primaryTypeDisplayName' } })); }
      finally {
        for (const [handle, value] of this.handles) if (value.kind === 'prediction' && value.sessionToken === prediction.sessionToken) this.handles.delete(handle);
        for (const [key, value] of this.searchSessions) if (value.token === prediction.sessionToken) this.searchSessions.delete(key);
      }
      this.validate(principal);
      const countryComponent = raw.addressComponents?.find(item => item.types.includes('country'));
      const localityComponent = raw.addressComponents?.find(item => item.types.includes('locality') || item.types.includes('postal_town') || item.types.includes('administrative_area_level_2'));
      const countryCode = countryComponent?.shortText?.toUpperCase();
      if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) throw new ServiceUnavailableException('Google place has no usable country');
      const location = raw.location;
      const matchingCities = location ? this.cities(principal).filter(city =>
        city.countryCodes.includes(countryCode) && location.latitude >= city.bounds.south &&
        location.latitude <= city.bounds.north && location.longitude >= city.bounds.west &&
        location.longitude <= city.bounds.east) : [];
      const cityId = matchingCities.length === 1 ? matchingCities[0].id : 'elsewhere';
      const selection = { googlePlaceId: raw.id, cityId, title: raw.displayName.text.slice(0, 200), locality: (localityComponent?.longText ?? raw.formattedAddress ?? '').slice(0, 100), countryCode, ...this.presentation(principal, raw) };
      const selectionId = this.addHandle({ ...principal, kind: 'selection', expiresAt: Date.now() + HANDLE_TTL_MS, ...selection,
        ...(raw.location ? { lat: raw.location.latitude, lng: raw.location.longitude } : {}) });
      return { version: 1, kind: 'places.resolve', data: advicePlacesResolveResultSchema.parse({ selectionId, place: selection }) };
    } finally { release(); }
  }

  async resolveActionV2(principal: AdviceProviderPrincipal, action: AdvicePlacesResolveAction) {
    const result = await this.resolveAction(principal, action);
    const selected = this.scoped<SelectionHandle>(principal, result.data.selectionId, 'selection');
    selected.native = true;
    const { placeType, ...place } = result.data.place;
    return { version: 2 as const, kind: 'places.resolve' as const, data: advicePlacesResolveResultV2Schema.parse({ selectionId: result.data.selectionId,
      place: { ...place, ...(placeType ? { primaryType: placeType } : {}), ...(selected.lat !== undefined && selected.lng !== undefined ? { lat: selected.lat, lng: selected.lng } : {}) } }) };
  }

  private presentation(principal: AdviceProviderPrincipal, raw: z.infer<typeof detailsBody>) {
    const photo = raw.photos?.[0];
    let photoHandle: string | undefined;
    if (photo) {
      if (!/^places\/[^/]+\/photos\/[^/]+$/.test(photo.name)) throw new ServiceUnavailableException('Google place photo reference is invalid');
      const googleMapsUri = photo.googleMapsUri ? safeHttpsUrl(photo.googleMapsUri) : null;
      const authors = (photo.authorAttributions ?? []).flatMap(author => {
        const uri = safeHttpsUrl(author.uri);
        return uri ? [{ displayName: author.displayName, uri }] : [];
      });
      if (googleMapsUri) photoHandle = this.addHandle({ ...principal, kind: 'photo', expiresAt: Date.now() + HANDLE_TTL_MS, photoName: photo.name, googleMapsUri, authors });
    }
    return { ...(raw.primaryTypeDisplayName ? { placeType: raw.primaryTypeDisplayName.text } : {}), ...(photoHandle ? { photoHandle } : {}) };
  }

  async metadata(principal: AdviceProviderPrincipal, action: AdvicePlacesMetadataAction): Promise<{ version: 1; kind: 'places.metadata'; data: AdvicePlacesMetadataResult }> {
    if (!isPrincipal(principal)) throw new HttpException('Invalid public share', 404);
    const projection = this.snapshot(principal);
    const places = [...projection.shortlists.flatMap(list => [...list.see, ...list.eat]), ...projection.stays.flatMap(stay => stay.days.flatMap(day => day.schedule.map(item => item.place)))];
    const place = places.find(item => item.key === action.placeKey);
    if (!place?.googlePlaceId) throw new HttpException('Published Google place is unavailable', 422);
    const release = this.enter(principal);
    try {
      const key = this.configReady();
      this.reserve(principal, 'details', 100, 1000);
      const raw = detailsBody.parse(await this.json(`${UPSTREAM}/v1/places/${encodeURIComponent(place.googlePlaceId)}?languageCode=en`, {
        method: 'GET', headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,displayName,photos,primaryTypeDisplayName' },
      }));
      this.validate(principal);
      if (raw.id !== place.googlePlaceId) throw new ServiceUnavailableException('Google place identity changed');
      return { version: 1, kind: 'places.metadata', data: advicePlacesMetadataResultSchema.parse({ placeKey: action.placeKey, ...this.presentation(principal, raw) }) };
    } finally { release(); }
  }

  async resolveSelection(principal: AdviceProviderPrincipal, selectionId: string) {
    const selection = this.scoped<SelectionHandle>(principal, selectionId, 'selection');
    this.validate(principal);
    const projection = this.snapshot(principal);
    const duplicate = projection.shortlists.flatMap(list => [...list.see, ...list.eat]).find(place => place.googlePlaceId === selection.googlePlaceId);
    return { googlePlaceId: selection.googlePlaceId, cityId: selection.cityId, title: selection.title, locality: selection.locality, countryCode: selection.countryCode, duplicate: duplicate ? { placeKey: duplicate.key, cityId: duplicate.cityId, category: duplicate.category } : null,
      ...(selection.native ? { lat: selection.lat, lng: selection.lng, primaryType: selection.placeType, photoHandle: selection.photoHandle } : {}) };
  }

  async photo(principal: AdviceProviderPrincipal, handle: string): Promise<z.infer<typeof advicePhotoResultSchema>> {
    if (!isPrincipal(principal)) throw new HttpException('Invalid public share', 404);
    const photo = this.scoped<PhotoHandle>(principal, handle, 'photo');
    this.validate(principal);
    const release = this.enter(principal);
    try {
      const key = this.configReady();
      this.reserve(principal, 'photo', 300, 3000);
      const media = mediaBody.parse(await this.json(`${UPSTREAM}/v1/${photo.photoName}/media?maxWidthPx=512&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': key } }));
      const photoUrl = safeHttpsUrl(media.photoUri, PHOTO_HOSTS);
      if (!photoUrl) return advicePhotoResultSchema.parse({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null });
      this.validate(principal);
      const response = await this.fetcher(photoUrl, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status >= 300 && response.status < 400) { discardBody(response); return advicePhotoResultSchema.parse({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null }); }
      if (!response.ok || exceedsDeclaredLength(response, PHOTO_LIMIT)) { discardBody(response); return advicePhotoResultSchema.parse({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null }); }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() ?? null;
      if (!isImageMime(contentType)) { discardBody(response); return advicePhotoResultSchema.parse({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null }); }
      const { bytes, truncated } = await readCapped(response, PHOTO_LIMIT);
      if (truncated || bytes.length === 0 || !hasImageSignature(bytes, contentType)) return advicePhotoResultSchema.parse({ state: 'unavailable', mimeType: null, bytesBase64: null, authors: [], googleAttribution: null });
      this.validate(principal);
      return advicePhotoResultSchema.parse({ state: 'available', mimeType: contentType, bytesBase64: bytes.toString('base64'), authors: photo.authors, googleMapsUri: photo.googleMapsUri, googleAttribution: 'Google Maps' });
    } finally { release(); }
  }
}
