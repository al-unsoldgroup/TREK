import { Optional } from '@nestjs/common';
import type { ZodType } from 'zod';
import { PluginController, PluginMethod } from '../plugins/host/rpc-kit/decorators';
import type { PluginRpcContext } from '../plugins/host/rpc-kit/types';
import { ForbiddenResource, BadParams } from '../plugins/host/rpc-errors';
import { adviceNativeImportSchema, adviceOwnerCityAutocompleteSchema, adviceOwnerCityResolveSchema, adviceOwnerWriteSchema, adviceShareConfigSchema } from '@trek/shared';
import { num } from '../plugins/host/rpc-params';
import { PluginSharesService } from './plugin-shares.service';
import { GooglePlacesProvider } from './google-places.provider';
import { OwnerCityProvider } from './owner-city.provider';
import { AdviceMapProvider } from './advice-map.provider';
import { adviceActionV2Schema, adviceOwnerWriteV2Schema, adviceShareConfigV2Schema, advicePhotoResultSchema } from '@trek/shared';

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
  constructor(private readonly shares: PluginSharesService, @Optional() private readonly places?: GooglePlacesProvider,
    @Optional() private readonly ownerCities?: OwnerCityProvider, @Optional() private readonly maps?: AdviceMapProvider) {}
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

  @PluginMethod('publicShare.filterSuggestionKeys', { permission: 'share:guest' })
  filterSuggestionKeys(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (!ctx.publicShare || ctx.actingUserId !== undefined || Object.keys(params).length !== 1 || !Array.isArray(params.keys)
      || params.keys.length > 200 || !params.keys.every(key => typeof key === 'string' && /^s:[0-9a-f-]{36}$/.test(key))) throw new BadParams('Invalid suggestion visibility query');
    return this.shares.filterSuggestionKeys(ctx.publicShare, params.keys);
  }

  @PluginMethod('publicShare.owner.getConfig', { permission: 'share:publish' })
  ownerConfig(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).length !== 1 || !Object.hasOwn(params, 'tripId')) throw new BadParams('getConfig takes tripId only');
    return this.shares.ownerConfig(num(params.tripId, 'tripId'), this.owner(ctx));
  }

  @PluginMethod('publicShare.owner.getNative', { permission: 'share:publish' })
  ownerNative(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).length !== 1) throw new BadParams('getNative takes tripId only');
    return this.shares.ownerNative(num(params.tripId, 'tripId'), this.owner(ctx));
  }

  @PluginMethod('publicShare.owner.configureNative', { permission: 'share:publish' })
  ownerConfigureNative(params: Record<string, unknown>, ctx: PluginRpcContext) {
    const { tripId, ...input } = params;
    return this.shares.ownerNativeConfigure(num(tripId, 'tripId'), this.owner(ctx), parse(adviceOwnerWriteV2Schema, input, 'native config'));
  }

  @PluginMethod('publicShare.owner.previewNative', { permission: 'share:publish' })
  ownerPreviewNative(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).some(key => !['tripId', 'config'].includes(key))) throw new BadParams('Invalid native preview');
    return this.shares.ownerNativePreview(num(params.tripId, 'tripId'), this.owner(ctx), parse(adviceShareConfigV2Schema, params.config, 'native config'));
  }

  @PluginMethod('publicShare.owner.nativeAction', { permission: 'share:publish' })
  async ownerNativeAction(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).some(key => !['tripId', 'action'].includes(key))) throw new BadParams('Invalid native action');
    const action = parse(adviceActionV2Schema, params.action, 'native action');
    const principal = this.shares.ownerPrincipal(num(params.tripId, 'tripId'), this.owner(ctx), ['places.metadata', 'map.tile'].includes(action.kind));
    if (principal.preview && !['read', 'places.autocomplete', 'places.resolve', 'places.metadata', 'map.tile'].includes(action.kind)) {
      throw new ForbiddenResource('Use the new design before editing shared feedback');
    }
    let result;
    if (action.kind === 'places.autocomplete') result = await this.places?.autocomplete(principal, { ...action, version: 1 });
    else if (action.kind === 'places.resolve') result = await this.places?.resolveActionV2(principal, { ...action, version: 1 });
    else if (action.kind === 'places.metadata') {
      const found = await this.places?.metadata(principal, { ...action, version: 1 });
      if (found) {
        const { placeType, ...data } = found.data;
        result = { version: 2, kind: action.kind, data: { ...data, ...(placeType ? { primaryType: placeType } : {}) } };
      }
    }
    else if (action.kind === 'map.tile') {
      const data = await this.maps?.tile(principal, { ...action, version: 1 });
      if (data) result = { version: 2, kind: action.kind, data };
    } else return { scope: { shareId: principal.shareId, guestId: principal.guestId, epoch: principal.epoch }, projection: this.shares.providerSnapshot(principal) };
    if (!result) throw new ForbiddenResource('Advice provider is unavailable');
    this.shares.validateProviderPrincipal(principal);
    return { providerResult: { ...result, version: 2 } };
  }

  @PluginMethod('publicShare.owner.resolveNativeSelection', { permission: 'share:publish' })
  resolveNativeSelection(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).some(key => !['tripId', 'selectionId'].includes(key)) || typeof params.selectionId !== 'string' || params.selectionId.length > 160) throw new BadParams('Invalid native selection');
    if (!this.places) throw new ForbiddenResource('Google place provider is unavailable');
    return this.places.resolveSelection(this.shares.ownerPrincipal(num(params.tripId, 'tripId'), this.owner(ctx)), params.selectionId);
  }

  @PluginMethod('publicShare.owner.nativePhoto', { permission: 'share:publish' })
  async nativePhoto(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).some(key => !['tripId', 'handle'].includes(key)) || typeof params.handle !== 'string' || params.handle.length > 160) throw new BadParams('Invalid native photo');
    if (!this.places) throw new ForbiddenResource('Google place provider is unavailable');
    return advicePhotoResultSchema.parse(await this.places.photo(this.shares.ownerPrincipal(num(params.tripId, 'tripId'), this.owner(ctx), true), params.handle));
  }

  @PluginMethod('publicShare.owner.getCandidates', { permission: 'share:publish' })
  ownerCandidates(params: Record<string, unknown>, ctx: PluginRpcContext) {
    if (Object.keys(params).length !== 1 || !Object.hasOwn(params, 'tripId')) throw new BadParams('getCandidates takes tripId only');
    return this.shares.ownerCandidates(num(params.tripId, 'tripId'), this.owner(ctx));
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

  @PluginMethod('publicShare.owner.cityAutocomplete', { permission: 'share:publish' })
  ownerCityAutocomplete(params: Record<string, unknown>, ctx: PluginRpcContext) {
    const ownerId = this.owner(ctx);
    if (!this.ownerCities) throw new ForbiddenResource('Google city provider is unavailable');
    const input = parse(adviceOwnerCityAutocompleteSchema, params, 'owner city autocomplete');
    return this.ownerCities.autocomplete(ownerId, input);
  }

  @PluginMethod('publicShare.owner.cityResolve', { permission: 'share:publish' })
  ownerCityResolve(params: Record<string, unknown>, ctx: PluginRpcContext) {
    const ownerId = this.owner(ctx);
    if (!this.ownerCities) throw new ForbiddenResource('Google city provider is unavailable');
    const input = parse(adviceOwnerCityResolveSchema, params, 'owner city resolution');
    return this.ownerCities.resolve(ownerId, input);
  }

  private owner(ctx: PluginRpcContext): number {
    if (ctx.publicShare || ctx.actingUserId === undefined) throw new ForbiddenResource('Authenticated owner invocation required');
    return ctx.actingUserId;
  }
}
