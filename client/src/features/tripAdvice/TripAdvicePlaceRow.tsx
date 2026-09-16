import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { advicePhotoResultSchema } from '@trek/shared'
import type { AdvicePlaceView, TripAdviceController, VisibilityField } from './tripAdvice.types'
import { useTripAdvicePlace } from './useTripAdvicePlace'

export function safeAdviceUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export function Visibility({ controller, field, itemKey, label }: { controller: TripAdviceController; field: VisibilityField; itemKey: string; label: string }) {
  const owner = controller.mode === 'owner' ? controller.owner : undefined
  if (!owner) return null
  const hidden = owner.config[field].includes(itemKey)
  return <button type="button" className="ta-icon" disabled={owner.saving || owner.legacy} aria-label={`${hidden ? 'Show' : 'Hide'} ${label}`} aria-pressed={hidden} onClick={event => { event.preventDefault(); event.stopPropagation(); void owner.setVisibility(field, itemKey) }}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
}
export function TripAdviceVotes({ controller, place }: { controller: TripAdviceController; place: AdvicePlaceView }) {
  const [busy, setBusy] = useState(false)
  const vote = controller.votes.find(item => item.placeKey === place.key)
  async function choose(value: -1 | 1) { setBusy(true); try { await controller.vote(place.key, vote?.mine === value ? 0 : value) } finally { setBusy(false) } }
  return <div className="ta-votes">{([1, -1] as const).map(value => <button type="button" className="ta-button" key={value} disabled={busy || controller.readonly} aria-label={`${value === 1 ? 'Upvote' : 'Downvote'} ${place.title}`} aria-pressed={vote?.mine === value} onClick={() => void choose(value)}>{value === 1 ? <ArrowUp size={15} /> : <ArrowDown size={15} />}{value === 1 ? vote?.positive || 0 : vote?.negative || 0}</button>)}</div>
}
export function TripAdvicePhoto({ controller, place }: { controller: TripAdviceController; place: Pick<AdvicePlaceView, 'title' | 'photoHandle'> }) {
  const [photo, setPhoto] = useState<{ url: string; source: string; authors: { displayName: string; uri: string }[] } | null>(null)
  useEffect(() => {
    let cancelled = false; let objectUrl: string | undefined
    setPhoto(null)
    if (!place.photoHandle) return
    void controller.photo(place.photoHandle).then(raw => {
      const parsed = advicePhotoResultSchema.safeParse(raw)
      if (cancelled || !parsed.success || parsed.data.state !== 'available') return
      const result = parsed.data
      if (!result.bytesBase64 || !result.mimeType || !result.googleMapsUri || !safeAdviceUrl(result.googleMapsUri)) return
      const bytes = Uint8Array.from(atob(result.bytesBase64), char => char.charCodeAt(0))
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
      setPhoto({ url: objectUrl, source: result.googleMapsUri, authors: result.authors })
    }).catch(() => { if (!cancelled) setPhoto(null) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [controller.photo, place.photoHandle])
  if (!photo) return null
  return <figure className="ta-photo"><img src={photo.url} alt={place.title} /><figcaption><span translate="no">Google Maps</span> · <a href={photo.source} target="_blank" rel="noopener noreferrer">Photo source</a>{photo.authors.map(author => <a key={author.uri} href={safeAdviceUrl(author.uri)} target="_blank" rel="noopener noreferrer"> {author.displayName}</a>)}</figcaption></figure>
}
export default function TripAdvicePlaceRow({ controller, place: source, idea = false, assignmentKey, assignmentTime, idPrefix = 'ta-place' }: { controller: TripAdviceController; place: AdvicePlaceView; idea?: boolean; assignmentKey?: string; assignmentTime?: string | null; idPrefix?: string }) {
  const { row, place } = useTripAdvicePlace(controller, source)
  const field = idea ? 'hiddenIdeaKeys' : 'hiddenPlaceKeys'
  const visibilityKey = assignmentKey && !controller.owner?.config.hiddenPlaceKeys.includes(place.key) ? assignmentKey : place.key
  const hidden = controller.mode === 'owner' && controller.owner?.config[field].includes(visibilityKey)
  return <article ref={row} id={`${idPrefix}-${visibilityKey}`} data-place-key={place.key} tabIndex={-1} className={`ta-place${hidden ? ' ta-hidden' : ''}`}><TripAdvicePhoto controller={controller} place={place} /><div className="ta-place-copy">{assignmentTime && <time className="ta-assignment-time" dateTime={assignmentTime}>{assignmentTime}</time>}<a href={safeAdviceUrl(place.mapsUrl)} target="_blank" rel="noopener noreferrer">{place.title}</a><p className="ta-meta">{[place.primaryType, place.locality, assignmentKey ? 'Scheduled' : idea ? 'Under consideration' : ''].filter(Boolean).join(' · ')}</p></div><TripAdviceVotes controller={controller} place={place} /><Visibility controller={controller} field={field} itemKey={visibilityKey} label={place.title} /></article>
}
