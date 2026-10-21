export type PitchType = 'ball' | 'called' | 'swinging' | 'foul' | 'inPlay'
export const pitchLocations = ['upIn', 'upOut', 'downIn', 'downOut', 'middle'] as const
export type PitchLocation = typeof pitchLocations[number]
export const pitchLocationLabels: Record<PitchLocation, string> = {
  upIn: 'Up and in', upOut: 'Up and out', downIn: 'Down and in', downOut: 'Down and out', middle: 'Down the middle',
}
export type Outcome = 'walk' | 'strikeout' | 'inPlay' | 'manual' | 'reset' | 'switch' | 'end'
export interface Team { id: string; name: string; archived?: boolean; createdAt: string; updatedAt: string }
export interface Coach { id: string; name: string; email: string; role: 'admin' | 'coach' | 'viewer'; active: boolean }
export interface TeamPitcher { teamId: string; pitcherId: string; active: boolean }
export interface TeamCoach { teamId: string; coachId: string }
export interface Invitation { id: string; teamId: string; email: string; teamName: string; createdAt: string }
export interface Pitcher {
  id: string; name: string; jersey: string; ownerId: string
  archived: boolean; createdAt: string; updatedAt: string
}
export interface Session {
  id: string; name: string; notes: string; startedAt: string; updatedAt: string
  endedAt: string | null; status: 'active' | 'paused' | 'ended'
  initialPitcherId: string; initialAppearanceId: string; selectedPitcherId: string
  pitcherIds: string[]; nextSequence: number
  teamId: string | null; recorderId: string; deviceId: string; revision: number
  recovered?: boolean
  /** Server-owned metadata; scoring uploads cannot change this. */
  archived?: boolean
}
export interface SessionEvent {
  id: string; sessionId: string; pitcherId: string; appearanceId: string
  sequence: number; timestamp: string; nextAppearanceId: string
  kind: 'pitch' | 'next' | 'reset' | 'switch' | 'end'
  pitchType?: PitchType; pitchLocation?: PitchLocation; voidedAt: string | null
}
export interface Appearance {
  id: string; sessionId: string; pitcherId: string; order: number
  balls: number; strikes: number; pitches: PitchType[]
  outcome: Outcome | null
}
export interface Projection { appearances: Appearance[]; current: Appearance }

export const pitchLabels: Record<PitchType, string> = {
  ball: 'Ball', called: 'Called strike', swinging: 'Swinging strike', foul: 'Foul', inPlay: 'In play',
}

/** Replay source events; materialized appearances can always be rebuilt. */
export function project(session: Session, events: SessionEvent[], beforeEvent?: (current: Appearance, event: SessionEvent) => void): Projection {
  const appearances: Appearance[] = []
  function open(id: string, pitcherId: string): Appearance {
    const appearance: Appearance = { id, sessionId: session.id, pitcherId, order: appearances.length, balls: 0, strikes: 0, pitches: [], outcome: null }
    appearances.push(appearance)
    return appearance
  }
  let current = open(session.initialAppearanceId, session.initialPitcherId)
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.voidedAt) continue
    beforeEvent?.(current, event)
    if (event.kind === 'pitch') {
      const type = event.pitchType!
      current.pitches.push(type)
      if (type === 'ball') current.balls++
      else if (type === 'called' || type === 'swinging') current.strikes++
      else if (type === 'foul' && current.strikes < 2) current.strikes++
      if (current.balls === 4) current.outcome = 'walk'
      else if (current.strikes === 3) current.outcome = 'strikeout'
      else if (type === 'inPlay') current.outcome = 'inPlay'
      if (current.outcome) current = open(event.nextAppearanceId, current.pitcherId)
    } else {
      current.outcome = event.kind === 'next' ? 'manual' : event.kind
      if (event.kind !== 'end') current = open(event.nextAppearanceId, event.kind === 'switch' ? event.pitcherId : current.pitcherId)
    }
  }
  return { appearances, current }
}

export interface Metrics {
  total: number; balls: number; positive: number; called: number; swinging: number; fouls: number; inPlay: number
  batters: number; walks: number; strikeouts: number
  strikePct: number | null; firstPitchPct: number | null; walkPct: number | null; pitchesPerBatter: number | null
}
export function metrics(appearances: Appearance[]): Metrics {
  const started = appearances.filter(a => a.pitches.length > 0)
  const pitches = started.flatMap(a => a.pitches)
  const count = (type: PitchType) => pitches.filter(p => p === type).length
  const total = pitches.length, balls = count('ball'), batters = started.length
  const walks = started.filter(a => a.outcome === 'walk').length
  return {
    total, balls, positive: total - balls, called: count('called'), swinging: count('swinging'), fouls: count('foul'), inPlay: count('inPlay'),
    batters, walks, strikeouts: started.filter(a => a.outcome === 'strikeout').length,
    strikePct: total ? (total - balls) / total * 100 : null,
    firstPitchPct: batters ? started.filter(a => a.pitches[0] !== 'ball').length / batters * 100 : null,
    walkPct: batters ? walks / batters * 100 : null,
    pitchesPerBatter: batters ? total / batters : null,
  }
}
export const percent = (value: number | null) => value === null ? '—' : `${Math.round(value)}%`
