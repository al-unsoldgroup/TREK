import type { AdvicePlacesMetadataBatchResultV2, AdvicePlacesMetadataResultV2 } from '@trek/shared'

const BATCH_WINDOW_MS = 10
const MAX_BATCH_SIZE = 8

type Pending = {
  resolve: (value: AdvicePlacesMetadataResultV2) => void
  reject: (reason: unknown) => void
}

export function createPlaceMetadataBatcher(
  send: (placeKeys: string[]) => Promise<AdvicePlacesMetadataBatchResultV2>,
) {
  const requests = new Map<string, Promise<AdvicePlacesMetadataResultV2>>()
  const pending = new Map<string, Pending>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = Promise.resolve()

  const flush = () => {
    timer = undefined
    const keys = [...pending.keys()]
    for (let index = 0; index < keys.length; index += MAX_BATCH_SIZE) {
      const placeKeys = keys.slice(index, index + MAX_BATCH_SIZE)
      const batch = placeKeys.map(placeKey => [placeKey, pending.get(placeKey)!] as const)
      for (const placeKey of placeKeys) pending.delete(placeKey)
      inFlight = inFlight.then(async () => {
        try {
          const result = await send(placeKeys)
          const places = new Map(result.places.map(place => [place.placeKey, place]))
          for (const [placeKey, request] of batch) {
            const place = places.get(placeKey)
            if (place) request.resolve(place)
            else request.reject(new Error('Invalid place metadata response.'))
          }
        } catch (error) { for (const [, request] of batch) request.reject(error) }
      })
    }
  }

  return {
    get(placeKey: string) {
      const existing = requests.get(placeKey)
      if (existing) return existing
      const request = new Promise<AdvicePlacesMetadataResultV2>((resolve, reject) => {
        pending.set(placeKey, { resolve, reject })
        timer ??= setTimeout(flush, BATCH_WINDOW_MS)
      })
      requests.set(placeKey, request)
      return request
    },
  }
}
