import posthog from 'posthog-js'

/**
 * Error tracking only — no session recording, no heatmaps, no autocapture of
 * clicks/inputs. `capture_exceptions: true` turns on posthog-js's own
 * window.onerror / unhandledrejection listeners (it does not replace
 * utils/globalErrorHandlers.ts, which still owns the chunk-reload recovery);
 * `captureException()` below covers what those listeners can't reach — errors
 * a React ErrorBoundary already caught.
 *
 * Optional by design: with no VITE_POSTHOG_KEY, `init()` is a no-op and
 * `captureException` degrades to nothing. Self-hosted instances that never set
 * the key send nothing to PostHog.
 */

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
let enabled = false

export function init(): void {
  if (!key || enabled) return
  enabled = true
  posthog.init(key, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com',
    capture_exceptions: true,
    autocapture: false,
    capture_pageview: true,
    // The commit this bundle was built from (Dockerfile ARG GIT_SHA — see
    // vite.config.js UI_VERSION for the semver counterpart). Unset on a source
    // checkout, which is fine: PostHog just groups those under no release.
    loaded: (client) => {
      const sha = import.meta.env.VITE_GIT_SHA as string | undefined
      if (sha) client.register({ $release: sha })
    },
  })
}

/** Errors an ErrorBoundary already caught never reach window.onerror. */
export function captureException(error: unknown): void {
  if (!enabled) return
  posthog.captureException(error)
}
