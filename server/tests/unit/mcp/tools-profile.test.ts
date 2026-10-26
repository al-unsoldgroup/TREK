/**
 * Unit tests for MCP travel profile tools: get_travel_profile, set_travel_profile.
 */
import { db as testDb } from '../../../src/db/database';
import { Settings } from '../../../src/db/entities/Settings.entity';
import { createUser } from '../../helpers/factories';
import { findRow } from '../../helpers/factories/rows';
import { setUserSetting } from '../../helpers/factories/settings';
import { createMcpHarness, parseResourceResult, parseToolResult, type McpHarness } from '../../helpers/mcp-harness';
import { resetTestDb } from '../../helpers/test-db';
import { createTestOrm, type TestOrm } from '../../helpers/test-orm';

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../../../src/db/database', async () => {
  const { createSnapshotTestDb, buildDbMock } = await import('../../helpers/db-mock');
  return buildDbMock(createSnapshotTestDb());
});

let orm: TestOrm;

beforeAll(async () => {
  orm = await createTestOrm(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
  delete process.env.DEMO_MODE;
});

afterAll(async () => {
  await orm.close();
  testDb.close();
});

async function storedProfile(userId: number): Promise<unknown> {
  const row = await findRow(orm, Settings, { user: userId, key: 'travel_profile' });
  return row?.value ? JSON.parse(row.value) : undefined;
}

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
      expect(await storedProfile(user.id)).toEqual({ cabin: 'business', airlines: { preferred: ['AF'] } });
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
      expect(await storedProfile(user.id)).toEqual({ cabin: 'economy' });
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
    const { user } = createUser(testDb, { email: 'demo@trek.app' });
    await withHarness(user.id, ['profile:write'], async (h) => {
      const result = await h.client.callTool({
        name: 'set_travel_profile',
        arguments: { patch: { cabin: 'first' } },
      });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Resource: trek://travel-profile', () => {
  it('returns an empty object when no profile is stored', async () => {
    const { user } = createUser(testDb);
    await withHarness(user.id, ['profile:read'], async (h) => {
      const result = await h.client.readResource({ uri: 'trek://travel-profile' });
      expect(parseResourceResult(result)).toEqual({});
    });
  });

  it('returns only the current user\'s stored profile', async () => {
    const { user } = createUser(testDb);
    const { user: other } = createUser(testDb);
    await setUserSetting(orm, user.id, 'travel_profile', JSON.stringify({ seats: 'aisle' }));
    await setUserSetting(orm, other.id, 'travel_profile', JSON.stringify({ seats: 'window' }));

    await withHarness(user.id, ['profile:read'], async (h) => {
      const result = await h.client.readResource({ uri: 'trek://travel-profile' });
      expect(parseResourceResult(result)).toEqual({ seats: 'aisle' });
    });
  });
});
