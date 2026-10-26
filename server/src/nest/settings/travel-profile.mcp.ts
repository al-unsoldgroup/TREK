import {
  McpController, Resource, Tool, type McpContext,
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  errorResult, ok,
} from '../../nest-mcp';
import { z } from 'zod';
import { SettingsService } from './settings.service';

const shortString = z.string().max(200);
const notesString = z.string().max(2000);

const travelProfileSchema = z.object({
  loyalty: z.array(
    z.object({
      program: shortString.min(1),
      number: shortString.optional(),
      status: shortString.optional(),
      notes: notesString.optional(),
    }).passthrough(),
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
    }).passthrough(),
  ).optional(),
  homes: z.array(
    z.object({
      city: shortString.min(1),
      from: shortString.optional(),
      to: shortString.optional(),
    }).passthrough(),
  ).optional(),
  constraints: z.object({}).passthrough().optional(),
  notes: notesString.optional(),
}).passthrough();

function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries(patch)) {
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

function jsonContent(uri: string, data: unknown) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    }],
  };
}

@McpController()
export class TravelProfileMcp {
  // The demo-mode write block is not repeated here: McpModule's tool gate
  // (trekDemoToolGate) refuses every non-read-only tool for a demo account.
  constructor(private readonly settings: SettingsService) {}

  private async getTravelProfile(userId: number): Promise<Record<string, unknown>> {
    const stored = await this.settings.getDecryptedUserSetting(userId, 'travel_profile');
    if (!stored) return {};
    try {
      const parsed = JSON.parse(stored);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  @Tool({
    name: 'get_travel_profile',
    description: 'Get your personal travel profile, including preferences, loyalty programs, and constraints.',
    inputSchema: {},
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'profile', mode: 'read' },
  })
  async getProfile(_input: Record<string, never>, ctx: McpContext) {
    return ok({ profile: await this.getTravelProfile(ctx.userId) });
  }

  @Tool({
    name: 'set_travel_profile',
    description: 'Update your personal travel profile using JSON merge-patch semantics.',
    inputSchema: {
      patch: z.record(z.string(), z.unknown()).describe('Profile fields to merge; null values delete fields'),
    },
    annotations: TOOL_ANNOTATIONS_WRITE,
    access: { group: 'profile', mode: 'write' },
  })
  async setProfile({ patch }: { patch: Record<string, unknown> }, ctx: McpContext) {
    const merged = mergePatch(await this.getTravelProfile(ctx.userId), patch);
    const result = travelProfileSchema.safeParse(merged);
    if (!result.success) {
      return errorResult(`Invalid travel profile: ${z.prettifyError(result.error)}`);
    }
    await this.settings.upsertSetting(ctx.userId, 'travel_profile', result.data);
    return ok({ profile: result.data });
  }

  @Resource({
    name: 'travel-profile',
    uri: 'trek://travel-profile',
    description: 'Your travel preferences, loyalty programs, and constraints',
    mimeType: 'application/json',
    access: { group: 'profile', mode: 'read' },
  })
  async profileResource(uri: URL, ctx: McpContext) {
    return jsonContent(uri.href, await this.getTravelProfile(ctx.userId));
  }
}
