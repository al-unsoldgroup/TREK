import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publicShareApi } from '../../api/publicShare'
import { useTripAdviceSession } from './useTripAdviceSession'

vi.mock('../../api/publicShare', () => ({ publicShareApi: {
  createSession: vi.fn(), readV2: vi.fn(), writeV2: vi.fn(), photo: vi.fn(),
} }))

const projection = { version: 2 as const, revision: 'a'.repeat(64), title: 'Japan', cities: [], stays: [], shortlists: [] }
const read = { projection, feedbackRevision: 1, votes: [{ placeKey: 'p:1', positive: 2, negative: 0, mine: 1 as const, version: 4 }], myPendingSuggestions: [], myComments: [], nextCommentsCursor: null }

describe('native Trip Advice guest controller', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(publicShareApi.createSession).mockResolvedValue({ csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00.000Z' })
    vi.mocked(publicShareApi.readV2).mockResolvedValue(read)
    vi.mocked(publicShareApi.writeV2).mockResolvedValue({ version: 2, kind: 'vote.set', data: {} })
  })

  it('loads the native projection through a scoped public session', async () => {
    const view = renderHook(() => useTripAdviceSession('ta_abcdefghijklmnopqrstuvwxyz123456'))
    await waitFor(() => expect(view.result.current.projection?.title).toBe('Japan'))
    expect(publicShareApi.createSession).toHaveBeenCalledWith('ta_abcdefghijklmnopqrstuvwxyz123456', expect.any(AbortSignal))
    expect(publicShareApi.readV2).toHaveBeenCalledWith('ta_abcdefghijklmnopqrstuvwxyz123456', 'csrf', expect.any(AbortSignal))
  })

  it('writes a vote with the current optimistic concurrency version then refreshes', async () => {
    const view = renderHook(() => useTripAdviceSession('ta_abcdefghijklmnopqrstuvwxyz123456'))
    await waitFor(() => expect(view.result.current.votes).toHaveLength(1))
    await act(async () => view.result.current.vote('p:1', -1))
    expect(publicShareApi.writeV2).toHaveBeenCalledWith('ta_abcdefghijklmnopqrstuvwxyz123456', 'csrf', expect.objectContaining({ version: 2, kind: 'vote.set', placeKey: 'p:1', value: -1, expectedVersion: 4 }))
    expect(publicShareApi.readV2).toHaveBeenCalledTimes(2)
  })
  it('forwards a comment anchor and preserves it in the rendered feedback', async () => {
    const anchor = { kind: 'day' as const, key: 'd:1' }
    vi.mocked(publicShareApi.readV2).mockResolvedValue({ ...read, myComments: [{ id: '22222222-2222-4222-8222-222222222222', text: 'Start slowly', displayName: null, createdAt: '2026-01-01T00:00:00.000Z', deleted: false, anchor }] })
    const view = renderHook(() => useTripAdviceSession('ta_abcdefghijklmnopqrstuvwxyz123456'))
    await waitFor(() => expect(view.result.current.comments).toHaveLength(1))
    await act(async () => view.result.current.comment('Start slowly', undefined, anchor))
    expect(publicShareApi.writeV2).toHaveBeenCalledWith(expect.any(String), 'csrf', expect.objectContaining({ kind: 'comment.create', anchor }))
    expect(view.result.current.comments[0].anchor).toEqual(anchor)
  })
  it('batches and deduplicates metadata requests within the guest session', async () => {
    vi.mocked(publicShareApi.writeV2).mockResolvedValue({ version: 2, kind: 'places.metadata.batch', data: { places: [
      { placeKey: 'p:1', primaryType: 'Garden' }, { placeKey: 'p:2', primaryType: 'Museum' },
    ] } })
    const view = renderHook(() => useTripAdviceSession('ta_abcdefghijklmnopqrstuvwxyz123456'))
    await waitFor(() => expect(view.result.current.projection).toBeTruthy())
    vi.useFakeTimers()
    const first = view.result.current.metadata('p:1')
    const resultsPromise = Promise.all([first, view.result.current.metadata('p:1'), view.result.current.metadata('p:2')])
    await vi.runAllTimersAsync()
    const results = await resultsPromise
    expect(publicShareApi.writeV2).toHaveBeenCalledTimes(1)
    expect(publicShareApi.writeV2).toHaveBeenCalledWith(expect.any(String), 'csrf', { version: 2, kind: 'places.metadata.batch', placeKeys: ['p:1', 'p:2'] })
    expect(results[0].primaryType).toBe('Garden')
  })
})
