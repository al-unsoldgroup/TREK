import { useEffect, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Popup, useMap } from 'react-leaflet'
import { GridLayer, latLngBounds, type Coords, type DoneCallback } from 'leaflet'
import { adviceMapTileResultSchema } from '@trek/shared'
import { TripAdviceVotes } from './TripAdvicePlaceRow'
import type { AdvicePlaceView, TripAdviceController } from './tripAdvice.types'

function Resize({ expanded }: { expanded: boolean }) { const map = useMap(); useEffect(() => { map.invalidateSize() }, [map, expanded]); return null }
function FitBounds({ coordinateKey }: { coordinateKey: string }) {
  const map = useMap()
  useEffect(() => {
    const points = coordinateKey.split(';').map(pair => pair.split(',').map(Number) as [number, number])
    map.fitBounds(latLngBounds(points), { padding: [25, 25], maxZoom: 14 })
  }, [coordinateKey, map])
  return null
}
function MediatedTiles({ controller, dayKey }: { controller: TripAdviceController; dayKey: string }) {
  const map = useMap()
  useEffect(() => {
    let disposed = false
    const urls = new Map<HTMLElement, string>()
    class AdviceTiles extends GridLayer {
      createTile(coords: Coords, done: DoneCallback) {
        const tile = document.createElement('img'); tile.alt = ''
        void controller.mapTile(dayKey, coords.z, coords.x, coords.y).then(raw => {
          const result = adviceMapTileResultSchema.parse(raw)
          if (disposed) return
          const bytes = Uint8Array.from(atob(result.bytesBase64), char => char.charCodeAt(0))
          if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error('Invalid map tile')
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); urls.set(tile, url)
          tile.onload = () => done(undefined, tile); tile.onerror = () => done(new Error('Map tile unavailable'), tile); tile.src = url
        }).catch(() => { if (!disposed) done(new Error('Map tile unavailable'), tile) })
        return tile
      }
    }
    const layer = new AdviceTiles({ tileSize: 256, minZoom: 2, maxZoom: 17, noWrap: true, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })
    layer.on('tileunload', event => { const tile = event.tile as HTMLElement; const url = urls.get(tile); if (url) URL.revokeObjectURL(url); urls.delete(tile) })
    layer.addTo(map)
    return () => { disposed = true; layer.remove(); urls.forEach(url => URL.revokeObjectURL(url)); urls.clear() }
  }, [controller.mapTile, dayKey, map])
  return null
}
export function mapPlaceState(placeKey: string, scheduledKeys: ReadonlySet<string>) { return scheduledKeys.has(placeKey) ? 'Scheduled' : 'Under consideration' }
export default function TripAdviceMap({ controller, places, scheduledKeys, dayKey }: { controller: TripAdviceController; places: AdvicePlaceView[]; scheduledKeys: ReadonlySet<string>; dayKey: string }) {
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const hasCoordinates = places.some(place => typeof place.lat === 'number' && typeof place.lng === 'number')
  useEffect(() => { if (!container.current) return; if (!globalThis.IntersectionObserver) { setVisible(true); return } const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting))); observer.observe(container.current); return () => observer.disconnect() }, [hasCoordinates])
  const located = [...new Map(places.filter(place => typeof place.lat === 'number' && typeof place.lng === 'number').map(place => [place.key, place])).values()]
  if (!located.length) return null
  const bounds = latLngBounds(located.map(place => [place.lat!, place.lng!]))
  const coordinateKey = located.map(place => `${place.lat},${place.lng}`).join(';')
  return <div ref={container} className="ta-map" data-expanded={expanded}>
    {visible && <MapContainer bounds={bounds} boundsOptions={{ padding: [25, 25], maxZoom: 14 }} minZoom={2} maxZoom={17} scrollWheelZoom={false}>
      <MediatedTiles controller={controller} dayKey={dayKey} />
      <FitBounds coordinateKey={coordinateKey} />
      <Resize expanded={expanded} />
      {located.map(place => { const state = mapPlaceState(place.key, scheduledKeys); return <CircleMarker key={place.key} center={[place.lat!, place.lng!]} radius={8} pathOptions={{ color: state === 'Scheduled' ? 'var(--ta-color-success)' : 'var(--ta-color-warning)' }}><Popup><strong>{place.title}</strong><p>{place.primaryType}</p><p>{state}</p><TripAdviceVotes controller={controller} place={place} /></Popup></CircleMarker> })}
    </MapContainer>}
    <button type="button" className="ta-button ta-map-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Shrink map' : 'Expand map'}</button>
  </div>
}
