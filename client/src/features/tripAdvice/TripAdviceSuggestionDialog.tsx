import { useEffect, useId, useRef, useState } from 'react'
import Modal from '../../components/shared/Modal'
import type { AdvicePlacePrediction } from '@trek/shared'
import type { AdviceSelection, RecommendationDialogContext, TripAdviceController } from './tripAdvice.types'
import { TripAdvicePhoto } from './TripAdvicePlaceRow'
import { dayLabel } from './tripAdvice.day'

export default function TripAdviceSuggestionDialog({ controller, context, close, inline = false }: { controller: TripAdviceController; context: RecommendationDialogContext; close(): void; inline?: boolean }) {
  const [query, setQuery] = useState(context.suggestion?.title || ''); const [category, setCategory] = useState(context.category)
  const [cityId, setCityId] = useState(context.cityId); const [note, setNote] = useState(context.suggestion?.reason || ''); const [name, setName] = useState(context.suggestion?.displayName || '')
  const [dayKey, setDayKey] = useState(context.dayKey || '')
  const days = controller.projection?.stays.filter(stay => stay.cityId === cityId).flatMap(stay => stay.days) || []
  const [showNote, setShowNote] = useState(Boolean(context.full)); const [results, setResults] = useState<AdvicePlacePrediction[]>([])
  const [selection, setSelection] = useState<AdviceSelection | null>(context.suggestion ? { selectionId: '', place: context.suggestion } : null); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const id = useId()
  const searchId = useRef(crypto.randomUUID()); const serial = useRef(0); const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement; input.current?.focus(); return () => { serial.current++; if (previous instanceof HTMLElement && previous.isConnected) previous.focus() } }, [])
  async function search() {
    const current = ++serial.current; if (query.trim().length < 2) return
    setBusy(true); setError('')
    try { const found = await controller.autocomplete({ cityId, category, ...(dayKey ? { dayKey } : {}) }, query.trim(), searchId.current); if (current === serial.current) setResults(found.slice(0, 5)) } catch (caught) { if (current === serial.current) setError(caught instanceof Error ? caught.message : 'Place search failed.') } finally { if (current === serial.current) setBusy(false) }
  }
  async function select(predictionId: string) {
    const current = ++serial.current; setBusy(true); setError('')
    try { const result = await controller.resolve(searchId.current, predictionId); if (current === serial.current) { setSelection(result); setResults([]) } } catch (caught) { if (current === serial.current) setError(caught instanceof Error ? caught.message : 'Place selection failed.') } finally { if (current === serial.current) setBusy(false) }
  }
  async function submit() {
    if (!selection) return
    const current = ++serial.current
    setBusy(true); setError('')
    const input = { cityId, category, ...(dayKey ? { dayKey } : {}), ...(note.trim() ? { reason: note.trim() } : {}), ...(name.trim() ? { displayName: name.trim() } : {}) }
    try { if (context.suggestion) await controller.updateSuggestion(context.suggestion.key.slice(2), { ...input, dayKey: dayKey || null, ...(selection.selectionId ? { selectionId: selection.selectionId } : {}) }); else await controller.suggest({ ...input, selectionId: selection.selectionId }); if (current === serial.current) close() } catch (caught) { if (current === serial.current) { setError(caught instanceof Error ? caught.message : 'Recommendation failed.'); setBusy(false) } }
  }
  if (controller.readonly) return null
  const content = <div ref={dialog} className="ta-dialog" data-mode={context.full ? 'full' : 'quick'} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-label={context.full ? 'Suggest a place' : 'Recommend here'} onKeyDown={event => {
    if (inline || event.key !== 'Tab') return
    const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,select,a[href]')
    if (!controls?.length) return
    const first = controls[0]; const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <button type="button" className="ta-button" aria-label="Close suggestion dialog" onClick={close}>Close</button>
    {!context.full && dayKey && <p className="ta-meta">For {days.find(day => day.key === dayKey)?.title || dayKey}</p>}
    {context.full && <><label htmlFor={`${id}-city`}>City</label><select id={`${id}-city`} value={cityId} onChange={event => { serial.current++; setCityId(event.target.value); setDayKey(''); setSelection(null); setResults([]); setBusy(false) }}>{controller.projection?.cities.map(city => <option key={city.id} value={city.id}>{city.label}</option>)}</select><label htmlFor={`${id}-day`}>Day</label><select id={`${id}-day`} value={dayKey} onChange={event => setDayKey(event.target.value)}><option value="">Any day in this city</option>{days.map(day => <option key={day.key} value={day.key}>{dayLabel(controller, day)}{day.title ? ` · ${day.title}` : ''}</option>)}</select><label htmlFor={`${id}-category`}>Category</label><select id={`${id}-category`} value={category} onChange={event => { serial.current++; setCategory(event.target.value === 'eat' ? 'eat' : 'see'); setResults([]); setBusy(false) }}><option value="see">See</option><option value="eat">Eat</option></select></>}
    <form onSubmit={event => { event.preventDefault(); void search() }}><label htmlFor={`${id}-place-search`}>Find a Google Place</label><input ref={input} id={`${id}-place-search`} value={query} maxLength={200} onChange={event => { serial.current++; setQuery(event.target.value); setSelection(null); setResults([]); setBusy(false) }} /><button className="ta-button" disabled={busy || query.trim().length < 2}>Search</button></form>
    <ul className="ta-dialog-results">{results.map(result => <li key={result.predictionId}><button type="button" className="ta-button" disabled={busy} onClick={() => void select(result.predictionId)}>{result.mainText}<small> {result.secondaryText}</small></button></li>)}</ul>
    {(results.length > 0 || selection) && <p className="ta-google-attribution" translate="no">Google Maps</p>}
    {selection && <section className="ta-selected-place"><TripAdvicePhoto controller={controller} place={selection.place} /><div className="ta-place-copy"><strong>{selection.place.title}</strong><p>{selection.place.primaryType}</p></div>{!context.full && <div className="ta-selection-actions"><button type="button" className="ta-button ta-primary" disabled={busy} onClick={() => void submit()}>Recommend</button>{!showNote && <button type="button" className="ta-button" onClick={() => setShowNote(true)}>Add note</button>}</div>}</section>}
    {showNote && <><label htmlFor={`${id}-reason`}>Why should we go?</label><textarea id={`${id}-reason`} value={note} maxLength={500} onChange={event => setNote(event.target.value)} /><label htmlFor={`${id}-name`}>Display name (optional)</label><input id={`${id}-name`} maxLength={60} value={name} onChange={event => setName(event.target.value)} /></>}
    <p role="status">{busy ? 'Working…' : ''}</p>{error && <p role="alert" className="ta-error">{error}</p>}
    <div className="ta-dialog-actions"><button type="button" className="ta-button" onClick={close}>Cancel</button>{context.full && <button type="button" className="ta-button ta-primary" disabled={!selection || busy} onClick={() => void submit()}>{context.suggestion ? 'Save changes' : 'Recommend'}</button>}</div>
  </div>
  return inline ? content : <Modal isOpen onClose={close} hideCloseButton title={context.full ? 'Suggest a place' : 'Recommend here'}>{content}</Modal>
}
