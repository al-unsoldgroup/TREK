import { useState } from 'react'
import type { RecommendationDialogContext, TripAdviceController } from './tripAdvice.types'
import TripAdviceRoute, { scrollAdvice } from './TripAdviceRoute'
import TripAdviceCity from './TripAdviceCity'
import TripAdvicePlaceRow, { Visibility } from './TripAdvicePlaceRow'
import TripAdviceComments from './TripAdviceComments'
import TripAdviceSuggestionDialog from './TripAdviceSuggestionDialog'
import './tripAdvice.tokens.css'
import { guestPreview } from './tripAdvice.preview'

export default function TripAdviceSurface({ controller }: { controller: TripAdviceController }) {
  const [preview, setPreview] = useState(false); const [recommendation, setRecommendation] = useState<RecommendationDialogContext | null>(null)
  const [activeSection, setActiveSection] = useState('Plan')
  if (controller.erased) return <div className="ta-surface"><p role="status">Your feedback has been erased and this guest session has ended.</p></div>
  if (!controller.projection) return <div className="ta-surface"><p role={controller.error ? 'alert' : 'status'}>{controller.error || 'Loading trip advice…'}</p></div>
  const owner = controller.mode === 'owner' ? controller.owner : undefined
  const projection = preview && owner ? guestPreview(controller.projection, owner.config) : controller.projection
  const ownerController = owner?.legacy ? { ...controller, readonly: true } : controller
  const visibleController = preview ? { ...ownerController, projection, mode: 'guest' as const, readonly: true, owner: undefined, suggestions: controller.suggestions.filter(item => !owner?.config.hiddenIdeaKeys.includes(item.key)) } : ownerController
  return <div className="ta-surface">
    {owner && <div className="ta-owner-bar"><strong>TREK</strong><span role="status">{owner.saving ? 'Saving…' : owner.saveState}</span><button type="button" className="ta-button" aria-pressed={preview} onClick={() => { setRecommendation(null); setPreview(value => !value) }}>{preview ? 'Owner view' : 'Guest preview'}</button><button type="button" className="ta-button" onClick={() => void owner.copyLink()}>Copy share link</button></div>}
    {owner?.legacy && <section className="ta-page" aria-label="Upgrade shared design"><p>Your existing link keeps its current design and visibility until you approve this preview.</p><button className="ta-button" type="button" disabled={owner.saving} onClick={() => void owner.upgrade?.()}>Use new design</button></section>}
    <header className="ta-hero"><p>Trip advice</p><h1>{projection.title}</h1><p>Your plan, local ideas and recommendations together.</p><nav aria-label="Advice sections">{['Plan', 'Ideas', 'Comments'].map(section => <button key={section} type="button" className="ta-button" aria-current={activeSection === section ? 'location' : undefined} onClick={() => { setActiveSection(section); scrollAdvice(`ta-${section.toLowerCase()}`) }}>{section}</button>)}</nav></header>
    <main className="ta-page">{controller.error && <p role="alert" className="ta-error">{controller.error}</p>}<p role="status">{controller.status}</p>
      {owner && !preview && <label><input type="checkbox" checked={owner.config.showNotes} disabled={owner.saving || owner.legacy} onChange={event => void owner.setShowNotes(event.target.checked)} /> Display day notes on the shared link</label>}
      <div className="ta-layout"><TripAdviceRoute controller={visibleController} /><section id="ta-plan" tabIndex={-1} aria-label="Plan">{projection.cities.map(city => <TripAdviceCity key={city.id} cityId={city.id} controller={visibleController} />)}<button className="ta-button ta-recommend" type="button" disabled={visibleController.readonly || !projection.cities.length} onClick={() => setRecommendation({ cityId: projection.cities[0].id, category: 'see', full: true })}>Suggest a place</button></section></div>
      <section id="ta-ideas" className="ta-section" tabIndex={-1}><h2>Ideas</h2>{projection.shortlists.flatMap(list => [...list.see, ...list.eat]).map(place => <TripAdvicePlaceRow key={place.key} controller={visibleController} place={place} idea />)}{visibleController.suggestions.map(suggestion => <article key={suggestion.key} className={`ta-card ta-idea${owner?.config.hiddenIdeaKeys.includes(suggestion.key) ? ' ta-hidden' : ''}`}><h3>{suggestion.title}</h3><p className="ta-meta">{[suggestion.primaryType, projection.cities.find(city => city.id === suggestion.cityId)?.label, suggestion.displayName || 'Guest adviser', 'Pending owner review'].filter(Boolean).join(' · ')}</p>{suggestion.reason && <p>{suggestion.reason}</p>}<Visibility controller={visibleController} field="hiddenIdeaKeys" itemKey={suggestion.key} label={suggestion.title} />{controller.mode === 'guest' && suggestion.state === 'pending' && <button className="ta-button" type="button" disabled={visibleController.readonly} onClick={() => setRecommendation({ cityId: suggestion.cityId, dayKey: suggestion.dayKey || undefined, category: suggestion.category, full: true, suggestion })}>Edit</button>}</article>)}</section>
      <TripAdviceComments controller={visibleController} />
      {recommendation && <TripAdviceSuggestionDialog controller={visibleController} context={recommendation} close={() => setRecommendation(null)} />}
    </main>
  </div>
}
