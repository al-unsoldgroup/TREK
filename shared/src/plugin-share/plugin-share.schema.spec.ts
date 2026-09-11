import { describe, expect, it } from 'vitest';
import { adviceActionSchema, adviceFeedbackWriteSchema, adviceShareConfigSchema, adviceReadActionSchema, adviceOwnerWriteSchema } from './plugin-share.schema';
import type { AdviceShareConfig } from './plugin-share.types';
const config: AdviceShareConfig = {
  version: 1, publicTitle: 'Japan',
  cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'], bounds: { south: 35, north: 36, west: 139, east: 140 } }],
  stays: [{ id: 'tokyo-first', cityId: 'tokyo', dayIds: [1] }, { id: 'tokyo-return', cityId: 'tokyo', dayIds: [2] }],
  schedule: [{ assignmentId: 1, publicTitle: 'Museum', category: 'see' }],
  shortlist: [{ placeId: 2, cityId: 'tokyo', category: 'eat', publicTitle: 'Cafe', locality: 'Tokyo', countryCode: 'JP' }],
};
describe('advice wire contracts', () => {
  it('accepts repeated stays with one city shortlist', () => expect(adviceShareConfigSchema.parse(config)).toEqual(config));
  it.each([
    { ...config, ownerId: 1 },
    { ...config, cities: [{ ...config.cities[0], notes: 'private' }] },
    { ...config, stays: [...config.stays, config.stays[0]] },
    { ...config, shortlist: [...config.shortlist, config.shortlist[0]] },
    { ...config, stays: [{ id: 'unknown', cityId: 'missing', dayIds: [1] }] },
    { ...config, cities: [{ ...config.cities[0], countryCodes: ['XX'] }] },
    { ...config, cities: [{ ...config.cities[0], bounds: { south: 1, north: 2, west: 179, east: -179 } }] },
  ])('rejects private extras, duplicate/unknown IDs and invalid geography', value => expect(adviceShareConfigSchema.safeParse(value).success).toBe(false));
  it('does not dispatch arbitrary actions or identity fields', () => {
    expect(adviceReadActionSchema.safeParse({ version: 1, kind: 'vote.set' }).success).toBe(false);
    expect(adviceReadActionSchema.safeParse({ version: 1, kind: 'read', shareId: 'other' }).success).toBe(false);
    expect(adviceActionSchema.safeParse({ version: 1, kind: 'comment.create', requestId: 'not-a-uuid', text: 'hello' }).success).toBe(false);
    expect(adviceActionSchema.safeParse({ version: 1, kind: 'vote.set', requestId: '00000000-0000-4000-8000-000000000001', placeKey: 'p:1', value: 1, expectedVersion: 0, guestId: 'forged' }).success).toBe(false);
    expect(adviceActionSchema.safeParse({ version: 1, kind: 'places.resolve', searchId: '00000000-0000-4000-8000-000000000001', predictionId: 'p' }).success).toBe(true);
  });
  it('requires the reviewed feedback response envelope', () => {
    expect(adviceFeedbackWriteSchema.safeParse({ version: 1, kind: 'vote.set', data: {}, extra: true }).success).toBe(false);
    expect(adviceFeedbackWriteSchema.safeParse({ version: 1, kind: 'vote.set', data: {} }).success).toBe(true);
  });
  it('bounds publication and requires booleans', () => {
    expect(adviceOwnerWriteSchema.safeParse({ config, expectedRevision: 0, enabled: 1, expiresInDays: 90 }).success).toBe(false);
    expect(adviceOwnerWriteSchema.safeParse({ config, expectedRevision: 0, enabled: true, expiresInDays: 91 }).success).toBe(false);
  });
});
