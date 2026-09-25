import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// posthog-node opens a real network client on construction — mock it so the
// unit test never dials out, and so we can assert on what was sent.
const captureException = vi.fn();
const captureExceptionImmediate = vi.fn().mockResolvedValue(undefined);
const _shutdown = vi.fn().mockResolvedValue(undefined);
const PostHogCtor = vi.fn().mockImplementation(function () { return {
  captureException,
  captureExceptionImmediate,
  _shutdown,
}; });

vi.mock('posthog-node', () => ({ PostHog: PostHogCtor }));

const KEYS = ['POSTHOG_API_KEY', 'POSTHOG_HOST', 'GIT_SHA'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  PostHogCtor.mockClear();
  captureException.mockClear();
  captureExceptionImmediate.mockClear();
  _shutdown.mockClear();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('telemetry/posthog', () => {
  it('without POSTHOG_API_KEY never constructs a client and every call is a no-op', async () => {
    const posthog = await import('../../../src/telemetry/posthog');
    expect(posthog.getClient()).toBeNull();
    posthog.captureException(new Error('boom'));
    await posthog.captureExceptionImmediate(new Error('boom'));
    await posthog.shutdown();
    expect(PostHogCtor).not.toHaveBeenCalled();
  });

  it('with POSTHOG_API_KEY set, tags the capture with $release = GIT_SHA', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.GIT_SHA = 'abc1234';
    const posthog = await import('../../../src/telemetry/posthog');
    const err = new Error('boom');

    posthog.captureException(err, 'user-1');

    expect(PostHogCtor).toHaveBeenCalledWith('phc_test', { host: 'https://us.i.posthog.com' });
    expect(captureException).toHaveBeenCalledWith(err, 'user-1', { $release: 'abc1234' });
  });

  it('reuses the same client across calls (constructed once)', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    const posthog = await import('../../../src/telemetry/posthog');
    posthog.getClient();
    posthog.getClient();
    expect(PostHogCtor).toHaveBeenCalledTimes(1);
  });

  it('shutdown flushes the client when one was constructed', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    const posthog = await import('../../../src/telemetry/posthog');
    posthog.getClient();
    await posthog.shutdown();
    expect(_shutdown).toHaveBeenCalledTimes(1);
  });
});
