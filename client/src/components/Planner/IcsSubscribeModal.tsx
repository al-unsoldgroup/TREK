import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Calendar, Power } from 'lucide-react'
import { SubscribeLinks } from './SubscribeLinks'

interface IcsSubscribeModalProps {
  /** Token endpoint base, e.g. `/api/trips/123/feed` or `/api/feed/user`. */
  endpoint: string
  title: string
  description: string
  /** Show the history-window / detail pickers. All-trips feed only — the
   *  per-trip feed has one trip and always emits it in full. */
  scopeOptions?: boolean
  onClose: () => void
}

// `history` values map to the server's `?history=` param: a day count, or `all`
// for no cutoff. `detail=trips` collapses each trip to its all-day span.
const HISTORY_CHOICES = [
  { value: '90', label: 'Last 90 days' },
  { value: '730', label: 'Last 2 years' },
  { value: 'all', label: 'Everything' },
]
const DETAIL_CHOICES = [
  { value: 'full', label: 'Full itinerary' },
  { value: 'trips', label: 'Trips only' },
]

// A server that has no APP_URL configured hands back a host-relative path; the
// webcal:// handoff and Google deep link need an absolute URL, so resolve it
// against the current origin as a fallback.
function absolutize(url: string): string {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('/')) return window.location.origin + url
  return url
}

/**
 * Shared subscribe dialog for the per-trip and all-trips ICS feeds. Opening it
 * only *reads* the current token — it never mints one silently. The user
 * explicitly enables the public link, and can rotate or fully turn it off.
 */
export function IcsSubscribeModal({ endpoint, title, description, scopeOptions, onClose }: IcsSubscribeModalProps) {
  const tokenUrl = `${endpoint}/token`
  const [feedUrl, setFeedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState('90')
  const [detail, setDetail] = useState('full')

  // The picks travel in the subscription URL, not in server state — a calendar
  // client stores this URL and re-fetches it verbatim on every refresh. Only
  // non-defaults are appended so the common link stays clean.
  const query = scopeOptions
    ? [history !== '90' ? `history=${history}` : '', detail !== 'full' ? `detail=${detail}` : '']
        .filter(Boolean).join('&')
    : ''
  const baseUrl = feedUrl ? absolutize(feedUrl) : ''
  const httpsUrl = baseUrl && query ? `${baseUrl}?${query}` : baseUrl
  const webcalUrl = httpsUrl ? httpsUrl.replace(/^https?:\/\//, 'webcal://') : ''

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(tokenUrl, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json() as { feed_url: string | null }
        setFeedUrl(data.feed_url)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [tokenUrl])

  useEffect(() => { load() }, [load])

  const mutate = async (method: 'POST' | 'PUT' | 'DELETE') => {
    setBusy(true)
    try {
      const res = await fetch(tokenUrl, { method, credentials: 'include' })
      if (res.ok) {
        const data = await res.json() as { feed_url: string | null }
        setFeedUrl(data.feed_url)
      }
    } catch { /* ignore */ }
    setBusy(false)
  }

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-card, white)',
        borderRadius: 14,
        padding: '22px 24px',
        width: '100%',
        maxWidth: 420,
        boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
        border: '1px solid var(--border-faint)',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        position: 'relative',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={16} strokeWidth={2} style={{ color: 'var(--accent, #6366f1)' }} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              color: 'var(--text-muted)', borderRadius: 6, display: 'flex',
            }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          {description}
        </p>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)', fontSize: 12 }}>
            Loading…
          </div>
        ) : !feedUrl ? (
          <>
            <button
              onClick={() => mutate('POST')}
              disabled={busy}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                width: '100%', padding: '9px 14px', borderRadius: 9, border: 'none',
                background: 'var(--accent, #6366f1)', color: 'var(--accent-text, #fff)',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
              }}
            >
              <Calendar size={14} strokeWidth={2} />
              Enable calendar subscription
            </button>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
              Creates a secret link anyone with it can read without logging in. You can turn it off anytime.
            </p>
          </>
        ) : (
          <>
            {scopeOptions && (
              <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ChoiceRow
                  label="Past trips"
                  choices={HISTORY_CHOICES}
                  value={history}
                  onChange={setHistory}
                />
                <ChoiceRow
                  label="Include"
                  choices={DETAIL_CHOICES}
                  value={detail}
                  onChange={setDetail}
                />
                <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                  “Trips only” puts a single all-day event per trip on your calendar instead of
                  every activity and booking — the readable choice for a long travel history.
                  Archived trips are always excluded.
                </p>
              </div>
            )}

            <SubscribeLinks httpsUrl={httpsUrl} webcalUrl={webcalUrl} />

            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-faint)', display: 'flex', gap: 8 }}>
              <button
                onClick={() => mutate('PUT')}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'none', border: '1px solid var(--border-primary)',
                  borderRadius: 7, padding: '5px 10px',
                  fontSize: 11, color: 'var(--text-muted)',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
                }}
              >
                <RefreshCw size={11} strokeWidth={2} style={{ animation: busy ? 'spin 0.8s linear infinite' : 'none' }} />
                Regenerate
              </button>
              <button
                onClick={() => mutate('DELETE')}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'none', border: '1px solid var(--border-primary)',
                  borderRadius: 7, padding: '5px 10px',
                  fontSize: 11, color: 'var(--danger, #dc2626)',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
                }}
              >
                <Power size={11} strokeWidth={2} />
                Turn off
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
              Regenerating creates a new link and invalidates the old one. Turning off disables the link entirely.
            </p>
          </>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>,
  document.body
  )
}

/** Labelled segmented picker for the all-trips feed's scope knobs. */
function ChoiceRow({ label, choices, value, onChange }: {
  label: string
  choices: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, minWidth: 62 }}>
        {label}
      </span>
      <div role="group" aria-label={label} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {choices.map(c => {
          const on = c.value === value
          return (
            <button
              key={c.value}
              onClick={() => onChange(c.value)}
              aria-pressed={on}
              style={{
                padding: '4px 9px', borderRadius: 7, fontSize: 11, fontFamily: 'inherit',
                cursor: 'pointer',
                border: `1px solid ${on ? 'var(--accent, #6366f1)' : 'var(--border-primary)'}`,
                background: on ? 'var(--accent, #6366f1)' : 'none',
                color: on ? 'var(--accent-text, #fff)' : 'var(--text-muted)',
                fontWeight: on ? 600 : 400,
              }}
            >
              {c.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
