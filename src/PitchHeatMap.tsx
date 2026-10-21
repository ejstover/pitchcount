import { useId, useState } from 'react'
import { percent, pitchLocationLabels, type SessionEvent } from './domain'
import { locationMetrics, locationOutcomes, type LocationOutcome } from './statistics'
import './statistics.css'

export function PitchHeatMap({ events, outcome: controlledOutcome, onOutcomeChange, embedded = false }: { events: SessionEvent[]; outcome?: LocationOutcome; onOutcomeChange?: (outcome: LocationOutcome) => void; embedded?: boolean }) {
  const [localOutcome, setLocalOutcome] = useState<LocationOutcome>('all')
  const outcome = controlledOutcome ?? localOutcome
  const headingId = useId()
  const stats = locationMetrics(events, outcome)
  const frequentLabel = outcome === 'ball' ? 'Most common ball location' : 'Most frequent location'
  return <section className={`pitch-heatmap ${embedded ? 'heatmap-embedded' : 'card'}`} aria-labelledby={headingId}>
    <div className="heatmap-heading"><div><h3 id={headingId}>Pitch locations</h3><p>Pitcher’s view — looking toward home plate</p></div>
      <label className="heatmap-outcome">Outcome<select aria-label="Outcome" value={outcome} onChange={event => {
        const next = event.target.value as LocationOutcome
        setLocalOutcome(next); onOutcomeChange?.(next)
      }}>{Object.entries(locationOutcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <div className="heatmap-content">
      <div className="heatmap-visual">
        <div className="heatmap-sides" aria-hidden="true"><span>LEFT</span><span>RIGHT</span></div>
        <div className={`heatmap-regions ${stats.located ? '' : 'heatmap-empty'}`} role="group" aria-label="Recorded pitch regions">
          {stats.regions.map(region => {
            const strength = (region.percentage ?? 0) / 100
            const color = [243, 242, 223].map((channel, index) => Math.round(channel + ([31, 80, 57][index] - channel) * strength))
            return <div key={region.location} role="group" className={`heatmap-region heatmap-${region.location}`} style={{ backgroundColor: `rgb(${color.join(',')})` }} aria-label={`${pitchLocationLabels[region.location]}: ${region.count} pitches, ${region.percentage === null ? 'no located pitches' : `${region.percentage.toFixed(1)}%`}`}>
              <span className="heatmap-region-data"><span className="heatmap-region-name">{pitchLocationLabels[region.location]}</span><strong>{region.count}</strong><span>{percent(region.percentage)}</span></span>
            </div>
          })}
        </div>
        <div className="heatmap-legend"><span>Share of located pitches</span><div className="heatmap-ramp" /><div className="heatmap-ticks"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div></div>
      </div>
      <div className="heatmap-insights" aria-live="polite">
        <p className="heatmap-coverage">Locations recorded for <strong>{stats.located} of {stats.total}</strong> pitches.</p>
        {stats.located ? <div className="heatmap-frequent"><span>{frequentLabel}{stats.mostFrequent.length > 1 ? ' (tie)' : ''}</span><strong>{stats.mostFrequent.map(location => pitchLocationLabels[location]).join(' · ')}</strong></div> : <p className="heatmap-no-data">{stats.total ? 'No locations recorded for these pitches.' : 'No matching pitches in this view.'}</p>}
        <p>Each percentage uses pitches with a recorded location for the selected outcome. Strikes includes called and swinging strikes.</p>
        {outcome === 'ball' && <p>Ball locations show where pitches ended up. Measuring misses from a target requires recording the intended target.</p>}
        <details><summary>About historical locations</summary><p>Earlier “in” locations appear on the left and “out” locations on the right, matching their original recording positions. No batter handedness was recorded.</p></details>
      </div>
    </div>
  </section>
}
