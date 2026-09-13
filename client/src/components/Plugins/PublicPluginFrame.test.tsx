import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicPluginFrame from './PublicPluginFrame'

const publicApi = vi.hoisted(() => ({
  createSession: vi.fn(),
  action: vi.fn(),
  photo: vi.fn(),
}))

vi.mock('../../api/publicPluginShare', () => ({ publicShareApi: publicApi }))
vi.mock('../../i18n', () => ({ useTranslation: () => ({ locale: 'en-US', t: (key: string) => key }) }))

const bootstrap = {
  kind: 'plugin-share' as const,
  version: 1 as const,
  plugin: { id: 'trip-advice' as const, entry: 'guest.html' as const, protocolVersion: 1 as const },
  title: 'Japan together',
  expiresAt: '2026-09-10T00:00:00.000Z',
}

const projection = {
  version: 1 as const,
  revision: 'a'.repeat(64),
  title: 'Japan together',
  cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'] }],
  stays: [],
  shortlists: [{ cityId: 'tokyo', see: [{ key: 'p:1', title: 'Temple', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: 'g:1', mapsUrl: 'https://www.google.com/maps/search/Temple' }], eat: [] }],
}

const feedback = {
  projection,
  feedbackRevision: 1,
  votes: [],
  myPendingSuggestions: [],
  myComments: [],
  nextCommentsCursor: null,
}

function mount() {
  const view = render(<PublicPluginFrame token="ta_public" bootstrap={bootstrap} />)
  const iframe = view.container.querySelector('iframe') as HTMLIFrameElement
  const posted: Array<Record<string, unknown>> = []
  ;(iframe.contentWindow as unknown as { postMessage: (message: unknown) => void }).postMessage = (message) => posted.push(message as Record<string, unknown>)
  fireEvent.load(iframe)
  return { ...view, iframe, posted }
}

function fromFrame(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data } as MessageEventInit))
}

beforeEach(() => {
  publicApi.createSession.mockResolvedValue({ csrfToken: 'host-only-csrf', expiresAt: bootstrap.expiresAt })
  publicApi.action.mockResolvedValue(feedback)
  publicApi.photo.mockResolvedValue({ state: 'available', mimeType: 'image/jpeg', bytesBase64: '/9j/', authors: [], googleAttribution: 'Google Maps', googleMapsUri: 'https://www.google.com/maps/photo' })
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  publicApi.createSession.mockReset()
  publicApi.action.mockReset()
  publicApi.photo.mockReset()
})

describe('PublicPluginFrame', () => {
  it('FE-USG215-FRAME-001: uses a dedicated opaque guest frame and excludes private credentials/state', () => {
    const { iframe, posted } = mount()

    expect(iframe.src).toContain('/plugin-frame/trip-advice/guest.html')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(JSON.stringify(posted[0])).not.toContain('ta_public')
    expect(JSON.stringify(posted[0])).not.toContain('csrf')
    expect(JSON.stringify(posted[0])).not.toContain('userId')
    expect(JSON.stringify(posted[0])).not.toContain('tripId')
    expect(typeof posted[0].nonce).toBe('string')
  })

  it('FE-USG215-FRAME-002: rejects foreign sources and invalid message shapes', async () => {
    const { iframe } = mount()
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'trek:public:ready', version: 1 } }))
    fromFrame(iframe, { type: 'trek:public:action', id: 'public-1', action: { version: 1, kind: 'read', extra: true } })

    await act(async () => undefined)
    expect(publicApi.createSession).not.toHaveBeenCalled()
    expect(publicApi.action).not.toHaveBeenCalled()
  })

  it('FE-USG215-FRAME-003: handles the addon read handshake without sending session credentials to the child', async () => {
    const { iframe, posted } = mount()
    fromFrame(iframe, { type: 'trek:public:ready', version: 1 })
    fromFrame(iframe, { type: 'trek:public:action', id: 'public-1', action: { version: 1, kind: 'read', commentsCursor: 'opaque-cursor' } })

    await waitFor(() => expect(publicApi.action).toHaveBeenCalledWith('ta_public', 'host-only-csrf', { version: 1, kind: 'read', commentsCursor: 'opaque-cursor' }, expect.any(AbortSignal)))
    expect(posted.some((message) => message.type === 'trek:public:result' && message.id === 'public-1')).toBe(true)
    expect(posted.every((message) => !('csrfToken' in message) && !('token' in message))).toBe(true)
  })

  it('FE-USG215-FRAME-004: opens only a Maps URL from the validated projection', async () => {
    const { iframe } = mount()
    fromFrame(iframe, { type: 'trek:public:ready', version: 1 })
    fromFrame(iframe, { type: 'trek:public:action', id: 'public-1', action: { version: 1, kind: 'read' } })
    await waitFor(() => expect(publicApi.action).toHaveBeenCalled())

    fromFrame(iframe, { type: 'trek:public:openMaps', placeKeyOrSelectionId: 'p:1' })
    fromFrame(iframe, { type: 'trek:public:openMaps', placeKeyOrSelectionId: 'https://evil.example' })

    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith('https://www.google.com/maps/search/Temple', '_blank', 'noopener,noreferrer')
  })

  it('FE-USG215-FRAME-005: returns validated photos and opens only validated attribution URLs', async () => {
    const { iframe, posted } = mount()
    fromFrame(iframe, { type: 'trek:public:photo', id: 'public-1', handle: 'photo-handle' })
    fromFrame(iframe, { type: 'trek:public:openAttribution', uri: 'https://evil.example/photo' })

    expect(publicApi.action).not.toHaveBeenCalled()
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: 'trek:public:result', id: 'public-1' })))
    expect(publicApi.photo).toHaveBeenCalledWith('ta_public', 'photo-handle', 'host-only-csrf', expect.any(AbortSignal))
    expect(posted).toContainEqual(expect.objectContaining({ type: 'trek:public:result', id: 'public-1', result: expect.objectContaining({ googleAttribution: 'Google Maps', googleMapsUri: 'https://www.google.com/maps/photo' }) }))
    expect(window.open).toHaveBeenCalledWith('https://evil.example/photo', '_blank', 'noopener,noreferrer')
  })

  it('FE-USG215-FRAME-006: cuts off the bridge after guest navigation', async () => {
    const { iframe } = mount()
    fireEvent.load(iframe)
    fromFrame(iframe, { type: 'trek:public:action', id: 'public-1', action: { version: 1, kind: 'read' } })

    await act(async () => undefined)
    expect(publicApi.createSession).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('FE-USG215-FRAME-007: clears a revoked session so the next action must reinitialize', async () => {
    publicApi.action.mockRejectedValue(new Error('Public advice is no longer available.'))
    const { iframe, posted } = mount()
    fromFrame(iframe, { type: 'trek:public:action', id: 'public-1', action: { version: 1, kind: 'read' } })
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: 'trek:public:error', id: 'public-1' })))

    fromFrame(iframe, { type: 'trek:public:action', id: 'public-2', action: { version: 1, kind: 'read' } })
    await waitFor(() => expect(publicApi.createSession).toHaveBeenCalledTimes(2))
  })

  it('FE-USG215-FRAME-008: forwards a valid write union member and preserves its strict envelope', async () => {
    publicApi.action.mockResolvedValue({ version: 1, kind: 'comment.create', data: { accepted: true } })
    const { iframe, posted } = mount()
    fromFrame(iframe, {
      type: 'trek:public:action',
      id: 'public-1',
      action: { version: 1, kind: 'comment.create', requestId: '123e4567-e89b-42d3-a456-426614174000', text: 'Try the market' },
    })

    await waitFor(() => expect(publicApi.action).toHaveBeenCalledWith(
      'ta_public',
      'host-only-csrf',
      { version: 1, kind: 'comment.create', requestId: '123e4567-e89b-42d3-a456-426614174000', text: 'Try the market' },
      expect.any(AbortSignal),
    ))
    expect(posted).toContainEqual(expect.objectContaining({ type: 'trek:public:result', id: 'public-1', result: { version: 1, kind: 'comment.create', data: { accepted: true } } }))
  })

  it('FE-USG215-FRAME-009: opens Maps for a host-resolved selection only', async () => {
    publicApi.action.mockResolvedValue({ version: 1, kind: 'places.resolve', data: { selectionId: 'selection-1', mapsUrl: 'https://www.google.com/maps/search/Resolved' } })
    const { iframe } = mount()
    fromFrame(iframe, {
      type: 'trek:public:action',
      id: 'public-1',
      action: { version: 1, kind: 'places.resolve', searchId: '123e4567-e89b-42d3-a456-426614174000', predictionId: 'prediction-1' },
    })
    await waitFor(() => expect(publicApi.action).toHaveBeenCalled())

    fromFrame(iframe, { type: 'trek:public:openMaps', placeKeyOrSelectionId: 'selection-1' })
    fromFrame(iframe, { type: 'trek:public:openMaps', placeKeyOrSelectionId: 'https://evil.example' })

    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith('https://www.google.com/maps/search/Resolved', '_blank', 'noopener,noreferrer')
  })
})
