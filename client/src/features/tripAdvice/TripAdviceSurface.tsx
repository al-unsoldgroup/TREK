import { useState } from 'react'
import { MapPin } from 'lucide-react'
import type { RecommendationDialogContext, TripAdviceController } from './tripAdvice.types'
import TripAdviceRoute, { scrollAdvice } from './TripAdviceRoute'
import TripAdviceCity from './TripAdviceCity'
import TripAdvicePlaceRow, { Visibility } from './TripAdvicePlaceRow'
import TripAdviceComments from './TripAdviceComments'
import TripAdviceSuggestionDialog from './TripAdviceSuggestionDialog'
import './tripAdvice.tokens.css'
import { guestPreview } from './tripAdvice.preview'

function matchesIdea(query: string, values: Array<string | null | undefined>) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = values.filter(Boolean).join(' ').toLowerCase()
  return words.every(word => haystack.includes(word))
}

export default function TripAdviceSurface({ controller }: { controller: TripAdviceController }) {
  const [preview, setPreview] = useState(false); const [recommendation, setRecommendation] = useState<RecommendationDialogContext | null>(null)
  const [activeSection, setActiveSection] = useState('Plan')
  const [ideaQuery, setIdeaQuery] = useState('')
  const [destinationsOpen, setDestinationsOpen] = useState(false)
  if (controller.erased) return <div className="ta-surface"><p role="status">Your feedback has been erased and this guest session has ended.</p></div>
  if (!controller.projection) return <div className="ta-surface"><p role={controller.error ? 'alert' : 'status'}>{controller.error || 'Loading trip advice…'}</p></div>
  const owner = controller.mode === 'owner' ? controller.owner : undefined
  const projection = preview && owner ? guestPreview(controller.projection, owner.config) : controller.projection
  const ownerController = owner?.legacy ? { ...controller, readonly: true } : controller
  const visibleController = preview ? { ...ownerController, projection, mode: 'guest' as const, readonly: true, owner: undefined, suggestions: controller.suggestions.filter(item => !owner?.config.hiddenIdeaKeys.includes(item.key)) } : ownerController
  const cityLabel = new Map(projection.cities.map(city => [city.id, city.label]))
  const committedCityIds = new Set(projection.stays.filter(stay => stay.days.length).map(stay => stay.cityId))
  const committedCities = projection.cities.filter(city => committedCityIds.has(city.id))
  const ideas = projection.shortlists.flatMap(list => [...list.see, ...list.eat]).filter(place => matchesIdea(ideaQuery, [place.title, cityLabel.get(place.cityId), place.locality, place.primaryType]))
  const suggestions = visibleController.suggestions.filter(suggestion => matchesIdea(ideaQuery, [suggestion.title, cityLabel.get(suggestion.cityId), suggestion.locality, suggestion.primaryType]))
  const ideaGroups = (['see', 'eat'] as const).map(category => ({ category, ideas: ideas.filter(place => place.category === category), suggestions: suggestions.filter(suggestion => suggestion.category === category) })).filter(group => group.ideas.length || group.suggestions.length)
  return <div className={`ta-surface${owner ? ' ta-has-owner-bar' : ''}`}>
    {owner && <div className="ta-owner-bar"><strong>TREK</strong><span role="status">{owner.saving ? 'Saving…' : owner.saveState}</span><button type="button" className="ta-button" aria-pressed={preview} onClick={() => { setRecommendation(null); setPreview(value => !value) }}>{preview ? 'Owner view' : 'Guest preview'}</button><button type="button" className="ta-button" onClick={() => void owner.copyLink()}>Copy share link</button></div>}
    {owner?.legacy && <section className="ta-page" aria-label="Upgrade shared design"><p>Your existing link keeps its current design and visibility until you approve this preview.</p><button className="ta-button" type="button" disabled={owner.saving} onClick={() => void owner.upgrade?.()}>Use new design</button></section>}
    <header className="ta-hero"><p>Trip advice</p><h1>{projection.title}</h1><p>Your plan, local ideas and recommendations together.</p></header>
    <nav className="ta-jumpbar" aria-label="Trip navigation"><div className="ta-jumpbar-main"><span className="ta-jump-title" title={projection.title}>{projection.title}</span><div className="ta-section-jumps">{['Plan', 'Ideas', 'Comments'].map(section => <button key={section} type="button" className="ta-button" aria-current={activeSection === section ? 'location' : undefined} onClick={() => { setActiveSection(section); scrollAdvice(`ta-${section.toLowerCase()}`) }}>{section}</button>)}<button type="button" className="ta-button ta-destinations-toggle" aria-label="Destinations" aria-expanded={destinationsOpen} aria-controls="ta-committed-destinations" onClick={() => setDestinationsOpen(value => !value)}><MapPin size={16} aria-hidden /><span>Destinations</span></button></div></div>{destinationsOpen && <div id="ta-committed-destinations" className="ta-city-jumps" role="group" aria-label="Committed destinations">{committedCities.map(city => <button key={city.id} type="button" className="ta-button" onClick={() => { setDestinationsOpen(false); setActiveSection('Plan'); scrollAdvice(`ta-city-${city.id}`) }}>{city.label}</button>)}</div>}</nav>
    <main className="ta-page">{controller.error && <p role="alert" className="ta-error">{controller.error}</p>}<p role="status">{controller.status}</p>
      {owner && !preview && <label><input type="checkbox" checked={owner.config.showNotes} disabled={owner.saving || owner.legacy} onChange={event => void owner.setShowNotes(event.target.checked)} /> Display day notes on the shared link</label>}
      <div className="ta-layout"><TripAdviceRoute controller={visibleController} /><section id="ta-plan" tabIndex={-1} aria-label="Plan">{projection.cities.map(city => <TripAdviceCity key={city.id} cityId={city.id} controller={visibleController} />)}<button className="ta-button ta-recommend" type="button" disabled={visibleController.readonly || !projection.cities.length} onClick={() => setRecommendation({ cityId: projection.cities[0].id, category: 'see', full: true })}>Suggest a place</button></section></div>
      <section id="ta-ideas" className="ta-section" tabIndex={-1} aria-labelledby="ta-ideas-title"><h2 id="ta-ideas-title">Ideas</h2><label htmlFor="ta-ideas-search">Search ideas</label><input id="ta-ideas-search" type="search" value={ideaQuery} placeholder="Search by place, city or type" onChange={event => setIdeaQuery(event.target.value)} />{ideaGroups.map(group => <section key={group.category} className="ta-idea-group" aria-labelledby={`ta-ideas-${group.category}`}><h3 id={`ta-ideas-${group.category}`}>{group.category === 'see' ? 'See' : 'Eat'}</h3>{group.ideas.map(place => <TripAdvicePlaceRow key={place.key} controller={visibleController} place={place} idea />)}{group.suggestions.map(suggestion => <article key={suggestion.key} className={`ta-card ta-idea${owner?.config.hiddenIdeaKeys.includes(suggestion.key) ? ' ta-hidden' : ''}`}><h4>{suggestion.title}</h4><p className="ta-meta">{[suggestion.primaryType, cityLabel.get(suggestion.cityId), suggestion.displayName || 'Guest adviser', 'Pending owner review'].filter(Boolean).join(' · ')}</p>{suggestion.reason && <p>{suggestion.reason}</p>}<Visibility controller={visibleController} field="hiddenIdeaKeys" itemKey={suggestion.key} label={suggestion.title} />{controller.mode === 'guest' && suggestion.state === 'pending' && <button className="ta-button" type="button" disabled={visibleController.readonly} onClick={() => setRecommendation({ cityId: suggestion.cityId, dayKey: suggestion.dayKey || undefined, category: suggestion.category, full: true, suggestion })}>Edit</button>}</article>)}</section>)}{!ideaGroups.length && <p role="status" className="ta-meta">{ideaQuery.trim() ? `No ideas match “${ideaQuery.trim()}”.` : 'No ideas yet.'}</p>}</section>
      <TripAdviceComments controller={visibleController} />
      {recommendation && <TripAdviceSuggestionDialog controller={visibleController} context={recommendation} close={() => setRecommendation(null)} />}
    </main>
  </div>
}
