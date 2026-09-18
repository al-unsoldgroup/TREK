import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Camera, ChevronUp, Plus, Utensils } from 'lucide-react'
import type { AdviceDayView, TripAdviceController } from './tripAdvice.types'
import TripAdvicePlaceRow, { Visibility } from './TripAdvicePlaceRow'
import TripAdviceSuggestionDialog from './TripAdviceSuggestionDialog'
import { cityRange } from './TripAdviceRoute'
import { dayLabel, dayMapPlaces } from './tripAdvice.day'
const TripAdviceMap = lazy(() => import('./TripAdviceMap'))

function ConsiderationPlaces({ controller, cityId, cityLabel, category, idPrefix }: { controller: TripAdviceController; cityId: string; cityLabel: string; category: 'see' | 'eat'; idPrefix: string }) {
  const places = controller.projection?.shortlists.find(list => list.cityId === cityId)?.[category] || []
  return <>
    {places.map(place => <TripAdvicePlaceRow key={place.key} controller={controller} place={place} idea idPrefix={idPrefix} />)}
    {!places.length && <p className="ta-meta">No {category === 'see' ? 'sights' : 'places to eat'} under consideration in {cityLabel} yet.</p>}
  </>
}

function TripAdviceDay({ controller, cityId, cityLabel, day }: { controller: TripAdviceController; cityId: string; cityLabel: string; day: AdviceDayView }) {
  const [open, setOpen] = useState(true)
  const [noteOpen, setNoteOpen] = useState(true)
  const [category, setCategory] = useState<'see' | 'eat'>('see')
  const [shownCategory, setShownCategory] = useState<'see' | 'eat' | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const categoryButtons = useRef<Record<'see' | 'eat', HTMLButtonElement | null>>({ see: null, eat: null })
  useEffect(() => { if (controller.readonly) setQuickOpen(false) }, [controller.readonly])
  const hidden = controller.mode === 'owner' && controller.owner?.config.hiddenDayKeys.includes(day.key)
  const considerationsId = `ta-day-${day.key}-considerations`
  return <details id={`ta-day-${day.key}`} className={`ta-day${hidden ? ' ta-hidden' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)} tabIndex={-1}>
    <summary className="ta-day-heading"><div><p className="ta-meta">{dayLabel(controller, day)}</p><h3>{day.title || 'Plan for the day'}</h3></div><Visibility controller={controller} field="hiddenDayKeys" itemKey={day.key} label={day.title || day.date} /></summary>
    <div className="ta-day-body">{day.note && <details className={`ta-note${controller.mode === 'owner' && controller.owner?.config.hiddenNoteDayKeys.includes(day.key) ? ' ta-hidden' : ''}`} open={noteOpen} onToggle={event => setNoteOpen(event.currentTarget.open)}><summary>Plan for the day<Visibility controller={controller} field="hiddenNoteDayKeys" itemKey={day.key} label={`notes for ${day.title || day.date}`} /></summary><p>{day.note}</p></details>}
      <Suspense fallback={<p role="status">Loading map…</p>}><TripAdviceMap controller={controller} dayKey={day.key} places={dayMapPlaces(controller, cityId, day)} scheduledKeys={new Set(day.schedule.map(row => row.place.key))} /></Suspense>
      {day.schedule.map(row => <TripAdvicePlaceRow key={row.key} controller={controller} place={row.place} assignmentKey={row.key} assignmentTime={row.time} />)}
      {!day.schedule.length && <p className="ta-meta">No places scheduled yet.</p>}
      <div className="ta-toolbar"><div className="ta-category-controls"><div role="group" aria-label="Recommendation category">{(['see', 'eat'] as const).map(value => <button key={value} ref={node => { categoryButtons.current[value] = node }} type="button" className="ta-button" aria-pressed={shownCategory === value} onClick={() => { setCategory(value); setShownCategory(current => current === value ? null : value) }}>{value === 'see' ? <Camera size={16} aria-hidden /> : <Utensils size={16} aria-hidden />}{value === 'see' ? 'See' : 'Eat'}</button>)}</div>{shownCategory && <button type="button" className="ta-button ta-collapse-shortlist" aria-label="Collapse shortlist" aria-expanded="true" aria-controls={considerationsId} onClick={() => { categoryButtons.current[shownCategory]?.focus(); setShownCategory(null) }}><ChevronUp size={16} aria-hidden />Collapse</button>}</div><button type="button" className="ta-button" disabled={controller.readonly} onClick={() => setQuickOpen(true)}><Plus size={16} aria-hidden />Recommend here</button></div>
      {shownCategory && <div id={considerationsId} className="ta-day-considerations" role="region" aria-label={`${shownCategory === 'see' ? 'Places to see' : 'Places to eat'} under consideration in ${cityLabel}`}>
        <ConsiderationPlaces controller={controller} cityId={cityId} cityLabel={cityLabel} category={shownCategory} idPrefix={`ta-day-${day.key}-consideration`} />
      </div>}
      {quickOpen && <TripAdviceSuggestionDialog inline controller={controller} context={{ cityId, dayKey: day.key, category }} close={() => setQuickOpen(false)} />}
    </div>
  </details>
}

export default function TripAdviceCity({ controller, cityId }: { controller: TripAdviceController; cityId: string }) {
  const [open, setOpen] = useState(true)
  const projection = controller.projection!
  const city = projection.cities.find(value => value.id === cityId)!
  const days = projection.stays.filter(stay => stay.cityId === cityId).flatMap(stay => stay.days)
  const hidden = controller.mode === 'owner' && controller.owner?.config.hiddenCityKeys.includes(cityId)
  return <details id={`ta-city-${cityId}`} className={`ta-card ta-city${hidden ? ' ta-hidden' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)} tabIndex={-1}>
    <summary><h2>{city.label}</h2><span className="ta-meta">{cityRange(controller, cityId)}</span><Visibility controller={controller} field="hiddenCityKeys" itemKey={cityId} label={city.label} /></summary>
    {days.map(day => <TripAdviceDay key={day.key} controller={controller} cityId={cityId} cityLabel={city.label} day={day} />)}
    {!days.length && <p className="ta-day-body ta-meta">A destination to consider. No committed dates yet.</p>}
  </details>
}
