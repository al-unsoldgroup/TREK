import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

type LifecycleInvoker = (method: 'invoke.publicShare.purge' | 'invoke.publicShare.eraseGuest', input: Record<string, string>) => Promise<unknown>;

/** Host-owned lifecycle delivery. The addon receives only its share-scoped ids. */
@Injectable()
export class PluginShareLifecycleService implements OnModuleDestroy {
  private readonly logger = new Logger(PluginShareLifecycleService.name);
  private invoker: LifecycleInvoker | undefined;
  private flushing = false;
  private retryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: DatabaseService) {}

  bind(invoker: LifecycleInvoker): void {
    this.invoker = invoker;
    this.flushInBackground();
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => { this.flushInBackground(); }, 30_000);
      this.retryTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.invoker = undefined;
  }

  private flushInBackground(): void {
    void this.flush().catch(() => this.logger.error('Unable to read the plugin-share cleanup queue; delivery will retry.'));
  }

  enqueuePurge(shareId: string): void {
    this.db.run("INSERT OR IGNORE INTO plugin_share_lifecycle_outbox(method, share_id, guest_id) VALUES ('purge', ?, '')", shareId);
  }

  enqueueEraseGuest(shareId: string, guestId: string): void {
    this.db.run("INSERT OR IGNORE INTO plugin_share_lifecycle_outbox(method, share_id, guest_id) VALUES ('erase_guest', ?, ?)", shareId, guestId);
  }

  hasPendingPurge(shareId: string): boolean {
    return !!this.db.get("SELECT 1 FROM plugin_share_lifecycle_outbox WHERE method = 'purge' AND share_id = ?", shareId);
  }

  async flush(): Promise<void> {
    if (!this.invoker || this.flushing) return;
    this.flushing = true;
    try {
      const rows = this.db.all<{ id: number; method: 'purge' | 'erase_guest'; share_id: string; guest_id: string }>(
        'SELECT id, method, share_id, guest_id FROM plugin_share_lifecycle_outbox ORDER BY id LIMIT 32',
      );
      for (const row of rows) {
        try {
          await this.invoker(row.method === 'purge' ? 'invoke.publicShare.purge' : 'invoke.publicShare.eraseGuest',
            row.method === 'purge' ? { shareId: row.share_id } : { shareId: row.share_id, guestId: row.guest_id });
          this.db.run('DELETE FROM plugin_share_lifecycle_outbox WHERE id = ?', row.id);
        } catch {
          // Preserve order and retry after the addon/runtime returns. A failed
          // lifecycle delivery must never make deletion erase its cleanup intent.
          break;
        }
      }
    } finally { this.flushing = false; }
  }
}
