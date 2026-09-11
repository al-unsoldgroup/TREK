import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { publicShareApi } from './publicShare'

const bootstrap = {
  kind: 'plugin-share',
  version: 1,
  plugin: { id: 'trip-advice', entry: 'guest.html', protocolVersion: 1 },
  title: 'Japan together',
  expiresAt: '2026-09-10T00:00:00.000Z',
}

const projection = {
  version: 1,
  revision: 'a'.repeat(64),
  title: 'Japan together',
  cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'] }],
  stays: [],
  shortlists: [],
}

const feedback = {
  projection,
  feedbackRevision: 1,
  votes: [],
  myPendingSuggestions: [],
  myComments: [],
  nextCommentsCursor: null,
}

function response(data: unknown, ok = true) {
  return { ok, json: vi.fn(async () => data) } as unknown as Response
}

describe('publicShareApi', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('FE-USG215-API-001: keeps legacy shared payloads on the legacy branch', async () => {
    fetchMock.mockResolvedValue(response({ trip: { title: 'Legacy' }, permissions: {} }))

    const result = await publicShareApi.getEntry('legacy-token')

    expect(result).toEqual({ kind: 'legacy', data: { trip: { title: 'Legacy' }, permissions: {} } })
    expect(fetchMock).toHaveBeenCalledWith('/api/shared/legacy-token', expect.objectContaining({ credentials: 'omit', cache: 'no-store' }))
  })

  it('FE-USG215-API-002: validates advice bootstrap and keeps the token out of the payload', async () => {
    fetchMock.mockResolvedValue(response(bootstrap))

    const result = await publicShareApi.getEntry('ta_public')

    expect(result).toEqual({ kind: 'plugin-share', bootstrap })
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('csrf')
  })

  it('FE-USG215-API-003: sends only the strict parent-owned session and read requests', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ csrfToken: 'csrf-secret', expiresAt: bootstrap.expiresAt }))
      .mockResolvedValueOnce(response(feedback))

    const session = await publicShareApi.createSession('ta_public')
    await publicShareApi.read('ta_public', session.csrfToken)

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/shared/ta_public/plugins/trip-advice/session', expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{}', cache: 'no-store',
    }))
    const actionInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(actionInit).toEqual(expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{"version":1,"kind":"read"}', cache: 'no-store',
    }))
    expect(new Headers(actionInit.headers).get('X-Trek-Advice-CSRF')).toBe('csrf-secret')
  })

  it('FE-USG215-API-004: refuses unsupported actions before network dispatch', async () => {
    await expect(publicShareApi.action('ta_public', 'csrf', { version: 1, kind: 'vote.set' })).rejects.toThrow('not available')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('FE-USG215-API-005: validates and forwards a full write action union member', async () => {
    fetchMock.mockResolvedValue(response({ version: 1, kind: 'comment.create', data: { accepted: true } }))

    await publicShareApi.action('ta_public', 'csrf-secret', {
      version: 1,
      kind: 'comment.create',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      text: 'Try the market',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/shared/ta_public/plugins/trip-advice/actions', expect.objectContaining({
      body: JSON.stringify({ version: 1, kind: 'comment.create', requestId: '123e4567-e89b-42d3-a456-426614174000', text: 'Try the market' }),
    }))
  })

  it('FE-USG215-API-006: requests only a scoped, CSRF-protected photo envelope', async () => {
    fetchMock.mockResolvedValue(response({ state: 'available', mimeType: 'image/jpeg', bytesBase64: '/9j/', authors: [], googleAttribution: '© Google' }))

    await expect(publicShareApi.photo('ta_public', 'photo-handle', 'csrf-secret')).resolves.toMatchObject({ state: 'available' })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(fetchMock).toHaveBeenCalledWith('/api/shared/ta_public/plugins/trip-advice/photos/photo-handle', expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store',
    }))
    expect(new Headers(init.headers).get('X-Trek-Advice-CSRF')).toBe('csrf-secret')
  })
})
