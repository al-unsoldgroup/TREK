import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { db } from '../../db/database';
import { exportICS } from '../../services/tripService';

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

function feedUrl(token: string, scope: 'trip' | 'user', base: string): string {
  return `${base.replace(/\/$/, '')}/api/feed/${scope}/${token}.ics`;
}

/** How far back the all-trips feed reaches, and how much of each trip it emits. */
export interface UserFeedOptions {
  /** Include trips that ended within this many days. `null` = no cutoff (full history). */
  historyDays: number | null;
  /** `full` = every itinerary/reservation event; `trips` = one all-day event per trip. */
  detail: 'full' | 'trips';
}

/** Back-compat default: the window and detail the feed used before it was tunable. */
export const DEFAULT_USER_FEED_OPTIONS: UserFeedOptions = { historyDays: 90, detail: 'full' };

// A century of history is well past "everything anyone has planned in TREK"; the
// cap only exists so a junk value can't turn into an absurd date string.
const MAX_HISTORY_DAYS = 36500;

/**
 * Parse the all-trips feed's query knobs. Calendar clients re-fetch a stored URL
 * verbatim, so the options have to travel in the URL rather than in server state —
 * and anything unparseable falls back to the default rather than erroring, so a
 * mangled subscription keeps working instead of going dark.
 */
export function parseUserFeedOptions(history?: string, detail?: string): UserFeedOptions {
  let historyDays = DEFAULT_USER_FEED_OPTIONS.historyDays;
  const h = typeof history === 'string' ? history.trim().toLowerCase() : '';
  if (h === 'all') {
    historyDays = null;
  } else if (h) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0) historyDays = Math.min(n, MAX_HISTORY_DAYS);
  }
  const d = typeof detail === 'string' ? detail.trim().toLowerCase() : '';
  return { historyDays, detail: d === 'trips' ? 'trips' : 'full' };
}

@Injectable()
export class FeedsService {
  // ── Trip feed token ─────────────────────────────────────────────────────

  private tripTokenRow(tripId: string, userId: number) {
    return db
      .prepare(
        'SELECT feed_token FROM trips WHERE id = ? AND (user_id = ? OR id IN (SELECT trip_id FROM trip_members WHERE user_id = ?))',
      )
      .get(tripId, userId, userId) as { feed_token: string | null } | undefined;
  }

  getTripToken(tripId: string, userId: number, base: string): { feed_url: string | null } {
    const row = this.tripTokenRow(tripId, userId);
    return { feed_url: row?.feed_token ? feedUrl(row.feed_token, 'trip', base) : null };
  }

  /** Enable (idempotent): mint a token only if the trip has none yet. */
  generateTripToken(tripId: string, userId: number, base: string): { feed_url: string } {
    const row = this.tripTokenRow(tripId, userId);
    if (row?.feed_token) return { feed_url: feedUrl(row.feed_token, 'trip', base) };
    const token = randomUUID();
    db.prepare('UPDATE trips SET feed_token = ? WHERE id = ?').run(token, tripId);
    return { feed_url: feedUrl(token, 'trip', base) };
  }

  /** Rotate: always issue a fresh token, invalidating the previous URL. */
  rotateTripToken(tripId: string, base: string): { feed_url: string } {
    const token = randomUUID();
    db.prepare('UPDATE trips SET feed_token = ? WHERE id = ?').run(token, tripId);
    return { feed_url: feedUrl(token, 'trip', base) };
  }

  /** Disable: clear the token so the public URL stops resolving. */
  disableTripToken(tripId: string): void {
    db.prepare('UPDATE trips SET feed_token = NULL WHERE id = ?').run(tripId);
  }

  // ── User (all-trips) feed token ──────────────────────────────────────────

  getUserToken(userId: number, base: string): { feed_url: string | null } {
    const row = db.prepare('SELECT feed_token FROM users WHERE id = ?').get(userId) as
      | { feed_token: string | null }
      | undefined;
    return { feed_url: row?.feed_token ? feedUrl(row.feed_token, 'user', base) : null };
  }

  generateUserToken(userId: number, base: string): { feed_url: string } {
    const existing = this.getUserToken(userId, base);
    if (existing.feed_url) return { feed_url: existing.feed_url };
    const token = randomUUID();
    db.prepare('UPDATE users SET feed_token = ? WHERE id = ?').run(token, userId);
    return { feed_url: feedUrl(token, 'user', base) };
  }

  rotateUserToken(userId: number, base: string): { feed_url: string } {
    const token = randomUUID();
    db.prepare('UPDATE users SET feed_token = ? WHERE id = ?').run(token, userId);
    return { feed_url: feedUrl(token, 'user', base) };
  }

  disableUserToken(userId: number): void {
    db.prepare('UPDATE users SET feed_token = NULL WHERE id = ?').run(userId);
  }

  // ── ICS generation ───────────────────────────────────────────────────────

  buildTripIcs(token: string): { ics: string; filename: string } | null {
    const row = db.prepare('SELECT id FROM trips WHERE feed_token = ?').get(token) as
      | { id: number }
      | undefined;
    if (!row) return null;
    try {
      const { ics, filename } = exportICS(row.id);
      // Inject calendar-subscription refresh hints into the VCALENDAR header so
      // clients re-fetch hourly. The one-time download path (exportICS) is left
      // untouched; this is feed-only.
      const withHints = ics.replace(
        'METHOD:PUBLISH\r\n',
        'METHOD:PUBLISH\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H\r\nX-PUBLISHED-TTL:PT1H\r\n',
      );
      return { ics: withHints, filename };
    } catch {
      return null;
    }
  }

  buildUserIcs(
    token: string,
    options: UserFeedOptions = DEFAULT_USER_FEED_OPTIONS,
  ): { ics: string; calName: string } | null {
    const user = db.prepare('SELECT id, username FROM users WHERE feed_token = ?').get(token) as
      | { id: number; username: string }
      | undefined;
    if (!user) return null;

    // "All Trips" means every trip the user can open — trips they own AND trips shared with
    // them as a member — mirroring the single-trip feed's access (tripTokenRow/assertAccess).
    // A membership WHERE on trips selects each row once, so owned + member trips don't dupe.
    const where = [
      '(user_id = ? OR id IN (SELECT trip_id FROM trip_members WHERE user_id = ?))',
      'is_archived = 0',
    ];
    const params: unknown[] = [user.id, user.id];
    if (options.historyDays !== null) {
      where.push('(end_date IS NULL OR end_date >= ?)');
      params.push(daysAgo(options.historyDays));
    }
    const trips = db
      .prepare(`SELECT id FROM trips WHERE ${where.join(' AND ')} ORDER BY start_date ASC`)
      .all(...params) as { id: number }[];

    const esc = (s: string) =>
      s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

    const calName = `${user.username} – All Trips`;
    let header =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TREK//Travel Planner//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n';
    header += `X-WR-CALNAME:${esc(calName)}\r\n`;
    header += 'REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\nX-PUBLISHED-TTL:PT1H\r\n';

    // VTIMEZONE blocks are deduped by TZID across all trips and emitted once in
    // the combined header, before any VEVENT, so per-trip TZID references still
    // resolve after extractVEvents strips everything but the events (#1453).
    // In `trips` detail the only surviving events are the trip's all-day span,
    // which carries VALUE=DATE and never a TZID — so no zones are collected.
    const zones = new Map<string, string>();
    let events = '';
    for (const { id } of trips) {
      try {
        const { ics } = exportICS(id);
        const blocks =
          options.detail === 'trips' ? extractVEvents(ics).filter(isTripEvent) : extractVEvents(ics);
        if (!blocks.length) continue;
        if (options.detail !== 'trips') {
          for (const vtz of extractVTimezones(ics)) {
            const tzid = vtz.match(/\r\nTZID:(.+)\r\n/)?.[1];
            if (tzid && !zones.has(tzid)) zones.set(tzid, vtz);
          }
        }
        events += blocks.join('');
      } catch {
        // skip failed trips
      }
    }

    const combined = header + [...zones.values()].join('') + events + 'END:VCALENDAR\r\n';
    return { ics: combined, calName };
  }
}

// Pull the VEVENT blocks out of a single-trip calendar by structural line
// scanning rather than a lazy regex on "END:VEVENT". User-supplied text (escaped
// onto a SUMMARY/DESCRIPTION line) can legitimately contain the literal
// "END:VEVENT", which a non-greedy regex would mistake for a terminator and
// truncate the event. Folded continuation lines always begin with a space, so a
// bare "BEGIN:VEVENT"/"END:VEVENT" only ever appears as a real delimiter.
function extractVEvents(ics: string): string[] {
  const blocks: string[] = [];
  let current = '';
  let inside = false;
  for (const line of ics.split('\r\n')) {
    if (line === 'BEGIN:VEVENT') {
      inside = true;
      current = '';
    }
    if (inside) current += line + '\r\n';
    if (line === 'END:VEVENT') {
      inside = false;
      blocks.push(current);
    }
  }
  return blocks;
}

// The trip-level all-day span, as opposed to the per-day / per-assignment /
// per-reservation events. exportICS stamps each event kind into its UID
// (`trek-<kind>-<id>@trek`), so the prefix is the discriminator. Matched at the
// start of a line so an escaped UID quoted inside a DESCRIPTION can't pass.
function isTripEvent(block: string): boolean {
  return /(^|\r\n)UID:trek-trip-/.test(block);
}

// Pull out each VTIMEZONE block (same structural line scan as extractVEvents) so
// the combined all-trips feed can carry the zone definitions its events' TZID
// parameters reference.
function extractVTimezones(ics: string): string[] {
  const blocks: string[] = [];
  let current = '';
  let inside = false;
  for (const line of ics.split('\r\n')) {
    if (line === 'BEGIN:VTIMEZONE') {
      inside = true;
      current = '';
    }
    if (inside) current += line + '\r\n';
    if (line === 'END:VTIMEZONE') {
      inside = false;
      blocks.push(current);
    }
  }
  return blocks;
}
