import { Module } from '@nestjs/common';
import { AdviceRateLimiter, PluginShareDb } from './plugin-share-db';
import { PluginSharesService } from './plugin-shares.service';
import { PluginShareProjectionService } from './plugin-share-projection.service';
import { PluginSharesRpc } from './plugin-shares.rpc';
import { PluginShareLifecycleService } from './plugin-share-lifecycle.service';
import { GooglePlacesProvider, GOOGLE_PLACES_FETCH } from './google-places.provider';
import { AdviceMapProvider, ADVICE_MAP_FETCH } from './advice-map.provider';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PluginShareRetentionJob } from './plugin-share-retention.job';
import { OwnerCityProvider } from './owner-city.provider';

/** Leaf authorization/data module: never imports the runtime that consumes it. */
@Module({ imports: [SchedulingModule], providers: [PluginShareDb, AdviceRateLimiter, PluginSharesService, PluginShareProjectionService, PluginSharesRpc, PluginShareLifecycleService, PluginShareRetentionJob, GooglePlacesProvider,
  OwnerCityProvider,
  AdviceMapProvider, { provide: ADVICE_MAP_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  { provide: GOOGLE_PLACES_FETCH, useValue: globalThis.fetch.bind(globalThis) }], exports: [PluginShareDb, PluginSharesService, PluginShareLifecycleService, GooglePlacesProvider, AdviceMapProvider] })
export class PluginSharesModule {}
