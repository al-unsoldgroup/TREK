/**
 * Unit tests for the calendar-feed cache primitives — the expiry and eviction
 * paths the e2e suite cannot reach without waiting out a real TTL or building
 * hundreds of feeds, plus the ETag rules the 304 behavior rests on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TtlCache, icsEtag, etagMatches } from '../../../src/nest/feeds/feeds.cache';

const ICS = (summary: string, stamp = '20260101T000000Z') =>
  `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:trek-trip-1@trek\r\nDTSTAMP:${stamp}\r\n` +
  `SUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe('TtlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stored value and misses on an unknown key', () => {
    const cache = new TtlCache<string>(1000, 4);
    cache.set('a', 'value');
    expect(cache.get('a')).toBe('value');
    expect(cache.get('b')).toBeUndefined();
  });

  it('expires an entry once its TTL has elapsed', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(1000, 4);
    cache.set('a', 'value');

    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe('value');

    vi.advanceTimersByTime(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry past maxEntries', () => {
    const cache = new TtlCache<string>(10_000, 2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a'); // 'a' is now the most recently used, so 'b' is next out
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.get('b')).toBeUndefined();
  });

  it('a re-set key refreshes rather than duplicating', () => {
    const cache = new TtlCache<string>(10_000, 2);
    cache.set('a', 'first');
    cache.set('a', 'second');
    cache.set('b', 'B');
    // If the re-set had added a second slot, 'b' would have pushed 'a' out.
    expect(cache.get('a')).toBe('second');
    expect(cache.get('b')).toBe('B');
  });

  it('a TTL of 0 disables the cache outright', () => {
    const cache = new TtlCache<string>(0, 4);
    expect(cache.enabled).toBe(false);
    cache.set('a', 'value');
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear drops everything', () => {
    const cache = new TtlCache<string>(10_000, 4);
    cache.set('a', 'A');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('icsEtag', () => {
  it('is stable when only DTSTAMP differs', () => {
    // exportICS stamps DTSTAMP with "now", so this is the normal case for an
    // untouched trip — and the one that has to yield a 304.
    expect(icsEtag(ICS('Trip'))).toBe(icsEtag(ICS('Trip', '20261231T235959Z')));
  });

  it('changes when the event content changes', () => {
    expect(icsEtag(ICS('Trip'))).not.toBe(icsEtag(ICS('Renamed')));
  });

  it('is a quoted opaque token', () => {
    expect(icsEtag(ICS('Trip'))).toMatch(/^"[\w-]+"$/);
  });

  it('does not strip a DTSTAMP-lookalike that is not at the start of a line', () => {
    const a = ICS('Cafe DTSTAMP:20260101T000000Z');
    const b = ICS('Cafe DTSTAMP:20990101T000000Z');
    expect(icsEtag(a)).not.toBe(icsEtag(b));
  });
});

describe('etagMatches', () => {
  const tag = '"abc123"';

  it('matches an exact echo', () => {
    expect(etagMatches(tag, tag)).toBe(true);
  });

  it('matches a weak-prefixed echo', () => {
    expect(etagMatches(`W/${tag}`, tag)).toBe(true);
  });

  it('matches within a comma-separated list', () => {
    expect(etagMatches(`"other", ${tag}`, tag)).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(etagMatches('*', tag)).toBe(true);
  });

  it('does not match a different tag, an absent header, or a bare substring', () => {
    expect(etagMatches('"different"', tag)).toBe(false);
    expect(etagMatches(undefined, tag)).toBe(false);
    expect(etagMatches('abc123', tag)).toBe(false); // unquoted is not the tag
  });
});
