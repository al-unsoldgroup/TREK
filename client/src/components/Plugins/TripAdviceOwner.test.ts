import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

const addon = resolve(process.cwd(), '../plugins/trip-advice/client')
const source = (name: string) => readFileSync(resolve(addon, name), 'utf8')
const projection = { version: 1, revision: 'a'.repeat(64), title: 'Test trip', cities: [], stays: [], shortlists: [] }

function mountOwner() {
  document.body.innerHTML = source('index.html').match(/<body>([\s\S]*?)<\/body>/)?.[1] || ''
  Element.prototype.scrollIntoView = vi.fn()
  const handlers = new Map<string, (event?: unknown) => void>()
  const calls: Array<{ sub: string; method: string; body: Record<string, unknown> }> = []
  let failPreview = false
  const parent = { postMessage(message: { type: string; requestId: string; sub: string; method: string; body: Record<string, unknown> }) {
    if (message.type === 'trek:context:request') handlers.get('message')?.({ source: parent, data: { type: 'trek:context', tripId: 158 } })
    if (message.type !== 'trek:invoke') return
    calls.push(message)
    queueMicrotask(() => {
      const preview = message.sub.includes('/preview?')
      const data = preview ? projection : message.method === 'PUT'
        ? { enabled: true, revision: 1, expiresAt: '2099-01-01T00:00:00Z' }
        : { config: null, candidates: { days: [], schedule: [], shortlist: [], preset: { version: 1, source: 'trip', publicTitle: 'Test trip', cities: [], stays: [], schedule: [], shortlist: [], hidden: { cityIds: [], dayIds: [], placeIds: [], assignmentIds: [] } } }, inbox: { comments: [], suggestions: [] } }
      handlers.get('message')?.({ source: parent, data: preview && failPreview
        ? { type: 'trek:error', requestId: message.requestId, message: 'Preview request failed' }
        : { type: 'trek:result', requestId: message.requestId, data } })
    })
  } }
  const context = vm.createContext({ document, parent, URL, console, navigator: { language: 'en-US' }, location: { href: 'https://trek.test/trips/158' }, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: (name: string, handler: (event?: unknown) => void) => handlers.set(name, handler) })
  vm.runInContext('window = globalThis', context)
  for (const name of ['advice-model.js', 'advice-protocol.js', 'advice-owner.js', 'advice-guest-template.js', 'advice-preview.js', 'advice.js']) vm.runInContext(source(name), context)
  handlers.get('DOMContentLoaded')?.()
  return { calls, setPreviewFailure(value: boolean) { failPreview = value } }
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('a refreshed real guest preview permits the owner to save', async () => {
  const { calls } = mountOwner()
  await waitFor(() => expect(document.getElementById('preview-status')?.textContent).toContain('Review the guest page'))
  document.getElementById('preview-button')?.click()
  await waitFor(() => expect(calls.filter(call => call.sub.includes('/preview?'))).toHaveLength(2))
  await waitFor(() => expect((document.getElementById('preview-button') as HTMLButtonElement).disabled).toBe(false))
  document.getElementById('publish-button')?.click()
  await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true))
  expect(calls.find(call => call.method === 'PUT')?.body.previewRevision).toBe(projection.revision)
})

it('saving after a failed preview retries the current preview and preserves the real error if it still fails', async () => {
  const view = mountOwner()
  await waitFor(() => expect(document.getElementById('preview-status')?.textContent).toContain('Review the guest page'))
  view.setPreviewFailure(true)
  document.getElementById('preview-button')?.click()
  await waitFor(() => expect(document.getElementById('owner-error')?.textContent).toBe('Preview request failed'))
  document.getElementById('publish-button')?.click()
  await waitFor(() => expect(view.calls.filter(call => call.sub.includes('/preview?'))).toHaveLength(3))
  expect(view.calls.some(call => call.method === 'PUT')).toBe(false)
  expect(document.getElementById('owner-error')?.textContent).toBe('Preview request failed')
  view.setPreviewFailure(false)
  await waitFor(() => expect((document.getElementById('publish-button') as HTMLButtonElement).disabled).toBe(false))
  document.getElementById('publish-button')?.click()
  await waitFor(() => expect(view.calls.some(call => call.method === 'PUT')).toBe(true))
})
