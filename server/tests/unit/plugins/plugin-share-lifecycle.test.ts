import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PluginShareLifecycleService } from '../../../src/nest/plugin-shares/plugin-share-lifecycle.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import { PluginShareRetentionJob } from '../../../src/nest/plugin-shares/plugin-share-retention.job';
import type { CronRegistrarService } from '../../../src/nest/scheduling/cron-registrar.service';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('plugin share lifecycle background delivery', () => {
  it('reports a failed queue read, retries, and stops the timer on shutdown', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const all = vi.fn().mockImplementationOnce(() => { throw new Error('database unavailable'); }).mockReturnValue([]);
    const transaction = (run: () => unknown) => run();
    const lifecycle = new PluginShareLifecycleService({ all, transaction } as unknown as DatabaseService);
    lifecycle.bind(vi.fn().mockResolvedValue(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(all).toHaveBeenCalledTimes(3);
    lifecycle.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not schedule or sweep during test application bootstrap', () => {
    const registrar = { isEnabled: () => false, register: vi.fn() };
    const lifecycle = { flushInBackground: vi.fn() };
    new PluginShareRetentionJob(registrar as unknown as CronRegistrarService, lifecycle as unknown as PluginShareLifecycleService).onApplicationBootstrap();
    expect(registrar.register).not.toHaveBeenCalled();
    expect(lifecycle.flushInBackground).not.toHaveBeenCalled();
  });
  it('sweeps on production startup and registers recurring cleanup through the gated registrar', () => {
    const registrar = { isEnabled: () => true, register: vi.fn() };
    const lifecycle = { flushInBackground: vi.fn() };
    new PluginShareRetentionJob(registrar as unknown as CronRegistrarService, lifecycle as unknown as PluginShareLifecycleService).onApplicationBootstrap();
    expect(lifecycle.flushInBackground).toHaveBeenCalledOnce();
    expect(registrar.register).toHaveBeenCalledWith('plugin-share-retention', '* * * * *', expect.any(Function));
    const tick = registrar.register.mock.calls[0]![2] as () => void;
    tick();
    expect(lifecycle.flushInBackground).toHaveBeenCalledTimes(2);
  });
});
