import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TripAdviceController } from './tripAdvice.types'
import TripAdviceMap from './TripAdviceMap'

const leafletMap = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  getContainer: vi.fn(),
  invalidateSize: vi.fn(),
}))

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MapContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Popup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMap: () => leafletMap,
}))

vi.mock('leaflet', () => {
  class GridLayer {
    on() { return this }
    addTo() { return this }
    remove() {}
  }
  const bounds = { pad: () => bounds }
  return { GridLayer, latLngBounds: () => bounds }
})

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('Trip Advice day map', () => {
  it('invalidates Leaflet after the expand transition finishes', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const wrapper = document.createElement('div')
    wrapper.className = 'ta-map'
    const mapContainer = document.createElement('div')
    wrapper.append(mapContainer)
    leafletMap.getContainer.mockReturnValue(mapContainer)
    const controller = { mapTile: vi.fn(), votes: [], vote: vi.fn() } as unknown as TripAdviceController
    const place = { key: 'p:1', title: 'Garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: '', lat: 35, lng: 139 }

    render(<TripAdviceMap controller={controller} places={[place]} scheduledKeys={new Set([place.key])} dayKey="d:1" />)
    await waitFor(() => expect(leafletMap.invalidateSize).toHaveBeenCalled())
    leafletMap.invalidateSize.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Expand map' }))
    await waitFor(() => expect(leafletMap.invalidateSize).toHaveBeenCalled())
    leafletMap.invalidateSize.mockClear()
    fireEvent.transitionEnd(wrapper, { propertyName: 'height' })

    expect(leafletMap.invalidateSize).toHaveBeenCalledOnce()
  })
})
