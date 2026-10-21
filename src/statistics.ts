import { pitchLocations, type Appearance, type PitchLocation, type PitchType, type Session, type SessionEvent } from './domain'

export const locationOutcomes = { all: 'All pitches', ball: 'Balls', strikes: 'Strikes', foul: 'Fouls', inPlay: 'In play' } as const
export type LocationOutcome = keyof typeof locationOutcomes

export function locationMetrics(events: SessionEvent[], outcome: LocationOutcome = 'all') {
  const matches = (type: PitchType) => outcome === 'all' || (outcome === 'strikes' ? type === 'called' || type === 'swinging' : type === outcome)
  const pitches = events.filter(e => e.kind === 'pitch' && !e.voidedAt && e.pitchType && matches(e.pitchType))
  const counts = Object.fromEntries(pitchLocations.map(location => [location, 0])) as Record<PitchLocation, number>
  for (const pitch of pitches) if (pitch.pitchLocation && pitchLocations.includes(pitch.pitchLocation)) counts[pitch.pitchLocation]++
  const located = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const regions = pitchLocations.map(location => ({ location, count: counts[location], percentage: located ? counts[location] / located * 100 : null }))
  const maximum = Math.max(...Object.values(counts))
  return { total: pitches.length, located, regions, mostFrequent: maximum ? pitchLocations.filter(location => counts[location] === maximum) : [] }
}

export const datePresets = { all: 'All time', thisWeek: 'This week', lastWeek: 'Last week', twoWeeks: 'Last two weeks', lastMonth: 'Last month', custom: 'Custom range' } as const
export type DateSelection = { preset: Exclude<keyof typeof datePresets, 'custom'> } | { preset: 'custom'; start: string; end: string }
export interface DateRange { start: string; end: string }

/** Local calendar keys, never UTC conversion of an HTML date input. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function validCustomRange(start: string, end: string): boolean {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && localDate(new Date(`${value}T12:00:00`)) === value
  return validDate(start) && validDate(end) && start <= end
}

export function resolveDateRange(selection: DateSelection, now = new Date()): DateRange | null {
  if (selection.preset === 'all') return null
  if (selection.preset === 'custom') return { start: selection.start, end: selection.end }
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const start = new Date(end)
  if (selection.preset === 'thisWeek') start.setDate(start.getDate() - start.getDay())
  if (selection.preset === 'lastWeek') {
    start.setDate(start.getDate() - start.getDay() - 7)
    end.setDate(start.getDate() + 6)
  }
  if (selection.preset === 'twoWeeks') start.setDate(start.getDate() - 13)
  if (selection.preset === 'lastMonth') {
    start.setDate(1)
    start.setMonth(start.getMonth() - 1)
    end.setDate(0)
  }
  return { start: localDate(start), end: localDate(end) }
}

export function dateRangeLabel(range: DateRange | null): string {
  if (!range) return 'All time'
  const format = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${format(range.start)} – ${format(range.end)}`
}

export function selectStatistics(data: { sessions: Session[]; appearances: Appearance[]; events: SessionEvent[] }, filters: { pitcherId: string; teamId: string; currentSessionId?: string; scope: string; range: DateRange | null }) {
  const sessions = data.sessions.filter(session => {
    const date = localDate(new Date(session.startedAt))
    return (!filters.teamId || session.teamId === filters.teamId) && (filters.scope === 'all' || session.id === filters.currentSessionId) && (!filters.range || date >= filters.range.start && date <= filters.range.end)
  })
  const sessionIds = new Set(sessions.map(session => session.id))
  const includes = (row: { sessionId: string; pitcherId: string }) => sessionIds.has(row.sessionId) && (!filters.pitcherId || row.pitcherId === filters.pitcherId)
  return { sessions, appearances: data.appearances.filter(includes), events: data.events.filter(includes) }
}
