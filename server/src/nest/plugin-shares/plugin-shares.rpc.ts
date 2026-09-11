import { Optional } from '@nestjs/common';
import type { ZodType } from 'zod';
import { PluginController, PluginMethod } from '../plugins/host/rpc-kit/decorators';
import type { PluginRpcContext } from '../plugins/host/rpc-kit/types';
import { ForbiddenResource, BadParams } from '../plugins/host/rpc-errors';
import { adviceNativeImportSchema, adviceOwnerWriteSchema, adviceShareConfigSchema } from '@trek/shared';
import { num } from '../plugins/host/rpc-params';
import { PluginSharesService } from './plugin-shares.service';
import { GooglePlacesProvider } from './google-places.provider';

// Take Zod's own result type rather than a hand-written mimic of it: a local
// structural copy does not narrow on `success`, and it is one more contract to
// keep in sync with the schemas it validates.
function parse<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadParams(`invalid ${label}: ${result.error.message}`);
  }
  return result.data;
}

@PluginController()
export class PluginSharesRpc {
  constructor(private readonly shares: PluginSharesService, @Optional() private readonly places?: GooglePlacesProvider) {}
  @PluginMethod('publicShare.snapshot', { permission: 'share:guest' })
  snapshot(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).length) throw new BadParams('snapshot takes no arguments');
    if (!ctx.publicShare || ctx.actingUserId !== undefined || ctx.pluginId !== ctx.publicShare.pluginId) throw new ForbiddenResource('Public share invocation required');
    return this.shares.snapshot(ctx.publicShare);
  }

  @PluginMethod('publicShare.resolveSelection', { permission: 'share:guest' })
  resolveSelection(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (!ctx.publicShare || ctx.actingUserId !== undefined || Object.keys(params).length !== 1 || typeof params.selectionId !== 'string') {
      throw new ForbiddenResource('Public share invocation required');
    }
    if (params.selectionId.length === 0 || params.selectionId.length > 160) throw new BadParams('selectionId must be 1-160 characters');
    if (!this.places) throw new ForbiddenResource('Google place provider is unavailable');
    return this.places.resolveSelection(ctx.publicShare, params.selectionId);
  }

  @PluginMethod('publicShare.owner.getConfig', { permission: 'share:publish' })
  ownerConfig(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).length !== 1 || !Object.hasOwn(params, 'tripId')) throw new BadParams('getConfig takes tripId only');
    return this.shares.ownerConfig(num(params.tripId, 'tripId'), this.owner(ctx));
  }

  @PluginMethod('publicShare.owner.preview', { permission: 'share:publish' })
  ownerPreview(params: Record<string, unknown>, ctx: PluginRpcContext) {
    const tripId = num(params.tripId, 'tripId');
    if (Object.keys(params).some(key => !['tripId', 'config'].includes(key))) throw new BadParams('preview contains an unsupported field');
    const config = parse(adviceShareConfigSchema, params.config, 'config');
    return this.shares.ownerPreview(tripId, this.owner(ctx), config);
  }

  @PluginMethod('publicShare.owner.configure', { permission: 'share:publish' })
  ownerConfigure(params: Record<string, unknown>, ctx: PluginRpcContext) {
    const tripId = num(params.tripId, 'tripId');
    if (Object.keys(params).some(key => key === 'tripId')) {
      const { tripId: _tripId, ...body } = params;
      return this.shares.ownerConfigure(tripId, this.owner(ctx), parse(adviceOwnerWriteSchema, body, 'config'));
    }
    throw new BadParams('tripId is required');
  }

  @PluginMethod('publicShare.owner.importSuggestion', { permission: 'db:write:places' })
  ownerImport(params: Record<string, unknown>, ctx: PluginRpcContext) {
    return this.shares.importSuggestion(num(params.tripId, 'tripId'), this.owner(ctx), parse(adviceNativeImportSchema, params, 'import'));
  }

  private owner(ctx: PluginRpcContext): number {
    if (ctx.publicShare || ctx.actingUserId === undefined) throw new ForbiddenResource('Authenticated owner invocation required');
    return ctx.actingUserId;
  }
}
