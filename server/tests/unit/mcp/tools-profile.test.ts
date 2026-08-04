/**
 * Unit tests for MCP travel profile tools: get_travel_profile, set_travel_profile.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser } from '../../helpers/factories';
import { createMcpHarness, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  delete process.env.DEMO_MODE;
});

afterAll(() => {
  testDb.close();
});

async function withHarness(userId: number, scopes: string[] | null, fn: (h: McpHarness) => Promise<void>) {
  const h = await createMcpHarness({ userId, withResources: false, scopes });
  try { await fn(h); } finally { await h.cleanup(); }
}

describe('Travel profile tools', () => {
  it('returns an empty profile when unset', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['profile:read'], async (h) => {
      const result = await h.client.callTool({ name: 'get_travel_profile', arguments: {} });
      expect(parseToolResult(result)).toEqual({ profile: {} });
    });
  });

  it('creates a travel profile', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['profile:write'], async (h) => {
      const result = await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { cabin: 'business', airlines: { preferred: ['AF'] } } },
      });
      expect(parseToolResult(result)).toEqual({ profile: { cabin: 'business', airlines: { preferred: ['AF'] } } });
      const stored = testDb.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'travel_profile'").get(user.id) as { value: string };
      expect(JSON.parse(stored.value)).toEqual({ cabin: 'business', airlines: { preferred: ['AF'] } });
    });
  });

  it('merges objects, replaces arrays, and deletes null fields', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['profile:write'], async (h) => {
      await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { airlines: { preferred: ['AF'], avoid: ['FR'], notes: 'SkyTeam' }, seats: 'aisle' } },
      });
      const result = await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { airlines: { preferred: ['BA'], notes: null }, seats: null } },
      });
      expect(parseToolResult(result)).toEqual({ profile: { airlines: { preferred: ['BA'], avoid: ['FR'] } } });
    });
  });

  it('rejects an invalid merged profile without persisting it', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['profile:write'], async (h) => {
      await h.client.callTool({ name: 'set_travel_profile', arguments: { patch: { cabin: 'economy' } } });
      const result = await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { loyalty: [{ program: 42 }] } },
      });
      expect(result.isError).toBe(true);
      const stored = testDb.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'travel_profile'").get(user.id) as { value: string };
      expect(JSON.parse(stored.value)).toEqual({ cabin: 'economy' });
    });
  });

  it('does not register tools without profile scopes', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['trips:read'], async (h) => {
      const tools = await h.client.listTools();
      expect(tools.tools.map(tool => tool.name)).not.toContain('get_travel_profile');
      expect(tools.tools.map(tool => tool.name)).not.toContain('set_travel_profile');
    });
  });

  it('blocks writes for demo users', async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = createUser(testDb, { email: 'demo@nomad.app' });
    await withHarness(user.id, ['profile:write'], async (h) => {
      const result = await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { cabin: 'first' } },
      });
      expect(result.isError).toBe(true);
    });
  });
});
