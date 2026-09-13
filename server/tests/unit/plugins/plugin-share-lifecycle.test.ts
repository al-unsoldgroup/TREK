import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PluginShareLifecycleService } from '../../../src/nest/plugin-shares/plugin-share-lifecycle.service';
import type { DatabaseService } from '../../../src/nest/database/database.service';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('plugin share lifecycle background delivery', () => {
  it('reports a failed queue read, retries, and stops the timer on shutdown', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const all = vi.fn().mockImplementationOnce(() => { throw new Error('database unavailable'); }).mockReturnValue([]);
    const lifecycle = new PluginShareLifecycleService({ all } as unknown as DatabaseService);
    lifecycle.bind(vi.fn().mockResolvedValue(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(all).toHaveBeenCalledTimes(2);
    lifecycle.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
