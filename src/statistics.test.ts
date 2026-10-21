import { describe, expect, it } from 'vitest'
import { metrics, project, type PitchType, type Session, type SessionEvent } from './domain'
import { localDate, locationMetrics, resolveDateRange, selectStatistics, validCustomRange } from './statistics'

function pitch(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return { id: 'pitch', sessionId: 's1', pitcherId: 'p1', appearanceId: 'a1', nextAppearanceId: 'a2', sequence: 1, timestamp: '2026-10-20T12:00:00Z', kind: 'pitch', pitchType: 'ball', voidedAt: null, ...overrides }
}
function session(id = 's1', overrides: Partial<Session> = {}): Session {
  return { id, teamId: 't1', recorderId: 'c1', deviceId: 'd1', revision: 0, name: '', notes: '', status: 'ended', initialPitcherId: 'p1', selectedPitcherId: 'p1', pitcherIds: ['p1'], initialAppearanceId: 'a1', nextSequence: 2, startedAt: '2026-10-20T12:00:00Z', endedAt: null, updatedAt: '2026-10-20T12:00:00Z', ...overrides }
}

describe('location metrics', () => {
  const events = [pitch({ pitchLocation: 'upIn' }), pitch({ pitchLocation: 'upIn' }), pitch({ pitchLocation: 'middle' }), pitch(), pitch({ pitchLocation: 'downOut', voidedAt: '2026-10-20T13:00:00Z' }), pitch({ kind: 'next', pitchType: undefined })]
  it('counts only active pitches and uses located pitches as the denominator', () => {
    const stats = locationMetrics(events)
    expect(stats).toMatchObject({ total: 4, located: 3, mostFrequent: ['upIn'] })
    expect(stats.regions[0].percentage).toBeCloseTo(200 / 3)
    expect(stats.regions[3]).toMatchObject({ location: 'downOut', count: 0, percentage: 0 })
  })
  it('includes every outcome in All pitches and only called/swinging in Strikes', () => {
    const events = (['ball', 'called', 'swinging', 'foul', 'inPlay'] as PitchType[]).map(pitchType => pitch({ pitchType, pitchLocation: 'middle' }))
    expect(locationMetrics(events).total).toBe(5)
    expect(locationMetrics(events, 'strikes')).toMatchObject({ total: 2, located: 2 })
    for (const outcome of ['ball', 'foul', 'inPlay'] as const) expect(locationMetrics(events, outcome).total).toBe(1)
  })
  it('reports ties and preserves all five historical screen positions', () => {
    const stats = locationMetrics(['upIn', 'upOut', 'downIn', 'downOut', 'middle'].map(pitchLocation => pitch({ pitchLocation: pitchLocation as SessionEvent['pitchLocation'] })))
    expect(stats.mostFrequent).toEqual(['upIn', 'upOut', 'downIn', 'downOut', 'middle'])
    expect(stats.regions.every(region => region.count === 1 && region.percentage === 20)).toBe(true)
  })
  it('has no maximum or percentages for empty or unlocated results', () => {
    for (const events of [[], [pitch()]]) {
      const stats = locationMetrics(events)
      expect(stats.located).toBe(0)
      expect(stats.mostFrequent).toEqual([])
      expect(stats.regions.every(region => region.percentage === null)).toBe(true)
    }
    expect(locationMetrics([pitch({ pitchType: 'swinging' })], 'strikes')).toMatchObject({ total: 1, located: 0 })
  })
})

describe('local date ranges', () => {
  const now = new Date(2026, 9, 20, 23, 30)
  it.each([
    ['all', null], ['thisWeek', { start: '2026-10-18', end: '2026-10-20' }],
    ['lastWeek', { start: '2026-10-11', end: '2026-10-17' }],
    ['twoWeeks', { start: '2026-10-07', end: '2026-10-20' }],
    ['lastMonth', { start: '2026-09-01', end: '2026-09-30' }],
  ] as const)('resolves %s', (preset, expected) => {
    expect(resolveDateRange({ preset }, now)).toEqual(expected)
  })
  it('starts a new week on Sunday', () => {
    const sunday = new Date(2026, 9, 18)
    expect(resolveDateRange({ preset: 'thisWeek' }, sunday)).toEqual({ start: '2026-10-18', end: '2026-10-18' })
    expect(resolveDateRange({ preset: 'lastWeek' }, sunday)).toEqual({ start: '2026-10-11', end: '2026-10-17' })
  })
  it('handles leap years, month ends and year boundaries', () => {
    expect(resolveDateRange({ preset: 'lastMonth' }, new Date(2024, 2, 31))).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(resolveDateRange({ preset: 'lastMonth' }, new Date(2026, 0, 1))).toEqual({ start: '2025-12-01', end: '2025-12-31' })
    expect(resolveDateRange({ preset: 'twoWeeks' }, new Date(2026, 0, 1))).toEqual({ start: '2025-12-19', end: '2026-01-01' })
  })
  it('uses calendar days across both daylight-saving transitions', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(resolveDateRange({ preset: 'twoWeeks' }, new Date(2026, 2, 14))).toEqual({ start: '2026-03-01', end: '2026-03-14' })
      expect(resolveDateRange({ preset: 'twoWeeks' }, new Date(2026, 10, 7))).toEqual({ start: '2026-10-25', end: '2026-11-07' })
      expect(localDate(new Date('2026-10-21T02:00:00Z'))).toBe('2026-10-20')
    } finally {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })
  it('validates inclusive custom ranges without accepting overflow dates', () => {
    expect(validCustomRange('2024-02-29', '2024-02-29')).toBe(true)
    for (const [start, end] of [['', '2026-01-01'], ['2026-01-01', ''], ['2026-10-21', '2026-10-20'], ['2026-02-29', '2026-03-01'], ['2026-13-01', '2027-01-01']]) expect(validCustomRange(start, end)).toBe(false)
    expect(resolveDateRange({ preset: 'custom', start: '2026-01-01', end: '2026-01-01' })).toEqual({ start: '2026-01-01', end: '2026-01-01' })
  })
})

describe('shared statistics filters', () => {
  const sessions = [session(), session('s2', { teamId: 't2' }), session('s3', { archived: true }), session('old', { startedAt: '2025-01-01T12:00:00Z' })]
  const events = sessions.flatMap(s => ['p1', 'p2'].map(pitcherId => pitch({ id: `${s.id}-${pitcherId}`, sessionId: s.id, pitcherId, pitchLocation: 'upIn', timestamp: '2026-10-21T12:00:00Z' })))
  const data = { sessions, events, appearances: sessions.flatMap(s => project(s, events.filter(e => e.sessionId === s.id && e.pitcherId === 'p1')).appearances) }
  const filters = { pitcherId: 'p1', teamId: 't1', scope: 'all', range: { start: '2026-10-20', end: '2026-10-20' } }
  it('intersects date, team and pitcher, including archived practices and entire sessions', () => {
    const result = selectStatistics(data, filters)
    expect(result.sessions.map(s => s.id)).toEqual(['s1', 's3'])
    expect(result.events.map(e => e.id)).toEqual(['s1-p1', 's3-p1'])
    expect(metrics(result.appearances).total).toBe(2)
    expect(locationMetrics(result.events).total).toBe(2)
  })
  it('intersects current session with dates and handles no current session', () => {
    expect(selectStatistics(data, { ...filters, scope: 'current', currentSessionId: 's3' }).events).toHaveLength(1)
    expect(selectStatistics(data, { ...filters, scope: 'current', currentSessionId: 'old' }).events).toHaveLength(0)
    expect(selectStatistics(data, { ...filters, scope: 'current' }).appearances).toHaveLength(0)
  })
  it('defaults to all data and does not let map outcome change summary metrics', () => {
    const result = selectStatistics(data, { pitcherId: '', teamId: '', scope: 'all', range: null })
    expect(result.events).toHaveLength(8)
    const before = metrics(result.appearances)
    expect(locationMetrics(result.events, 'strikes').total).toBe(0)
    expect(metrics(result.appearances)).toEqual(before)
  })
})
