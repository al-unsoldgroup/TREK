import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  adviceNativeOwnerResponseSchema,
  adviceMapTileResultSchema,
  adviceOwnerCityAutocompleteResultSchema,
  adviceOwnerCityResolveResultSchema,
  advicePhotoResultSchema,
  advicePlacesAutocompleteResultSchema,
  advicePlacesResolveResultV2Schema,
  advicePlacesMetadataBatchResultV2Schema,
  type AdviceCommentAnchorV2,
  adviceReadResultV2Schema,
  adviceWriteResponseV2Schema,
  type AdviceActionV2,
  type AdviceNativeOwnerResponse,
  type AdviceOwnerWriteV2,
  type AdviceReadResultV2,
  type AdviceShareConfigV2,
} from '@trek/shared'
import { pluginsApi } from '../../api/client'
import { createPlaceMetadataBatcher } from './placeMetadataBatcher'
import type { AdviceSuggestionInput, AdviceSuggestionUpdateInput, RecommendationContext, TripAdviceController, VisibilityField } from './tripAdvice.types'

const PLUGIN_ID = 'trip-advice'

function nativePath(tripId: number) { return `owner/native?tripId=${encodeURIComponent(String(tripId))}` }
function daysUntil(expiresAt: string | undefined) {
  if (!expiresAt) return 30
  return Math.max(1, Math.min(90, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000)))
}
function detail(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback }
function legacyCopy(text: string) {
  const input = document.createElement('textarea')
  input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'
  document.body.appendChild(input); input.select()
  try { return typeof document.execCommand === 'function' && document.execCommand('copy') } catch { return false } finally { input.remove() }
}

/** Authenticated owner controller. The renderer only receives validated guest-safe data. */
export function useTripAdviceOwner(tripId: number): TripAdviceController {
  const [ownerState, setOwnerState] = useState<AdviceNativeOwnerResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<AdviceReadResultV2 | null>(null)
  const citySession = useRef(crypto.randomUUID())
  const active = useRef(0)

  const load = useCallback(async () => {
    const current = ++active.current
    const raw = await pluginsApi.invoke(PLUGIN_ID, nativePath(tripId))
    const next = adviceNativeOwnerResponseSchema.parse(raw)
    if (current === active.current) { setOwnerState(next); setLoading(false) }
    return next
  }, [tripId])

  const action = useCallback(async (value: AdviceActionV2) => {
    const raw = await pluginsApi.invoke(PLUGIN_ID, `owner/native/actions?tripId=${encodeURIComponent(String(tripId))}`, { method: 'POST', body: value })
    return value.kind === 'read' ? adviceReadResultV2Schema.parse(raw) : adviceWriteResponseV2Schema.parse(raw)
  }, [tripId])

  const refreshFeedback = useCallback(async () => {
    const next = await action({ version: 2, kind: 'read' })
    if ('projection' in next) setFeedback(next)
  }, [action])

  useEffect(() => {
    setLoading(true); setError(null)
    void load().catch(caught => { setError(detail(caught, 'Trip advice could not be loaded.')); setLoading(false) })
    return () => { active.current++ }
  }, [load])

  useEffect(() => {
    if (!ownerState?.config || ownerState.legacy) { setFeedback(null); return }
    void refreshFeedback().catch(caught => setError(detail(caught, 'Trip feedback could not be loaded.')))
  }, [ownerState?.config?.revision, ownerState?.legacy, refreshFeedback])

  const configure = useCallback(async (config: AdviceShareConfigV2, upgrade = false) => {
    if (!ownerState) throw new Error('Trip advice is still loading.')
    const previous = ownerState
    setOwnerState({ ...previous, draftConfig: config })
    setSaving(true); setSaveState('Saving…'); setError(null)
    const body: AdviceOwnerWriteV2 = {
      expectedRevision: previous.config?.revision ?? 0,
      config,
      enabled: previous.config?.enabled ?? true,
      expiresInDays: daysUntil(previous.config?.expiresAt),
      ...(upgrade && previous.upgradeRevision ? { upgradeToV2: { expectedLegacyHash: previous.upgradeRevision } } : {}),
    }
    try {
      const raw = await pluginsApi.invoke(PLUGIN_ID, nativePath(tripId), { method: 'PUT', body })
      const next = adviceNativeOwnerResponseSchema.parse(raw)
      setOwnerState(next); setSaveState('Saved')
      return next
    } catch (caught) {
      setOwnerState(previous); setSaveState('Not saved'); setError(detail(caught, 'Trip advice could not be saved.'))
      try { await load() } catch { /* rollback already restored the last confirmed state */ }
      throw caught
    } finally { setSaving(false) }
  }, [load, ownerState, tripId])

  const setVisibility = useCallback(async (field: VisibilityField, key: string) => {
    if (!ownerState || ownerState.legacy) return
    const values = ownerState.draftConfig[field]
    await configure({ ...ownerState.draftConfig, [field]: values.includes(key) ? values.filter(value => value !== key) : [...values, key] })
  }, [configure, ownerState])

  const setShowNotes = useCallback(async (value: boolean) => {
    if (!ownerState || ownerState.legacy) return
    await configure({ ...ownerState.draftConfig, showNotes: value })
  }, [configure, ownerState])

  const upgrade = useCallback(async () => {
    if (!ownerState?.legacy || !ownerState.upgradeRevision) return
    await configure(ownerState.draftConfig, true)
  }, [configure, ownerState])

  const copyLink = useCallback(async () => {
    try {
      let current = ownerState
      if (!current) throw new Error('Trip advice is still loading.')
      setError(null)
      if (!current.config?.token) current = await configure(current.draftConfig)
      if (!current.config?.token) throw new Error('Share link is unavailable.')
      const url = new URL(`/shared/${encodeURIComponent(current.config.token)}`, window.location.origin).href
      try { await navigator.clipboard.writeText(url) } catch (caught) { if (!legacyCopy(url)) throw caught }
      setSaveState('Link copied')
    } catch (caught) {
      setSaveState('Link not copied')
      setError(detail(caught, 'The share link could not be copied. Try again.'))
    }
  }, [configure, ownerState])

  const searchCities = useCallback(async (input: string) => {
    const query = new URLSearchParams({ tripId: String(tripId), input, sessionToken: citySession.current })
    const raw = await pluginsApi.invoke(PLUGIN_ID, `owner/cities/autocomplete?${query}`)
    return adviceOwnerCityAutocompleteResultSchema.parse(raw).suggestions
  }, [tripId])

  const addCity = useCallback(async (predictionId: string) => {
    if (!ownerState?.config || ownerState.legacy) throw new Error('Upgrade the link before adding a city.')
    setSaving(true); setSaveState('Saving…'); setError(null)
    try {
      const raw = await pluginsApi.invoke(PLUGIN_ID, 'owner/cities/resolve', { method: 'POST', body: {
        tripId, sessionToken: citySession.current, predictionId, expectedRevision: ownerState.config.revision,
      } })
      const result = adviceOwnerCityResolveResultSchema.parse(raw)
      setOwnerState(result.owner); setSaveState('Saved'); citySession.current = crypto.randomUUID()
    } catch (caught) {
      setError(detail(caught, 'City could not be added.')); setSaveState('Not saved')
      try { await load() } catch { /* retain the last confirmed response */ }
      throw caught
    } finally { setSaving(false) }
  }, [load, ownerState, tripId])

  const deleteOwnerComment = useCallback(async (id: string) => {
    await pluginsApi.invoke(PLUGIN_ID, `owner/comments/delete?tripId=${encodeURIComponent(String(tripId))}&commentId=${encodeURIComponent(id)}`, { method: 'POST' })
    await load()
  }, [load, tripId])

  const writeAction = useCallback(async (value: Exclude<AdviceActionV2, { kind: 'read' }>, confirmation: string) => {
    setError(null); setSaveState('Saving…')
    try { const result = await action(value); await Promise.all([refreshFeedback(), load()]); setSaveState(confirmation); return result }
    catch (caught) { setError(detail(caught, 'Request failed.')); setSaveState(''); throw caught }
  }, [action, load, refreshFeedback])

  const vote = useCallback(async (placeKey: string, value: -1 | 0 | 1) => {
    const expectedVersion = feedback?.votes.find(item => item.placeKey === placeKey)?.version ?? 0
    await writeAction({ version: 2, kind: 'vote.set', requestId: crypto.randomUUID(), placeKey, value, expectedVersion }, 'Vote saved.')
  }, [feedback?.votes, writeAction])
  const comment = useCallback(async (text: string, displayName?: string, anchor?: AdviceCommentAnchorV2) => {
    await writeAction({ version: 2, kind: 'comment.create', requestId: crypto.randomUUID(), text, ...(displayName ? { displayName } : {}), ...(anchor ? { anchor } : {}) }, 'Comment added.')
  }, [writeAction])
  const erase = useCallback(async () => { throw new Error('Owner feedback cannot be erased from preview.') }, [])
  const autocomplete = useCallback(async (context: RecommendationContext, input: string, searchId: string) => {
    const result = await action({ version: 2, kind: 'places.autocomplete', searchId, cityId: context.cityId, category: context.category, input, locale: navigator.language || 'en' })
    if (!('data' in result)) throw new Error('Invalid place search response.')
    return advicePlacesAutocompleteResultSchema.parse(result.data).suggestions
  }, [action])
  const resolve = useCallback(async (searchId: string, predictionId: string) => {
    const result = await action({ version: 2, kind: 'places.resolve', searchId, predictionId })
    if (!('data' in result)) throw new Error('Invalid place selection response.')
    return advicePlacesResolveResultV2Schema.parse(result.data)
  }, [action])
  const suggest = useCallback(async (input: AdviceSuggestionInput) => {
    await writeAction({ version: 2, kind: 'suggestion.create', requestId: crypto.randomUUID(), selectionId: input.selectionId, category: input.category, ...(input.dayKey ? { dayKey: input.dayKey } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(input.displayName ? { displayName: input.displayName } : {}) }, 'Recommendation added.')
  }, [writeAction])
  const updateSuggestion = useCallback(async (suggestionId: string, input: AdviceSuggestionUpdateInput) => {
    await writeAction({ version: 2, kind: 'suggestion.update', requestId: crypto.randomUUID(), suggestionId, category: input.category, ...(input.dayKey !== undefined ? { dayKey: input.dayKey } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(input.displayName ? { displayName: input.displayName } : {}), ...(input.selectionId ? { selectionId: input.selectionId } : {}) }, 'Recommendation updated.')
  }, [writeAction])
  const photo = useCallback(async (handle: string) => {
    const raw = await pluginsApi.invoke(PLUGIN_ID, `owner/native/photos?tripId=${encodeURIComponent(String(tripId))}`, { method: 'POST', body: { handle } })
    return advicePhotoResultSchema.parse(raw)
  }, [tripId])
  const mapTile = useCallback(async (dayKey: string, z: number, x: number, y: number) => {
    const result = await action({ version: 2, kind: 'map.tile', dayKey, z, x, y })
    if (!('data' in result)) throw new Error('Invalid map response.')
    return adviceMapTileResultSchema.parse(result.data)
  }, [action])
  const metadataBatcher = useMemo(() => createPlaceMetadataBatcher(async placeKeys => {
    const result = await action({ version: 2, kind: 'places.metadata.batch', placeKeys })
    if (!('data' in result)) throw new Error('Invalid place metadata response.')
    return advicePlacesMetadataBatchResultV2Schema.parse(result.data)
  }), [action])
  const metadata = useCallback((placeKey: string) => metadataBatcher.get(placeKey), [metadataBatcher])

  return {
    mode: 'owner',
    projection: ownerState?.projection ?? null,
    loading,
    error,
    status: saveState,
    erased: false,
    votes: feedback?.votes ?? [],
    comments: ownerState?.inbox.comments ?? feedback?.myComments ?? [],
    suggestions: ownerState?.inbox.suggestions ?? feedback?.myPendingSuggestions ?? [],
    vote, comment, erase, autocomplete, resolve, suggest, updateSuggestion, photo, metadata, mapTile,
    deleteComment: deleteOwnerComment,
    owner: ownerState ? {
      config: ownerState.draftConfig, saving, saveState, legacy: ownerState.legacy, upgrade,
      setVisibility, setShowNotes, copyLink, searchCities, addCity,
    } : undefined,
  }
}
