import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { pitchLabels, pitchLocationLabels, pitchLocations, type PitchLocation, type PitchType } from './domain'

type SpecialOutcome = 'swinging' | 'foul' | 'inPlay'
type Target = { type: 'ball' | 'called'; location: PitchLocation }
const quadrants = pitchLocations.filter(location => location !== 'middle')
const specialOutcomes: [SpecialOutcome, string][] = [['swinging', 'Swing'], ['foul', 'Foul'], ['inPlay', 'In play']]

/** The visible octagon, inner square and circle share these boundaries. */
export function pitchTargetAt(x: number, y: number): Target | null {
  if (x < 0 || y < 0 || x > 1 || y > 1 || x + y < .2 || (1 - x) + y < .2 || x + (1 - y) < .2 || (1 - x) + (1 - y) < .2) return null
  const type = x >= .2 && x <= .8 && y >= .2 && y <= .8 ? 'called' : 'ball'
  const location = type === 'called' && Math.hypot(x - .5, y - .5) <= .1 ? 'middle'
    : y < .5 ? x < .5 ? 'upIn' : 'upOut' : x < .5 ? 'downIn' : 'downOut'
  return { type, location }
}

export function PitchRecorder({ disabled, record }: { disabled: boolean; record: (type: PitchType, location?: PitchLocation) => void }) {
  const [outcome, setOutcome] = useState<SpecialOutcome | null>(null)
  const [preview, setPreview] = useState<Target | null>(null)
  const [feedback, setFeedback] = useState('')
  const gesture = useRef<{ id: number; outcome: SpecialOutcome | null } | null>(null)
  // Refs make one-shot outcomes safe even when several taps precede a render.
  const selectedOutcome = useRef<SpecialOutcome | null>(null)
  const hintId = useId()
  const selectOutcome = (next: SpecialOutcome | null) => { selectedOutcome.current = next; setOutcome(next) }
  useEffect(() => {
    const cancel = () => { gesture.current = null; setPreview(null) }
    window.addEventListener('resize', cancel)
    return () => window.removeEventListener('resize', cancel)
  }, [])
  useEffect(() => {
    if (disabled) { gesture.current = null; setPreview(null); selectOutcome(null) }
  }, [disabled])
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 1600)
    return () => window.clearTimeout(timer)
  }, [feedback])

  function commit(target: Target, special = selectedOutcome.current) {
    if (disabled) return
    const type = special ?? target.type
    record(type, target.location)
    setFeedback(`${pitchLabels[type]} · ${pitchLocationLabels[target.location]}`)
    selectOutcome(null)
  }
  function targetAt(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return pitchTargetAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
  }
  function resetGesture() { gesture.current = null; setPreview(null) }

  return <section className="pitch-recorder" aria-label="Record a pitch" onKeyDown={event => {
    if (event.key === 'Escape') { resetGesture(); selectOutcome(null) }
  }}>
    <div className="zone-column">
      <div className="zone-legend" aria-hidden="true"><span><i className="legend-strike" />Inside · Strike</span><span><i className="legend-ball" />Outside · Ball</span></div>
      <div className={`single-pitch-zone ${disabled ? 'zone-disabled' : ''}`} role="group" aria-label="Pitch location, pitcher’s view" aria-describedby={hintId}
        onPointerDown={event => {
          if (disabled || !event.isPrimary || event.button !== 0 || gesture.current) return
          const target = targetAt(event)
          if (!target) return
          gesture.current = { id: event.pointerId, outcome: selectedOutcome.current }
          event.currentTarget.setPointerCapture(event.pointerId)
          setPreview(target)
        }}
        onPointerMove={event => { if (gesture.current?.id === event.pointerId) setPreview(targetAt(event)) }}
        onPointerUp={event => {
          if (gesture.current?.id !== event.pointerId) return
          const special = gesture.current.outcome
          const target = targetAt(event)
          resetGesture()
          if (target) commit(target, special)
        }}
        onPointerCancel={resetGesture} onLostPointerCapture={resetGesture}>
        {(['ball', 'called'] as const).flatMap(type => (type === 'ball' ? quadrants : pitchLocations).map(location => {
          const active = preview?.type === type && preview.location === location
          return <button key={`${type}-${location}`} type="button" disabled={disabled}
            className={`zone-target zone-${type} zone-${location} ${active ? 'zone-preview' : ''}`}
            aria-label={`${pitchLabels[outcome ?? type]}, ${pitchLocationLabels[location].toLowerCase()}${outcome ? `, ${type === 'ball' ? 'outside' : 'inside'} zone` : ''}`}
            onClick={event => { if (event.detail === 0) commit({ type, location }) }} />
        }))}
        <svg className="zone-lines" viewBox="0 0 100 100" aria-hidden="true">
          <path className="zone-outer-lines" d="M50 0V6M50 15V20M0 50H5M15 50H20M80 50H85M95 50H100M50 80V86M50 97V100M20 0 0 20V80L20 100H80L100 80V20L80 0ZM20 20H80V80H20Z" />
          <path className="zone-inner-lines" d="M50 20V40M20 50H40M60 50H80M50 60V80" />
          <circle className="zone-center-line" cx="50" cy="50" r="10" />
          <g className="zone-labels"><text x="50" y="11">HIGH</text><text x="50" y="92">LOW</text><text transform="translate(10 50) rotate(-90)">LEFT</text><text transform="translate(90 50) rotate(90)">RIGHT</text></g>
        </svg>
      </div>
      <p className="zone-perspective">Pitcher’s view · Looking toward home plate</p>
    </div>
    <div className="zone-options">
      <div className="zone-instructions" id={hintId}>
        <strong>{outcome ? `${pitchLabels[outcome]} selected` : 'Tap a location'}</strong>
        <span>{outcome ? 'Tap the zone for this pitch.' : 'Inside for a strike. Outside for a ball.'}</span>
      </div>
      <div className="zone-outcomes" role="group" aria-label="Pitch outcome for next pitch">
        {specialOutcomes.map(([type, label]) => <button key={type} disabled={disabled} type="button"
          className={`zone-outcome outcome-${type}`} aria-pressed={outcome === type}
          onClick={() => selectOutcome(selectedOutcome.current === type ? null : type)}>{label}</button>)}
      </div>
      <div className="zone-message" role="status" aria-live="polite" aria-atomic="true">
        {outcome ? `Tap ${specialOutcomes.find(([type]) => type === outcome)?.[1]} again to cancel.` : feedback || 'Tap, or slide and lift to record.'}
      </div>
      {outcome === 'swinging' && <button className="text-button unlocated-swing" disabled={disabled} onClick={() => {
        record('swinging'); selectOutcome(null); setFeedback('Swinging strike · Location not recorded')
      }}>Record without location</button>}
    </div>
  </section>
}
