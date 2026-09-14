import { useEffect, useRef, useState } from 'react'
import { Eye } from 'lucide-react'
import type { TripAdviceController, VisibilityField } from './tripAdvice.types'
import { Visibility } from './TripAdvicePlaceRow'

export function scrollAdvice(id: string) {
  const target = document.getElementById(id)
  let details = target?.closest('details')
  while (details) { details.open = true; details = details.parentElement?.closest('details') || null }
  target?.scrollIntoView?.({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  target?.focus({ preventScroll: true })
}
export function cityRange(controller: TripAdviceController, cityId: string) {
  const days = controller.projection?.stays.filter(stay => stay.cityId === cityId).flatMap(stay => stay.days).sort((a, b) => a.date.localeCompare(b.date)) || []
  if (!days.length) return 'Ideas'
  const format = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const range = days[0].dayNumber === days[days.length - 1].dayNumber ? `Day ${days[0].dayNumber}` : `Days ${days[0].dayNumber}–${days[days.length - 1].dayNumber}`
  return `${format(days[0].date)}–${format(days[days.length - 1].date)} · ${range}`
}
export default function TripAdviceRoute({ controller }: { controller: TripAdviceController }) {
  const [search, setSearch] = useState(''); const [predictions, setPredictions] = useState<{ predictionId: string; mainText: string }[]>([]); const [error, setError] = useState('')
  const sequence = useRef(0)
  useEffect(() => () => { sequence.current++ }, [])
  async function searchCity() {
    const current = ++sequence.current
    try { const results = await controller.owner!.searchCities(search.trim()); if (current === sequence.current) setPredictions(results.slice(0, 5)) }
    catch (caught) { if (current === sequence.current) setError(caught instanceof Error ? caught.message : 'City search failed.') }
  }
  async function addCity(predictionId: string) {
    const current = ++sequence.current
    try { await controller.owner!.addCity(predictionId); if (current === sequence.current) { setPredictions([]); setSearch('') } }
    catch (caught) { if (current === sequence.current) setError(caught instanceof Error ? caught.message : 'Could not add city.') }
  }
  const projection = controller.projection!
  const committed = new Set(projection.stays.filter(stay => stay.days.length).map(stay => stay.cityId))
  const row = (city: typeof projection.cities[number]) => <li key={city.id}><button type="button" className="ta-route-link" onClick={() => scrollAdvice(`ta-city-${city.id}`)}><strong>{city.label}</strong><small>{cityRange(controller, city.id)}</small></button><Visibility controller={controller} field="hiddenCityKeys" itemKey={city.id} label={city.label} /></li>
  const elements: { key: string; label: string; field: VisibilityField; cityId: string }[] = projection.cities.map(city => ({ key: city.id, label: city.label, field: 'hiddenCityKeys', cityId: city.id }))
  projection.stays.forEach(stay => stay.days.forEach(day => {
    elements.push({ key: day.key, label: day.title || day.date, field: 'hiddenDayKeys', cityId: stay.cityId })
    if (day.note) elements.push({ key: day.key, label: `Note: ${day.title || day.date}`, field: 'hiddenNoteDayKeys', cityId: stay.cityId })
    day.schedule.forEach(row => elements.push({ key: controller.owner?.config.hiddenPlaceKeys.includes(row.place.key) ? row.place.key : row.key, label: row.place.title, field: 'hiddenPlaceKeys', cityId: stay.cityId }))
  }))
  projection.shortlists.forEach(list => [...list.see, ...list.eat].forEach(place => elements.push({ key: place.key, label: place.title, field: 'hiddenIdeaKeys', cityId: list.cityId })))
  const matches = elements.filter(item => item.label.toLowerCase().includes(search.toLowerCase())).slice(0, 5)
  return <aside className="ta-card ta-route" aria-label="Trip route"><h2>The route</h2><h3>Committed</h3><ul>{projection.cities.filter(city => committed.has(city.id)).map(row)}</ul><details><summary><Eye size={16} aria-hidden /> Others</summary><ul>{projection.cities.filter(city => !committed.has(city.id)).map(row)}</ul></details>
    {controller.mode === 'owner' && controller.owner && <><label htmlFor="ta-route-search">Find in this trip or add a city</label><input id="ta-route-search" value={search} onChange={event => { sequence.current++; setSearch(event.target.value); setPredictions([]) }} />{search && <ul>{matches.map(item => <li key={`${item.field}:${item.key}`}><button type="button" className="ta-route-link" onClick={() => scrollAdvice(`ta-city-${item.cityId}`)}>{item.label}</button><Visibility controller={controller} field={item.field} itemKey={item.key} label={item.label} /></li>)}</ul>}{search.trim().length >= 2 && !matches.length && <button className="ta-button" type="button" disabled={controller.owner.legacy} onClick={() => void searchCity()}>Find a new city</button>}<ul>{predictions.map(result => <li key={result.predictionId}><button className="ta-button" type="button" onClick={() => void addCity(result.predictionId)}>Add {result.mainText}</button></li>)}</ul>{error && <p role="alert">{error}</p>}</>}
  </aside>
}
