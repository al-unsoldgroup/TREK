import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginsApi } from '../../api/client'
import { useTripAdviceOwner } from './useTripAdviceOwner'

vi.mock('../../api/client', () => ({ pluginsApi: { invoke: vi.fn() } }))

const config = { version: 2 as const, showNotes: false, hiddenCityKeys: [] as string[], hiddenDayKeys: [] as string[], hiddenNoteDayKeys: [] as string[], hiddenPlaceKeys: [] as string[], hiddenIdeaKeys: [] as string[], addedCities: [] }
const projection = { version: 2 as const, revision: 'a'.repeat(64), title: 'Japan', cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'] }], stays: [], shortlists: [] }
const owner = (over: Record<string, unknown> = {}) => ({
  version: 2 as const,
  config: { shareId: 'share', token: 'ta_abcdefghijklmnopqrstuvwxyz123456', enabled: true, revision: 3, expiresAt: '2099-01-01T00:00:00.000Z', config },
  legacy: false, draftConfig: config, projection, inbox: { suggestions: [], comments: [] }, ...over,
})
const feedback = { projection, feedbackRevision: 0, votes: [], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null }

describe('native Trip Advice owner controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pluginsApi.invoke).mockImplementation(async (_id, sub, init) => {
      if (sub.includes('/actions')) return feedback
      if (init?.method === 'PUT') return owner({ config: { ...owner().config, revision: 4, config: init.body && (init.body as { config: typeof config }).config }, draftConfig: init.body && (init.body as { config: typeof config }).config })
      return owner()
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('auto-saves a visibility exception with the current revision', async () => {
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner).toBeTruthy())
    await act(async () => view.result.current.owner!.setVisibility('hiddenCityKeys', 'tokyo'))
    const call = vi.mocked(pluginsApi.invoke).mock.calls.find(([, , init]) => init?.method === 'PUT')
    expect(call?.[1]).toBe('owner/native?tripId=3')
    expect(call?.[2]?.body).toEqual(expect.objectContaining({ expectedRevision: 3, config: expect.objectContaining({ hiddenCityKeys: ['tokyo'] }) }))
    expect(view.result.current.owner?.saveState).toBe('Saved')
  })

  it('copies the active same-origin share URL', async () => {
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner).toBeTruthy())
    await act(async () => view.result.current.owner!.copyLink())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/\/shared\/ta_abcdefghijklmnopqrstuvwxyz123456$/))
  })
  it('copies a newly created link with the synchronous fallback when clipboard activation expires', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('Activation expired'))
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(true) })
    vi.mocked(pluginsApi.invoke).mockImplementation(async (_id, sub, init) => {
      if (sub.includes('/actions')) return feedback
      if (init?.method === 'PUT') return owner()
      return owner({ config: { ...owner().config, token: undefined } })
    })
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner).toBeTruthy())
    await act(async () => view.result.current.owner!.copyLink())
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(view.result.current.owner?.saveState).toBe('Link copied')
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('requires the reviewed legacy hash for the explicit upgrade', async () => {
    vi.mocked(pluginsApi.invoke).mockImplementation(async (_id, sub, init) => {
      if (sub.includes('/actions')) return feedback
      if (init?.method === 'PUT') return owner()
      return owner({ legacy: true, upgradeRevision: 'b'.repeat(64) })
    })
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner?.legacy).toBe(true))
    await act(async () => view.result.current.owner!.upgrade!())
    const call = vi.mocked(pluginsApi.invoke).mock.calls.find(([, , init]) => init?.method === 'PUT')
    expect(call?.[2]?.body).toEqual(expect.objectContaining({ upgradeToV2: { expectedLegacyHash: 'b'.repeat(64) } }))
  })
  it('forwards anchored owner comments and reloads the owner inbox after writes', async () => {
    const anchor = { kind: 'city' as const, key: 'tokyo' }
    let written = false
    vi.mocked(pluginsApi.invoke).mockImplementation(async (_id, sub, init) => {
      if (sub.includes('/actions')) {
        if ((init?.body as { kind?: string })?.kind === 'comment.create') { written = true; return { version: 2, kind: 'comment.create', data: {} } }
        return feedback
      }
      return owner({ inbox: { suggestions: [], comments: written ? [{ id: '22222222-2222-4222-8222-222222222222', text: 'Start slowly', displayName: null, createdAt: '2026-01-01T00:00:00.000Z', deleted: false, anchor }] : [] } })
    })
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner).toBeTruthy())
    await act(async () => view.result.current.comment('Start slowly', undefined, anchor))
    expect(pluginsApi.invoke).toHaveBeenCalledWith('trip-advice', 'owner/native/actions?tripId=3', expect.objectContaining({ body: expect.objectContaining({ kind: 'comment.create', anchor }) }))
    expect(view.result.current.comments[0].anchor).toEqual(anchor)
  })
  it('reports clipboard denial without rejecting the copy action', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('Clipboard denied'))
    const view = renderHook(() => useTripAdviceOwner(3))
    await waitFor(() => expect(view.result.current.owner).toBeTruthy())
    await act(async () => { await expect(view.result.current.owner!.copyLink()).resolves.toBeUndefined() })
    expect(view.result.current.error).toBe('Clipboard denied')
    expect(view.result.current.owner?.saveState).toBe('Link not copied')
  })
})
