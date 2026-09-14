import { useState } from 'react'
import type { TripAdviceController } from './tripAdvice.types'
import type { AdviceCommentAnchorV2 } from '@trek/shared'
import { scrollAdvice } from './TripAdviceRoute'
import { dayLabel } from './tripAdvice.day'

export default function TripAdviceComments({ controller }: { controller: TripAdviceController }) {
  const [text, setText] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [erase, setErase] = useState(false)
  const [anchorKey, setAnchorKey] = useState('')
  const targets: { anchor: AdviceCommentAnchorV2; label: string }[] = controller.projection?.cities.map(city => ({ anchor: { kind: 'city', key: city.id }, label: city.label })) || []
  const places = new Map<string, string>()
  controller.projection?.stays.forEach(stay => stay.days.forEach(day => { targets.push({ anchor: { kind: 'day', key: day.key }, label: dayLabel(controller, day) }); day.schedule.forEach(row => places.set(row.place.key, row.place.title)) }))
  controller.projection?.shortlists.forEach(list => [...list.see, ...list.eat].forEach(place => places.set(place.key, place.title)))
  places.forEach((label, key) => targets.push({ anchor: { kind: 'place', key }, label }))
  const targetKey = (anchor: AdviceCommentAnchorV2) => `${anchor.kind}:${anchor.key}`
  function jump(anchor: AdviceCommentAnchorV2) {
    if (anchor.kind === 'place') { const target = [...document.querySelectorAll<HTMLElement>('[data-place-key]')].find(element => element.dataset.placeKey === anchor.key); if (target) scrollAdvice(target.id) }
    else scrollAdvice(`ta-${anchor.kind}-${anchor.key}`)
  }
  async function send() { setBusy(true); setError(''); try { await controller.comment(text.trim(), name.trim() || undefined, targets.find(target => targetKey(target.anchor) === anchorKey)?.anchor); setText('') } catch (caught) { setError(caught instanceof Error ? caught.message : 'Comment could not be sent.') } finally { setBusy(false) } }
  return <section id="ta-comments" className="ta-section" tabIndex={-1}><h2>Comments</h2>{controller.comments.map(comment => <article key={comment.id} className="ta-card ta-comment"><strong>{comment.displayName || 'Guest adviser'}</strong>{comment.anchor && <button type="button" className="ta-anchor-link" onClick={() => jump(comment.anchor!)}>{targets.find(target => targetKey(target.anchor) === targetKey(comment.anchor!))?.label || 'Trip item'}</button>}<p>{comment.text}</p><button type="button" className="ta-button" disabled={controller.readonly} onClick={() => void controller.deleteComment(comment.id)}>{controller.mode === 'owner' ? 'Delete comment' : 'Delete my comment'}</button></article>)}
    <form onSubmit={event => { event.preventDefault(); void send() }}><fieldset disabled={controller.readonly}><label htmlFor="ta-comment-target">About</label><select id="ta-comment-target" value={anchorKey} onChange={event => setAnchorKey(event.target.value)}><option value="">The whole trip</option>{targets.map(target => <option key={targetKey(target.anchor)} value={targetKey(target.anchor)}>{target.label}</option>)}</select><label htmlFor="ta-comment-name">Display name (optional)</label><input id="ta-comment-name" maxLength={60} value={name} onChange={event => setName(event.target.value)} /><label htmlFor="ta-comment">A note for the trip owner</label><textarea id="ta-comment" required maxLength={2000} value={text} onChange={event => setText(event.target.value)} /><button className="ta-button ta-primary" disabled={busy || !text.trim()}>Send comment</button></fieldset></form>
    {error && <p role="alert" className="ta-error">{error}</p>}
    {controller.mode === 'guest' && !controller.readonly && <div>{erase ? <><p>Erase your votes, comments and pending suggestions and end this guest session?</p><button className="ta-button" type="button" onClick={() => void controller.erase()}>Confirm erasure</button><button className="ta-button" type="button" onClick={() => setErase(false)}>Cancel</button></> : <button className="ta-button" type="button" onClick={() => setErase(true)}>Erase my feedback</button>}</div>}
  </section>
}
