import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adviceFeedbackWriteSchema } from '@trek/shared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginSupervisor } from '../../../src/nest/plugins/supervisor/plugin-supervisor';
import { PluginRpcHost, type HostDeps } from '../../../src/nest/plugins/host/rpc-host';
import { PluginDataDb, PublicSharePluginDataDb } from '../../../src/nest/plugins/host/plugin-data.service';
import { createTestPluginRegistry } from '../../../src/nest/plugins/host/rpc-kit/testing';
import { PluginController, PluginMethod } from '../../../src/nest/plugins/host/rpc-kit/decorators';
import type { PluginRpcContext } from '../../../src/nest/plugins/host/rpc-kit/types';
import { DbRpc } from '../../../src/nest/plugins/host/rpc/db.rpc';
import type { PluginUserSettingsService } from '../../../src/nest/plugins/plugin-user-settings.service';
import type { PublicSharePrincipal } from '../../../src/nest/plugins/protocol/envelope';

const settings: Pick<PluginUserSettingsService, 'readOne'> = { readOne: () => undefined };
const projection = {
  version: 1 as const, revision: 'runtime-test', title: 'Runtime test', cities: [], stays: [],
  shortlists: [{ cityId: 'elsewhere', see: [{ key: 'p:1', title: 'Runtime shortlist place', category: 'see',
    cityId: 'elsewhere', locality: 'Runtime city', countryCode: 'ES', googlePlaceId: 'ChIJshortlist-place',
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Runtime' }], eat: [] }],
};

@PluginController()
class PublicProjectionRpc {
  @PluginMethod('publicShare.owner.getCandidates', { permission: 'share:publish' })
  ownerCandidates(_params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (ctx.publicShare || ctx.actingUserId !== 42) throw new Error('authenticated owner required');
    return { days: [{ id: 1, date: '2026-10-09' }], schedule: [], shortlist: [] };
  }
  @PluginMethod('publicShare.owner.getConfig', { permission: 'share:publish' })
  ownerConfig(_params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (ctx.publicShare || ctx.actingUserId !== 42) throw new Error('authenticated owner required');
    return null;
  }

  @PluginMethod('publicShare.snapshot', { permission: 'share:guest' })
  snapshot(_params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (!ctx.publicShare) throw new Error('public principal required');
    return projection;
  }
  @PluginMethod('publicShare.resolveSelection', { permission: 'share:guest' })
  resolveSelection() {
    return { googlePlaceId: 'ChIJruntime-place', cityId: 'elsewhere', title: 'Runtime place', locality: 'Runtime city', countryCode: 'ES', duplicate: null };
  }
}

function addonRoot(): string | undefined {
  const candidates = [
    process.env.TREK_TRIP_ADVICE_ROOT,
    path.resolve(__dirname, '../../../../plugins/trip-advice'),
  ].filter((value): value is string => Boolean(value));
  return candidates.find(root => fs.existsSync(path.join(root, 'server/index.js')) &&
    fs.existsSync(path.join(root, 'server/lib/advice-service.js')));
}

function stageAddon(sourceRoot: string, codeRoot: string): void {
  const serverRoot = path.join(codeRoot, 'trip-advice', 'server');
  fs.mkdirSync(path.join(serverRoot, 'lib'), { recursive: true });
  for (const file of ['index.js', 'lib/advice-service.js', 'lib/advice-store.js', 'lib/protocol.js']) {
    fs.copyFileSync(path.join(sourceRoot, 'server', file), path.join(serverRoot, file));
  }
}

describe('standalone trip-advice through the real child runtime', () => {
  let codeRoot: string;
  let dataRoot: string;
  let supervisor: PluginSupervisor | undefined;

  beforeAll(() => {
    codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-advice-code-'));
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-advice-data-'));
    process.env.TREK_PLUGINS_DIR = codeRoot;
    process.env.TREK_PLUGINS_DATA_DIR = dataRoot;
  });

  afterEach(async () => {
    await supervisor?.shutdownAll();
    supervisor = undefined;
  });

  afterAll(() => {
    delete process.env.TREK_PLUGINS_DIR;
    delete process.env.TREK_PLUGINS_DATA_DIR;
    fs.rmSync(codeRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('loads the actual addon and completes a public read through scoped SQL', async () => {
    const sourceRoot = addonRoot();
    if (!sourceRoot) throw new Error('set TREK_TRIP_ADVICE_ROOT to the standalone trip-advice checkout');
    stageAddon(sourceRoot, codeRoot);

    // The host mints share, session and guest ids with randomUUID(), and the
    // addon validates them as UUIDs. Readable placeholders here would only pass
    // because this fixture never crossed the real child runtime.
    const principal: PublicSharePrincipal = {
      kind: 'publicShare', pluginId: 'trip-advice', shareId: randomUUID(),
      epoch: 1, sessionId: randomUUID(), guestId: randomUUID(),
    };
    const createRpcHost = (id: string, granted: ReadonlySet<string>): PluginRpcHost => {
      const data = new PluginDataDb(id);
      const deps: HostDeps = {
        data,
        validatePublicShare: () => {},
        publicShareData: scope => new PublicSharePluginDataDb(data, scope.shareId, scope.guestId),
        callPlugin: async () => undefined,
        emitPluginEvent: () => {},
      };
      return new PluginRpcHost(id, granted, deps, createTestPluginRegistry([
        new PublicProjectionRpc(), new DbRpc(settings as PluginUserSettingsService),
      ]));
    };
    supervisor = new PluginSupervisor(createRpcHost);
    await supervisor.activate('trip-advice', new Set(['db:own', 'share:guest', 'share:publish']));

    const result = await supervisor.invoke('trip-advice', 'invoke.publicShare', {
      version: 1, scope: { shareId: principal.shareId, guestId: principal.guestId, epoch: principal.epoch },
      action: { version: 1, kind: 'read' },
    }, { publicShare: principal });

    expect(result).toMatchObject({ projection, feedbackRevision: 0, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null });

    const suggestion = await supervisor.invoke('trip-advice', 'invoke.publicShare', {
      version: 1, scope: { shareId: principal.shareId, guestId: principal.guestId, epoch: principal.epoch },
      action: { version: 1, kind: 'suggestion.create', requestId: '11111111-1111-4111-8111-111111111111', selectionId: 'runtime-selection', category: 'see' },
    }, { publicShare: principal });
    expect(suggestion).toMatchObject({ kind: 'suggestion.create', data: { state: 'pending', cityId: 'elsewhere', category: 'see' } });

    // First-time setup must load before any share exists. A fixture that always
    // preconfigures a share misses the real owner's entry path.
    const ownerResult = await supervisor.invoke('trip-advice', 'invoke.route', {
      routeId: 0,
      req: { method: 'GET', path: '/owner', query: { tripId: '1' }, headers: {}, user: { id: 42 } },
    }, { actingUserId: 42 });
    expect(ownerResult).toMatchObject({ status: 200 });
    expect(JSON.parse(z.object({ body: z.string() }).parse(ownerResult).body)).toMatchObject({
      config: null, candidates: { days: [{ id: 1, date: '2026-10-09' }], schedule: [], shortlist: [] }, inbox: { suggestions: [], comments: [] },
    });

    const invoke = (action: Record<string, unknown>, guest = principal) => {
      if (!supervisor) throw new Error('plugin runtime is not active');
      return supervisor.invoke('trip-advice', 'invoke.publicShare', {
        version: 1, scope: { shareId: guest.shareId, guestId: guest.guestId, epoch: guest.epoch }, action,
      }, { publicShare: guest });
    };
    const upvote = { version: 1, kind: 'vote.set', requestId: randomUUID(), placeKey: 'p:1', value: 1, expectedVersion: 0 };
    const firstVote = await invoke(upvote);
    expect(adviceFeedbackWriteSchema.parse(firstVote)).toEqual(firstVote);
    expect(firstVote).toMatchObject({ kind: 'vote.set', data: { mine: 1, positive: 1, negative: 0, version: 1 } });
    const retriedVote = await invoke(upvote);
    expect(adviceFeedbackWriteSchema.parse(retriedVote)).toEqual(retriedVote);
    expect(retriedVote).toEqual(firstVote);
    expect(await invoke({ ...upvote, requestId: randomUUID(), value: -1, expectedVersion: 1 }))
      .toMatchObject({ data: { mine: -1, positive: 0, negative: 1, version: 2 } });
    expect(await invoke({ ...upvote, requestId: randomUUID(), value: 0, expectedVersion: 2 }))
      .toMatchObject({ data: { mine: 0, positive: 0, negative: 0, version: 3 } });
    await invoke({ version: 1, kind: 'comment.create', requestId: randomUUID(), text: 'Keep the morning flexible', displayName: 'Runtime guest' });

    await supervisor.shutdownAll();
    supervisor = new PluginSupervisor(createRpcHost);
    await supervisor.activate('trip-advice', new Set(['db:own', 'share:guest', 'share:publish']));
    expect(await invoke({ version: 1, kind: 'read' })).toMatchObject({
      votes: [{ placeKey: 'p:1', mine: 0, positive: 0, negative: 0, version: 3 }],
      myComments: [{ text: 'Keep the morning flexible', displayName: 'Runtime guest' }],
      myPendingSuggestions: [{ title: 'Runtime place', state: 'pending' }],
    });
    expect(await invoke({ version: 1, kind: 'read' }, { ...principal, guestId: randomUUID(), sessionId: randomUUID() }))
      .toMatchObject({ myComments: [], myPendingSuggestions: [] });
  });
});
