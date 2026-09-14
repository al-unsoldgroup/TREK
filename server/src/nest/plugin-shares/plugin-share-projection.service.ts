import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { adviceOwnerCandidatesSchema, adviceProjectionSchema, adviceShareConfigSchema, adviceProjectionV2Schema, adviceShareConfigV2Schema, type AdvicePlace, type AdviceShareConfig, type AdviceShareConfigV2 } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { getCountryFromCoords } from '../atlas/atlas-geo';
import { adviceCountry, adviceLocality } from './plugin-share-location';

interface Day { id: number; date: string | null; day_number: number; notes: string | null }
interface Assignment { id: number; place_id: number; day_id: number; assignment_time: string | null; order_index: number }
interface Place { id: number; google_place_id: string | null; lat: number | null; lng: number | null }

@Injectable()
export class PluginShareProjectionService {
  constructor(private readonly db: DatabaseService) {}

  private logisticsPlaces(tripId: number): number[] {
    return this.db.all<{ id: number; name: string; category: string | null }>(`SELECT p.id, p.name, c.name AS category
      FROM places p LEFT JOIN categories c ON c.id = p.category_id WHERE p.trip_id = ?`, tripId).filter(place => {
      const category = place.category?.trim().toLowerCase() ?? '';
      if (['hotel', 'accommodation', 'transport', 'airport', 'flight', 'train station', 'bus station', 'parking', 'luggage storage'].includes(category)) return true;
      return /\b(?:hotels?|ryokan|baggage|luggage|retrieve bags|airport|aéroport)\b/iu.test(place.name);
    }).map(place => place.id);
  }

  candidates(tripId: number) {
    return adviceOwnerCandidatesSchema.parse({ ...this.nativeCandidates(tripId), preset: this.preset(tripId) });
  }

  private nativeCandidates(tripId: number) {
    const logistics = new Set(this.logisticsPlaces(tripId));
    const days = this.db.all<{ id: number; date: string }>(`SELECT id, date FROM days
      WHERE trip_id = ? AND date IS NOT NULL ORDER BY day_number, id`, tripId)
      .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
    const places = this.db.all<{ placeId: number; publicTitle: string; lat: number | null; lng: number | null }>(`
      SELECT p.id AS placeId, p.name AS publicTitle, p.lat, p.lng FROM places p
      WHERE p.trip_id = ?
      AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.trip_id = p.trip_id AND r.place_id = p.id
        AND r.type NOT IN ('restaurant','event','tour','activity'))
      AND NOT EXISTS (SELECT 1 FROM day_accommodations a WHERE a.trip_id = p.trip_id AND a.place_id = p.id)
      ORDER BY p.name, p.id`, tripId).filter(place => !logistics.has(place.placeId));
    const assignments = this.db.all<{ assignmentId: number; dayId: number; placeId: number; excluded: number }>(`
      SELECT a.id AS assignmentId, a.day_id AS dayId, a.place_id AS placeId,
        EXISTS (SELECT 1 FROM reservations r WHERE r.trip_id = d.trip_id AND r.assignment_id = a.id
          AND r.type NOT IN ('restaurant','event','tour','activity')) AS excluded
      FROM day_assignments a JOIN days d ON d.id = a.day_id JOIN places p ON p.id = a.place_id
      WHERE d.trip_id = ? AND p.trip_id = ? ORDER BY d.day_number, a.order_index, a.id`, tripId, tripId);
    const scheduled = new Set(assignments.map(a => a.placeId));
    const byId = new Map(places.map(place => [place.placeId, place]));
    const eligibleDays = new Set(days.map(day => day.id));
    const schedule = assignments.flatMap(a => {
      const place = byId.get(a.placeId);
      return place && !a.excluded && eligibleDays.has(a.dayId)
        ? [{ ...place, assignmentId: a.assignmentId, dayId: a.dayId }] : [];
    });
    return adviceOwnerCandidatesSchema.parse({ days, schedule, shortlist: places.filter(place => !scheduled.has(place.placeId)) });
  }

  preset(tripId: number, hidden: NonNullable<AdviceShareConfig['hidden']> = { cityIds: [], dayIds: [], placeIds: [], assignmentIds: [] }): AdviceShareConfig {
    return this.nativePreset(tripId, hidden).config;
  }

  private nativePreset(tripId: number, hidden: NonNullable<AdviceShareConfig['hidden']> = { cityIds: [], dayIds: [], placeIds: [], assignmentIds: [] }) {
    const native = this.nativeCandidates(tripId);
    const trip = this.db.get<{ title: string }>('SELECT title FROM trips WHERE id = ?', tripId);
    if (!trip) throw new UnprocessableEntityException('Trip is unavailable');
    const metadata = this.db.all<{ id: number; address: string | null; country_code: string | null; region_name: string | null; category: string | null }>(`SELECT p.id, p.address, r.country_code, r.region_name, c.name AS category FROM places p LEFT JOIN place_regions r ON r.place_id = p.id LEFT JOIN categories c ON c.id = p.category_id WHERE p.trip_id = ?`, tripId);
    const byId = new Map(metadata.map(row => [row.id, row]));
    const cities = new Map<string, AdviceShareConfig['cities'][number]>();
    const unlocatedCities = new Set<string>();
    const placeCities = new Map<number, string>();
    const categories = new Map<number, 'see' | 'eat'>();
    const locatedPlaces = [...native.schedule, ...native.shortlist].map(place => {
      const detail = byId.get(place.placeId);
      const located = place.lat !== null && place.lng !== null;
      const country = detail?.country_code || (located ? getCountryFromCoords(place.lat!, place.lng!) : null) || adviceCountry(detail?.address);
      return { place, detail, located, country };
    });
    const countryEvidence = [...metadata, ...locatedPlaces.flatMap(({ country, detail }) => {
      if (!country) return [];
      const locality = adviceLocality(detail?.address, country, detail?.region_name ?? null);
      return locality ? [{ country_code: country, region_name: locality }] : [];
    })];
    for (const { place, detail, located, country } of locatedPlaces) {
      const countryCode = country || adviceCountry(detail?.address, countryEvidence);
      const knownLocality = adviceLocality(detail?.address, countryCode, detail?.region_name ?? null);
      const locality = knownLocality || 'Location not specified';
      const cityId = `city-${createHash('sha256').update(`${countryCode ?? ''}/${locality.toLocaleLowerCase('en')}`).digest('hex').slice(0, 16)}`;
      if (!knownLocality) unlocatedCities.add(cityId);
      let city = cities.get(cityId);
      if (!city) {
        city = { id: cityId, label: locality.slice(0, 100), countryCodes: countryCode ? [countryCode] : [], bounds: null };
        cities.set(cityId, city);
      }
      if (located) {
        const point = { south: Math.max(-90, place.lat! - 0.03), north: Math.min(90, place.lat! + 0.03), west: Math.max(-180, place.lng! - 0.03), east: Math.min(180, place.lng! + 0.03) };
        const old = city.bounds;
        city.bounds = old ? { south: Math.min(old.south, point.south), north: Math.max(old.north, point.north), west: Math.min(old.west, point.west), east: Math.max(old.east, point.east) } : point;
      }
      placeCities.set(place.placeId, cityId);
      categories.set(place.placeId, /restaurant|food|cafe|café|dining|eat|bar|bakery/i.test(detail?.category ?? '') ? 'eat' : 'see');
    }
    const days = [...native.days].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const dayCities = new Map<number, string>();
    for (const day of days) {
      const counts = new Map<string, number>();
      for (const row of native.schedule.filter(row => row.dayId === day.id)) {
        const cityId = placeCities.get(row.placeId)!;
        if (unlocatedCities.has(cityId)) continue;
        counts.set(cityId, (counts.get(cityId) ?? 0) + 1);
      }
      const chosen = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (chosen) dayCities.set(day.id, chosen);
    }
    const cityStays = this.db.all<{ startDate: string; endDate: string; address: string | null }>(`
      SELECT s.date AS startDate, e.date AS endDate, p.address FROM day_accommodations a
      JOIN places p ON p.id = a.place_id AND p.trip_id = a.trip_id
      JOIN days s ON s.id = a.start_day_id AND s.trip_id = a.trip_id
      JOIN days e ON e.id = a.end_day_id AND e.trip_id = a.trip_id WHERE a.trip_id = ?`, tripId).flatMap(stay => {
      const country = adviceCountry(stay.address, countryEvidence);
      const parts = new Set(stay.address?.normalize('NFKC').split(',').map(part => part.trim().replace(/^〒?\s*\d{3}-\d{4}\s+/, '').toLocaleLowerCase('en')));
      const matches = [...cities.values()].filter(city => country && city.countryCodes.includes(country) && parts.has(city.label.normalize('NFKC').toLocaleLowerCase('en')));
      return matches.length === 1 ? [{ startDate: stay.startDate, endDate: stay.endDate, cityId: matches[0]!.id }] : [];
    });
    for (const day of days) {
      if (dayCities.has(day.id)) continue;
      const matches = new Set(cityStays.filter(stay => stay.startDate <= day.date && day.date < stay.endDate).map(stay => stay.cityId));
      if (matches.size === 1) dayCities.set(day.id, [...matches][0]!);
    }
    const fallback = 'city-unlocated';
    let previousCity: string | undefined;
    const stays: AdviceShareConfig['stays'] = [];
    let previousDate: string | undefined;
    for (const day of days) {
      const cityId = dayCities.get(day.id) || previousCity || days.map(next => dayCities.get(next.id)).find(Boolean) || fallback;
      previousCity = cityId;
      if (!cities.has(cityId)) cities.set(cityId, { id: cityId, label: 'Trip days', countryCodes: [], bounds: null });
      if (hidden.dayIds.includes(day.id) || hidden.cityIds.includes(cityId)) { previousDate = undefined; continue; }
      const last = stays[stays.length - 1];
      if (last?.cityId === cityId && previousDate && Date.parse(day.date) - Date.parse(previousDate) === 86400000) last.dayIds.push(day.id);
      else stays.push({ id: `stay-${day.id}`, cityId, dayIds: [day.id] });
      previousDate = day.date;
    }
    const includedDays = new Set(stays.flatMap(stay => stay.dayIds));
    const config = adviceShareConfigSchema.parse({ version: 1, source: 'trip', hidden, publicTitle: trip.title.slice(0, 200),
      cities: [...cities.values()].filter(city => !unlocatedCities.has(city.id) && !hidden.cityIds.includes(city.id)), stays,
      schedule: native.schedule.filter(row => includedDays.has(row.dayId) && !hidden.placeIds.includes(row.placeId) && !hidden.assignmentIds.includes(row.assignmentId) && !hidden.cityIds.includes(placeCities.get(row.placeId)!)).map(row => ({ assignmentId: row.assignmentId, publicTitle: row.publicTitle, category: categories.get(row.placeId)! })),
      shortlist: native.shortlist.filter(row => !hidden.placeIds.includes(row.placeId) && !hidden.cityIds.includes(placeCities.get(row.placeId)!)).map(row => {
        const city = cities.get(placeCities.get(row.placeId)!)!;
        return { placeId: row.placeId, publicTitle: row.publicTitle, category: categories.get(row.placeId)!, cityId: unlocatedCities.has(city.id) ? 'elsewhere' : city.id, locality: city.label, countryCode: city.countryCodes[0] ?? null };
      }),
    });
    return { config, placeCities };
  }

  build(tripId: number, config: AdviceShareConfig, validate = false): z.infer<typeof adviceProjectionSchema> {
    const displayNotes = config.displayNotes === true;
    const native = config.source === 'trip' ? this.nativePreset(tripId, config.hidden) : null;
    if (native) config = native.config;
    const days = this.db.all<Day>('SELECT id, date, day_number, notes FROM days WHERE trip_id = ? ORDER BY day_number, id', tripId);
    const places = this.db.all<Place>('SELECT id, google_place_id, lat, lng FROM places WHERE trip_id = ?', tripId);
    const dayNotes = displayNotes ? this.db.all<{ day_id: number; text: string }>('SELECT day_id, text FROM day_notes WHERE trip_id = ? ORDER BY sort_order, id', tripId) : [];
    const notesFor = (day: Day) => {
      if (!displayNotes) return {};
      const notes = [day.notes, ...dayNotes.filter(note => note.day_id === day.id).map(note => note.text)]
        .flatMap(text => typeof text === 'string' && text.trim() ? [{ text: text.trim().slice(0, 10000) }] : []).slice(0, 100);
      return notes.length ? { notes } : {};
    };
    const assignments = this.db.all<Assignment>(`SELECT a.id, a.place_id, a.day_id, a.assignment_time, a.order_index
      FROM day_assignments a JOIN days d ON d.id = a.day_id JOIN places p ON p.id = a.place_id
      WHERE d.trip_id = ? AND p.trip_id = ? ORDER BY a.order_index, a.id`, tripId, tripId);
    const excluded = new Set(this.db.all<{ place_id: number }>(`SELECT DISTINCT place_id FROM reservations
      WHERE trip_id = ? AND place_id IS NOT NULL AND type NOT IN ('restaurant','event','tour','activity')`, tripId).map(r => r.place_id));
    for (const stay of this.db.all<{ place_id: number }>(`SELECT place_id FROM day_accommodations
      WHERE trip_id = ? AND place_id IS NOT NULL`, tripId)) excluded.add(stay.place_id);
    for (const id of this.logisticsPlaces(tripId)) excluded.add(id);
    const excludedAssignments = new Set(this.db.all<{ assignment_id: number }>(`SELECT DISTINCT assignment_id FROM reservations
      WHERE trip_id = ? AND assignment_id IS NOT NULL AND type NOT IN ('restaurant','event','tour','activity')`, tripId).map(r => r.assignment_id));
    const selectedDays = new Set(config.stays.flatMap(s => s.dayIds));
    const selectedAssignments = new Map(config.schedule.map(s => [s.assignmentId, s]));
    const scheduledPlaces = new Set(assignments.map(a => a.place_id));
    if (validate && (
      [...selectedDays].some(id => !days.some(d => d.id === id && d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date))) ||
      config.schedule.some(s => !assignments.some(a => a.id === s.assignmentId && selectedDays.has(a.day_id) && !excluded.has(a.place_id) && !excludedAssignments.has(a.id))) ||
      config.shortlist.some(s => !places.some(p => p.id === s.placeId) || excluded.has(s.placeId) || scheduledPlaces.has(s.placeId))
    )) throw new UnprocessableEntityException('Selection contains unavailable, scheduled or private logistics targets');

    const summary = (p: Place, text: string, category: 'see' | 'eat', cityId: string, locality: string, countryCode: string | null): AdvicePlace => {
      const maps = new URL('https://www.google.com/maps/search/');
      const queryLocality = ['Location not specified', 'Trip days'].includes(locality) ? null : locality;
      maps.searchParams.set('api', '1'); maps.searchParams.set('query', [text, queryLocality, countryCode].filter(Boolean).join(' '));
      if (p.google_place_id) maps.searchParams.set('query_place_id', p.google_place_id);
      const coordinates = p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 ? { lat: p.lat, lng: p.lng } : undefined;
      return { key: `p:${p.id}`, title: text, category, cityId, locality, countryCode, googlePlaceId: p.google_place_id, mapsUrl: maps.href, ...(coordinates ? { coordinates } : {}) };
    };
    const stays: z.infer<typeof adviceProjectionSchema>['stays'] = config.stays.map(stay => {
      const city = config.cities.find(c => c.id === stay.cityId)!;
      return { id: stay.id, cityId: city.id, shortlistCityId: city.id,
        days: days.filter(d => stay.dayIds.includes(d.id) && d.date).map(day => ({ key: `d:${day.id}`, date: day.date!, ...notesFor(day),
          schedule: assignments.filter(a => a.day_id === day.id && selectedAssignments.has(a.id) && !excluded.has(a.place_id) && !excludedAssignments.has(a.id)).map(a => {
            const selection = selectedAssignments.get(a.id)!;
            const p = places.find(p => p.id === a.place_id)!;
            const placeCity = config.cities.find(c => c.id === native?.placeCities.get(p.id)) ?? city;
            const booked = !!this.db.get(`SELECT 1 FROM reservations r WHERE r.trip_id = ?
              AND COALESCE(r.ingest_state, 'live') <> 'staged' AND r.status = 'confirmed'
              AND r.type IN ('restaurant','event','tour','activity')
              AND (r.assignment_id = ? OR (r.assignment_id IS NULL AND r.place_id = ? AND r.day_id = ?
                AND (SELECT COUNT(*) FROM day_assignments x WHERE x.place_id = ? AND x.day_id = ?) = 1)) LIMIT 1`,
            tripId, a.id, p.id, day.id, p.id, day.id);
            return { key: `a:${a.id}`, place: summary(p, selection.publicTitle, selection.category, placeCity.id, placeCity.label, placeCity.countryCodes[0] ?? null),
              time: a.assignment_time && /^\d{2}:\d{2}$/.test(a.assignment_time) ? a.assignment_time : null, booked };
          }),
        })),
      };
    }).filter(s => s.days.length).sort((a, b) => a.days[0]!.date.localeCompare(b.days[0]!.date));
    const shortlists = [...config.cities.map(c => c.id), 'elsewhere'].map(cityId => {
      const bucket: z.infer<typeof adviceProjectionSchema>['shortlists'][number] = { cityId, see: [], eat: [] };
      for (const selection of config.shortlist.filter(s => s.cityId === cityId)) {
        const p = places.find(p => p.id === selection.placeId);
        if (p && !excluded.has(p.id) && !scheduledPlaces.has(p.id)) bucket[selection.category].push(summary(p, selection.publicTitle, selection.category, cityId, selection.locality, selection.countryCode));
      }
      return bucket;
    });
    const publicData = { version: 1 as const, title: config.publicTitle,
      cities: config.cities.map(({ id, label, countryCodes }) => ({ id, label, countryCodes })), stays, shortlists };
    return adviceProjectionSchema.parse({ ...publicData, revision: createHash('sha256').update(JSON.stringify(publicData)).digest('hex') });
  }

  migrateV1(tripId: number, config: AdviceShareConfig): AdviceShareConfigV2 {
    const before = this.build(tripId, config);
    const all = this.build(tripId, this.preset(tripId));
    const dayKeys = new Set(before.stays.flatMap(stay => stay.days.map(day => day.key)));
    const assignmentKeys = new Set(before.stays.flatMap(stay => stay.days.flatMap(day => day.schedule.map(row => row.key))));
    const ideaKeys = new Set(before.shortlists.flatMap(list => [...list.see, ...list.eat].map(place => place.key)));
    const visibleCities = new Set(all.stays.filter(stay => stay.days.some(day => dayKeys.has(day.key))).map(stay => stay.cityId));
    for (const list of all.shortlists) if ([...list.see, ...list.eat].some(place => ideaKeys.has(place.key))) visibleCities.add(list.cityId);
    for (const stay of all.stays) for (const day of stay.days) for (const row of day.schedule) if (assignmentKeys.has(row.key)) visibleCities.add(row.place.cityId);
    return adviceShareConfigV2Schema.parse({ version: 2, showNotes: config.displayNotes === true,
      hiddenCityKeys: all.cities.filter(city => !visibleCities.has(city.id)).map(city => city.id),
      hiddenDayKeys: all.stays.flatMap(stay => stay.days.filter(day => !dayKeys.has(day.key)).map(day => day.key)),
      hiddenNoteDayKeys: [], hiddenPlaceKeys: all.stays.flatMap(stay => stay.days.flatMap(day => day.schedule.filter(row => !assignmentKeys.has(row.key)).map(row => row.key))),
      hiddenIdeaKeys: all.shortlists.flatMap(list => [...list.see, ...list.eat].filter(place => !ideaKeys.has(place.key)).map(place => place.key)), addedCities: [],
    });
  }

  buildV2(tripId: number, input: AdviceShareConfigV2, owner = false) {
    const config = adviceShareConfigV2Schema.parse(input);
    const hidden = { cityIds: owner ? [] : config.hiddenCityKeys, dayIds: owner ? [] : config.hiddenDayKeys.map(key => Number(key.slice(2))),
      placeIds: owner ? [] : config.hiddenPlaceKeys.filter(key => key.startsWith('p:')).map(key => Number(key.slice(2))),
      assignmentIds: owner ? [] : config.hiddenPlaceKeys.filter(key => key.startsWith('a:')).map(key => Number(key.slice(2))) };
    const base = this.build(tripId, { ...this.preset(tripId, hidden), displayNotes: config.showNotes });
    const dayDetails = new Map(this.db.all<{ id: number; title: string | null; day_number: number }>('SELECT id, title, day_number FROM days WHERE trip_id = ?', tripId).map(day => [`d:${day.id}`, day]));
    const place = ({ coordinates, ...value }: AdvicePlace) => ({ ...value, ...(coordinates ?? {}) });
    const data = { version: 2 as const, title: base.title,
      cities: [...base.cities, ...config.addedCities.filter(city => owner || !config.hiddenCityKeys.includes(city.key)).map(city => ({ id: city.key, label: city.label, countryCodes: city.countryCodes }))],
      stays: base.stays.map(stay => ({ ...stay, days: stay.days.map(({ notes, ...day }) => {
        const note = notes?.map(value => value.text).join('\n\n').slice(0, 10000);
        const detail = dayDetails.get(day.key)!;
        return { ...day, dayNumber: detail.day_number, title: (detail.title ?? '').slice(0, 200),
          ...(note && (owner || !config.hiddenNoteDayKeys.includes(day.key)) ? { note } : {}),
          schedule: day.schedule.map(row => ({ ...row, place: place(row.place) })) };
      }) })),
      shortlists: [...base.shortlists.map(list => ({ ...list,
        see: list.see.filter(item => owner || !config.hiddenIdeaKeys.includes(item.key)).map(place),
        eat: list.eat.filter(item => owner || !config.hiddenIdeaKeys.includes(item.key)).map(place),
      })), ...config.addedCities.filter(city => owner || !config.hiddenCityKeys.includes(city.key)).map(city => ({ cityId: city.key, see: [], eat: [] }))],
    };
    return adviceProjectionV2Schema.parse({ ...data, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex') });
  }
}
