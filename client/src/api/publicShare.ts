import {
  adviceActionSchema,
  adviceBootstrapSchema,
  adviceFeedbackReadSchema,
  adviceFeedbackWriteSchema,
  advicePhotoResultSchema,
  type AdviceAction,
  type AdviceBootstrap,
  type AdviceReadAction,
  type AdviceReadResult,
  type AdviceWriteResponse,
} from '@trek/shared'

/**
 * The public-share transport is deliberately separate from apiClient. Public
 * links must not enter the authenticated interceptor, Dexie repositories, or
 * the service-worker cache policy used by the member app.
 */

export interface PublicShareSession {
  csrfToken: string
  expiresAt: string
}

export type PublicShareEntry =
  | { kind: 'legacy'; data: unknown }
  | { kind: 'plugin-share'; bootstrap: AdviceBootstrap }

function tokenPath(token: string): string {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200 || /[\u0000-\u001f/]/.test(token)) {
    throw new Error('Invalid public share token.')
  }
  return `/api/shared/${encodeURIComponent(token)}`
}

async function json<T>(input: RequestInfo | URL, init: RequestInit, errorMessage: string): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('Cache-Control', 'no-store')
  const response = await fetch(input, {
    ...init,
    mode: 'same-origin',
    cache: 'no-store',
    headers,
  })
  if (!response.ok) throw new Error(errorMessage)
  return response.json() as Promise<T>
}

function isPluginBootstrap(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'plugin-share'
}

function readSession(value: unknown): PublicShareSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid public share session.')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    typeof record.csrfToken !== 'string' ||
    record.csrfToken.length === 0 ||
    record.csrfToken.length > 200 ||
    typeof record.expiresAt !== 'string' ||
    record.expiresAt.length === 0 ||
    record.expiresAt.length > 80 ||
    Number.isNaN(Date.parse(record.expiresAt))
  ) throw new Error('Invalid public share session.')
  return { csrfToken: record.csrfToken, expiresAt: record.expiresAt }
}

function parseAction(action: unknown): AdviceAction {
  const parsed = adviceActionSchema.safeParse(action)
  if (!parsed.success) throw new Error('Public advice action is not available.')
  return parsed.data
}

function parseReadResult(value: unknown): AdviceReadResult {
  const parsed = adviceFeedbackReadSchema.safeParse(value)
  if (!parsed.success) throw new Error('TREK returned an invalid advice feedback envelope.')
  return parsed.data
}

function parseWriteResult(value: unknown): AdviceWriteResponse {
  const parsed = adviceFeedbackWriteSchema.safeParse(value)
  if (!parsed.success) throw new Error('TREK returned an invalid advice action result.')
  return parsed.data
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9:_-]+$/.test(value)
}

export const publicShareApi = {
  async getEntry(token: string, signal?: AbortSignal): Promise<PublicShareEntry> {
    const data = await json<unknown>(tokenPath(token), { method: 'GET', credentials: 'omit', signal }, 'Public share link unavailable.')
    if (!isPluginBootstrap(data)) return { kind: 'legacy', data }
    const parsed = adviceBootstrapSchema.safeParse(data)
    if (!parsed.success) throw new Error('Invalid public advice link.')
    return { kind: 'plugin-share', bootstrap: parsed.data }
  },

  async createSession(token: string, signal?: AbortSignal): Promise<PublicShareSession> {
    const data = await json<unknown>(`${tokenPath(token)}/plugins/trip-advice/session`, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, 'Public advice session unavailable.')
    return readSession(data)
  },

  async action(token: string, csrfToken: string, action: unknown, signal?: AbortSignal): Promise<AdviceReadResult | AdviceWriteResponse> {
    const parsedAction = parseAction(action)
    const data = await json<unknown>(`${tokenPath(token)}/plugins/trip-advice/actions`, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Trek-Advice-CSRF': csrfToken,
      },
      body: JSON.stringify(parsedAction),
    }, 'Public advice is no longer available.')
    return parsedAction.kind === 'read' ? parseReadResult(data) : parseWriteResult(data)
  },

  async read(token: string, csrfToken: string, action: AdviceReadAction = { version: 1, kind: 'read' }, signal?: AbortSignal): Promise<AdviceReadResult> {
    const result = await this.action(token, csrfToken, action, signal)
    if (!('projection' in result)) throw new Error('TREK returned an invalid advice feedback envelope.')
    return result
  },

  async write(token: string, csrfToken: string, action: Exclude<AdviceAction, AdviceReadAction>, signal?: AbortSignal): Promise<AdviceWriteResponse> {
    const result = await this.action(token, csrfToken, action, signal)
    if (!('data' in result)) throw new Error('TREK returned an invalid advice action result.')
    return result
  },

  async photo(token: string, handle: string, csrfToken: string, signal?: AbortSignal) {
    if (!isOpaqueHandle(handle)) throw new Error('Invalid public photo handle.')
    const data = await json<unknown>(`${tokenPath(token)}/plugins/trip-advice/photos/${encodeURIComponent(handle)}`, {
      method: 'GET',
      credentials: 'include',
      signal,
      headers: { 'X-Trek-Advice-CSRF': csrfToken },
    }, 'Public advice photo is unavailable.')
    const parsed = advicePhotoResultSchema.safeParse(data)
    if (!parsed.success) throw new Error('TREK returned an invalid advice photo.')
    return parsed.data
  },
}
