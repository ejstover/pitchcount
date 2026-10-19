import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudError, emptySnapshot, type Gateway, type Snapshot, type Upload } from './shared'
import { PitchDatabase, Repository } from './storage'
import { metrics } from './domain'

let db: PitchDatabase, repo: Repository
const identity = { coachId: 'coach-a', deviceId: 'device-a' }
let remote: Snapshot, accepted: Map<string, number>, uploads: Upload[], loseAck: boolean, failure: CloudError | null
let gateway: Gateway
beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true })
  remote = emptySnapshot(); accepted = new Map(); uploads = []; loseAck = false; failure = null
  remote.coaches = [{ id: identity.coachId, name: 'Coach A', email: 'a@example.com', role: 'coach', active: true }]
  const timestamp = new Date().toISOString()
  remote.teams = [{ id: 't1', name: 'Falcons', createdAt: timestamp, updatedAt: timestamp }, { id: 't2', name: 'Owls', createdAt: timestamp, updatedAt: timestamp }]
  remote.pitchers = [{ id: 'p1', name: 'Jordan', jersey: '', ownerId: identity.coachId, archived: false, createdAt: timestamp, updatedAt: timestamp }]
  remote.teamCoaches = remote.teams.map(t => ({ teamId: t.id, coachId: identity.coachId }))
  remote.teamPitchers = remote.teams.map(t => ({ teamId: t.id, pitcherId: 'p1', active: true }))
  gateway = {
    workspace: async () => structuredClone(remote), manage: async () => undefined,
    upload: async op => {
      uploads.push(structuredClone(op))
      if (failure) throw failure
      if (accepted.has(op.id)) return accepted.get(op.id)!
      remote.sessions = [...remote.sessions.filter(s => s.id !== op.sessionId), structuredClone(op.session)]
      remote.events = [...remote.events.filter(e => e.sessionId !== op.sessionId), ...structuredClone(op.events)]
      accepted.set(op.id, op.session.revision)
      if (loseAck) { loseAck = false; throw new CloudError('Connection lost after upload', 'network') }
      return op.session.revision
    },
  }
  db = new PitchDatabase(`sync-test-${crypto.randomUUID()}`)
  repo = new Repository(db, identity, gateway)
  await repo.sync()
})
afterEach(async () => { await db.delete(); vi.unstubAllGlobals() })
describe('account-scoped offline session synchronization', () => {
  it('commits source events and upload operations together and recovers them after reopening', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    await repo.act(sid, 'pitch', 'foul', 'downOut')
    const name = db.name; db.close(); db = new PitchDatabase(name)
    expect(await db.uploads.count()).toBe(1)
    expect(await db.events.toArray()).toMatchObject([{ pitchType: 'foul', pitchLocation: 'downOut' }])
  })
  it('does not lose a pitch if the outbox write fails', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    const fail = () => { throw new Error('Disk full') }
    db.uploads.hook('creating', fail)
    await expect(repo.act(sid, 'pitch', 'ball', 'middle')).rejects.toThrow('Disk full')
    db.uploads.hook('creating').unsubscribe(fail)
    expect(await db.events.count()).toBe(0)
    expect((await db.sessions.get(sid))?.revision).toBe(1)
    await repo.act(sid, 'pitch', 'ball', 'middle')
    expect(await db.events.count()).toBe(1)
  })
  it('retries an accepted upload with the same operation ID without duplicating pitches', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    await repo.act(sid, 'pitch', 'called', 'upIn')
    loseAck = true; await repo.sync()
    expect(await repo.hasPending()).toBe(true)
    await repo.sync()
    expect(uploads[0].id).toBe(uploads[1].id)
    expect(remote.events).toHaveLength(1); expect(await repo.hasPending()).toBe(false)
    expect(metrics((await repo.snapshot()).appearances).total).toBe(1)
  })
  it('keeps recording when authentication expires and resumes uploads after reconnecting', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    failure = new CloudError('Sign in again to reconnect', 'PGRST301'); await repo.sync()
    await repo.act(sid, 'pitch', 'ball', 'middle')
    expect(await db.events.count()).toBe(1); expect((await repo.pendingUploads()).every(o => !o.blocked)).toBe(true)
    failure = null; await repo.sync()
    expect(remote.events).toHaveLength(1); expect(await repo.hasPending()).toBe(false)
  })
  it('quarantines rejected work, clears revoked team data, and preserves recovery export', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    await repo.act(sid, 'pitch', 'inPlay', 'downIn')
    remote.teams = remote.teams.filter(t => t.id !== 't1')
    remote.teamCoaches = remote.teamCoaches.filter(m => m.teamId !== 't1')
    remote.teamPitchers = remote.teamPitchers.filter(m => m.teamId !== 't1')
    failure = new CloudError('Team access was removed', '42501'); await repo.sync()
    expect((await repo.snapshot()).sessions).toEqual([])
    const recovery = await repo.exportRecovery()
    expect(recovery.operations).toHaveLength(1)
    expect(recovery.operations.find(o => o.events.length)!.events[0].pitchLocation).toBe('downIn')
    await expect(repo.clearCache()).rejects.toThrow('pending')
  })
  it('makes another coach/device read-only but allows an independent local practice', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    const another = new Repository(db, { ...identity, deviceId: 'device-b' })
    await expect(another.act(sid, 'pitch', 'ball')).rejects.toThrow('read-only')
    await expect(another.saveNotes(sid, 'Cannot edit')).rejects.toThrow('read-only')
    await expect(another.startSession('p1', 'Other device')).resolves.toBeTypeOf('string')
  })
  it('filters eligible team pitchers and keeps team history after membership changes', async () => {
    const sid = await repo.startSession('p1', '', 't1')
    await repo.act(sid, 'pitch', 'ball'); await repo.act(sid, 'end')
    await db.teamPitchers.update(['t1', 'p1'], { active: false })
    await expect(repo.startSession('p1', '', 't1')).rejects.toThrow('active pitcher')
    expect((await db.sessions.get(sid))?.teamId).toBe('t1')
    await expect(repo.startSession('p1', '', 't2')).resolves.toBeTypeOf('string')
  })
  it('keeps caches isolated by account', async () => {
    const other = new PitchDatabase(`other-account-${crypto.randomUUID()}`)
    try { expect((await new Repository(other, { coachId: 'coach-b', deviceId: 'device-a' }).snapshot()).pitchers).toEqual([]) }
    finally { await other.delete() }
  })
  it('freezes an in-flight operation while new pitches commit and coalesce separately', async () => {
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const upload = gateway.upload
    let first = true
    gateway.upload = async op => { if (first) { first = false; started(); await waiting }; return upload(op) }
    const sid = await repo.startSession('p1', '', 't1')
    const syncing = repo.sync(); await entered
    await repo.act(sid, 'pitch', 'ball', 'middle')
    await repo.act(sid, 'pitch', 'foul', 'upOut')
    expect(await db.uploads.count()).toBe(2)
    release(); await syncing
    expect(remote.events).toHaveLength(2); expect(await repo.hasPending()).toBe(false)
    expect(uploads.map(o => o.session.revision)).toEqual([1, 3])
  })
  it('keeps locally committed pitches when a stale download arrives', async () => {
    const sid = await repo.startSession('p1', '', 't1'); await repo.sync()
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const workspace = gateway.workspace, stale = structuredClone(remote)
    gateway.workspace = async () => { started(); await waiting; return stale }
    const syncing = repo.sync(); await entered
    await repo.act(sid, 'pitch', 'ball', 'middle')
    release(); await syncing
    expect(await db.events.count()).toBe(1)
    expect(await repo.hasPending()).toBe(true)
    gateway.workspace = workspace; await repo.sync()
    expect(remote.events).toHaveLength(1)
  })
  it('retires an account before an in-flight refresh can refill its cleared cache', async () => {
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    gateway.workspace = async () => { started(); await waiting; return structuredClone(remote) }
    const syncing = repo.sync(); await entered
    const clearing = repo.clearCache()
    release(); await syncing; await clearing
    await repo.sync()
    expect((await repo.snapshot()).pitchers).toEqual([])
    await expect(repo.saveTeam({ name: 'Closed account' })).rejects.toThrow('closed')
  })
})
