import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBackup, validateBackup } from './backup'
import { metrics, pitchLocations } from './domain'
import { PitchDatabase, Repository } from './storage'

let db: PitchDatabase, repo: Repository, sessionId: string, pitcherId: string
beforeEach(async () => {
  db = new PitchDatabase(`backup-test-${crypto.randomUUID()}`); repo = new Repository(db)
  await repo.savePitcher({ name: 'Avery', jersey: '12', teamIds: [await repo.saveTeam({ name: 'Falcons' })] })
  pitcherId = (await db.pitchers.toArray())[0].id
  sessionId = await repo.startSession(pitcherId, 'Backup practice')
  for (const type of ['called', 'foul', 'swinging']) await repo.act(sessionId, 'pitch', type)
  await repo.act(sessionId, 'undo')
  await repo.act(sessionId, 'next')
  await repo.act(sessionId, 'pitch', 'ball')
  await repo.saveNotes(sessionId, 'Finish tall')
  await repo.act(sessionId, 'pause')
})
afterEach(async () => { await db.delete() })

describe('JSON backup and restore', () => {
  it('round-trips v5 goals and reads v4 without goals or account links', async () => {
    const teamId=(await db.teams.toArray())[0].id
    await db.goals.add({id:crypto.randomUUID(),scope:'personal',teamId:null,pitcherId,metric:'walkPct',direction:'max',target:10,revision:2,updatedAt:new Date().toISOString(),updatedBy:'player'})
    await db.goals.add({id:crypto.randomUUID(),scope:'team',teamId,pitcherId:null,metric:'total',direction:'min',target:1000,revision:1,updatedAt:new Date().toISOString(),updatedBy:null})
    const backup=await repo.exportBackup()
    expect(backup.goals).toHaveLength(2)
    expect(backup).not.toHaveProperty('playerAccounts')
    await repo.restoreBackup(parseBackup(JSON.stringify(backup)))
    expect((await repo.snapshot()).goals).toEqual(backup.goals)
    expect(validateBackup({...backup,version:4}).goals).toEqual([])
    expect(() => validateBackup({...backup,goals:[{...backup.goals[0],pitcherId:'missing'}]})).toThrow('goal')
    expect(() => validateBackup({...backup,goals:[{...backup.goals[0],target:-1}]})).toThrow('goal')
    expect(() => validateBackup({...backup,goals:[backup.goals[0],backup.goals[0]]})).toThrow('duplicate')
  })
  it('preserves all five locations, undo history, and legacy pitches through JSON and restore', async () => {
    await repo.act(sessionId, 'resume')
    for (const location of pitchLocations) await repo.act(sessionId, 'pitch', 'ball', location)
    await repo.act(sessionId, 'undo')
    const before = await repo.snapshot()
    const backup = parseBackup(JSON.stringify(await repo.exportBackup()))
    expect(backup.version).toBe(5)
    expect(backup.events.filter(e => e.pitchLocation).sort((a, b) => a.sequence - b.sequence).map(e => e.pitchLocation)).toEqual(pitchLocations)
    expect(backup.events.find(e => e.pitchType === 'swinging')?.pitchLocation).toBeUndefined()
    await repo.restoreBackup(backup)
    expect(await repo.snapshot()).toEqual(before)
  })
  it.each(['sideways', '', null, 1])('rejects invalid pitch location %j', async location => {
    const backup = await repo.exportBackup()
    const malformed = JSON.parse(JSON.stringify(backup))
    malformed.events.find((event: { kind: string }) => event.kind === 'pitch').pitchLocation = location
    await expect(repo.restoreBackup(malformed)).rejects.toThrow('pitch location')
    expect(await repo.exportBackup()).toMatchObject({ events: backup.events })
  })
  it('rejects locations attached to non-pitch events', async () => {
    const backup = JSON.parse(JSON.stringify(await repo.exportBackup()))
    backup.events.find((event: { kind: string }) => event.kind === 'next').pitchLocation = 'middle'
    expect(() => validateBackup(backup)).toThrow('only pitch events')
  })
  it('round-trips all source records, notes, undo history, and a paused session across databases', async () => {
    const backup = parseBackup(JSON.stringify(await repo.exportBackup()))
    const target = new PitchDatabase(`restore-target-${crypto.randomUUID()}`)
    try {
      const other = new Repository(target)
      await other.restoreBackup(backup)
      expect(await other.snapshot()).toEqual(await repo.snapshot())
      expect(metrics((await other.snapshot()).appearances)).toMatchObject({ total: 3, strikeouts: 0, batters: 2 })
      await other.act(sessionId, 'resume')
      await other.act(sessionId, 'pitch', 'foul')
      expect(metrics((await other.snapshot()).appearances).total).toBe(4)
    } finally { await target.delete() }
  })
  it('handles undo followed by boundaries and switches without rejecting valid source references', async () => {
    await repo.act(sessionId, 'resume')
    await repo.savePitcher({ name: 'Riley', jersey: '', teamIds: [] })
    const second = (await db.pitchers.toArray()).find(p => p.id !== pitcherId)!.id
    await repo.act(sessionId, 'pitch', 'inPlay')
    await repo.act(sessionId, 'switch', second)
    await repo.act(sessionId, 'undo')
    await repo.act(sessionId, 'pitch', 'called')
    const source = await repo.snapshot()
    const backup = await repo.exportBackup()
    await repo.restoreBackup(backup)
    expect(await repo.snapshot()).toEqual(source)
  })
  it('replaces old records and rebuilds appearances, including archived pitchers and ended sessions', async () => {
    await repo.act(sessionId, 'end')
    await repo.archivePitcher(pitcherId, true)
    const backup = await repo.exportBackup()
    await repo.savePitcher({ name: 'Temporary', jersey: '', teamIds: [await repo.saveTeam({ name: 'Extra' })] })
    await repo.restoreBackup(backup)
    expect(await db.pitchers.count()).toBe(1)
    expect(await db.teams.count()).toBe(1)
    expect((await db.pitchers.get(pitcherId))!.archived).toBe(true)
    expect((await db.sessions.get(sessionId))!.status).toBe('ended')
  })
  it('rolls back all replacement writes if rebuilding fails', async () => {
    const backup = await repo.exportBackup()
    await repo.savePitcher({ name: 'Keep this player', jersey: '', teamIds: [] })
    const before = await repo.snapshot()
    const fail = () => { throw new Error('Simulated full disk') }
    db.appearances.hook('creating', fail)
    await expect(repo.restoreBackup(backup)).rejects.toThrow('Simulated full disk')
    db.appearances.hook('creating').unsubscribe(fail)
    expect(await repo.snapshot()).toEqual(before)
  })
  it('orders export and restore with scoring actions', async () => {
    await repo.act(sessionId, 'resume')
    const pitch = repo.act(sessionId, 'pitch', 'called')
    const backup = repo.exportBackup()
    await pitch
    expect((await backup).events.filter(e => e.kind === 'pitch' && !e.voidedAt)).toHaveLength(4)
  })
  it('accepts an empty backup', async () => {
    await repo.restoreBackup({ format: 'pitchwork-backup', version: 1, exportedAt: new Date().toISOString(), teams: [], pitchers: [], sessions: [], events: [] })
    expect(await db.pitchers.count()).toBe(0)
    expect(await db.appearances.count()).toBe(0)
  })
  it.each([
    ['unsupported version', (b: any) => { b.version = 999 }],
    ['missing fields', (b: any) => { delete b.pitchers[0].name }],
    ['bad dates', (b: any) => { b.exportedAt = 'yesterday' }],
    ['wrong types', (b: any) => { b.pitchers[0].archived = 'false' }],
    ['unknown pitch outcome', (b: any) => { b.events[0].pitchType = 'bunt' }],
    ['duplicate rows', (b: any) => { b.pitchers.push(b.pitchers[0]) }],
    ['missing team', (b: any) => { b.teams = [] }],
    ['missing pitcher', (b: any) => { b.pitchers = [] }],
    ['missing session', (b: any) => { b.sessions = [] }],
    ['missing appearance', (b: any) => { b.events[0].appearanceId = 'missing' }],
    ['reused appearance', (b: any) => { b.events[0].nextAppearanceId = b.sessions[0].initialAppearanceId }],
    ['duplicate sequence', (b: any) => { b.events[1].sequence = b.events[0].sequence }],
    ['sequence gap', (b: any) => { b.events[0].sequence = 10 }],
    ['incorrect next sequence', (b: any) => { b.sessions[0].nextSequence = 1 }],
    ['incorrect session end', (b: any) => { b.sessions[0].status = 'ended' }],
    ['voided boundary', (b: any) => { b.events.find((e: any) => e.kind === 'next').voidedAt = b.exportedAt }],
    ['multiple ongoing sessions', (b: any) => { b.sessions.push({ ...b.sessions[0], id: 'second', initialAppearanceId: 'second-appearance' }) }],
  ])('rejects %s without changing local records', async (_, corrupt) => {
    const before = await repo.snapshot()
    const backup = JSON.parse(JSON.stringify(await repo.exportBackup()))
    corrupt(backup)
    await expect(repo.restoreBackup(backup)).rejects.toThrow('Invalid backup')
    expect(await repo.snapshot()).toEqual(before)
  })
  it('rejects malformed JSON and non-objects with an actionable message', () => {
    expect(() => parseBackup('{')).toThrow('not valid JSON')
    expect(() => validateBackup(null)).toThrow('must be an object')
  })
})


describe('archive backup compatibility', () => {
  it('preserves archive state in v3 and defaults legacy v2 records to active', async () => {
    await repo.act(sessionId,'end')
    const team = (await db.teams.toArray())[0]
    await db.teams.update(team.id,{archived:true});await db.sessions.update(sessionId,{archived:true})
    const backup=await repo.exportBackup()
    expect(backup.version).toBe(5);expect(backup.teams[0].archived).toBe(true);expect(backup.sessions[0].archived).toBe(true)
    await repo.restoreBackup(backup)
    expect((await repo.snapshot()).sessions[0].archived).toBe(true)
    const legacy=validateBackup({...backup,version:2})
    expect(legacy.teams[0].archived).toBe(false);expect(legacy.sessions[0].archived).toBe(false)
  })
})
