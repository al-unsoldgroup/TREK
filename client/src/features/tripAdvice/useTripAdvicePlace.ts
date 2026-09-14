import { useEffect, useRef, useState } from 'react'
import type { AdvicePlacesMetadataResultV2 } from '@trek/shared'
import type { AdvicePlaceView, TripAdviceController } from './tripAdvice.types'

export function useTripAdvicePlace(controller: TripAdviceController, place: AdvicePlaceView) {
  const row = useRef<HTMLElement>(null)
  const [metadata, setMetadata] = useState<AdvicePlacesMetadataResultV2 | null>(null)
  useEffect(() => {
    setMetadata(null)
    if (!place.key.startsWith('p:') || !place.googlePlaceId || (place.primaryType && place.photoHandle)) return
    let disposed = false
    let observer: IntersectionObserver | undefined
    const load = () => {
      observer?.disconnect()
      void controller.metadata(place.key).then(value => { if (!disposed && value.placeKey === place.key) setMetadata(value) }).catch(() => { if (!disposed) setMetadata(null) })
    }
    if (!globalThis.IntersectionObserver) load()
    else if (row.current) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load() }); observer.observe(row.current) }
    return () => { disposed = true; observer?.disconnect() }
  }, [controller.metadata, place.googlePlaceId, place.key, place.photoHandle, place.primaryType])
  return { row, place: { ...place, ...(metadata?.primaryType ? { primaryType: metadata.primaryType } : {}), ...(metadata?.photoHandle ? { photoHandle: metadata.photoHandle } : {}) } }
}
