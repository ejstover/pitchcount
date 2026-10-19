import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { metrics, project } from './domain'
import { PitchDatabase, Repository } from './storage'

let db: PitchDatabase
let repo: Repository
let pitcherId: string
let sessionId: string
beforeEach(async () => {
  db = new PitchDatabase(`pitchwork-test-${crypto.randomUUID()}`)
  repo = new Repository(db)
  await repo.savePitcher({ name: 'Jordan Lee', jersey: '14', teamName: 'Falcons' })
  pitcherId = (await db.pitchers.toArray())[0].id
  sessionId = await repo.startSession(pitcherId, 'Sunday bullpen')
})
afterEach(async () => { await db.delete() })
async function current() {
  const session = (await db.sessions.get(sessionId))!
  return project(session, await db.events.where('sessionId').equals(sessionId).toArray())
}
async function stats() { return metrics((await current()).appearances) }

describe('persistent repository', () => {
  it('commits each pitch and recovers session, count, notes, and events after reopening', async () => {
    await repo.act(sessionId, 'pitch', 'ball')
    await repo.act(sessionId, 'pitch', 'foul')
    await repo.saveNotes(sessionId, 'Stay tall at release')
    const databaseName = db.name
    db.close()
    db = new PitchDatabase(databaseName); repo = new Repository(db)
    expect((await current()).current).toMatchObject({ balls: 1, strikes: 1 })
    expect(await db.events.count()).toBe(2)
    expect(await db.sessions.get(sessionId)).toMatchObject({ notes: 'Stay tall at release', status: 'active', selectedPitcherId: pitcherId })
  })
  it('allows only one ongoing session and permits a new one after ending', async () => {
    await expect(repo.startSession(pitcherId, '')).rejects.toThrow('existing session')
    await repo.act(sessionId, 'pause')
    await expect(repo.startSession(pitcherId, '')).rejects.toThrow('existing session')
    await repo.act(sessionId, 'end')
    await expect(repo.startSession(pitcherId, '')).resolves.toBeTypeOf('string')
  })
  it('rejects scoring while paused or ended, and resumes a persistent count', async () => {
    await repo.act(sessionId, 'pitch', 'called')
    await repo.act(sessionId, 'pause')
    await expect(repo.act(sessionId, 'pitch', 'ball')).rejects.toThrow('Resume')
    await expect(repo.act(sessionId, 'undo')).rejects.toThrow('Resume')
    await repo.act(sessionId, 'resume')
    expect((await current()).current.strikes).toBe(1)
    await repo.act(sessionId, 'end')
    await expect(repo.act(sessionId, 'pitch', 'ball')).rejects.toThrow('ended')
    expect((await stats()).strikeouts).toBe(0)
  })
  it('preserves order for rapid queued pitches, including automatic batter changes', async () => {
    await Promise.all(['ball', 'ball', 'ball', 'ball', 'called', 'foul'].map(type => repo.act(sessionId, 'pitch', type)))
    expect((await current()).current).toMatchObject({ balls: 0, strikes: 2 })
    expect(await stats()).toMatchObject({ total: 6, walks: 1, batters: 2 })
    expect((await db.events.orderBy('[sessionId+sequence]').toArray()).map(e => e.sequence)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('switches to a fresh batter and returns to another fresh batter', async () => {
    await repo.savePitcher({ name: 'Morgan', jersey: '', teamName: 'falcons' })
    const p2 = (await db.pitchers.toArray()).find(p => p.name === 'Morgan')!.id
    await repo.act(sessionId, 'pitch', 'ball')
    await repo.act(sessionId, 'pitch', 'called')
    await repo.act(sessionId, 'switch', p2)
    expect((await current()).current).toMatchObject({ balls: 0, strikes: 0, pitcherId: p2 })
    await repo.act(sessionId, 'pitch', 'foul')
    await repo.act(sessionId, 'switch', pitcherId)
    expect((await current()).current).toMatchObject({ balls: 0, strikes: 0, pitcherId })
    expect(await stats()).toMatchObject({ total: 3, batters: 2, walks: 0, strikeouts: 0 })
    expect((await db.sessions.get(sessionId))!.pitcherIds).toEqual([pitcherId, p2])
    expect(await db.teams.count()).toBe(1)
  })
  it.each([
    ['ball', 'ball', 'ball', 'ball'], ['called', 'called', 'swinging'], ['inPlay'],
  ])('undo reverses terminal sequence %j and survives reopening', async (...types: string[]) => {
    for (const type of types) await repo.act(sessionId, 'pitch', type)
    await repo.act(sessionId, 'undo')
    expect((await current()).current.outcome).toBeNull()
    expect((await current()).appearances).toHaveLength(1)
    expect(await stats()).toMatchObject({ total: types.length - 1, walks: 0, strikeouts: 0 })
    expect((await db.events.toArray()).filter(e => e.voidedAt)).toHaveLength(1)
    const name = db.name; db.close(); db = new PitchDatabase(name); repo = new Repository(db)
    expect((await current()).current.pitches).toHaveLength(types.length - 1)
  })
  it('undo selects the original pitcher but preserves subsequent manual boundaries', async () => {
    await repo.savePitcher({ name: 'Morgan', jersey: '', teamName: '' })
    const p2 = (await db.pitchers.toArray()).find(p => p.id !== pitcherId)!.id
    await repo.act(sessionId, 'pitch', 'inPlay')
    await repo.act(sessionId, 'switch', p2)
    await repo.act(sessionId, 'undo')
    expect((await db.sessions.get(sessionId))!.selectedPitcherId).toBe(pitcherId)
    expect((await current()).current.pitcherId).toBe(pitcherId)
    expect((await current()).appearances.filter(a => a.outcome === 'switch')).toHaveLength(2)
    await expect(repo.act(sessionId, 'undo')).rejects.toThrow('no pitches')
  })
  it('archives and reactivates without removing history', async () => {
    await repo.act(sessionId, 'pitch', 'inPlay')
    await expect(repo.archivePitcher(pitcherId, true)).rejects.toThrow('Change')
    await repo.act(sessionId, 'end')
    await repo.archivePitcher(pitcherId, true)
    expect((await db.pitchers.get(pitcherId))!.archived).toBe(true)
    expect(await stats()).toMatchObject({ total: 1, strikePct: 100 })
    await expect(repo.startSession(pitcherId, '')).rejects.toThrow('active pitcher')
    await repo.archivePitcher(pitcherId, false)
    await expect(repo.startSession(pitcherId, '')).resolves.toBeTypeOf('string')
  })
  it('rolls back the event and session if materializing the count fails', async () => {
    await repo.act(sessionId, 'pitch', 'ball')
    const before = await repo.snapshot()
    const failure = () => { throw new Error('Simulated disk failure') }
    db.appearances.hook('creating', failure)
    await expect(repo.act(sessionId, 'pitch', 'called')).rejects.toThrow('Simulated disk failure')
    db.appearances.hook('creating').unsubscribe(failure)
    expect(await repo.snapshot()).toEqual(before)
    await repo.act(sessionId, 'pitch', 'called')
    expect((await current()).current).toMatchObject({ balls: 1, strikes: 1 })
    expect(await db.events.count()).toBe(2)
  })
  it('records next/reset boundaries without deleting pitches, excluding empty batters', async () => {
    await repo.act(sessionId, 'next')
    await repo.act(sessionId, 'pitch', 'ball')
    await repo.act(sessionId, 'reset')
    await repo.act(sessionId, 'next')
    expect(await stats()).toMatchObject({ total: 1, batters: 1, walks: 0, strikeouts: 0, pitchesPerBatter: 1 })
  })
  it('rejects invalid pitches and blank names without saving partial data', async () => {
    await expect(repo.act(sessionId, 'pitch', 'invalid')).rejects.toThrow('valid pitch')
    await expect(repo.savePitcher({ name: '  ', jersey: '', teamName: 'Ghost team' })).rejects.toThrow('name')
    expect(await db.events.count()).toBe(0)
    expect(await db.teams.count()).toBe(1)
  })
  it('uses transactions to prevent two repositories from starting sessions simultaneously', async () => {
    await repo.act(sessionId, 'end')
    const another = new Repository(new PitchDatabase(db.name))
    try {
      const results = await Promise.allSettled([repo.startSession(pitcherId, 'A'), another.startSession(pitcherId, 'B')])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(await db.sessions.filter(s => s.status !== 'ended').count()).toBe(1)
    } finally { another.db.close() }
  })
})
