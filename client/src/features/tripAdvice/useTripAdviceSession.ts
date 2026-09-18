import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  adviceMapTileResultSchema,
  advicePlacesAutocompleteResultSchema,
  advicePlacesResolveResultV2Schema,
  advicePlacesMetadataBatchResultV2Schema,
  type AdviceCommentAnchorV2,
  type AdviceActionV2,
  type AdviceReadResultV2,
} from '@trek/shared'
import { publicShareApi } from '../../api/publicShare'
import { createPlaceMetadataBatcher } from './placeMetadataBatcher'
import type { AdviceSuggestionInput, AdviceSuggestionUpdateInput, RecommendationContext, TripAdviceController } from './tripAdvice.types'

const requestId = () => crypto.randomUUID()

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

/** Guest-token controller for the native Advice surface. Tokens stay inside this transport hook. */
export function useTripAdviceSession(token: string | undefined, sessionVersion?: number): TripAdviceController {
  const [read, setRead] = useState<AdviceReadResultV2 | null>(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [loading, setLoading] = useState(Boolean(token))
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [erased, setErased] = useState(false)
  const active = useRef(0)

  const refresh = useCallback(async (csrf = csrfToken) => {
    if (!token || !csrf) return
    const current = ++active.current
    const next = await publicShareApi.readV2(token, csrf)
    if (current === active.current) setRead(next)
  }, [csrfToken, token])

  useEffect(() => {
    if (!token) { setLoading(false); setError('Public advice link unavailable.'); return }
    const controller = new AbortController()
    const current = ++active.current
    setLoading(true); setError(null); setErased(false)
    void publicShareApi.createSession(token, controller.signal).then(async session => {
      const next = await publicShareApi.readV2(token, session.csrfToken, controller.signal)
      if (current !== active.current || controller.signal.aborted) return
      setCsrfToken(session.csrfToken); setRead(next); setLoading(false)
    }).catch(caught => {
      if (!controller.signal.aborted && current === active.current) {
        setError(message(caught, 'Public advice is unavailable.')); setLoading(false)
      }
    })
    return () => { controller.abort(); active.current++ }
  }, [sessionVersion, token])

  const write = useCallback(async (action: Exclude<AdviceActionV2, { kind: 'read' }>, confirmation: string) => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    setError(null); setStatus('Saving…')
    try {
      const result = await publicShareApi.writeV2(token, csrfToken, action)
      if (action.kind !== 'session.erase') await refresh()
      setStatus(confirmation)
      return result
    } catch (caught) {
      const detail = message(caught, 'Request failed.')
      setError(detail); setStatus('')
      throw caught
    }
  }, [csrfToken, refresh, token])

  const vote = useCallback(async (placeKey: string, value: -1 | 0 | 1) => {
    const expectedVersion = read?.votes.find(item => item.placeKey === placeKey)?.version ?? 0
    await write({ version: 2, kind: 'vote.set', requestId: requestId(), placeKey, value, expectedVersion }, 'Vote saved.')
  }, [read?.votes, write])

  const comment = useCallback(async (text: string, displayName?: string, anchor?: AdviceCommentAnchorV2) => {
    await write({ version: 2, kind: 'comment.create', requestId: requestId(), text, ...(displayName ? { displayName } : {}), ...(anchor ? { anchor } : {}) }, 'Comment added.')
  }, [write])

  const deleteComment = useCallback(async (commentId: string) => {
    await write({ version: 2, kind: 'comment.delete', requestId: requestId(), commentId }, 'Comment deleted.')
  }, [write])

  const erase = useCallback(async () => {
    await write({ version: 2, kind: 'session.erase', requestId: requestId() }, 'Feedback erased.')
    setRead(null); setErased(true); setCsrfToken('')
  }, [write])

  const autocomplete = useCallback(async (context: RecommendationContext, input: string, searchId: string) => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    const result = await publicShareApi.writeV2(token, csrfToken, {
      version: 2, kind: 'places.autocomplete', searchId, cityId: context.cityId,
      category: context.category, input, locale: navigator.language || 'en',
    })
    return advicePlacesAutocompleteResultSchema.parse(result.data).suggestions
  }, [csrfToken, token])

  const resolve = useCallback(async (searchId: string, predictionId: string) => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    const result = await publicShareApi.writeV2(token, csrfToken, { version: 2, kind: 'places.resolve', searchId, predictionId })
    return advicePlacesResolveResultV2Schema.parse(result.data)
  }, [csrfToken, token])

  const suggest = useCallback(async (input: AdviceSuggestionInput) => {
    await write({
      version: 2, kind: 'suggestion.create', requestId: requestId(), selectionId: input.selectionId,
      category: input.category, ...(input.dayKey ? { dayKey: input.dayKey } : {}),
      ...(input.reason ? { reason: input.reason } : {}), ...(input.displayName ? { displayName: input.displayName } : {}),
    }, 'Recommendation added.')
  }, [write])

  const updateSuggestion = useCallback(async (suggestionId: string, input: AdviceSuggestionUpdateInput) => {
    await write({
      version: 2, kind: 'suggestion.update', requestId: requestId(), suggestionId,
      category: input.category, ...(input.dayKey !== undefined ? { dayKey: input.dayKey } : {}),
      ...(input.reason ? { reason: input.reason } : {}), ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.selectionId ? { selectionId: input.selectionId } : {}),
    }, 'Recommendation updated.')
  }, [write])

  const photo = useCallback(async (handle: string) => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    return publicShareApi.photo(token, handle, csrfToken)
  }, [csrfToken, token])

  const metadataBatcher = useMemo(() => createPlaceMetadataBatcher(async placeKeys => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    const result = await publicShareApi.writeV2(token, csrfToken, { version: 2, kind: 'places.metadata.batch', placeKeys })
    return advicePlacesMetadataBatchResultV2Schema.parse(result.data)
  }), [csrfToken, token])
  const metadata = useCallback((placeKey: string) => metadataBatcher.get(placeKey), [metadataBatcher])

  const mapTile = useCallback(async (dayKey: string, z: number, x: number, y: number) => {
    if (!token || !csrfToken) throw new Error('Public advice session unavailable.')
    const result = await publicShareApi.writeV2(token, csrfToken, { version: 2, kind: 'map.tile', dayKey, z, x, y })
    return adviceMapTileResultSchema.parse(result.data)
  }, [csrfToken, token])

  return {
    mode: 'guest', projection: read?.projection ?? null, loading, error, status, erased,
    votes: read?.votes ?? [], comments: read?.myComments ?? [], suggestions: read?.myPendingSuggestions ?? [],
    vote, comment, deleteComment, erase, autocomplete, resolve, suggest, updateSuggestion, photo, metadata, mapTile,
  }
}
