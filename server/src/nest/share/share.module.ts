import { Module } from '@nestjs/common';
import { PluginSharesModule } from '../plugin-shares/plugin-shares.module';
import { TripShareController, SharedController } from './share.controller';
import { ShareService } from './share.service';
import { ShareMcp } from './share.mcp';
import { SettingsModule } from '../settings/settings.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { QueryHelpersModule } from '../query-helpers/query-helpers.module';
import { PlacePhotosModule } from '../place-photos/place-photos.module';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { McpSharedModule } from '../mcp-shared/mcp-shared.module';
import { SharedPageController } from './shared-page.controller';
import { SharedPageService } from './shared-page.service';

@Module({
  imports: [PluginSharesModule, McpSharedModule, SettingsModule, PermissionsModule, QueryHelpersModule, AuthModule, PlacePhotosModule, StorageModule],
  controllers: [TripShareController, SharedController, SharedPageController],
  providers: [ShareService, ShareMcp, SharedPageService],
})
export class ShareModule {}
