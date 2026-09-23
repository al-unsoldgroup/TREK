import { PostHog } from 'posthog-node';
import { readEnv } from '../app-config';

/**
 * Server-side error capture. Optional by design: with no POSTHOG_API_KEY,
 * `getClient()` returns null and every capture call below is a no-op — a
 * self-hosted instance that never sets the key sends nothing to PostHog.
 *
 * Every event is tagged `$release` = the git SHA the running image was built
 * from (Dockerfile ARG GIT_SHA), matching the client's VITE_GIT_SHA, so a
 * regression can be traced to one deploy from either side.
 */
let client: PostHog | null = null;
let initialised = false;

export function getClient(): PostHog | null {
  if (initialised) return client;
  initialised = true;
  const { posthogApiKey, posthogHost } = readEnv().integrations;
  if (!posthogApiKey) return null;
  client = new PostHog(posthogApiKey, { host: posthogHost });
  return client;
}

/** distinctId is optional — most of what lands here has no request-scoped user. */
export function captureException(error: unknown, distinctId?: string): void {
  const c = getClient();
  if (!c) return;
  const { gitSha } = readEnv().app;
  c.captureException(error, distinctId, gitSha ? { $release: gitSha } : undefined);
}

/**
 * Awaited version for the two spots that exit the process right after
 * capturing (uncaughtException/unhandledRejection in index.ts) — the queued
 * form above would otherwise be dropped by process.exit() before it flushes.
 */
export async function captureExceptionImmediate(error: unknown, distinctId?: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  const { gitSha } = readEnv().app;
  await c.captureExceptionImmediate(error, distinctId, gitSha ? { $release: gitSha } : undefined);
}

/** Called from server/src/shutdown.ts so queued events flush before exit. */
export async function shutdown(): Promise<void> {
  if (!client) return;
  await client._shutdown();
}
