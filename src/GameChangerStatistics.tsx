import { useState } from 'react'
import type { Snapshot } from './shared'
import { gcComparison, type GCStats } from './gamechanger'
import { dateRangeLabel, selectGameChangerSummaries, selectStatistics, type DateRange } from './statistics'
import { PitchHeatMap } from './PitchHeatMap'
import './gamechanger.css'

interface Props {
  data: Snapshot; mode: 'game' | 'combined'; teamId: string; pitcherId: string; range: DateRange | null
  onAllTime: () => void
}
export function GameChangerStatistics({ data, mode, teamId, pitcherId, range, onAllTime }: Props) {
  const { included, conflicts, partial } = selectGameChangerSummaries(data.gcSummaries ?? [], { teamId, pitcherId, range })
  const players = included.flatMap(s => s.players.filter(p => !pitcherId || p.pitcherId === pitcherId))
  const selected = selectStatistics(data, { pitcherId, teamId, scope: 'all', range })
  const comparison = gcComparison(selected.appearances, players)
  const [outcome, setOutcome] = useState<'all' | 'ball' | 'strikes' | 'foul' | 'inPlay'>('all')
  const rows = [['total', 'Pitches'], ['batters', 'Batters faced'], ['walks', 'Walks'], ['strikeouts', 'Strikeouts'], ['walkPct', 'Walk %'], ['pitchesPerBatter', 'Pitches / batter'], ['strikePct', 'Strike %'], ['firstPitchPct', 'First-pitch strike %']] as const
  const format = (key: string, value: number | null) => value === null ? '—' : key.endsWith('Pct') ? `${value.toFixed(1)}%` : key === 'pitchesPerBatter' ? value.toFixed(2) : String(value)
  const title = pitcherId ? data.pitchers.find(p => p.id === pitcherId)?.name : teamId ? data.teams.find(t => t.id === teamId)?.name : 'The whole roster'
  const detailFields: [keyof GCStats, string][] = [['games', 'Games pitched'], ['outs', 'Innings'], ['hits', 'Hits'], ['runs', 'Runs'], ['earnedRuns', 'Earned runs'], ['hitBatters', 'Hit batters'], ['wildPitches', 'Wild pitches'], ['era', 'ERA'], ['whip', 'WHIP']]
  const teamName = (id: string) => data.teams.find(t => t.id === id)?.name ?? 'Team'
  return <div className="gc-statistics">
    <section className="card settings-card stats-overview">
      <div className="section-heading"><div><span className="eyebrow">{mode === 'combined' ? 'PRACTICE + GAMES' : 'GAME RESULTS'}</span><h2>{title}</h2></div><span className="small-label">{dateRangeLabel(range)}</span></div>
      {!!partial.length && <p className="settings-notice" role="status">{partial.length} game {partial.length === 1 ? 'summary is' : 'summaries are'} excluded because the dates cover only part of the imported totals. <button className="text-button" onClick={onAllTime}>Show all time</button></p>}
      {!!conflicts.length && <div className="settings-notice" role="status"><strong>Overlapping game summaries excluded.</strong><p>Practice and other game data are still included. Review coverage or remove duplicate summaries in account settings.</p><ul>{conflicts.map(s => <li key={s.id}>{teamName(s.teamId)} · {s.season} · {s.coverageStart} – {s.coverageEnd}</li>)}</ul></div>}
      {!players.length && <p className="settings-help">{mode === 'combined' ? 'Showing practice results only. ' : ''}No imported games match these filters. Game data can be imported in account settings.</p>}
      <div className="gc-table-wrap"><table className="gc-table"><caption>{mode === 'combined' ? 'Practice and game results' : 'Imported game results'}</caption><thead><tr><th>Measure</th>{mode === 'combined' && <th>Practice</th>}<th><abbr title="GameChanger">GC games</abbr></th>{mode === 'combined' && <th>Combined</th>}</tr></thead><tbody>{rows.map(([key, label]) => <tr key={key}><th>{label}</th>{mode === 'combined' && <td>{format(key, comparison.practice[key])}</td>}<td>{format(key, comparison.game[key])}</td>{mode === 'combined' && <td>{format(key, players.length ? comparison.combined[key] : comparison.practice[key])}{players.length > 0 && ['strikePct', 'firstPitchPct'].includes(key) && comparison.combined[key] !== null && <small>Estimated</small>}</td>}</tr>)}</tbody></table></div>
      {(['strikePct', 'firstPitchPct'] as const).filter(key => players.some(p => p.stats[key] === null && (p.stats[key === 'strikePct' ? 'pitches' : 'batters'] ?? 0) > 0)).map(key => <p key={key} className="settings-notice">Missing {key === 'strikePct' ? 'strike percentage' : 'first-pitch strike percentage'} for: {[...new Set(players.filter(p => p.stats[key] === null).map(p => p.name))].join(', ')}.</p>)}
      <details className="gc-data-details"><summary>Data coverage & calculation notes{included.length ? ` · ${included.length} game ${included.length === 1 ? 'summary' : 'summaries'}` : ''}</summary>
        <p>Practice uses session start dates in your local time. Game summaries are included only when their full coverage falls within the selected dates. Overlapping summaries for the same team are excluded to prevent double counting.</p>
        <p>Combined strike rates are estimates, weighted by pitches or batters faced using GC's rounded rates. Missing rates stay unavailable. Practice and game scoring definitions may differ. Heat maps and pitch-outcome details use recorded practice pitches only.</p>
        {included.map(s => <div key={s.id}><h3>{teamName(s.teamId)} · {s.season}</h3><p>{s.coverageStart} – {s.coverageEnd} · Imported by {s.importedByName} · Updated {new Date(s.updatedAt).toLocaleString()}</p>{s.warnings.map(w => <p key={w} className="settings-notice">{w}</p>)}{s.teamTotals && <p>GC reported team totals: {s.teamTotals.pitches ?? '—'} pitches · {s.teamTotals.batters ?? '—'} batters faced · {s.teamTotals.walks ?? '—'} walks · {s.teamTotals.strikeouts ?? '—'} strikeouts · {s.teamTotals.games ?? '—'} games. Results above sum selected player rows; games pitched are not added into a unique team game count.</p>}</div>)}
        {partial.map(s => <p key={s.id}>Outside full date coverage: {teamName(s.teamId)} · {s.season} · {s.coverageStart} – {s.coverageEnd}</p>)}
      </details>
    </section>
    {!!players.length && <details className="card settings-card gc-game-details"><summary>Game details</summary>{included.map(s => <div key={s.id}><p className="eyebrow">{teamName(s.teamId)} · {s.season}</p>{s.players.filter(p => !pitcherId || p.pitcherId === pitcherId).map(p => <section className="gc-player-detail" key={p.sourceKey}><h3>{data.pitchers.find(n => n.id === p.pitcherId)?.name ?? p.name}</h3><dl className="gc-detail-grid">{detailFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{p.stats[key] === null ? '—' : key === 'outs' ? `${Math.floor(p.stats.outs! / 3)}.${p.stats.outs! % 3}` : p.stats[key]}</dd></div>)}</dl><details><summary>All source pitching values</summary><dl className="gc-detail-grid">{Object.entries(p.sourceValues).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl></details></section>)}</div>)}</details>}
    {mode === 'combined' && <PitchHeatMap events={selected.events} outcome={outcome} onOutcomeChange={setOutcome} />}
  </div>
}
