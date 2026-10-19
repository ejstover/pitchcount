import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PitchDatabase, Repository } from './storage'
import type { Upload } from './shared'

const a = '10000000-0000-4000-8000-000000000001', b = '10000000-0000-4000-8000-000000000002'
const admin = '10000000-0000-4000-8000-000000000003', device = '20000000-0000-4000-8000-000000000001'
let sql: PGlite
async function login(id: string) { await sql.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`) }
async function rpc<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const parameters = args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' ? '::jsonb' : '::text'}`).join(',')
  return (await sql.query<{ result: T }>(`select public.${name}(${parameters}) as result`, args.map(x => typeof x === 'object' ? JSON.stringify(x) : x))).rows[0].result
}
async function team(name = 'Falcons') { const id = crypto.randomUUID(); await rpc('manage', 'saveTeam', { id, name }); return id }
async function pitcher(teams: string[]) { const id = crypto.randomUUID(); await rpc('manage', 'savePitcher', { id, name: 'Jordan', jersey: '14', teamIds: teams }); return id }
async function invite(teamId: string, email = 'b@example.com') {
  await rpc('manage', 'invite', { teamId, email })
  return (await sql.query<{ id: string }>('select id from public.invitations where team_id=$1', [teamId])).rows[0].id
}
async function operations(pid: string, teamId: string | null, owner = a) {
  const db = new PitchDatabase(`sql-fixture-${crypto.randomUUID()}`)
  const repo = new Repository(db, { coachId: owner, deviceId: device })
  try {
    await db.pitchers.put({ id: pid, name: 'Jordan', jersey: '', ownerId: owner, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    if (teamId) { await db.teamPitchers.put({ teamId, pitcherId: pid, active: true }); await db.teamCoaches.put({ teamId, coachId: owner }) }
    const sid = await repo.startSession(pid, 'Bullpen', teamId)
    await repo.act(sid, 'pitch', 'ball', 'upIn')
    return (await repo.pendingUploads()).sort((a, b) => a.expectedRevision - b.expectedRevision)
  } finally { await db.delete() }
}
beforeAll(async () => {
  sql = new PGlite()
  await sql.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated; grant execute on function auth.uid() to authenticated;`)
  await sql.exec(readFileSync('supabase/migrations/202610190001_accounts.sql', 'utf8'))
  await sql.exec(readFileSync('supabase/migrations/202610190002_teams.sql', 'utf8'))
}, 30_000)
beforeEach(async () => {
  await sql.exec(`reset role; truncate public.operation_receipts, public.practices, public.invitations, public.team_pitchers, public.pitchers, public.team_coaches, public.teams, public.coaches, public.account_provisions, auth.users cascade;
    insert into public.account_provisions(id,email,name,role) values('${a}','a@example.com','Coach A','coach'),('${b}','b@example.com','Coach B','coach'),('${admin}','admin@example.com','Admin','admin');
    insert into auth.users(id,email) select id,email from public.account_provisions;`)
  await login(a)
})
afterAll(async () => { await sql?.close() })

describe('server team access and practice transactions', () => {
  it('creates a team with its coach, supports many memberships, and prevents duplicate assignments', async () => {
    const t1 = await team(), t2 = await team('Owls'), pid = await pitcher([t1, t2, t1])
    const data = await rpc<any>('get_workspace')
    expect(data.teamCoaches).toHaveLength(2)
    expect(data.teamPitchers.filter((m: any) => m.pitcherId === pid)).toHaveLength(2)
    await expect(rpc('manage', 'removeCoach', { teamId: t1, coachId: a })).rejects.toThrow('retain')
  })
  it('accepts invitations only for the approved matching email and allows cancellation', async () => {
    const tid = await team(), iid = await invite(tid)
    await expect(rpc('manage', 'acceptInvitation', { id: iid })).rejects.toThrow('unavailable')
    await login(b)
    expect((await rpc<any>('get_workspace')).invitations[0].id).toBe(iid)
    await rpc('manage', 'acceptInvitation', { id: iid })
    expect((await rpc<any>('get_workspace')).teams[0].id).toBe(tid)
    await rpc('manage', 'saveTeam', { id: tid, name: 'Renamed by B' })
    const next = await invite(tid, 'admin@example.com')
    await rpc('manage', 'cancelInvitation', { teamId: tid, id: next })
    expect((await rpc<any>('get_workspace')).invitations).toEqual([])
  })
  it('keeps a shared pitcher’s other team practices and independent work private', async () => {
    const t1 = await team('A team'), t2 = await team('Shared'), pid = await pitcher([t1, t2])
    for (const tid of [t1, t2, null]) for (const op of await operations(pid, tid)) await rpc('upload_practice', op)
    const iid = await invite(t2); await login(b); await rpc('manage', 'acceptInvitation', { id: iid })
    const data = await rpc<any>('get_workspace')
    expect(data.pitchers.map((p: any) => p.id)).toEqual([pid])
    expect(data.sessions).toHaveLength(1)
    expect(data.sessions[0].teamId).toBe(t2)
    expect(data.events).toHaveLength(1)
    await expect(rpc('manage', 'saveTeam', { id: t1, name: 'Attack' })).rejects.toThrow('denied')
    await expect(sql.query('update public.pitchers set name=$1 where id=$2', ['Attack', pid])).rejects.toThrow('permission denied')
  })
  it('uploads atomically, validates source events, and deduplicates a lost acknowledgement', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    expect(await rpc('upload_practice', ops[0])).toBe(1)
    expect(await rpc('upload_practice', ops[0])).toBe(1)
    const bad: Upload = structuredClone(ops[1]); bad.events[0].pitchLocation = 'invalid' as any
    await expect(rpc('upload_practice', bad)).rejects.toThrow('Invalid pitch')
    expect((await rpc<any>('get_workspace')).events).toHaveLength(0)
    expect(await rpc('upload_practice', ops[1])).toBe(2)
    expect((await rpc<any>('get_workspace')).events[0].pitchLocation).toBe('upIn')
    await expect(rpc('upload_practice', { ...ops[0], id: crypto.randomUUID() })).rejects.toThrow('revision conflict')
  })
  it('prevents another coach/device from recording into an existing practice', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    await rpc('upload_practice', ops[0])
    const otherDevice = structuredClone(ops[1]); otherDevice.session.deviceId = crypto.randomUUID()
    await expect(rpc('upload_practice', otherDevice)).rejects.toThrow('another recorder')
    const iid = await invite(tid); await login(b); await rpc('manage', 'acceptInvitation', { id: iid })
    const otherCoach = structuredClone(ops[1]); otherCoach.session.recorderId = b
    await expect(rpc('upload_practice', otherCoach)).rejects.toThrow('another recorder')
  })
  it('keeps historical names and team attribution after roster removal and revokes access immediately', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    for (const op of ops) await rpc('upload_practice', op)
    const iid = await invite(tid); await login(b); await rpc('manage', 'acceptInvitation', { id: iid })
    await rpc('manage', 'setPitcher', { teamId: tid, pitcherId: pid, active: false })
    let data = await rpc<any>('get_workspace')
    expect(data.pitchers[0].id).toBe(pid); expect(data.sessions[0].teamId).toBe(tid)
    await login(a); await rpc('manage', 'removeCoach', { teamId: tid, coachId: b }); await login(b)
    data = await rpc<any>('get_workspace'); expect(data.sessions).toEqual([]); expect(data.pitchers).toEqual([])
  })
  it('blocks suspended users even with an existing JWT', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    await sql.exec(`reset role; update public.coaches set active=false where id='${a}';`)
    await login(a)
    expect((await rpc<any>('get_workspace')).teams).toEqual([])
    await expect(rpc('upload_practice', ops[0])).rejects.toThrow('Account cannot')
    await expect(rpc('manage', 'saveTeam', { id: tid, name: 'Attack' })).rejects.toThrow('Account cannot')
  })
  it('restores fresh private copies without importing account permissions or replacing shared records', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    for (const op of ops) await rpc('upload_practice', op)
    const data = await rpc<any>('get_workspace')
    const backup = { format: 'pitchwork-backup', version: 2, exportedAt: new Date().toISOString(), ...data }
    const operationId = crypto.randomUUID()
    await login(b)
    await rpc('manage', 'restore', { backup, operationId, deviceId: device })
    await rpc('manage', 'restore', { backup, operationId, deviceId: device })
    const restored = await rpc<any>('get_workspace')
    expect(restored.teams).toHaveLength(1); expect(restored.teams[0].id).not.toBe(tid)
    expect(restored.teamCoaches).toEqual([{ teamId: restored.teams[0].id, coachId: b }])
    expect(restored.sessions[0].recovered).toBe(true)
    expect(restored.events[0].pitchLocation).toBe('upIn')
    await login(a); expect((await rpc<any>('get_workspace')).teams).toHaveLength(1)
  })
  it('accepts coalesced revisions and rejects null source fields atomically', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid, tid)
    const coalesced = { ...ops[1], expectedRevision: 0 }
    const malformed = structuredClone(coalesced)
    malformed.events[0].sequence = null as any
    await expect(rpc('upload_practice', malformed)).rejects.toThrow('Invalid event sequence')
    expect((await rpc<any>('get_workspace')).sessions).toEqual([])
    expect(await rpc('upload_practice', coalesced)).toBe(2)
    expect((await rpc<any>('get_workspace')).events).toHaveLength(1)
  })
})
