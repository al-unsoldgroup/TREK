import type { AdviceDayView, AdvicePlaceView, TripAdviceController } from './tripAdvice.types'

export function dayLabel(controller: TripAdviceController, day: AdviceDayView): string {
  const date = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return `Day ${day.dayNumber} · ${date}`
}

export function dayMapPlaces(controller: TripAdviceController, cityId: string, day: AdviceDayView): AdvicePlaceView[] {
  const shortlist = controller.projection?.shortlists.find(list => list.cityId === cityId)
  return [...new Map([...day.schedule.map(row => row.place), ...(shortlist?.see || []), ...(shortlist?.eat || [])].map(place => [place.key, place])).values()]
}
