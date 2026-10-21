import Dexie, { type Table } from 'dexie'
import { createId as id } from './id'
import { validateBackup, type Backup } from './backup'
import { pitchLocations, project, type Appearance, type Pitcher, type PitchLocation, type PitchType, type Session, type SessionEvent, type Team, type Coach, type TeamCoach, type TeamPitcher, type Invitation } from './domain'

import { CloudError, type Gateway, type Identity, type SavePitcher, type Snapshot, type Upload, type RemovalInput, type RemovalPreview, type RemovalKind } from './shared'
export type { Snapshot } from './shared'

export class PitchDatabase extends Dexie {
  teams!: Table<Team, string>
  pitchers!: Table<Pitcher, string>
  sessions!: Table<Session, string>
  appearances!: Table<Appearance, string>
  events!: Table<SessionEvent, string>
  coaches!: Table<Coach, string>
  teamCoaches!: Table<TeamCoach, [string, string]>
  teamPitchers!: Table<TeamPitcher, [string, string]>
  invitations!: Table<Invitation, string>
  uploads!: Table<Upload, string>
  deletions!: Table<{kind: RemovalKind; id: string}, [string,string]>
  constructor(name = 'pitchwork') {
    super(name)
    this.version(1).stores({
      teams: 'id, name', pitchers: 'id, name, teamId',
      sessions: 'id, status, startedAt, *pitcherIds',
      appearances: 'id, sessionId, pitcherId, [sessionId+pitcherId]',
      events: 'id, sessionId, [sessionId+sequence], pitcherId, appearanceId',
    })
    this.version(2).stores({
      pitchers: 'id, name, ownerId', coaches: 'id',
      teamCoaches: '[teamId+coachId], teamId, coachId',
      teamPitchers: '[teamId+pitcherId], teamId, pitcherId', invitations: 'id, teamId',
      uploads: 'id, sessionId, [sessionId+expectedRevision]',
    })
    this.version(3).stores({ deletions: '[kind+id]' }).upgrade(async tx => {
      await tx.table('teams').toCollection().modify(t => { t.archived ??= false })
      await tx.table('sessions').toCollection().modify(s => { s.archived ??= false })
    })
  }
}
const now = () => new Date().toISOString()

export class Repository {
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(dirty: boolean) => void>()
  private syncing: Promise<void> | null = null
  private retired = false
  syncMessage = ''
  constructor(public db: PitchDatabase, public identity: Identity = { coachId: 'local', deviceId: 'local' }, private gateway?: Gateway) {}
  subscribe(listener: (dirty: boolean) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(dirty = false) { this.listeners.forEach(listener => listener(dirty)) }
  owns(session: Session) { return !session.recovered && session.recorderId === this.identity.coachId && session.deviceId === this.identity.deviceId }
  private writable(session: Session) { if (session.archived) throw new Error('Reactivate the practice before editing it.'); if (!this.owns(session)) throw new Error('This practice is read-only on this device.') }
  private async eligible(pitcherId: string, teamId: string | null) {
    if (teamId && (await this.db.teams.get(teamId))?.archived) throw new Error('Choose an active team.')
    const pitcher = await this.db.pitchers.get(pitcherId)
    const member = teamId ? await this.db.teamPitchers.get([teamId, pitcherId]) : null
    if (!pitcher || pitcher.archived || (teamId && !member?.active)) throw new Error('Choose an active pitcher on this team.')
    if (teamId && !await this.db.teamCoaches.get([teamId, this.identity.coachId]) && (await this.db.coaches.get(this.identity.coachId))?.role !== 'admin') throw new Error('You are no longer assigned to this team.')
  }
  private async queueUpload(session: Session) {
    let expectedRevision = session.revision
    if (this.gateway) {
      const waiting = await this.db.uploads.where('sessionId').equals(session.id).filter(o => !o.inFlight && !o.blocked).toArray()
      if (waiting.length) {
        expectedRevision = Math.min(...waiting.map(o => o.expectedRevision))
        await this.db.uploads.bulkDelete(waiting.map(o => o.id))
      }
    }
    session.revision++
    await this.db.sessions.put(session)
    await this.db.uploads.add({ id: id(), sessionId: session.id, expectedRevision, session: { ...session }, events: (await this.db.events.where('sessionId').equals(session.id).toArray()).sort((a,b) => a.sequence - b.sequence) })
    Dexie.currentTransaction?.on('complete', () => this.emit(true))
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { if (this.retired) throw new Error('This account has been closed.'); return work() })
    this.queue = result.catch(() => undefined)
    return result
  }
  async snapshot(): Promise<Snapshot> {
    return this.db.transaction('r', this.db.tables, async () => ({
      teams: (await this.db.teams.toArray()).map(t => ({...t, archived: t.archived ?? false})), pitchers: await this.db.pitchers.toArray(),
      coaches: await this.db.coaches.toArray(), teamCoaches: await this.db.teamCoaches.toArray(), teamPitchers: await this.db.teamPitchers.toArray(), invitations: await this.db.invitations.toArray(),
      sessions: (await this.db.sessions.toArray()).map(s => ({...s, archived: s.archived ?? false})), appearances: await this.db.appearances.toArray(), events: await this.db.events.toArray(),
    }))
  }
  exportBackup(): Promise<Backup> {
    return this.serial(async () => {
      const { teams, pitchers, sessions, events, teamPitchers } = await this.snapshot()
      return validateBackup({ format: 'pitchwork-backup', version: 3, exportedAt: now(), teams, teamPitchers, pitchers, sessions, events })
    })
  }
  restoreBackup(value: unknown, operationId = id()): Promise<void> {
    return this.serial(async () => {
      const backup = validateBackup(value)
      // Production imports are server-validated copies. Membership permissions are never imported.
      if (this.gateway) {
        await this.gateway.manage('restore', { backup, operationId, deviceId: this.identity.deviceId })
        await this.refresh()
        return
      }
      const appearances = backup.sessions.flatMap(session => project(session, backup.events.filter(e => e.sessionId === session.id)).appearances)
      await this.db.transaction('rw', this.db.tables, async () => {
        await Promise.all(this.db.tables.map(table => table.clear()))
        await this.db.teams.bulkAdd(backup.teams)
        await this.db.teamCoaches.bulkAdd(backup.teams.map(t => ({ teamId: t.id, coachId: this.identity.coachId })))
        await this.db.teamPitchers.bulkAdd(backup.teamPitchers)
        await this.db.pitchers.bulkAdd(backup.pitchers)
        await this.db.sessions.bulkAdd(backup.sessions)
        await this.db.events.bulkAdd(backup.events)
        await this.db.appearances.bulkAdd(appearances)
      })
    })
  }
  async manage(action: string, input: Record<string, unknown>): Promise<void> {
    if (this.retired) throw new Error('This account has been closed.')
    if (!this.gateway) throw new Error('Shared team setup is unavailable.')
    if (!navigator.onLine) throw new Error('Reconnect to manage teams and assignments.')
    await this.gateway.manage(action, input)
    await this.refresh()
  }
  async previewRemoval(input: RemovalInput): Promise<RemovalPreview> {
    if (!this.gateway || !navigator.onLine) throw new Error('Reconnect to remove records.')
    return await this.gateway.manage('removalPreview', { ...input }) as RemovalPreview
  }
  removeRecord(input: RemovalInput, permanent: boolean): Promise<void> {
    return this.serial(async () => {
      await this.sync()
      if (await this.hasPending()) throw new Error('Sync or recover pending practices before removing records.')
      await this.manage(permanent ? 'deleteRecord' : 'archiveRecord', { ...input })
    })
  }
  saveTeam(input: { id?: string; name: string }): Promise<string> {
    return this.serial(async () => {
      const name = input.name.trim()
      if (!name) throw new Error('Enter a team name.')
      const teamId = input.id ?? id()
      if (this.gateway) { await this.manage('saveTeam', { ...input, id: teamId, name }); return teamId }
      await this.db.transaction('rw', this.db.teams, this.db.teamCoaches, async () => {
        const old = await this.db.teams.get(teamId)
        await this.db.teams.put({ id: teamId, name, archived: old?.archived ?? false, createdAt: old?.createdAt ?? now(), updatedAt: now() })
        await this.db.teamCoaches.put({ teamId, coachId: this.identity.coachId })
      })
      return teamId
    })
  }
  savePitcher(input: SavePitcher): Promise<void> {
    return this.serial(async () => {
      const name = input.name.trim()
      if (!name) throw new Error('Enter a pitcher name.')
      const pitcherId = input.id ?? id()
      const teamIds = [...new Set(input.teamIds)]
      if (this.gateway) { await this.manage('savePitcher', { ...input, id: pitcherId, name, teamIds }); return }
      await this.db.transaction('rw', this.db.pitchers, this.db.teamPitchers, this.db.teamCoaches, async () => {
        for (const teamId of teamIds) if (!await this.db.teamCoaches.get([teamId, this.identity.coachId])) throw new Error('Team could not be found.')
        const previous = await this.db.pitchers.get(pitcherId)
        if (input.id && !previous) throw new Error('Pitcher could not be found.')
        await this.db.pitchers.put({ id: pitcherId, name, jersey: input.jersey.trim(), ownerId: previous?.ownerId ?? this.identity.coachId,
          archived: previous?.archived ?? false, createdAt: previous?.createdAt ?? now(), updatedAt: now() })
        const accessible = await this.db.teamCoaches.where('coachId').equals(this.identity.coachId).toArray()
        for (const { teamId } of accessible) await this.db.teamPitchers.put({ teamId, pitcherId, active: teamIds.includes(teamId) })
      })
    })
  }
  archivePitcher(pitcherId: string, archived: boolean): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.pitchers, this.db.sessions, this.db.teamPitchers, async () => {
      const pitcher = await this.db.pitchers.get(pitcherId)
      if (!pitcher) throw new Error('Pitcher could not be found.')
      if (this.gateway) throw new Error('Archive using the online roster action.')
      const ongoing = await this.db.sessions.filter(s => s.status !== 'ended' && this.owns(s) && s.selectedPitcherId === pitcherId).first()
      if (archived && ongoing) throw new Error('Change the selected pitcher or end the session before archiving this pitcher.')
      await this.db.pitchers.update(pitcherId, { archived, updatedAt: now() })
    }))
  }
  startSession(pitcherId: string, name: string, teamId: string | null = null): Promise<string> {
    return this.serial(() => this.db.transaction('rw', this.db.tables, async () => {
      if (await this.db.sessions.filter(s => s.status !== 'ended' && this.owns(s)).count()) throw new Error('Resume or end your existing session first.')
      const pitcher = await this.db.pitchers.get(pitcherId)
      if (!pitcher || pitcher.archived) throw new Error('Choose an active pitcher.')
      await this.eligible(pitcherId, teamId)
      const timestamp = now()
      const session: Session = { teamId, recorderId: this.identity.coachId, deviceId: this.identity.deviceId, revision: 0, id: id(), name: name.trim(), notes: '', startedAt: timestamp, updatedAt: timestamp, endedAt: null,
        archived: false, status: 'active', initialPitcherId: pitcherId, initialAppearanceId: id(), selectedPitcherId: pitcherId, pitcherIds: [pitcherId], nextSequence: 1 }
      await this.queueUpload(session)
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
  private async append(session: Session, kind: SessionEvent['kind'], pitcherId: string, pitchType?: PitchType, pitchLocation?: PitchLocation) {
    const events = await this.db.events.where('sessionId').equals(session.id).toArray()
    const current = project(session, events).current
    const event: SessionEvent = { id: id(), sessionId: session.id, pitcherId, appearanceId: current.id, sequence: session.nextSequence++, timestamp: now(),
      nextAppearanceId: id(), kind, voidedAt: null }
    if (pitchType !== undefined) event.pitchType = pitchType
    if (pitchLocation !== undefined) event.pitchLocation = pitchLocation
    await this.db.events.add(event)
  }
  act(sessionId: string, action: 'pitch' | 'next' | 'reset' | 'switch' | 'undo' | 'pause' | 'resume' | 'end', value?: string, pitchLocation?: PitchLocation): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.tables, async () => {
      if (pitchLocation !== undefined && (action !== 'pitch' || !pitchLocations.includes(pitchLocation))) throw new Error('Choose a valid location for a pitch.')
      const session = await this.db.sessions.get(sessionId)
      if (!session || session.status === 'ended') throw new Error('This session has ended.')
      this.writable(session)
      if (session.teamId && !await this.db.teamCoaches.get([session.teamId, this.identity.coachId]) && (await this.db.coaches.get(this.identity.coachId))?.role !== 'admin') throw new Error('You are no longer assigned to this team.')
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
        await this.eligible(pitcher.id, session.teamId)
        await this.append(session, 'switch', pitcher.id)
        session.selectedPitcherId = pitcher.id
        if (!session.pitcherIds.includes(pitcher.id)) session.pitcherIds.push(pitcher.id)
      } else {
        if (action === 'pitch' && !['ball', 'called', 'swinging', 'foul', 'inPlay'].includes(value ?? '')) throw new Error('Choose a valid pitch outcome.')
        await this.append(session, action, session.selectedPitcherId, action === 'pitch' ? value as PitchType : undefined, pitchLocation)
      }
      session.updatedAt = now()
      await this.queueUpload(session)
      await this.rebuild(session)
    }))
  }
  saveNotes(sessionId: string, notes: string): Promise<void> {
    return this.serial(() => this.db.transaction('rw', this.db.sessions, this.db.events, this.db.uploads, async () => {
      const session = await this.db.sessions.get(sessionId)
      if (!session) throw new Error('Session could not be found.')
      this.writable(session)
      session.notes = notes; session.updatedAt = now()
      await this.queueUpload(session)
    }))
  }
  async pendingUploads() { return this.db.uploads.toArray() }
  async discardBlockedUploads() {
    await this.db.transaction('rw', this.db.uploads, async () => {
      await this.db.uploads.filter(o => !!o.blocked).delete()
    })
    this.syncMessage = ''; this.emit()
  }
  async hasPending() { return (await this.db.uploads.count()) > 0 }
  async clearCache() {
    this.retired = true
    await this.queue; await this.syncing
    try {
      await this.db.transaction('rw', this.db.tables, async () => {
        if (await this.hasPending()) throw new Error('Sync or recover pending practices before signing out.')
        await Promise.all(this.db.tables.map(t => t.clear()))
      })
    } catch (error) { this.retired = false; throw error }
    this.emit()
  }
  async exportRecovery() {
    return { format: 'pitchwork-unsynced-recovery', version: 1, exportedAt: now(), operations: await this.db.uploads.toArray() }
  }
  private async refresh() {
    if (!this.gateway || this.retired) return
    const remote = await this.gateway.workspace()
    await this.db.transaction('rw', this.db.tables, async () => {
      if (this.retired) return
      const pending = await this.db.uploads.toArray()
      const pendingIds = new Set(pending.filter(p => !p.blocked).map(p => p.sessionId))
      const teams = new Set(remote.teams.map(t => t.id))
      const blockedIds = new Set(pending.filter(p => p.blocked).map(p => p.sessionId))
      const removed = remote.deletions ?? []
      await this.db.deletions.bulkPut(removed)
      const deleted = new Set((await this.db.deletions.toArray()).filter(d => d.kind === 'session').map(d => d.id))
      for (const op of pending) if (deleted.has(op.sessionId)) await this.db.uploads.update(op.id, {blocked: 'This practice was permanently deleted. Export unsynced work for recovery.'})
      const remoteVersions = new Map(remote.sessions.map(s => [s.id, s.revision]))
      const local = await this.db.sessions.filter(s => !deleted.has(s.id) && !blockedIds.has(s.id) && (pendingIds.has(s.id) || (this.owns(s) && s.revision > (remoteVersions.get(s.id) ?? 0))) && (s.teamId === null || teams.has(s.teamId))).toArray()
      const localIds = new Set(local.map(s => s.id))
      const events = await this.db.events.filter(e => localIds.has(e.sessionId)).toArray()
      const sessions = [...remote.sessions.filter(s => !deleted.has(s.id) && !localIds.has(s.id) && !blockedIds.has(s.id)), ...local].map(s => ({...s, archived: remote.sessions.find(r => r.id === s.id)?.archived ?? s.archived ?? false}))
      const sessionIds = new Set(sessions.map(s => s.id))
      const source = [...remote.events.filter(e => !localIds.has(e.sessionId)), ...events].filter(e => sessionIds.has(e.sessionId))
      for (const table of this.db.tables) if (table.name !== 'uploads' && table.name !== 'deletions') await table.clear()
      await this.db.teams.bulkPut(remote.teams.map(t => ({...t, archived: t.archived ?? false}))); await this.db.pitchers.bulkPut(remote.pitchers)
      await this.db.coaches.bulkPut(remote.coaches); await this.db.teamCoaches.bulkPut(remote.teamCoaches)
      await this.db.teamPitchers.bulkPut(remote.teamPitchers); await this.db.invitations.bulkPut(remote.invitations)
      await this.db.sessions.bulkPut(sessions); await this.db.events.bulkPut(source)
      await this.db.appearances.bulkPut(sessions.flatMap(s => project(s, source.filter(e => e.sessionId === s.id)).appearances))
    })
    this.emit()
  }
  sync(): Promise<void> {
    if (this.retired) return Promise.resolve()
    if (this.syncing) return this.syncing
    this.syncing = this.performSync().finally(() => { this.syncing = null })
    return this.syncing
  }
  private async performSync() {
    if (!this.gateway || !navigator.onLine) { this.emit(); return }
    this.syncMessage = ''
    try {
      const blocked = new Set((await this.db.uploads.toArray()).filter(o => o.blocked).map(o => o.sessionId))
      while (!this.retired) {
        const op = await this.db.transaction('rw', this.db.uploads, async () => {
          const next = (await this.db.uploads.toArray()).filter(o => !o.blocked && !blocked.has(o.sessionId)).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.expectedRevision - b.expectedRevision)[0]
          if (next) { next.inFlight = true; await this.db.uploads.put(next) }
          return next
        })
        if (!op) break
        try {
          await this.gateway.upload(op)
          await this.db.uploads.delete(op.id)
        } catch (error) {
          if (error instanceof CloudError && ['42501', '40001'].includes(error.code)) {
            await this.db.uploads.where('sessionId').equals(op.sessionId).modify({ blocked: error.message })
            blocked.add(op.sessionId)
            this.syncMessage = 'Some practices need attention. Export unsynced work in Settings.'
          } else throw error
        }
      }
      await this.refresh()
      if (blocked.size) this.syncMessage = 'Some practices need attention. Export unsynced work in Settings.'
    } catch (error) {
      this.syncMessage = error instanceof Error ? error.message : 'Could not sync. Your saved pitches remain on this device.'
    } finally { this.emit() }
  }
}
