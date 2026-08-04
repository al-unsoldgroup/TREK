import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { isDemoUser } from '../../services/authService';
import { getDecryptedUserSetting, upsertSetting } from '../../services/settingsService';
import { canRead, canWrite } from '../scopes';
import { TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, demoDenied, ok } from './_shared';

const shortString = z.string().max(200);
const notesString = z.string().max(2000);

const travelProfileSchema = z.object({
  loyalty: z.array(
    z.object({
      program: shortString.min(1),
      number: shortString.optional(),
      status: shortString.optional(),
      notes: notesString.optional(),
    }).passthrough()
  ).optional(),
  airlines: z.object({
    preferred: z.array(shortString).optional(),
    avoid: z.array(shortString).optional(),
    notes: notesString.optional(),
  }).passthrough().optional(),
  hotels: z.object({
    brands: z.array(shortString).optional(),
    style: shortString.optional(),
    channels: z.array(shortString).optional(),
    notes: notesString.optional(),
  }).passthrough().optional(),
  car: z.object({
    brands: z.array(shortString).optional(),
    notes: notesString.optional(),
  }).passthrough().optional(),
  rail: z.object({
    notes: notesString.optional(),
  }).passthrough().optional(),
  seats: shortString.optional(),
  cabin: shortString.optional(),
  budget: z.object({}).passthrough().optional(),
  companions: z.array(
    z.object({
      name: shortString.min(1),
      notes: notesString.optional(),
    }).passthrough()
  ).optional(),
  homes: z.array(
    z.object({
      city: shortString.min(1),
      from: shortString.optional(),
      to: shortString.optional(),
    }).passthrough()
  ).optional(),
  constraints: z.object({}).passthrough().optional(),
  notes: notesString.optional(),
}).passthrough();

export function getTravelProfile(userId: number): Record<string, unknown> {
  const stored = getDecryptedUserSetting(userId, 'travel_profile');
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    // defineProperty (not assignment) so a "__proto__" key becomes an own property
    // instead of polluting the prototype chain.
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, {
      value: mergePatch(result[key], value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function registerProfileTools(server: McpServer, userId: number, scopes: string[] | null): void {
  const R = canRead(scopes, 'profile');
  const W = canWrite(scopes, 'profile');

  if (R) server.registerTool(
    'get_travel_profile',
    {
      description: 'Get your personal travel profile, including preferences, loyalty programs, and constraints.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => ok({ profile: getTravelProfile(userId) })
  );

  if (W) server.registerTool(
    'set_travel_profile',
    {
      description: 'Update your personal travel profile using JSON merge-patch semantics.',
      inputSchema: {
        patch: z.record(z.string(), z.unknown()).describe('Profile fields to merge; null values delete fields'),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ patch }) => {
      if (isDemoUser(userId)) return demoDenied();
      const merged = mergePatch(getTravelProfile(userId), patch);
      const result = travelProfileSchema.safeParse(merged);
      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Invalid travel profile: ${z.prettifyError(result.error)}` }],
          isError: true,
        };
      }
      upsertSetting(userId, 'travel_profile', result.data);
      return ok({ profile: result.data });
    }
  );
}
