import { pitchLocations, project, type Pitcher, type Session, type SessionEvent, type Team, type TeamPitcher } from './domain'
import { gcSeasonKey, validateGCSummary, type GCMapping, type GCSummary } from './gamechanger'

export interface Backup {
  format: 'pitchwork-backup'
  version: 4
  exportedAt: string
  teams: Team[]
  teamPitchers: TeamPitcher[]
  pitchers: Pitcher[]
  sessions: Session[]
  events: SessionEvent[]
  gcSummaries: GCSummary[]
  gcMappings: GCMapping[]
}
type Row = Record<string, unknown>
function fail(message: string): never { throw new Error(`Invalid backup: ${message}`) }
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as Row
}
function text(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(`${label} must be ${nonempty ? 'nonempty ' : ''}text.`)
  return value
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label, true)
  if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) fail(`${label} must be a valid date and time.`)
  return result
}
function nullableTime(value: unknown, label: string) { return value === null ? null : timestamp(value, label) }
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer.`)
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`${label} is not supported.`)
  return value as T
}
function rows<T>(value: unknown, label: string, parse: (row: Row) => T): T[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`)
  return value.map((item, i) => parse(object(item, `${label}[${i}]`)))
}
function unique(values: string[], label: string): Set<string> {
  const set = new Set(values)
  if (set.size !== values.length) fail(`${label} contains duplicate identifiers.`)
  return set
}

/** Normalize untrusted JSON and verify references before opening a write transaction. */
export function validateBackup(value: unknown): Backup {
  let root = object(value, 'file')
  if (root.format === 'pitchwork-backup' && root.version === 1) {
    const legacyPitchers = rows(root.pitchers, 'pitchers', row => row)
    root = { ...root, version: 2, teamPitchers: legacyPitchers.filter(p => p.teamId !== null).map(p => ({ teamId: p.teamId, pitcherId: p.id, active: true })), pitchers: legacyPitchers.map(p => ({ ...p, ownerId: 'legacy' })), sessions: rows(root.sessions, 'sessions', row => ({ ...row, teamId: null, recorderId: 'legacy', deviceId: 'legacy', revision: 0 })) }
  }
  const legacy = root.version === 2
  if (root.format !== 'pitchwork-backup' || ![2,3,4].includes(root.version as number)) fail('unsupported format or version. Choose a Pitchwork JSON backup.')
  const archived = (row: Row) => { if (legacy) return false; if (typeof row.archived !== 'boolean') fail('archived must be true or false.'); return row.archived }
  const teams = rows(root.teams, 'teams', row => ({ archived: archived(row), id: text(row.id, 'team id', true), name: text(row.name, 'team name', true), createdAt: timestamp(row.createdAt, 'team creation time'), updatedAt: timestamp(row.updatedAt, 'team update time') }))
  const pitchers = rows<Pitcher>(root.pitchers, 'pitchers', row => {
    if (typeof row.archived !== 'boolean') fail('pitcher archived must be true or false.')
    return { id: text(row.id, 'pitcher id', true), name: text(row.name, 'pitcher name', true), jersey: text(row.jersey, 'jersey'), ownerId: text(row.ownerId, 'pitcher owner', true), archived: row.archived, createdAt: timestamp(row.createdAt, 'pitcher creation time'), updatedAt: timestamp(row.updatedAt, 'pitcher update time') }
  })
  const teamPitchers = rows<TeamPitcher>(root.teamPitchers, 'team memberships', row => {
    if (typeof row.active !== 'boolean') fail('membership active must be true or false.')
    return { teamId: text(row.teamId, 'membership team', true), pitcherId: text(row.pitcherId, 'membership pitcher', true), active: row.active }
  })
  const sessions = rows<Session>(root.sessions, 'sessions', row => {
    if (!Array.isArray(row.pitcherIds)) fail('session pitchers must be a list.')
    if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0) fail('invalid session revision.')
    if (row.recovered !== undefined && typeof row.recovered !== 'boolean') fail('invalid recovery flag.')
    return { archived: archived(row), teamId: row.teamId === null ? null : text(row.teamId, 'practice team', true), recorderId: text(row.recorderId, 'recording coach', true), deviceId: text(row.deviceId, 'recording device', true), revision: row.revision, ...(row.recovered ? { recovered: true } : {}), id: text(row.id, 'session id', true), name: text(row.name, 'practice name'), notes: text(row.notes, 'notes'), startedAt: timestamp(row.startedAt, 'session start'), updatedAt: timestamp(row.updatedAt, 'session update'), endedAt: nullableTime(row.endedAt, 'session end'), status: choice(row.status, ['active', 'paused', 'ended'], 'session status'), initialPitcherId: text(row.initialPitcherId, 'initial pitcher', true), initialAppearanceId: text(row.initialAppearanceId, 'initial appearance', true), selectedPitcherId: text(row.selectedPitcherId, 'selected pitcher', true), pitcherIds: row.pitcherIds.map(id => text(id, 'participating pitcher', true)), nextSequence: positiveInteger(row.nextSequence, 'next event sequence') }
  })
  const events = rows<SessionEvent>(root.events, 'events', row => {
    const kind = choice(row.kind, ['pitch', 'next', 'reset', 'switch', 'end'], 'event kind')
    const event: SessionEvent = { id: text(row.id, 'event id', true), sessionId: text(row.sessionId, 'event session', true), pitcherId: text(row.pitcherId, 'event pitcher', true), appearanceId: text(row.appearanceId, 'event appearance', true), nextAppearanceId: text(row.nextAppearanceId, 'next appearance', true), sequence: positiveInteger(row.sequence, 'event sequence'), timestamp: timestamp(row.timestamp, 'event time'), kind, voidedAt: nullableTime(row.voidedAt, 'undo time') }
    if (kind === 'pitch') {
      event.pitchType = choice(row.pitchType, ['ball', 'called', 'swinging', 'foul', 'inPlay'] as const, 'pitch outcome')
      if (row.pitchLocation !== undefined) event.pitchLocation = choice(row.pitchLocation, pitchLocations, 'pitch location')
    } else if (event.voidedAt !== null || row.pitchType !== undefined || row.pitchLocation !== undefined) fail('only pitch events can have pitch outcomes, locations, or be undone.')
    return event
  })
  const teamIds = unique(teams.map(t => t.id), 'teams')
  const pitcherIds = unique(pitchers.map(p => p.id), 'pitchers')
  const gcSummaries = root.version === 4 ? rows(root.gcSummaries, 'GameChanger summaries', validateGCSummary) : []
  const gcMappings = root.version === 4 ? rows<GCMapping>(root.gcMappings, 'GameChanger mappings', row => ({ teamId: text(row.teamId, 'mapping team', true), season: text(row.season, 'mapping season', true), sourceKey: text(row.sourceKey, 'mapping source', true), pitcherId: text(row.pitcherId, 'mapping pitcher', true) })) : []
  unique(gcSummaries.map(s => s.id), 'GameChanger summaries')
  unique(gcSummaries.map(s => `${s.teamId}/${gcSeasonKey(s.season)}`), 'GameChanger team seasons')
  unique(gcMappings.map(m => `${m.teamId}/${gcSeasonKey(m.season)}/${m.sourceKey}`), 'GameChanger mappings')
  for (const s of gcSummaries) if (!teamIds.has(s.teamId) || s.players.some(p => !pitcherIds.has(p.pitcherId))) fail('GameChanger summary references a missing team or pitcher.')
  for (const m of gcMappings) if (!teamIds.has(m.teamId) || !pitcherIds.has(m.pitcherId)) fail('GameChanger mapping references a missing team or pitcher.')
  const sessionIds = unique(sessions.map(s => s.id), 'sessions')
  unique(events.map(e => e.id), 'events')
  unique([...sessions.map(s => s.initialAppearanceId), ...events.map(e => e.nextAppearanceId)], 'appearance identifiers')
  unique(teamPitchers.map(m => `${m.teamId}/${m.pitcherId}`), 'team memberships')
  for (const m of teamPitchers) if (!teamIds.has(m.teamId) || !pitcherIds.has(m.pitcherId)) fail('a membership references a missing team or pitcher.')
  unique(sessions.filter(s => s.status !== 'ended' && !s.recovered).map(s => `${s.recorderId}/${s.deviceId}`), 'ongoing recording devices')
  for (const s of sessions) if (s.teamId !== null && !teamIds.has(s.teamId)) fail('a practice references a missing team.')
  const bySession = new Map<string, SessionEvent[]>()
  for (const event of events) {
    if (!sessionIds.has(event.sessionId) || !pitcherIds.has(event.pitcherId)) fail('an event references a missing session or pitcher.')
    const group = bySession.get(event.sessionId) ?? []
    group.push(event); bySession.set(event.sessionId, group)
  }
  for (const session of sessions) {
    if (session.archived && session.status !== 'ended') fail('only ended practices can be archived.')
    const participants = unique(session.pitcherIds, 'session pitchers')
    if (![session.initialPitcherId, session.selectedPitcherId].every(id => participants.has(id)) || !session.pitcherIds.every(id => pitcherIds.has(id))) fail('a session references a missing or nonparticipating pitcher.')
    const source = (bySession.get(session.id) ?? []).sort((a, b) => a.sequence - b.sequence)
    if (source.some((event, index) => event.sequence !== index + 1) || session.nextSequence !== source.length + 1) fail('session event sequences must be unique and consecutive.')
    const reserved = new Set([session.initialAppearanceId])
    for (const event of source) {
      if (!participants.has(event.pitcherId) || !reserved.has(event.appearanceId)) fail('an event references a nonparticipating pitcher or an appearance that does not precede it.')
      reserved.add(event.nextAppearanceId)
    }
    const ends = source.filter(e => e.kind === 'end')
    if (session.status === 'ended' ? (session.endedAt === null || ends.length !== 1 || source.at(-1)?.kind !== 'end') : (session.endedAt !== null || ends.length !== 0)) fail('session status and ending events disagree.')
    const projection = project(session, source, (current, event) => {
      if (event.kind !== 'switch' && event.pitcherId !== current.pitcherId) fail('an event is assigned to the wrong pitcher.')
      if (event.kind === 'pitch' && event.appearanceId !== current.id) fail('a pitch is assigned to the wrong batter.')
    })
    if (projection.current.pitcherId !== session.selectedPitcherId) fail('selected pitcher disagrees with the session history.')
  }
  return { format: 'pitchwork-backup', version: 4, exportedAt: timestamp(root.exportedAt, 'export time'), teams, teamPitchers, pitchers, sessions, events, gcSummaries, gcMappings }
}

export function parseBackup(json: string): Backup {
  let value: unknown
  try { value = JSON.parse(json) } catch { fail('the file is not valid JSON.') }
  return validateBackup(value)
}
export function backupTotals(backup: Backup) {
  return { pitchers: backup.pitchers.length, sessions: backup.sessions.length, pitches: backup.events.filter(e => e.kind === 'pitch' && !e.voidedAt).length, gcSummaries: backup.gcSummaries.length }
}
export function downloadBackup(backup: Backup): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `pitchwork-backup-${backup.exportedAt.replace(/[:.]/g, '-')}.json`
  document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
