import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adviceActionSchema,
  type AdviceAction,
  type AdviceBootstrap,
  type AdviceProjection,
  type AdviceReadResult,
  type AdviceWriteResponse,
} from '@trek/shared'
import { useTranslation } from '../../i18n'
import { publicShareApi, type PublicShareSession } from '../../api/publicPluginShare'
import ErrorBoundary from '../shared/ErrorBoundary'

interface PublicPluginFrameProps {
  token: string
  bootstrap: AdviceBootstrap
}

type PublicMessage =
  | { type: 'trek:public:ready'; version: 1 }
  | { type: 'trek:public:action'; id: string; action: AdviceAction }
  | { type: 'trek:public:photo'; id: string; handle: string }
  | { type: 'trek:public:openMaps'; placeKeyOrSelectionId: string }
  | { type: 'trek:public:openAttribution'; uri: string }

const messageKeys: Record<PublicMessage['type'], string[]> = {
  'trek:public:ready': ['type', 'version'],
  'trek:public:action': ['type', 'id', 'action'],
  'trek:public:photo': ['type', 'id', 'handle'],
  'trek:public:openMaps': ['type', 'placeKeyOrSelectionId'],
  'trek:public:openAttribution': ['type', 'uri'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^public-[1-9][0-9]{0,5}$/.test(value)
}

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9:_-]+$/.test(value)
}

function googleMapsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.host !== 'www.google.com' || !url.pathname.startsWith('/maps/search/') || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function isHttpsUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function newChannelNonce(): string {
  return globalThis.crypto?.randomUUID?.() ?? `public-${Math.random().toString(36).slice(2, 14)}`
}

function parseMessage(value: unknown): PublicMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !(value.type in messageKeys)) return null
  const type = value.type as PublicMessage['type']
  if (!hasExactKeys(value, messageKeys[type])) return null
  if (type === 'trek:public:ready' && value.version === 1) return value as PublicMessage
  if (type === 'trek:public:action' && isRequestId(value.id)) {
    const action = adviceActionSchema.safeParse(value.action)
    return action.success ? { ...value, action: action.data } as PublicMessage : null
  }
  if (type === 'trek:public:photo' && isRequestId(value.id)) return value as PublicMessage
  if (type === 'trek:public:openMaps' && isOpaqueHandle(value.placeKeyOrSelectionId)) return value as PublicMessage
  if (type === 'trek:public:openAttribution' && isHttpsUri(value.uri)) return value as PublicMessage
  return null
}

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function publicTheme() {
  const root = document.documentElement
  return {
    background: token('--bg-primary', '#ffffff'),
    surface: token('--bg-card', '#ffffff'),
    text: token('--text-primary', '#111827'),
    muted: token('--text-muted', '#6b7280'),
    accent: token('--accent', '#111827'),
    border: token('--border-primary', '#e5e7eb'),
    mode: root.classList.contains('dark') ? 'dark' : 'light',
  }
}

function mapUrlFor(projection: AdviceProjection | null, resolved: ReadonlyMap<string, string>, key: string): string | null {
  const resolvedUrl = resolved.get(key)
  if (resolvedUrl) return resolvedUrl
  if (!projection) return null
  const places = projection.stays.flatMap((stay) => stay.days.flatMap((day) => day.schedule.map((row) => row.place)))
  places.push(...projection.shortlists.flatMap((list) => [...list.see, ...list.eat]))
  const place = places.find((candidate) => candidate.key === key)
  return place ? googleMapsUrl(place.mapsUrl) : null
}

function resolvedMapUrl(action: AdviceAction, result: AdviceWriteResponse): [string, string] | null {
  if (action.kind !== 'places.resolve' || !isRecord(result.data)) return null
  const selectionId = result.data.selectionId
  const place = isRecord(result.data.place) ? result.data.place : null
  const mapsUrl = googleMapsUrl(result.data.mapsUrl ?? place?.mapsUrl)
  return isOpaqueHandle(selectionId) && mapsUrl ? [selectionId, mapsUrl] : null
}

/**
 * Public advice host. It is intentionally not a variation of PluginFrame:
 * there is no member context, generic RPC, sessionStorage, WebSocket forwarding,
 * or credential-bearing plugin route in this frame.
 */
export default function PublicPluginFrame({ token: shareToken, bootstrap }: PublicPluginFrameProps) {
  const { locale, t } = useTranslation()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const loadsRef = useRef(0)
  const blockedRef = useRef(false)
  const projectionRef = useRef<AdviceProjection | null>(null)
  const resolvedMapsRef = useRef(new Map<string, string>())
  const sessionRef = useRef<PublicShareSession | null>(null)
  const sessionTokenRef = useRef<string | null>(null)
  const sessionPromiseRef = useRef<Promise<PublicShareSession> | null>(null)
  const actionCountRef = useRef(0)
  const requestIdsRef = useRef(new Set<string>())
  const pendingIdsRef = useRef(new Set<string>())
  const abortRef = useRef<AbortController | null>(null)
  const nonceRef = useRef(newChannelNonce())
  const [blocked, setBlocked] = useState(false)
  const [mapFallbackUrl, setMapFallbackUrl] = useState<string | null>(null)

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const cancelPending = useCallback(() => {
    pendingIdsRef.current.forEach((id) => post({ type: 'trek:public:error', nonce: nonceRef.current, id, message: t('common.error') }))
    pendingIdsRef.current.clear()
  }, [post, t])

  useEffect(() => {
    loadsRef.current = 0
    blockedRef.current = false
    projectionRef.current = null
    resolvedMapsRef.current.clear()
    sessionRef.current = null
    sessionTokenRef.current = null
    sessionPromiseRef.current = null
    actionCountRef.current = 0
    requestIdsRef.current.clear()
    pendingIdsRef.current.clear()
    nonceRef.current = newChannelNonce()
    setBlocked(false)
    setMapFallbackUrl(null)
  }, [shareToken])

  const context = useCallback(() => ({
    type: 'trek:public:context',
    version: 1,
    nonce: nonceRef.current,
    plugin: { id: bootstrap.plugin.id, protocolVersion: bootstrap.plugin.protocolVersion },
    title: bootstrap.title,
    expiresAt: bootstrap.expiresAt,
    locale,
    dir: document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr',
    theme: publicTheme(),
  }), [bootstrap, locale])

  const ensureSession = useCallback(() => {
    if (sessionTokenRef.current !== shareToken) {
      sessionRef.current = null
      sessionPromiseRef.current = null
      sessionTokenRef.current = shareToken
    }
    if (sessionRef.current) return Promise.resolve(sessionRef.current)
    if (!sessionPromiseRef.current) {
      const controller = abortRef.current
      if (!controller) return Promise.reject(new Error('Public advice frame closed.'))
      const tracked: Promise<PublicShareSession> = publicShareApi.createSession(shareToken, controller.signal)
        .then((session) => {
          if (sessionTokenRef.current === shareToken) sessionRef.current = session
          if (sessionPromiseRef.current === tracked) sessionPromiseRef.current = null
          return session
        })
        .catch((error: unknown) => {
          if (sessionPromiseRef.current === tracked) sessionPromiseRef.current = null
          throw error
        })
      sessionPromiseRef.current = tracked
    }
    return sessionPromiseRef.current
  }, [shareToken])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const controller = new AbortController()
    abortRef.current = controller
    let active = true

    const fail = (id: string, message = t('common.error')) => {
      if (active && !blockedRef.current) post({ type: 'trek:public:error', nonce: nonceRef.current, id, message })
    }

    const onMessage = (event: MessageEvent) => {
      if (!active || blockedRef.current || event.source !== frame.contentWindow) return
      const message = parseMessage(event.data)
      if (!message) return
      if (message.type === 'trek:public:ready') {
        post(context())
        void ensureSession().catch(() => undefined)
        return
      }
      if (message.type === 'trek:public:openMaps') {
        const url = mapUrlFor(projectionRef.current, resolvedMapsRef.current, message.placeKeyOrSelectionId)
        if (url) {
          setMapFallbackUrl(null)
          if (!window.open(url, '_blank', 'noopener,noreferrer')) setMapFallbackUrl(url)
        }
        return
      }
      if (message.type === 'trek:public:openAttribution') {
        // `parseMessage` permits only a bounded credential-free HTTPS URL. Open
        // it from this user-initiated message turn, never from plugin markup.
        window.open(message.uri, '_blank', 'noopener,noreferrer')
        return
      }
      if (message.type === 'trek:public:photo') {
        if (requestIdsRef.current.has(message.id)) {
          fail(message.id)
          return
        }
        requestIdsRef.current.add(message.id)
        if (actionCountRef.current >= 4) {
          fail(message.id)
          return
        }
        actionCountRef.current += 1
        pendingIdsRef.current.add(message.id)
        void ensureSession()
          .then((session) => publicShareApi.photo(shareToken, message.handle, session.csrfToken, controller.signal))
          .then((result) => {
            if (active && !blockedRef.current) post({ type: 'trek:public:result', nonce: nonceRef.current, id: message.id, result })
          })
          .catch(() => {
            if (active) fail(message.id, t('memories.error.loadPhotos'))
          }).finally(() => {
          pendingIdsRef.current.delete(message.id)
          actionCountRef.current -= 1
        })
        return
      }
      if (requestIdsRef.current.has(message.id)) {
        fail(message.id)
        return
      }
      requestIdsRef.current.add(message.id)
      if (actionCountRef.current >= 4) {
        fail(message.id)
        return
      }
      actionCountRef.current += 1
      pendingIdsRef.current.add(message.id)
      void ensureSession()
        .then((session) => publicShareApi.action(shareToken, session.csrfToken, message.action, controller.signal))
        .then((result) => {
          if (!active || blockedRef.current) return
          if ('projection' in result) {
            projectionRef.current = result.projection
          } else {
            const map = resolvedMapUrl(message.action, result)
            if (map) {
              resolvedMapsRef.current.set(map[0], map[1])
              if (resolvedMapsRef.current.size > 64) {
                const oldest = resolvedMapsRef.current.keys().next().value
                if (typeof oldest === 'string') resolvedMapsRef.current.delete(oldest)
              }
            }
            if (message.action.kind === 'session.erase') sessionRef.current = null
          }
          post({ type: 'trek:public:result', nonce: nonceRef.current, id: message.id, result })
        })
        .catch(() => {
          if (active) {
            sessionRef.current = null
            fail(message.id)
          }
        })
        .finally(() => {
          pendingIdsRef.current.delete(message.id)
          actionCountRef.current -= 1
        })
    }

    window.addEventListener('message', onMessage)
    return () => {
      active = false
      cancelPending()
      resolvedMapsRef.current.clear()
      controller.abort()
      if (abortRef.current === controller) abortRef.current = null
      window.removeEventListener('message', onMessage)
    }
  }, [cancelPending, context, ensureSession, post, shareToken, t])

  const onLoad = () => {
    loadsRef.current += 1
    if (loadsRef.current > 1) {
      blockedRef.current = true
      setBlocked(true)
      cancelPending()
      abortRef.current?.abort()
      return
    }
    post(context())
  }

  return (
    <ErrorBoundary boundaryId="public-plugin-frame" label={bootstrap.title} resetKeys={[shareToken]}>
      <div className="relative h-full w-full overflow-hidden bg-surface">
        <iframe
          ref={frameRef}
          src={`/plugin-frame/${bootstrap.plugin.id}/${bootstrap.plugin.entry}`}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          loading="eager"
          title={bootstrap.title}
          onLoad={onLoad}
          className="block h-full w-full border-0"
          style={{ display: blocked ? 'none' : 'block' }}
        />
        {mapFallbackUrl && !blocked && (
          <div className="absolute bottom-4 left-4 right-4 flex justify-center rounded-lg border border-edge bg-surface p-2 shadow-lg">
            <a href={mapFallbackUrl} target="_blank" rel="noopener noreferrer" className="rounded-md bg-accent px-3 py-2 text-sm text-accent-text">
              {t('common.open')}
            </a>
          </div>
        )}
        {blocked && <div role="alert" className="flex h-full items-center justify-center bg-surface p-6 text-center text-content-muted">{t('plugins.frameLoadFailed')}</div>}
      </div>
    </ErrorBoundary>
  )
}
