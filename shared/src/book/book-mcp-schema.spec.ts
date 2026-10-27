import { restoreBookPageRequestSchema } from './book-ops.schema';
import { bookMapElementSchema } from './book.schema';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

function arraySchemaIssues(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...((key === 'items' && Array.isArray(child)) || (key === 'additionalItems' && child !== undefined)
      ? [`${path}.${key}`]
      : []),
    ...arraySchemaIssues(child, `${path}.${key}`),
  ]);
}

function intersectionPaths(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'allOf' && child !== undefined ? [`${path}.${key}`] : []),
    ...intersectionPaths(child, `${path}.${key}`),
  ]);
}

function checkElementAlternatives(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const entries = Object.entries(value);
  const properties = entries.find(([key]) => key === 'properties')?.[1];
  const isElement = properties && typeof properties === 'object' && 'kind' in properties;
  if (isElement) {
    expect(value).toMatchObject({
      type: 'object',
      properties: { id: expect.anything(), frame: expect.anything() },
      required: expect.arrayContaining(['id', 'frame', 'kind']),
    });
  }
  return (isElement ? 1 : 0) + entries.reduce((count, [, child]) => count + checkElementAlternatives(child), 0);
}

describe('book restore MCP schema', () => {
  it('advertises arrays with a single items schema and no tuple-only keywords', () => {
    const schema = z.toJSONSchema(restoreBookPageRequestSchema, { target: 'draft-7', io: 'input' });
    expect(arraySchemaIssues(schema)).toEqual([]);
  });

  it('advertises eleven complete element alternatives in both lists, without intersections', () => {
    const schema = z.toJSONSchema(restoreBookPageRequestSchema, { target: 'draft-7', io: 'input' });
    expect(intersectionPaths(schema)).toEqual([]);
    expect(checkElementAlternatives(schema)).toBe(22);
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
