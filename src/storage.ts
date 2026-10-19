import Dexie, { type Table } from 'dexie'
import { createId as id } from './id'
import { validateBackup, type Backup } from './backup'
import { project, type Appearance, type Pitcher, type PitchType, type Session, type SessionEvent, type Team } from './domain'

export class PitchDatabase extends Dexie {
  teams!: Table<Team, string>
  pitchers!: Table<Pitcher, string>
  sessions!: Table<Session, string>
  appearances!: Table<Appearance, string>
  events!: Table<SessionEvent, string>
  constructor(name = 'pitchwork') {
    super(name)
    this.version(1).stores({
      teams: 'id, name', pitchers: 'id, name, teamId',
      sessions: 'id, status, startedAt, *pitcherIds',
      appearances: 'id, sessionId, pitcherId, [sessionId+pitcherId]',
      events: 'id, sessionId, [sessionId+sequence], pitcherId, appearanceId',
    })
  }
}
const now = () => new Date().toISOString()

export interface Snapshot { teams: Team[]; pitchers: Pitcher[]; sessions: Session[]; appearances: Appearance[]; events: SessionEvent[] }
export class Repository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(public db: PitchDatabase) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.catch(() => undefined)
    return result
  }
  async snapshot(): Promise<Snapshot> {
    return this.db.transaction('r', this.db.tables, async () => ({
      teams: await this.db.teams.toArray(), pitchers: await this.db.pitchers.toArray(),
      sessions: await this.db.sessions.toArray(), appearances: await this.db.appearances.toArray(), events: await this.db.events.toArray(),
    }))
  }
  exportBackup(): Promise<Backup> {
    return this.serial(async () => {
      const { teams, pitchers, sessions, events } = await this.snapshot()
      return validateBackup({ format: 'pitchwork-backup', version: 1, exportedAt: now(), teams, pitchers, sessions, events })
    })
  }
  restoreBackup(value: unknown): Promise<void> {
    // Validate and copy at execution time so queued input cannot bypass validation.
    return this.serial(async () => {
      const backup = validateBackup(value)
      const appearances = backup.sessions.flatMap(session => project(session, backup.events.filter(e => e.sessionId === session.id)).appearances)
      await this.db.transaction('rw', this.db.tables, async () => {
        await Promise.all(this.db.tables.map(table => table.clear()))
        await this.db.teams.bulkAdd(backup.teams)
        await this.db.pitchers.bulkAdd(backup.pitchers)
        await this.db.sessions.bulkAdd(backup.sessions)
        await this.db.events.bulkAdd(backup.events)
        await this.db.appearances.bulkAdd(appearances)
      })
    })
  }
  savePitcher(input: { id?: string; name: string; jersey: string; teamName: string }): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.teams, this.db.pitchers, async () => {
      const name = input.name.trim()
      if (!name) throw new Error('Enter a pitcher name.')
      const timestamp = now()
      let teamId: string | null = null
      const teamName = input.teamName.trim()
      if (teamName) {
        const teams = await this.db.teams.toArray()
        const existing = teams.find(t => t.name.toLocaleLowerCase() === teamName.toLocaleLowerCase())
        teamId = existing?.id ?? id()
        if (!existing) await this.db.teams.add({ id: teamId, name: teamName, createdAt: timestamp, updatedAt: timestamp })
      }
      const previous = input.id ? await this.db.pitchers.get(input.id) : undefined
      if (input.id && !previous) throw new Error('Pitcher could not be found.')
      await this.db.pitchers.put({ id: previous?.id ?? id(), name, jersey: input.jersey.trim(), teamId,
        archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp })
    }))
  }
  archivePitcher(pitcherId: string, archived: boolean): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.pitchers, this.db.sessions, async () => {
      const pitcher = await this.db.pitchers.get(pitcherId)
      if (!pitcher) throw new Error('Pitcher could not be found.')
      const ongoing = await this.db.sessions.filter(s => s.status !== 'ended' && s.selectedPitcherId === pitcherId).first()
      if (archived && ongoing) throw new Error('Change the selected pitcher or end the session before archiving this pitcher.')
      await this.db.pitchers.update(pitcherId, { archived, updatedAt: now() })
    }))
  }
  startSession(pitcherId: string, name: string): Promise<string> {
    return this.serial(() => this.db.transaction('rw', this.db.sessions, this.db.pitchers, this.db.appearances, async () => {
      if (await this.db.sessions.filter(s => s.status !== 'ended').count()) throw new Error('Resume or end your existing session first.')
      const pitcher = await this.db.pitchers.get(pitcherId)
      if (!pitcher || pitcher.archived) throw new Error('Choose an active pitcher.')
      const timestamp = now()
      const session: Session = { id: id(), name: name.trim(), notes: '', startedAt: timestamp, updatedAt: timestamp, endedAt: null,
        status: 'active', initialPitcherId: pitcherId, initialAppearanceId: id(), selectedPitcherId: pitcherId, pitcherIds: [pitcherId], nextSequence: 1 }
      await this.db.sessions.add(session)
      await this.db.appearances.bulkPut(project(session, []).appearances)
      return session.id
    }))
  }
  private async rebuild(session: Session): Promise<void> {
    const events = await this.db.events.where('sessionId').equals(session.id).toArray()
    const projection = project(session, events)
    await this.db.appearances.where('sessionId').equals(session.id).delete()
    await this.db.appearances.bulkPut(projection.appearances)
  }
  private async append(session: Session, kind: SessionEvent['kind'], pitcherId: string, pitchType?: PitchType) {
    const events = await this.db.events.where('sessionId').equals(session.id).toArray()
    const current = project(session, events).current
    const event: SessionEvent = { id: id(), sessionId: session.id, pitcherId, appearanceId: current.id, sequence: session.nextSequence++, timestamp: now(),
      nextAppearanceId: id(), kind, pitchType, voidedAt: null }
    await this.db.events.add(event)
  }
  act(sessionId: string, action: 'pitch' | 'next' | 'reset' | 'switch' | 'undo' | 'pause' | 'resume' | 'end', value?: string): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.sessions, this.db.events, this.db.appearances, this.db.pitchers, async () => {
      const session = await this.db.sessions.get(sessionId)
      if (!session || session.status === 'ended') throw new Error('This session has ended.')
      if (session.status === 'paused' && action !== 'resume' && action !== 'end') throw new Error('Resume the session before recording changes.')
      if (action === 'resume') session.status = 'active'
      else if (action === 'pause') session.status = 'paused'
      else if (action === 'end') {
        await this.append(session, 'end', session.selectedPitcherId)
        session.status = 'ended'; session.endedAt = now()
      } else if (action === 'undo') {
        const events = await this.db.events.where('sessionId').equals(session.id).toArray()
        const latest = events.filter(e => e.kind === 'pitch' && !e.voidedAt).sort((a, b) => b.sequence - a.sequence)[0]
        if (!latest) throw new Error('There are no pitches to undo.')
        await this.db.events.update(latest.id, { voidedAt: now() })
        const afterUndo = await this.db.events.where('sessionId').equals(session.id).toArray()
        if (project(session, afterUndo).current.pitcherId !== latest.pitcherId) await this.append(session, 'switch', latest.pitcherId)
        session.selectedPitcherId = latest.pitcherId
      } else if (action === 'switch') {
        if (value === session.selectedPitcherId) return
        const pitcher = value ? await this.db.pitchers.get(value) : undefined
        if (!pitcher || pitcher.archived) throw new Error('Choose an active pitcher.')
        await this.append(session, 'switch', pitcher.id)
        session.selectedPitcherId = pitcher.id
        if (!session.pitcherIds.includes(pitcher.id)) session.pitcherIds.push(pitcher.id)
      } else {
        if (action === 'pitch' && !['ball', 'called', 'swinging', 'foul', 'inPlay'].includes(value ?? '')) throw new Error('Choose a valid pitch outcome.')
        await this.append(session, action, session.selectedPitcherId, action === 'pitch' ? value as PitchType : undefined)
      }
      session.updatedAt = now()
      await this.db.sessions.put(session)
      await this.rebuild(session)
    }))
  }
  saveNotes(sessionId: string, notes: string): Promise<void> {
    return this.serial(async () => {
      const count = await this.db.sessions.update(sessionId, { notes, updatedAt: now() })
      if (!count) throw new Error('Session could not be found.')
    })
  }
}
export const repository = new Repository(new PitchDatabase())
