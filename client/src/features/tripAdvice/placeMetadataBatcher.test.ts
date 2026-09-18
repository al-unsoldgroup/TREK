import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaceMetadataBatcher } from './placeMetadataBatcher'

describe('place metadata batcher', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces unique requests into bounded batches and resolves each place', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async (placeKeys: string[]) => ({
      places: placeKeys.map(placeKey => ({ placeKey, primaryType: `Type ${placeKey}` })),
    }))
    const batcher = createPlaceMetadataBatcher(send)

    const first = batcher.get('p:1')
    expect(batcher.get('p:1')).toBe(first)
    const requests = [first, ...Array.from({ length: 8 }, (_, index) => batcher.get(`p:${index + 2}`))]

    await vi.runAllTimersAsync()
    await expect(Promise.all(requests)).resolves.toHaveLength(9)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toEqual(['p:1', 'p:2', 'p:3', 'p:4', 'p:5', 'p:6', 'p:7', 'p:8'])
    expect(send.mock.calls[1]?.[0]).toEqual(['p:9'])
  })

  it('rejects the matching caller when a valid batch omits its place', async () => {
    vi.useFakeTimers()
    const batcher = createPlaceMetadataBatcher(async () => ({ places: [] }))
    const request = batcher.get('p:1').catch(error => error)
    await vi.runAllTimersAsync()
    expect(await request).toEqual(new Error('Invalid place metadata response.'))
  })

  it('waits for one chunk before dispatching the next', async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve })
    const send = vi.fn(async (placeKeys: string[]) => {
      if (placeKeys[0] === 'p:1') await firstPending
      return { places: placeKeys.map(placeKey => ({ placeKey })) }
    })
    const batcher = createPlaceMetadataBatcher(send)
    const requests = Array.from({ length: 9 }, (_, index) => batcher.get(`p:${index + 1}`))

    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.resolve()
    await Promise.all(requests)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
