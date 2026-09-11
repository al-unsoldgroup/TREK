import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { PluginSharesService } from './plugin-shares.service';
import { PluginShareProjectionService } from './plugin-share-projection.service';
import { PluginSharesRpc } from './plugin-shares.rpc';
import { PluginShareLifecycleService } from './plugin-share-lifecycle.service';
import { GooglePlacesProvider, GOOGLE_PLACES_FETCH } from './google-places.provider';

/** Leaf authorization/data module: never imports the runtime that consumes it. */
@Module({ imports: [PermissionsModule, RateLimitModule], providers: [PluginSharesService, PluginShareProjectionService, PluginSharesRpc, PluginShareLifecycleService, GooglePlacesProvider,
  { provide: GOOGLE_PLACES_FETCH, useValue: globalThis.fetch.bind(globalThis) }], exports: [PluginSharesService, PluginShareLifecycleService, GooglePlacesProvider] })
export class PluginSharesModule {}
