import { createHash } from 'crypto';

/**
 * Small bounded TTL cache for the calendar feeds.
 *
 * Feeds are the one read path that can re-render an entire account's travel
 * history on a single unauthenticated GET, and calendar clients fetch on their
 * own schedule — several devices subscribed to the same URL land as a burst.
 * A short TTL collapses that burst into one build.
 *
 * Insertion order doubles as recency: `get` re-inserts on a hit, so evicting
 * `keys().next()` drops the least recently used entry.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Whether this cache does anything at all (TTL of 0 disables it entirely). */
  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop everything. Used by tests; there is no runtime invalidation path. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * A validator for an ICS body that ignores DTSTAMP.
 *
 * exportICS stamps every VEVENT with DTSTAMP:<now>, so two builds of an
 * untouched trip differ byte-for-byte. Hashing the raw body would therefore mint
 * a fresh ETag on every request and no client would ever get a 304 — exactly the
 * case worth optimizing, since a full-history feed is megabytes and a calendar
 * refetches it on a timer forever.
 *
 * DTSTAMP records when the iCalendar object was generated, not anything about
 * the trip, so leaving it out of the digest makes the ETag track real content.
 * A 304 then says "your copy is still current", which is true: the events, their
 * times, and their text are identical, and only that generation stamp moved.
 */
export function icsEtag(ics: string): string {
  const stable = ics.replace(/^DTSTAMP:.*\r?\n/gm, '');
  return `"${createHash('sha256').update(stable).digest('base64url').slice(0, 27)}"`;
}

/**
 * RFC 9110 If-None-Match test. Handles a comma-separated list, the `W/` weak
 * prefix (our tags are strong, but clients may echo either), and `*`.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}
