import { lazy, Suspense, useEffect, useState } from 'react'
import { Camera, Plus, Utensils } from 'lucide-react'
import type { AdviceDayView, TripAdviceController } from './tripAdvice.types'
import TripAdvicePlaceRow, { Visibility } from './TripAdvicePlaceRow'
import TripAdviceSuggestionDialog from './TripAdviceSuggestionDialog'
import { cityRange } from './TripAdviceRoute'
import { dayLabel, dayMapPlaces } from './tripAdvice.day'
const TripAdviceMap = lazy(() => import('./TripAdviceMap'))

function TripAdviceDay({ controller, cityId, day }: { controller: TripAdviceController; cityId: string; day: AdviceDayView }) {
  const [open, setOpen] = useState(true)
  const [noteOpen, setNoteOpen] = useState(true)
  const [category, setCategory] = useState<'see' | 'eat'>('see')
  const [quickOpen, setQuickOpen] = useState(false)
  useEffect(() => { if (controller.readonly) setQuickOpen(false) }, [controller.readonly])
  const hidden = controller.mode === 'owner' && controller.owner?.config.hiddenDayKeys.includes(day.key)
  return <details id={`ta-day-${day.key}`} className={`ta-day${hidden ? ' ta-hidden' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)} tabIndex={-1}>
    <summary className="ta-day-heading"><div><p className="ta-meta">{dayLabel(controller, day)}</p><h3>{day.title || 'Plan for the day'}</h3></div><Visibility controller={controller} field="hiddenDayKeys" itemKey={day.key} label={day.title || day.date} /></summary>
    <div className="ta-day-body">{day.note && <details className={`ta-note${controller.mode === 'owner' && controller.owner?.config.hiddenNoteDayKeys.includes(day.key) ? ' ta-hidden' : ''}`} open={noteOpen} onToggle={event => setNoteOpen(event.currentTarget.open)}><summary>Plan for the day<Visibility controller={controller} field="hiddenNoteDayKeys" itemKey={day.key} label={`notes for ${day.title || day.date}`} /></summary><p>{day.note}</p></details>}
      <Suspense fallback={<p role="status">Loading map…</p>}><TripAdviceMap controller={controller} dayKey={day.key} places={dayMapPlaces(controller, cityId, day)} scheduledKeys={new Set(day.schedule.map(row => row.place.key))} /></Suspense>
      {day.schedule.map(row => <TripAdvicePlaceRow key={row.key} controller={controller} place={row.place} assignmentKey={row.key} assignmentTime={row.time} />)}
      {!day.schedule.length && <p className="ta-meta">No places scheduled yet.</p>}
      <div className="ta-toolbar"><div aria-label="Recommendation category">{(['see', 'eat'] as const).map(value => <button key={value} type="button" className="ta-button" aria-pressed={category === value} onClick={() => setCategory(value)}>{value === 'see' ? <Camera size={16} aria-hidden /> : <Utensils size={16} aria-hidden />}{value === 'see' ? 'See' : 'Eat'}</button>)}</div><button type="button" className="ta-button" disabled={controller.readonly} onClick={() => setQuickOpen(true)}><Plus size={16} aria-hidden />Recommend here</button></div>
      {quickOpen && <TripAdviceSuggestionDialog inline controller={controller} context={{ cityId, dayKey: day.key, category }} close={() => setQuickOpen(false)} />}
    </div>
  </details>
}

function CityConsiderations({ controller, cityId, label }: { controller: TripAdviceController; cityId: string; label: string }) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<'see' | 'eat'>('see')
  const shortlist = controller.projection?.shortlists.find(list => list.cityId === cityId)
  const places = shortlist?.[category] || []
  return <details className="ta-considerations" aria-label={`${label} considerations`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>See what we’re considering to See &amp; Eat</summary>
    {open && <div className="ta-day-body">
      <div className="ta-toolbar" role="group" aria-label={`${label} consideration categories`}>{(['see', 'eat'] as const).map(value => <button key={value} type="button" className="ta-button" aria-pressed={category === value} onClick={() => setCategory(value)}>{value === 'see' ? <Camera size={16} aria-hidden /> : <Utensils size={16} aria-hidden />}{value === 'see' ? 'See' : 'Eat'}</button>)}</div>
      {places.map(place => <TripAdvicePlaceRow key={place.key} controller={controller} place={place} idea idPrefix={`ta-consideration-${cityId}`} />)}
      {!places.length && <p className="ta-meta">No {category === 'see' ? 'sights' : 'places to eat'} under consideration in {label} yet.</p>}
    </div>}
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
    {days.map(day => <TripAdviceDay key={day.key} controller={controller} cityId={cityId} day={day} />)}
    {!days.length && <p className="ta-day-body ta-meta">A destination to consider. No committed dates yet.</p>}
    <CityConsiderations controller={controller} cityId={cityId} label={city.label} />
  </details>
}
