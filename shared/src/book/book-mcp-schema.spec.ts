import { restoreBookPageRequestSchema } from './book-ops.schema';
import { bookMapElementSchema } from './book.schema';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

function tupleItems(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'items' && Array.isArray(child) ? [`${path}.${key}`] : []),
    ...tupleItems(child, `${path}.${key}`),
  ]);
}

describe('book restore MCP schema', () => {
  it('advertises arrays with a single items schema for tool importers', () => {
    const schema = z.toJSONSchema(restoreBookPageRequestSchema, { target: 'draft-7', io: 'input' });
    expect(tupleItems(schema)).toEqual([]);
  });

  it('keeps latitude/longitude order, bounds and tuple length when parsing map geometry', () => {
    const map = { id: 'map-1', kind: 'map', frame: { x: 0, y: 0, w: 100, h: 100 } };
    for (const field of ['path', 'roads']) {
      for (const point of [
        [90, 180],
        [-90, -180],
        [0, 0],
      ]) {
        expect(bookMapElementSchema.safeParse({ ...map, [field]: [[point]] }).success).toBe(true);
      }
      for (const point of [[91, 0], [-91, 0], [0, 181], [0, -181], [0], [0, 0, 0], ['0', 0]]) {
        expect(bookMapElementSchema.safeParse({ ...map, [field]: [[point]] }).success).toBe(false);
      }
    }
    expect(bookMapElementSchema.safeParse({ ...map, roads: [null] }).success).toBe(true);
  });
});
