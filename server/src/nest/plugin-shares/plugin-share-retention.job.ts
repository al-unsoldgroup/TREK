import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { CronRegistrarService } from '../scheduling/cron-registrar.service';
import { PluginShareLifecycleService } from './plugin-share-lifecycle.service';

@Injectable()
export class PluginShareRetentionJob implements OnApplicationBootstrap {
  constructor(private readonly registrar: CronRegistrarService, private readonly lifecycle: PluginShareLifecycleService) {}

  onApplicationBootstrap(): void {
    if (!this.registrar.isEnabled()) return;
    this.lifecycle.flushInBackground();
    this.registrar.register('plugin-share-retention', '* * * * *', () => this.lifecycle.flushInBackground());
  }
}
