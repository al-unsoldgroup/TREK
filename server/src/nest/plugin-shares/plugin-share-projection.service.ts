import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { adviceProjectionSchema, type AdvicePlace, type AdviceShareConfig } from '@trek/shared';
import { DatabaseService } from '../database/database.service';

interface Day { id: number; date: string | null; day_number: number }
interface Assignment { id: number; place_id: number; day_id: number; assignment_time: string | null; order_index: number }
interface Place { id: number; google_place_id: string | null }

@Injectable()
export class PluginShareProjectionService {
  constructor(private readonly db: DatabaseService) {}

  build(tripId: number, config: AdviceShareConfig, validate = false): z.infer<typeof adviceProjectionSchema> {
    const days = this.db.all<Day>('SELECT id, date, day_number FROM days WHERE trip_id = ? ORDER BY day_number, id', tripId);
    const places = this.db.all<Place>('SELECT id, google_place_id FROM places WHERE trip_id = ?', tripId);
    const assignments = this.db.all<Assignment>(`SELECT a.id, a.place_id, a.day_id, a.assignment_time, a.order_index
      FROM day_assignments a JOIN days d ON d.id = a.day_id JOIN places p ON p.id = a.place_id
      WHERE d.trip_id = ? AND p.trip_id = ? ORDER BY a.order_index, a.id`, tripId, tripId);
    const excluded = new Set(this.db.all<{ place_id: number }>(`SELECT DISTINCT place_id FROM reservations
      WHERE trip_id = ? AND place_id IS NOT NULL AND type NOT IN ('restaurant','event','tour','activity')`, tripId).map(r => r.place_id));
    for (const stay of this.db.all<{ place_id: number }>(`SELECT place_id FROM day_accommodations
      WHERE trip_id = ? AND place_id IS NOT NULL`, tripId)) excluded.add(stay.place_id);
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

    const summary = (p: Place, text: string, category: 'see' | 'eat', cityId: string, locality: string, countryCode: string): AdvicePlace => {
      const maps = new URL('https://www.google.com/maps/search/');
      maps.searchParams.set('api', '1'); maps.searchParams.set('query', `${text} ${locality} ${countryCode}`);
      if (p.google_place_id) maps.searchParams.set('query_place_id', p.google_place_id);
      return { key: `p:${p.id}`, title: text, category, cityId, locality, countryCode, googlePlaceId: p.google_place_id, mapsUrl: maps.href };
    };
    const stays: z.infer<typeof adviceProjectionSchema>['stays'] = config.stays.map(stay => {
      const city = config.cities.find(c => c.id === stay.cityId)!;
      return { id: stay.id, cityId: city.id, shortlistCityId: city.id,
        days: days.filter(d => stay.dayIds.includes(d.id) && d.date).map(day => ({ key: `d:${day.id}`, date: day.date!,
          schedule: assignments.filter(a => a.day_id === day.id && selectedAssignments.has(a.id) && !excluded.has(a.place_id) && !excludedAssignments.has(a.id)).map(a => {
            const selection = selectedAssignments.get(a.id)!;
            const p = places.find(p => p.id === a.place_id)!;
            const booked = !!this.db.get(`SELECT 1 FROM reservations r WHERE r.trip_id = ?
              AND COALESCE(r.ingest_state, 'live') <> 'staged' AND r.status = 'confirmed'
              AND r.type IN ('restaurant','event','tour','activity')
              AND (r.assignment_id = ? OR (r.assignment_id IS NULL AND r.place_id = ? AND r.day_id = ?
                AND (SELECT COUNT(*) FROM day_assignments x WHERE x.place_id = ? AND x.day_id = ?) = 1)) LIMIT 1`,
            tripId, a.id, p.id, day.id, p.id, day.id);
            return { key: `a:${a.id}`, place: summary(p, selection.publicTitle, selection.category, city.id, city.label, city.countryCodes[0]!),
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
}
