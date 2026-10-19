import { describe, expect, it } from 'vitest'
import { metrics, project, type PitchType, type Session, type SessionEvent } from './domain'

const session: Session = { id: 'session', name: '', notes: '', startedAt: '2026-10-18T12:00:00Z', updatedAt: '2026-10-18T12:00:00Z', endedAt: null, status: 'active', initialPitcherId: 'p1', initialAppearanceId: 'a1', selectedPitcherId: 'p1', pitcherIds: ['p1'], nextSequence: 1 }
function pitches(...types: PitchType[]): SessionEvent[] {
  return types.map((pitchType, index) => ({ id: `e${index}`, sessionId: session.id, pitcherId: 'p1', appearanceId: 'a1', sequence: index + 1, timestamp: session.startedAt, nextAppearanceId: `after-${index}`, kind: 'pitch', pitchType, voidedAt: null }))
}
function boundary(kind: 'next' | 'reset' | 'switch', sequence: number, pitcherId = 'p1'): SessionEvent {
  return { id: `boundary-${sequence}`, sessionId: session.id, pitcherId, appearanceId: 'a1', sequence, timestamp: session.startedAt, nextAppearanceId: `manual-${sequence}`, kind, voidedAt: null }
}
describe('pitch counting', () => {
  it('separates official pitch totals from the batter count', () => {
    const result = project(session, pitches('ball', 'called', 'foul', 'foul', 'foul'))
    expect(result.current).toMatchObject({ balls: 1, strikes: 2 })
    expect(metrics(result.appearances)).toMatchObject({ total: 5, positive: 4, strikePct: 80 })
  })
  it('ends four balls as a walk and opens the next batter', () => {
    const result = project(session, pitches('ball', 'ball', 'ball', 'ball'))
    expect(result.appearances[0].outcome).toBe('walk')
    expect(result.current).toMatchObject({ balls: 0, strikes: 0, pitches: [] })
    expect(metrics(result.appearances)).toMatchObject({ batters: 1, walks: 1, walkPct: 100, pitchesPerBatter: 4 })
  })
  it('counts called and swinging strikes separately and strikes out on three', () => {
    const result = project(session, pitches('called', 'swinging', 'swinging'))
    expect(result.appearances[0].outcome).toBe('strikeout')
    expect(metrics(result.appearances)).toMatchObject({ called: 1, swinging: 2, strikeouts: 1, strikePct: 100 })
  })
  it('two-strike fouls do not strike out a batter', () => {
    const result = project(session, pitches('foul', 'foul', 'foul', 'foul', 'foul'))
    expect(result.current).toMatchObject({ strikes: 2, outcome: null })
    expect(metrics(result.appearances)).toMatchObject({ total: 5, fouls: 5, positive: 5, strikeouts: 0 })
  })
  it('in-play finishes the appearance and counts as a positive outcome', () => {
    const result = project(session, pitches('ball', 'inPlay'))
    expect(result.appearances[0].outcome).toBe('inPlay')
    expect(metrics(result.appearances)).toMatchObject({ inPlay: 1, strikePct: 50, walks: 0, strikeouts: 0 })
  })
  it.each(['next', 'reset', 'switch'] as const)('%s preserves pitches without inventing a walk or strikeout', kind => {
    const result = project(session, [...pitches('ball', 'called'), boundary(kind, 3, kind === 'switch' ? 'p2' : 'p1')])
    expect(result.current).toMatchObject({ balls: 0, strikes: 0, pitcherId: kind === 'switch' ? 'p2' : 'p1' })
    expect(metrics(result.appearances)).toMatchObject({ total: 2, walks: 0, strikeouts: 0, batters: 1 })
  })
  it('uses started appearances for first pitch metrics, including foul and in-play', () => {
    const result = project(session, [
      ...pitches('inPlay'),
      { ...pitches('foul')[0], id: 'second', sequence: 2, nextAppearanceId: 'unused' },
      boundary('next', 3),
      { ...pitches('ball')[0], id: 'third', sequence: 4 },
      boundary('next', 5), boundary('next', 6),
    ])
    const stats = metrics(result.appearances)
    expect(stats.batters).toBe(3)
    expect(stats.firstPitchPct).toBeCloseTo(200 / 3)
    expect(stats.strikePct).toBeCloseTo(200 / 3)
  })
  it('returns null for undefined ratios rather than misleading zeros', () => {
    expect(metrics(project(session, []).appearances)).toMatchObject({ total: 0, batters: 0, strikePct: null, firstPitchPct: null, walkPct: null, pitchesPerBatter: null })
  })
  it.each([
    ['walk', ['ball', 'ball', 'ball', 'ball']],
    ['strikeout', ['called', 'called', 'swinging']],
    ['inPlay', ['ball', 'inPlay']],
  ] as [string, PitchType[]][])('voiding the terminal pitch reverses a %s', (_, types) => {
    const events = pitches(...types)
    events[events.length - 1].voidedAt = session.startedAt
    const result = project(session, events)
    expect(result.appearances).toHaveLength(1)
    expect(result.current.outcome).toBeNull()
    expect(result.current.pitches).toHaveLength(types.length - 1)
    expect(metrics(result.appearances)).toMatchObject({ walks: 0, strikeouts: 0 })
  })
  it('retains a later explicit manual boundary after undo', () => {
    const events = pitches('ball', 'ball', 'ball', 'ball')
    events[3].voidedAt = session.startedAt
    const result = project(session, [...events, boundary('next', 5)])
    expect(result.appearances[0]).toMatchObject({ balls: 3, outcome: 'manual' })
    expect(result.current.pitches).toHaveLength(0)
    expect(metrics(result.appearances).walks).toBe(0)
  })
  it('orders source events by per-session sequence, not timestamps or array order', () => {
    const events = pitches('ball', 'inPlay', 'called')
    expect(project(session, events.reverse()).current).toMatchObject({ strikes: 1, balls: 0 })
  })
})
