import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TripAdviceSurface from './TripAdviceSurface'
import type { TripAdviceController } from './tripAdvice.types'
import { dayLabel, dayMapPlaces } from './tripAdvice.day'

vi.mock('./TripAdviceMap', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
export function controllerFixture(): TripAdviceController {
  return {
    mode: 'guest', loading: false, error: null, status: '', erased: false,
    projection: { version: 2, revision: 'a'.repeat(64), title: 'Japan', cities: [{ id: 'tokyo', label: 'Tokyo', countryCodes: ['JP'] }, { id: 'kyoto', label: 'Kyoto', countryCodes: ['JP'] }], stays: [{ id: 'tokyo-stay', cityId: 'tokyo', shortlistCityId: 'tokyo', days: [{ key: 'd:1', dayNumber: 1, date: '2026-10-01', title: 'Arrival', note: 'An easy first day', schedule: [] }] }], shortlists: [] },
    votes: [], comments: [], suggestions: [], vote: vi.fn(), comment: vi.fn(), deleteComment: vi.fn(), erase: vi.fn(), autocomplete: vi.fn().mockResolvedValue([]), resolve: vi.fn(), suggest: vi.fn(), updateSuggestion: vi.fn(), photo: vi.fn(), metadata: vi.fn().mockResolvedValue({ placeKey: 'p:1' }), mapTile: vi.fn(),
  }
}
describe('native Trip Advice', () => {
  it('shows assignment times only on the corresponding scheduled rows', () => {
    const controller = controllerFixture()
    const place = { key: 'p:1', title: 'Garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden' }
    controller.projection!.stays[0].days[0].schedule = [{ key: 'a:1', place, time: '09:30', booked: false }, { key: 'a:2', place: { ...place, key: 'p:2', title: 'Temple' }, time: null, booked: false }]
    const { container } = render(<TripAdviceSurface controller={controller} />)
    const timed = container.querySelector('[id="ta-place-a:1"]')!
    expect(timed.querySelector('time')?.textContent).toBe('09:30')
    expect(timed.querySelector('time')?.getAttribute('datetime')).toBe('09:30')
    expect(container.querySelector('[id="ta-place-a:2"] time')).toBeNull()
  })
  it('opens city-scoped considerations below the days and switches See and Eat without leaking another city', async () => {
    const controller = controllerFixture()
    const place = { key: 'p:1', title: 'Tokyo garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden' }
    controller.projection!.shortlists = [{ cityId: 'tokyo', see: [place], eat: [{ ...place, key: 'p:2', title: 'Tokyo cafe', category: 'eat' }] }, { cityId: 'kyoto', see: [{ ...place, key: 'p:3', title: 'Kyoto temple', cityId: 'kyoto' }], eat: [] }]
    const { container } = render(<TripAdviceSurface controller={controller} />)
    const city = container.querySelector('#ta-city-tokyo')!
    const considerations = within(city as HTMLElement).getByText('See what we’re considering to See & Eat').closest('details')!
    expect(considerations.open).toBe(false)
    expect(within(considerations).queryByRole('link', { name: 'Tokyo garden' })).toBeNull()
    fireEvent.click(considerations.querySelector('summary')!)
    expect(considerations.open).toBe(true)
    expect(await within(considerations).findByRole('link', { name: 'Tokyo garden' })).toBeTruthy()
    expect(within(considerations).queryByRole('link', { name: 'Kyoto temple' })).toBeNull()
    fireEvent.click(within(considerations).getByRole('button', { name: /^Eat$/ }))
    expect(within(considerations).getByRole('link', { name: 'Tokyo cafe' })).toBeTruthy()
    expect(within(considerations).queryByRole('link', { name: 'Tokyo garden' })).toBeNull()
    expect(city.lastElementChild).toBe(considerations)
  })
  it('reveals the current city shortlist from each day See and Eat control', () => {
    const controller = controllerFixture()
    const place = { key: 'p:1', title: 'Tokyo garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden' }
    controller.projection!.shortlists = [{ cityId: 'tokyo', see: [place], eat: [{ ...place, key: 'p:2', title: 'Tokyo cafe', category: 'eat' }] }, { cityId: 'kyoto', see: [{ ...place, key: 'p:3', title: 'Kyoto temple', cityId: 'kyoto' }], eat: [] }]
    const { container } = render(<TripAdviceSurface controller={controller} />)
    const day = container.querySelector('[id="ta-day-d:1"]')!

    expect(within(day as HTMLElement).queryByRole('link', { name: 'Tokyo garden' })).toBeNull()
    fireEvent.click(within(day as HTMLElement).getByRole('button', { name: 'See' }))
    expect(within(day as HTMLElement).getByRole('link', { name: 'Tokyo garden' })).toBeTruthy()
    expect(within(day as HTMLElement).queryByRole('link', { name: 'Kyoto temple' })).toBeNull()

    fireEvent.click(within(day as HTMLElement).getByRole('button', { name: 'Eat' }))
    expect(within(day as HTMLElement).getByRole('link', { name: 'Tokyo cafe' })).toBeTruthy()
    expect(within(day as HTMLElement).queryByRole('link', { name: 'Tokyo garden' })).toBeNull()
  })

  it('explains when a day category has no city places under consideration', () => {
    const controller = controllerFixture()
    controller.projection!.shortlists = [{ cityId: 'tokyo', see: [], eat: [] }]
    const { container } = render(<TripAdviceSurface controller={controller} />)
    const day = container.querySelector('[id="ta-day-d:1"]')!

    fireEvent.click(within(day as HTMLElement).getByRole('button', { name: 'Eat' }))
    expect(within(day as HTMLElement).getByText('No places to eat under consideration in Tokyo yet.')).toBeTruthy()
    expect(within(day as HTMLElement).getByRole('button', { name: 'Recommend here' })).toBeTruthy()
  })

  it('labels independently collapsible days with number and full calendar date', () => {
    const { container } = render(<TripAdviceSurface controller={controllerFixture()} />)
    const day = container.querySelector<HTMLDetailsElement>('.ta-day')!
    expect(day.querySelector('.ta-meta')?.textContent).toMatch(/Day 1 ·.*2026/)
    expect(day.tagName).toBe('DETAILS')
    expect(day.open).toBe(true)
    fireEvent.click(day.querySelector('summary')!)
    expect(day.open).toBe(false)
  })
  it('keeps the canonical day number when earlier days are hidden', () => {
    const controller = controllerFixture()
    const day = { ...controller.projection!.stays[0].days[0], key: 'd:5', dayNumber: 5, date: '2026-10-05' }
    expect(dayLabel(controller, day)).toMatch(/^Day 5 ·/)
  })
  it('maps only scheduled places and the current city shortlist, never pending or other-city ideas', () => {
    const controller = controllerFixture()
    const place = { key: 'p:1', title: 'Garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden', lat: 35, lng: 139 }
    const day = controller.projection!.stays[0].days[0]
    day.schedule = [{ key: 'a:1', place, time: null, booked: false }]
    controller.projection!.shortlists = [{ cityId: 'tokyo', see: [{ ...place, key: 'p:2' }], eat: [] }, { cityId: 'kyoto', see: [{ ...place, key: 'p:3', cityId: 'kyoto' }], eat: [] }]
    controller.suggestions = [{ ...place, key: 's:22222222-2222-4222-8222-222222222222', googlePlaceId: 'google', dayKey: day.key, state: 'pending', reason: null, displayName: null }]
    expect(dayMapPlaces(controller, 'tokyo', day).map(value => value.key)).toEqual(['p:1', 'p:2'])
  })
  it('full suggestions expose city/day targeting and section navigation marks the selected destination', () => {
    render(<TripAdviceSurface controller={controllerFixture()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ideas' }))
    expect(screen.getByRole('button', { name: 'Ideas' }).getAttribute('aria-current')).toBe('location')
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a place' }))
    fireEvent.change(screen.getByLabelText('Day', { exact: true }), { target: { value: 'd:1' } })
    expect((screen.getByLabelText('Day', { exact: true }) as HTMLSelectElement).value).toBe('d:1')
    fireEvent.change(screen.getByLabelText('City', { exact: true }), { target: { value: 'kyoto' } })
    expect((screen.getByLabelText('Day', { exact: true }) as HTMLSelectElement).value).toBe('')
  })
  it('sends an explicitly selected comment anchor', async () => {
    const controller = controllerFixture()
    render(<TripAdviceSurface controller={controller} />)
    fireEvent.change(screen.getByLabelText('About'), { target: { value: 'day:d:1' } })
    fireEvent.change(screen.getByLabelText('A note for the trip owner'), { target: { value: 'Start slowly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))
    await waitFor(() => expect(controller.comment).toHaveBeenCalledWith('Start slowly', undefined, { kind: 'day', key: 'd:1' }))
  })
  it('uses assignment keys for schedule eyes and exposes owner eyes on pending ideas', () => {
    const controller = controllerFixture()
    controller.mode = 'owner'
    controller.owner = { saving: false, saveState: 'Saved', config: { version: 2, showNotes: false, hiddenCityKeys: [], hiddenDayKeys: [], hiddenNoteDayKeys: [], hiddenPlaceKeys: [], hiddenIdeaKeys: [], addedCities: [] }, setVisibility: vi.fn(), setShowNotes: vi.fn(), copyLink: vi.fn(), searchCities: vi.fn(), addCity: vi.fn() }
    const place = { key: 'p:1', title: 'Garden', category: 'see' as const, cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: null, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden' }
    controller.projection!.stays[0].days[0].schedule = [{ key: 'a:8', place, time: null, booked: false }]
    controller.suggestions = [{ ...place, key: 's:22222222-2222-4222-8222-222222222222', title: 'Pending cafe', googlePlaceId: 'google', state: 'pending', reason: null, displayName: null }]
    render(<TripAdviceSurface controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide Garden' }))
    expect(controller.owner.setVisibility).toHaveBeenCalledWith('hiddenPlaceKeys', 'a:8')
    fireEvent.click(screen.getByRole('button', { name: 'Hide Pending cafe' }))
    expect(controller.owner.setVisibility).toHaveBeenCalledWith('hiddenIdeaKeys', 's:22222222-2222-4222-8222-222222222222')
  })
  it('loads missing Google type through the bounded place metadata controller', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const controller = controllerFixture()
    controller.metadata = vi.fn().mockResolvedValue({ placeKey: 'p:1', primaryType: 'Botanical garden' })
    controller.projection!.shortlists = [{ cityId: 'tokyo', eat: [], see: [{ key: 'p:1', title: 'Garden', category: 'see', cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: 'google', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden' }] }]
    render(<TripAdviceSurface controller={controller} />)
    await screen.findByText('Botanical garden · Tokyo · Under consideration')
    expect(controller.metadata).toHaveBeenCalledWith('p:1')
  })
  it('renders the complete native document without an iframe or owner authority', () => {
    const { container } = render(<TripAdviceSurface controller={controllerFixture()} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Japan' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Ideas' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Comments' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /copy share/i })).toBeNull()
    expect(screen.getByText('An easy first day').closest('details')?.open).toBe(true)
    expect(screen.getByRole('button', { name: 'Recommend here' })).toBeTruthy()
  })
  it('keeps other cities collapsed and expands the plan city when route is selected', () => {
    const { container } = render(<TripAdviceSurface controller={controllerFixture()} />)
    const others = screen.getByText('Others').closest('details')
    expect(others?.open).toBe(false)
    const city = container.querySelector<HTMLDetailsElement>('#ta-city-tokyo')!
    city.open = false
    fireEvent.click(screen.getByRole('button', { name: /Tokyo.*Oct/ }))
    expect(city.open).toBe(true)
  })
  it('opens full suggestion dialog and dismisses with Escape', () => {
    render(<TripAdviceSurface controller={controllerFixture()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a place' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('does not dismiss inside the sheet and restores focus after Cancel', () => {
    render(<TripAdviceSurface controller={controllerFixture()} />)
    const opener = screen.getByRole('button', { name: 'Suggest a place' })
    opener.focus(); fireEvent.click(opener)
    fireEvent.click(screen.getByLabelText('Find a Google Place'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
  it('keeps legacy visibility controls disabled until explicit design upgrade', () => {
    const controller = controllerFixture()
    controller.mode = 'owner'
    controller.owner = { legacy: true, saving: false, saveState: 'Saved', config: { version: 2, showNotes: false, hiddenCityKeys: [], hiddenDayKeys: [], hiddenNoteDayKeys: [], hiddenPlaceKeys: [], hiddenIdeaKeys: [], addedCities: [] }, setVisibility: vi.fn(), setShowNotes: vi.fn(), copyLink: vi.fn(), searchCities: vi.fn(), addCity: vi.fn(), upgrade: vi.fn() }
    render(<TripAdviceSurface controller={controller} />)
    expect(screen.getAllByRole('button', { name: 'Hide Tokyo' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Recommend here' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByRole('button', { name: 'Suggest a place' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Use new design' }))
    expect(controller.owner.upgrade).toHaveBeenCalledOnce()
    expect(controller.owner.setVisibility).not.toHaveBeenCalled()
  })
  it('guest preview withholds hidden city content and opted-out notes while preserving owner reversibility', () => {
    const controller = controllerFixture()
    controller.mode = 'owner'
    controller.owner = { saving: false, saveState: 'Saved', config: { version: 2, showNotes: false, hiddenCityKeys: ['kyoto'], hiddenDayKeys: [], hiddenNoteDayKeys: [], hiddenPlaceKeys: [], hiddenIdeaKeys: [], addedCities: [] }, setVisibility: vi.fn(), setShowNotes: vi.fn(), copyLink: vi.fn(), searchCities: vi.fn(), addCity: vi.fn() }
    render(<TripAdviceSurface controller={controller} />)
    expect(screen.getByText('An easy first day')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recommend here' }))
    expect(screen.getByRole('region', { name: 'Recommend here' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Guest preview' }))
    expect(screen.queryByRole('region', { name: 'Recommend here' })).toBeNull()
    expect(screen.queryByText('An easy first day')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Kyoto' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide Tokyo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Erase my feedback' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Recommend here' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Owner view' }))
    expect(screen.getByRole('heading', { name: 'Kyoto' })).toBeTruthy()
  })
  it('quick selection offers Recommend and Add note before submitting scoped suggestion', async () => {
    const controller = controllerFixture()
    controller.autocomplete = vi.fn().mockResolvedValue([{ predictionId: 'prediction', mainText: 'Garden', secondaryText: 'Tokyo' }])
    controller.resolve = vi.fn().mockResolvedValue({ selectionId: 'selection', place: { key: 'p:2', title: 'Garden', category: 'see', cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: 'google', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden', primaryType: 'Garden' } })
    render(<TripAdviceSurface controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recommend here' }))
    expect(screen.getByRole('region', { name: 'Recommend here' }).closest('.ta-day')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Recommend here' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Find a Google Place'), { target: { value: 'Garden' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click((await screen.findByText('Garden', { selector: '.ta-dialog-results button' })))
    expect(screen.getByText('Google Maps')).toBeTruthy()
    await screen.findByRole('button', { name: 'Add note' })
    expect(controller.suggest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    fireEvent.change(screen.getByLabelText('Why should we go?'), { target: { value: 'Quiet start' } })
    fireEvent.click(screen.getByRole('button', { name: 'Recommend' }))
    await waitFor(() => expect(controller.suggest).toHaveBeenCalledWith(expect.objectContaining({ selectionId: 'selection', cityId: 'tokyo', dayKey: 'd:1', category: 'see', reason: 'Quiet start' })))
  })
  it('edits an owned pending idea using its existing selection and prefilled details', async () => {
    const controller = controllerFixture()
    controller.suggestions = [{ key: 's:22222222-2222-4222-8222-222222222222', title: 'Garden', category: 'see', cityId: 'tokyo', locality: 'Tokyo', countryCode: 'JP', googlePlaceId: 'google', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Garden', state: 'pending', reason: 'Quiet start', displayName: 'Maya', dayKey: 'd:1' }]
    render(<TripAdviceSurface controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect((screen.getByLabelText('Why should we go?') as HTMLTextAreaElement).value).toBe('Quiet start')
    expect((screen.getAllByLabelText('Display name (optional)').find(input => (input as HTMLInputElement).value === 'Maya') as HTMLInputElement).value).toBe('Maya')
    fireEvent.change(screen.getByLabelText('Why should we go?'), { target: { value: 'Sunset instead' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(controller.updateSuggestion).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.objectContaining({ cityId: 'tokyo', category: 'see', reason: 'Sunset instead', dayKey: 'd:1', displayName: 'Maya' })))
    expect(controller.resolve).not.toHaveBeenCalled()
  })
})
