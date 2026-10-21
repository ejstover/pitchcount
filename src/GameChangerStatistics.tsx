import { useState } from 'react'
import type { Snapshot } from './shared'
import { gcComparison, gcCovered, type GCStats } from './gamechanger'
import { dateRangeLabel, selectStatistics, type DateRange } from './statistics'
import { PitchHeatMap } from './PitchHeatMap'
import './gamechanger.css'

export function GameChangerStatistics({ data, mode, pitcherId, range, onCoverage, onImport }: { data: Snapshot; mode: 'game' | 'combined'; pitcherId: string; range: DateRange | null; onCoverage: (range: DateRange) => void; onImport: () => void }) {
  const [teamId, setTeamId] = useState(''), [summaryId, setSummaryId] = useState('')
  const summaries = data.gcSummaries ?? []
  const summary = summaries.find(s => s.id === summaryId && s.teamId === teamId)
  const covered = !!summary && gcCovered(summary, range)
  const players = covered ? summary.players.filter(p => !pitcherId || p.pitcherId === pitcherId) : []
  const selected = selectStatistics(data, { pitcherId, teamId, scope: 'all', range })
  const comparison = gcComparison(selected.appearances, players)
  const [outcome, setOutcome] = useState<'all' | 'ball' | 'strikes' | 'foul' | 'inPlay'>('all')
  const rows = [['total', 'Pitches'], ['batters', 'Batters faced'], ['walks', 'Walks'], ['strikeouts', 'Strikeouts'], ['walkPct', 'Walk %'], ['pitchesPerBatter', 'Pitches / batter'], ['strikePct', 'Strike %'], ['firstPitchPct', 'First-pitch strike %']] as const
  const format = (key: string, value: number | null) => value === null ? '—' : key.endsWith('Pct') ? `${value.toFixed(1)}%` : key === 'pitchesPerBatter' ? value.toFixed(2) : String(value)
  const detailFields: [keyof GCStats, string][] = [['games', 'Games pitched'], ['outs', 'Innings'], ['hits', 'Hits'], ['runs', 'Runs'], ['earnedRuns', 'Earned runs'], ['hitBatters', 'Hit batters'], ['wildPitches', 'Wild pitches'], ['era', 'ERA'], ['whip', 'WHIP']]
  return <div className="gc-statistics">
    <div className="filter-bar"><label className="field-label">Comparison team<select aria-label="Comparison team" value={teamId} onChange={e => { setTeamId(e.target.value); setSummaryId('') }}><option value="">Choose team</option>{data.teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (archived)' : ''}</option>)}</select></label><label className="field-label">GC season<select aria-label="GC season" value={summaryId} disabled={!teamId} onChange={e => { setSummaryId(e.target.value); const s = summaries.find(s => s.id === e.target.value); if (s) onCoverage({ start: s.coverageStart, end: s.coverageEnd }) }}><option value="">Choose season</option>{summaries.filter(s => s.teamId === teamId).map(s => <option key={s.id} value={s.id}>{s.season}</option>)}</select></label><button onClick={onImport}>Import GameChanger CSV</button></div>
    {!summary ? <section className="card settings-card"><h2>Compare practice with game results</h2><p>Choose a team and imported season to review game results and compatible practice measures. Import a CSV in Settings to get started.</p></section> : <>
      <section className="card settings-card"><span className="eyebrow">{summary.season}</span><h2>{mode === 'combined' ? 'Practice + GameChanger' : 'GameChanger pitching'}</h2><p>GC coverage: {summary.coverageStart} – {summary.coverageEnd}. Practice range: {dateRangeLabel(range)}.</p><p className="settings-help">Imported by {summary.importedByName} · Updated {new Date(summary.updatedAt).toLocaleString()}</p>
        {!covered && <p className="settings-notice" role="status">GC is excluded because the selected dates do not contain its full coverage. Season totals cannot be split into smaller periods. <button onClick={() => onCoverage({ start: summary.coverageStart, end: summary.coverageEnd })}>Use GC coverage dates</button></p>}
        {covered && !players.length && <p className="settings-notice">No imported pitching row matches this pitcher.</p>}
        <div className="gc-table-wrap"><table className="gc-table"><caption>Selected pitcher rows{mode === 'combined' ? ' compared with practice' : ''}</caption><thead><tr><th>Measure</th>{mode === 'combined' && <th>Practice</th>}<th><abbr title="GameChanger">GC games</abbr></th>{mode === 'combined' && <th>Combined</th>}</tr></thead><tbody>{rows.map(([key, label]) => <tr key={key}><th>{label}</th>{mode === 'combined' && <td>{format(key, comparison.practice[key])}</td>}<td>{format(key, comparison.game[key])}</td>{mode === 'combined' && <td>{format(key, covered && players.length ? comparison.combined[key] : comparison.practice[key])}{covered && players.length > 0 && ['strikePct', 'firstPitchPct'].includes(key) && comparison.combined[key] !== null && <small>Estimated</small>}</td>}</tr>)}</tbody></table></div>
        <p className="settings-help">Combined strike rates estimate GC strike counts from its rounded percentages, weighted by pitches or batters faced. They do not reconstruct pitches. A missing GC rate makes that combined rate unavailable. GC and practice scoring definitions may differ.</p>
        {(['strikePct', 'firstPitchPct'] as const).filter(key => players.some(p => p.stats[key] === null && (p.stats[key === 'strikePct' ? 'pitches' : 'batters'] ?? 0) > 0)).map(key => <p key={key} className="settings-notice">Missing {key === 'strikePct' ? 'strike percentage' : 'first-pitch strike percentage'} for: {players.filter(p => p.stats[key] === null).map(p => p.name).join(', ')}.</p>)}
        {summary.warnings.map(w => <p className="settings-notice" key={w}>{w}</p>)}
        {!!summary.teamTotals && <details><summary>GC reported team totals (source reference)</summary><p>{summary.teamTotals.pitches ?? '—'} pitches · {summary.teamTotals.batters ?? '—'} batters faced · {summary.teamTotals.walks ?? '—'} walks · {summary.teamTotals.strikeouts ?? '—'} strikeouts · {summary.teamTotals.games ?? '—'} team games. These may differ from selected player rows.</p></details>}
      </section>
      {covered && players.map(p => <section className="card settings-card" key={p.sourceKey}><h3>{data.pitchers.find(n => n.id === p.pitcherId)?.name ?? p.name} · Game details</h3><dl className="gc-detail-grid">{detailFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{p.stats[key] === null ? '—' : key === 'outs' ? `${Math.floor(p.stats.outs! / 3)}.${p.stats.outs! % 3}` : p.stats[key]}</dd></div>)}</dl><details><summary>All source pitching values</summary><dl className="gc-detail-grid">{Object.entries(p.sourceValues).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>)}</dl></details></section>)}
      {mode === 'combined' && <><h2 className="subheading">Practice locations</h2><p>GameChanger summaries contain no pitch locations or complete pitch-outcome breakdown. This map uses recorded practice pitches only.</p><PitchHeatMap events={selected.events} outcome={outcome} onOutcomeChange={setOutcome} /></>}
    </>}
  </div>
}
