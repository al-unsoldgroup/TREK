import type { AdviceProjectionV2, AdviceShareConfigV2 } from '@trek/shared'

/** Presentation-only preview; the server independently applies the same exclusions to public reads. */
export function guestPreview(projection: AdviceProjectionV2, config: AdviceShareConfigV2): AdviceProjectionV2 {
  const cities = projection.cities.filter(city => !config.hiddenCityKeys.includes(city.id))
  const visibleCities = new Set(cities.map(city => city.id))
  return { ...projection, cities,
    stays: projection.stays.filter(stay => visibleCities.has(stay.cityId)).map(stay => ({ ...stay, days: stay.days.filter(day => !config.hiddenDayKeys.includes(day.key)).map(day => {
      const { note, ...rest } = day
      return { ...rest, ...(config.showNotes && !config.hiddenNoteDayKeys.includes(day.key) && note ? { note } : {}), schedule: day.schedule.filter(row => !config.hiddenPlaceKeys.includes(row.key) && !config.hiddenPlaceKeys.includes(row.place.key)) }
    }) })),
    shortlists: projection.shortlists.filter(list => list.cityId === 'elsewhere' || visibleCities.has(list.cityId)).map(list => ({ ...list, see: list.see.filter(place => !config.hiddenIdeaKeys.includes(place.key)), eat: list.eat.filter(place => !config.hiddenIdeaKeys.includes(place.key)) })),
  }
}
