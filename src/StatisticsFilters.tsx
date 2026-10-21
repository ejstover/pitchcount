import type { Pitcher, Team } from './domain'
import { StatisticsDateFilter } from './StatisticsDateFilter'
import type { DateRange, DateSelection } from './statistics'

export type StatisticsSource = 'practice' | 'game' | 'combined'
interface Props {
  teams: Team[]; pitchers: Pitcher[]; teamId: string; pitcherId: string; source: StatisticsSource
  dates: DateSelection; range: DateRange | null
  onTeam: (id: string) => void; onPitcher: (id: string) => void; onSource: (source: StatisticsSource) => void
  onDates: (dates: DateSelection) => void
}
export function StatisticsFilters({ teams, pitchers, teamId, pitcherId, source, dates, range, onTeam, onPitcher, onSource, onDates }: Props) {
  return <section className="card statistics-filters" aria-label="Statistics filters">
    <div className="statistics-filter-grid">
      <label className="field-label statistics-team">Team<select aria-label="Statistics team" value={teamId} onChange={e => onTeam(e.target.value)}><option value="">All teams</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.archived ? ' (archived)' : ''}</option>)}</select></label>
      <label className="field-label statistics-pitcher">Pitcher<select aria-label="Statistics pitcher" value={pitcherId} onChange={e => onPitcher(e.target.value)}><option value="">All pitchers</option>{pitchers.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>)}</select></label>
      <StatisticsDateFilter compact value={dates} range={range} onChange={onDates} trailingControl={
        <label className="field-label statistics-source">Source<select aria-label="Statistics source" value={source} onChange={e => onSource(e.target.value as StatisticsSource)}><option value="combined">Combined</option><option value="practice">Practice</option><option value="game">Games</option></select></label>
      } />
    </div>
  </section>
}
