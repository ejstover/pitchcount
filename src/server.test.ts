import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PitchDatabase, Repository } from './storage'
import { CloudError, type Gateway, type Upload } from './shared'
import { parseGameChanger, type GCImport, type GCSummary } from './gamechanger'

const a = '10000000-0000-4000-8000-000000000001', b = '10000000-0000-4000-8000-000000000002'
const admin = '10000000-0000-4000-8000-000000000003', device = '20000000-0000-4000-8000-000000000001'
let sql: PGlite
async function login(id: string) { await sql.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`) }
async function rpc<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  const parameters = args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' ? '::jsonb' : '::text'}`).join(',')
  try { return (await sql.query<{ result: T }>(`select public.${name}(${parameters}) as result`, args.map(x => typeof x === 'object' ? JSON.stringify(x) : x))).rows[0].result } catch (cause) { throw new Error(`${name}: ${(cause as Error).message}`) }
}
async function team(name = 'Falcons') { const id = crypto.randomUUID(); await rpc('manage', 'saveTeam', { id, name }); return id }
async function pitcher(teams: string[]) { const id = crypto.randomUUID(); await rpc('manage', 'savePitcher', { id, name: 'Jordan', jersey: '14', teamIds: teams }); return id }
async function invite(teamId: string, email = 'b@example.com') {
  await rpc('manage', 'invite', { teamId, email })
  return (await sql.query<{ id: string }>('select id from public.invitations where team_id=$1', [teamId])).rows[0].id
}
async function gcInput(teamId: string): Promise<GCImport> {
  const parsed = parseGameChanger(readFileSync('tests/fixtures/gamechanger.csv', 'utf8'))
  const players = []
  for (const row of parsed.players) { const id = await pitcher([teamId]); players.push({ ...row, pitcherId: id }) }
  return { ...parsed, players, teamId, season: 'Fall 2026', coverageStart: '2026-09-01', coverageEnd: '2026-10-20', fileName: 'stats.csv', operationId: crypto.randomUUID(), newPitchers: [], expectedRevision: 0, coverageConfirmed: true }
}
describe('GameChanger imports against PostgreSQL', () => {
  it('atomically imports, deduplicates renamed/reordered exports, replaces with reductions, and detects conflicts', async () => {
    const input = await gcInput(await team())
    await rpc('manage', 'importGameChanger', input)
    await rpc('manage', 'importGameChanger', input)
    let data = await rpc<any>('get_workspace')
    expect(data.gcSummaries).toHaveLength(1); expect(data.gcMappings).toHaveLength(4); expect(data.events).toEqual([])
    const first = data.gcSummaries[0] as GCSummary
    expect(first.players.reduce((n, p) => n + p.stats.pitches!, 0)).toBe(535)
    await rpc('manage', 'importGameChanger', { ...input, players: [...input.players].reverse(), fileName: 'renamed(6).csv', operationId: crypto.randomUUID(), expectedRevision: 1 })
    expect((await rpc<any>('get_workspace')).gcSummaries[0].revision).toBe(1)
    const replacement = structuredClone(input); replacement.operationId = crypto.randomUUID(); replacement.expectedRevision = 1; replacement.players = replacement.players.slice(0, 1); replacement.players[0].stats.pitches = 100
    await rpc('manage', 'importGameChanger', replacement)
    data = await rpc<any>('get_workspace'); expect(data.gcSummaries[0].revision).toBe(2); expect(data.gcSummaries[0].players).toHaveLength(1)
    await expect(rpc('manage', 'importGameChanger', { ...input, operationId: crypto.randomUUID(), expectedRevision: 1 })).rejects.toThrow('Refresh')
    await expect(rpc('manage', 'importGameChanger', { ...input, coverageEnd: '2026-10-21' })).rejects.toThrow('Operation ID')
  })
  it('rejects viewers, suspended and unrelated coaches, forged mappings, missing confirmation and malformed counts', async () => {
    const input = await gcInput(await team()), outsider = await pitcher([])
    await expect(rpc('manage', 'importGameChanger', { ...input, coverageConfirmed: false })).rejects.toThrow('Confirm')
    const bad = structuredClone(input); bad.players[0].stats.pitches = -1
    await expect(rpc('manage', 'importGameChanger', bad)).rejects.toThrow('Invalid GameChanger')
    bad.players[0].stats.pitches = 10; bad.players[0].pitcherId = outsider
    await expect(rpc('manage', 'importGameChanger', bad)).rejects.toThrow('on this team')
    await login(b)
    await expect(rpc('manage', 'importGameChanger', input)).rejects.toThrow('access denied')
    expect((await rpc<any>('get_workspace')).gcSummaries).toEqual([])
    await sql.exec(`reset role; update public.coaches set role='viewer' where id='${a}';`); await login(a)
    await expect(rpc('manage', 'importGameChanger', input)).rejects.toThrow('Approved coach')
    await sql.exec(`reset role; update public.coaches set role='coach',active=false where id='${a}';`); await login(a)
    await expect(rpc('manage', 'importGameChanger', input)).rejects.toThrow('Approved coach')
  })
  it('creates only requested players in the transaction and rolls them back on conflict', async () => {
    const input = await gcInput(await team())
    await rpc('manage', 'importGameChanger', input)
    const changed = structuredClone(input), id = crypto.randomUUID()
    changed.operationId = crypto.randomUUID(); changed.players[0].pitcherId = id; changed.newPitchers = [{ id, name: 'New Pitcher', jersey: '9' }]
    await expect(rpc('manage', 'importGameChanger', changed)).rejects.toThrow('Refresh')
    expect((await rpc<any>('get_workspace')).pitchers.some((p: any) => p.id === id)).toBe(false)
    changed.expectedRevision = 1; await rpc('manage', 'importGameChanger', changed); await rpc('manage', 'importGameChanger', changed)
    expect((await rpc<any>('get_workspace')).pitchers.filter((p: any) => p.id === id)).toHaveLength(1)
  })
  it('keeps historical players visible, blocks dependent deletion, and removes a summary with safe retry', async () => {
    const input = await gcInput(await team()), pid = input.players[0].pitcherId
    await rpc('manage', 'importGameChanger', input)
    await rpc('manage', 'setPitcher', { teamId: input.teamId, pitcherId: pid, active: false })
    const invitation = await invite(input.teamId); await login(b); await rpc('manage', 'acceptInvitation', { id: invitation, teamId: input.teamId })
    expect((await rpc<any>('get_workspace')).pitchers.some((p: any) => p.id === pid)).toBe(true)
    const preview = await rpc<any>('manage', 'removalPreview', { kind: 'pitcher', id: pid })
    expect(preview.deleteBlockers.join(' ')).toContain('GameChanger summaries')
    const removal = { teamId: input.teamId, season: input.season, expectedRevision: 1, operationId: crypto.randomUUID() }
    await rpc('manage', 'removeGameChanger', removal); await rpc('manage', 'removeGameChanger', removal)
    expect((await rpc<any>('get_workspace')).gcSummaries).toEqual([])
    await login(a)
    await rpc('manage', 'importGameChanger', input) // old operation receipt cannot resurrect deleted summaries
    expect((await rpc<any>('get_workspace')).gcSummaries).toEqual([])
  })
  it('restores version 4 with fresh references, preserves original records and retries once', async () => {
    const input = await gcInput(await team()); await rpc('manage', 'importGameChanger', input)
    const data = await rpc<any>('get_workspace')
    const restore = { operationId: crypto.randomUUID(), deviceId: device, backup: { ...data, format: 'pitchwork-backup', version: 4 } }
    await rpc('manage', 'restore', restore); await rpc('manage', 'restore', restore)
    const result = await rpc<any>('get_workspace')
    expect(result.gcSummaries).toHaveLength(2); expect(result.teams).toHaveLength(2)
    const copy = result.gcSummaries.find((s: GCSummary) => s.teamId !== input.teamId) as GCSummary
    expect(copy.players.every(p => !input.players.some(old => old.pitcherId === p.pitcherId))).toBe(true)
    expect(result.gcMappings.filter((m: any) => m.teamId === copy.teamId).map((m: any) => m.pitcherId).sort()).toEqual(copy.players.map(p => p.pitcherId).sort())
    const malformed = structuredClone(restore); malformed.operationId = crypto.randomUUID(); malformed.backup.gcSummaries[0].players[0].pitcherId = crypto.randomUUID()
    await expect(rpc('manage', 'restore', malformed)).rejects.toThrow('Missing backup GC pitcher')
    expect((await rpc<any>('get_workspace')).teams).toHaveLength(2)
  })
})
async function operations(pid: string, teamId: string | null, owner = a, ended = false) {
  const db = new PitchDatabase(`sql-fixture-${crypto.randomUUID()}`)
  const repo = new Repository(db, { coachId: owner, deviceId: device })
  try {
    await db.pitchers.put({ id: pid, name: 'Jordan', jersey: '', ownerId: owner, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    if (teamId) { await db.teamPitchers.put({ teamId, pitcherId: pid, active: true }); await db.teamCoaches.put({ teamId, coachId: owner }) }
    const sid = await repo.startSession(pid, 'Bullpen', teamId)
    await repo.act(sid, 'pitch', 'ball', 'upIn')
    if (ended) await repo.act(sid, 'end')
    return (await repo.pendingUploads()).sort((a, b) => a.expectedRevision - b.expectedRevision)
  } finally { await db.delete() }
}
beforeAll(async () => {
  sql = new PGlite()
  await sql.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated; grant execute on function auth.uid() to authenticated;`)
  for (const migration of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
    await sql.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'))
  }
}, 30_000)
beforeEach(async () => {
  await sql.exec(`reset role; truncate public.account_deletions,public.removal_visibility,public.record_tombstones,public.operation_receipts, public.practices, public.invitations, public.team_pitchers, public.pitchers, public.team_coaches, public.teams, public.coaches, public.account_provisions, auth.users cascade;
    insert into public.account_provisions(id,email,name,role) values('${a}','a@example.com','Coach A','coach'),('${b}','b@example.com','Coach B','coach'),('${admin}','admin@example.com','Admin','admin');
    insert into auth.users(id,email) select id,email from public.account_provisions;`)
  await login(a)
})
afterAll(async () => { await sql?.close() })

async function playerAccount(pid: string, email = 'player@example.com') {
  await sql.exec('reset role')
  const result = await sql.query<{r:{id:string}}>("select public.account_action($1::uuid,'preparePlayer',$2::jsonb) r", [admin, JSON.stringify({email,name:'Player',pitcherId:pid})])
  const id = result.rows[0].r.id
  await sql.query('insert into auth.users(id,email) values($1,$2)', [id,email])
  return id
}
const goalInput = (teamId: string | null, pitcherId: string | null, scope = 'team', extra = {}) => ({ id:crypto.randomUUID(),scope,teamId,pitcherId,metric:'strikePct',direction:'min',target:60,expectedRevision:0,...extra })

describe('player accounts and goal authorization against PostgreSQL', () => {
  it('provisions a unique pitcher link without coaching memberships, and keeps existing roles unchanged', async () => {
    const tid=await team(), pid=await pitcher([tid]), player=await playerAccount(pid)
    await login(player)
    const data=await rpc<any>('get_workspace')
    expect(data.coaches.find((c:any) => c.id===player)).toMatchObject({role:'player',pitcherId:pid})
    expect(data.teamCoaches.some((m:any) => m.coachId===player)).toBe(false)
    expect(data.teams.map((t:any) => t.id)).toEqual([tid])
    await sql.exec('reset role')
    await expect(sql.query("select public.account_action($1::uuid,'preparePlayer',$2::jsonb)",[admin,JSON.stringify({email:'another@example.com',name:'Other',pitcherId:pid})])).rejects.toThrow()
    await expect(sql.query("select public.account_action($1::uuid,'prepare',$2::jsonb)",[admin,JSON.stringify({email:'player@example.com',name:'Player'})])).rejects.toThrow('player account')
    await expect(sql.query("select public.account_action($1::uuid,'update',$2::jsonb)",[admin,JSON.stringify({id:player,active:true,pitcherId:pid,teamIds:[tid]})])).rejects.toThrow('coaching assignments')
    expect((await sql.query<{role:string}>('select role from public.coaches where id=$1',[a])).rows[0].role).toBe('coach')
  })
  it('allows coaches to manage only their teams and players to manage only their own personal goals', async () => {
    const tid=await team(), pid=await pitcher([tid]), other=await pitcher([tid])
    const staff=goalInput(tid,null), coach=goalInput(tid,pid,'coach')
    const acknowledged=await rpc<any>('manage','saveGoal',staff)
    expect(acknowledged).toMatchObject({id:staff.id,target:60,revision:1,updatedBy:a})
    await rpc('manage','saveGoal',coach)
    await expect(rpc('manage','saveGoal',goalInput(null,pid,'personal'))).rejects.toThrow('linked player')
    await login(b)
    await expect(rpc('manage','saveGoal',{...staff,expectedRevision:1})).rejects.toThrow('access denied')
    await expect(rpc('manage','deleteGoal',{id:staff.id,expectedRevision:1})).rejects.toThrow('access denied')
    const player=await playerAccount(pid); await login(player)
    const personal=goalInput(null,pid,'personal',{target:50,updatedBy:a})
    await rpc('manage','saveGoal',personal) // Less demanding personal goals are allowed.
    expect((await rpc<any>('get_workspace')).goals.find((g:any) => g.id===personal.id)).toMatchObject({updatedBy:player,target:50,revision:1})
    await expect(rpc('manage','saveGoal',goalInput(null,other,'personal'))).rejects.toThrow('linked player')
    await expect(rpc('manage','saveGoal',goalInput(tid,other,'coach'))).rejects.toThrow('access denied')
    await expect(rpc('manage','saveGoal',{...staff,expectedRevision:1})).rejects.toThrow('access denied')
    await expect(rpc('manage','deleteGoal',{id:staff.id,expectedRevision:1})).rejects.toThrow('access denied')
    await rpc('manage','deleteGoal',{id:personal.id,expectedRevision:1})
    expect((await rpc<any>('get_workspace')).goals).toHaveLength(2)
  })
  it('blocks team recording, imports, roster changes, restore and invitation acceptance for players, including forged identities', async () => {
    const tid=await team(),pid=await pitcher([tid]),operation=(await operations(pid,tid)).at(-1)!
    const iid=await invite(tid,'player@example.com'),player=await playerAccount(pid)
    await login(player)
    for (const [action,input] of [
      ['saveTeam',{id:crypto.randomUUID(),name:'Forged'}],['savePitcher',{id:pid,name:'Forged',jersey:'',teamIds:[tid]}],
      ['setPitcher',{teamId:tid,pitcherId:pid,active:false}],['acceptInvitation',{id:iid,teamId:tid}],
      ['importGameChanger',{teamId:tid}],['restore',{backup:{version:5},operationId:crypto.randomUUID()}],
      ['archiveRecord',{kind:'team',id:tid,archived:true}],
    ] as const) await expect(rpc('manage',action,input)).rejects.toThrow()
    await expect(rpc('upload_practice',{...operation,session:{...operation.session,recorderId:player}})).rejects.toThrow(/cannot record/i)
    await expect(sql.query('insert into public.team_coaches values($1,$2)',[tid,player])).rejects.toThrow('permission denied')
    await expect(sql.query('insert into public.player_accounts values($1,$2)',[player,pid])).rejects.toThrow('permission denied')
    await expect(sql.query("select public.account_action($1::uuid,'update',$2::jsonb)",[admin,JSON.stringify({id:player,active:true,teamIds:[tid]})])).rejects.toThrow('permission denied')
  })
  it('allows players to upload their own independent practices while preserving other-player and recorder privacy', async () => {
    const tid=await team(),pid=await pitcher([tid]),other=await pitcher([tid]),player=await playerAccount(pid)
    const own=(await operations(pid,null,player,true)).at(-1)!
    await login(player)
    await rpc('upload_practice',{...own,expectedRevision:0})
    expect((await rpc<any>('get_workspace')).sessions.map((s:any) => s.id)).toEqual([own.sessionId])
    const forged=(await operations(other,null,player,true)).at(-1)!
    await expect(rpc('upload_practice',{...forged,expectedRevision:0})).rejects.toThrow('other-player')
    await login(a)
    expect((await rpc<any>('get_workspace')).sessions).toEqual([])
    expect((await sql.query('select id from public.practices')).rows).toEqual([])
  })
  it('limits workspace and direct table reads to shared teams; roster removal and suspension revoke access', async () => {
    const tid=await team(),pid=await pitcher([tid]),mate=await pitcher([tid])
    const practice=(await operations(mate,tid)).at(-1)!; await rpc('upload_practice',{...practice,expectedRevision:0})
    const independent=(await operations(pid,null)).at(-1)!; await rpc('upload_practice',{...independent,expectedRevision:0})
    const staff=goalInput(tid,null); await rpc('manage','saveGoal',staff)
    await login(b); const privateTeam=await team('Private'),privatePid=await pitcher([privateTeam])
    await rpc('manage','saveGoal',goalInput(privateTeam,null))
    const player=await playerAccount(pid);await login(player)
    let data=await rpc<any>('get_workspace')
    expect(data.teams.map((t:any) => t.id)).toEqual([tid])
    expect(data.sessions.map((s:any) => s.id)).toEqual([practice.sessionId])
    expect(data.pitchers.some((p:any) => p.id===privatePid)).toBe(false)
    expect((await sql.query('select id from public.goals')).rows).toHaveLength(1)
    expect((await sql.query('select id from public.practices')).rows).toHaveLength(1)
    await login(a);await rpc('manage','setPitcher',{teamId:tid,pitcherId:pid,active:false})
    await login(player);data=await rpc<any>('get_workspace')
    expect(data.teams).toEqual([]);expect(data.goals).toEqual([]);expect(data.sessions).toEqual([])
    await sql.exec('reset role');await sql.query('update public.coaches set active=false where id=$1',[player])
    await login(player);expect((await rpc<any>('get_workspace')).pitchers).toEqual([])
    await expect(rpc('manage','saveGoal',goalInput(null,pid,'personal'))).rejects.toThrow('Active account')
  })
  it('shares personal goals with teammates and assigned coaches, without sharing the player’s other team targets', async () => {
    const tid=await team(),second=await team('Owls'),pid=await pitcher([tid,second]),mate=await pitcher([tid])
    await rpc('manage','saveGoal',goalInput(second,pid,'coach'))
    const player=await playerAccount(pid);await login(player)
    const personal=goalInput(null,pid,'personal');await rpc('manage','saveGoal',personal)
    expect((await rpc<any>('get_workspace')).teams).toHaveLength(2)
    const teammate=await playerAccount(mate,'mate@example.com');await login(teammate)
    const data=await rpc<any>('get_workspace')
    expect(data.goals.map((g:any) => g.id)).toEqual([personal.id])
    await login(a);expect((await rpc<any>('get_workspace')).goals).toHaveLength(2)
  })
  it('detects stale updates, duplicate targets, stale deletes and immutable goal identity', async () => {
    const tid=await team(),g=goalInput(tid,null);await rpc('manage','saveGoal',g)
    await expect(rpc('manage','saveGoal',{...g,id:crypto.randomUUID()})).rejects.toThrow('Refresh')
    await rpc('manage','saveGoal',{...g,target:65,expectedRevision:1})
    await expect(rpc('manage','saveGoal',{...g,target:70,expectedRevision:1})).rejects.toThrow('Refresh')
    await expect(rpc('manage','deleteGoal',{id:g.id,expectedRevision:1})).rejects.toThrow('Refresh')
    await expect(rpc('manage','saveGoal',{...g,metric:'walkPct',direction:'max',expectedRevision:2})).rejects.toThrow('identity')
    await rpc('manage','deleteGoal',{id:g.id,expectedRevision:2})
    expect((await rpc<any>('get_workspace')).goals).toEqual([])
  })
  it('validates targets and directions on the server, and keeps viewers read-only', async () => {
    const tid=await team()
    for (const bad of [{target:-1},{target:101},{target:'60'},{direction:'max'},{metric:'total',target:2.5},{scope:'personal'},{metric:'invented'}]) {
      await expect(rpc('manage','saveGoal',goalInput(tid,null,'team',bad))).rejects.toThrow()
    }
    await rpc('manage','saveGoal',goalInput(tid,null))
    await sql.exec(`reset role; update public.coaches set role='viewer' where id='${a}'`);await login(a)
    expect((await rpc<any>('get_workspace')).goals).toHaveLength(1)
    await expect(rpc('manage','saveGoal',goalInput(tid,null,'team',{metric:'total',direction:'max',target:100}))).rejects.toThrow('access denied')
  })
  it('lets admins relink, suspend and reactivate players without creating coach assignments', async () => {
    const tid=await team(),pid=await pitcher([tid]),other=await pitcher([]),player=await playerAccount(pid)
    const change=(active:boolean,pitcherId:string) => sql.query("select public.account_action($1::uuid,'update',$2::jsonb)",[admin,JSON.stringify({id:player,active,pitcherId,teamIds:[]})])
    await change(false,other);await login(player)
    expect((await rpc<any>('get_workspace')).teams).toEqual([])
    await sql.exec('reset role');await change(true,other);await login(player)
    const data=await rpc<any>('get_workspace')
    expect(data.coaches.find((c:any) => c.id===player).pitcherId).toBe(other)
    expect(data.pitchers.map((p:any) => p.id)).toEqual([other])
    await expect(rpc('manage','saveGoal',goalInput(null,pid,'personal'))).rejects.toThrow('linked player')
    await rpc('manage','saveGoal',goalInput(null,other,'personal'))
  })
  it('preserves goals through archive and removes them with permanent team or pitcher deletion', async () => {
    const tid=await team(),pid=await pitcher([tid]),g=goalInput(tid,null)
    await rpc('manage','saveGoal',g);await rpc('manage','archiveRecord',{kind:'team',id:tid,archived:true})
    expect((await rpc<any>('get_workspace')).goals).toHaveLength(1)
    await expect(rpc('manage','saveGoal',{...g,target:70,expectedRevision:1})).rejects.toThrow('Reactivate')
    await rpc('manage','deleteRecord',{kind:'team',id:tid,confirmation:'Falcons'})
    expect((await rpc<any>('get_workspace')).goals).toEqual([])
    const player=await playerAccount(pid);await login(player);await rpc('manage','saveGoal',goalInput(null,pid,'personal'))
    await login(a);await rpc('manage','deleteRecord',{kind:'pitcher',id:pid,confirmation:'Jordan'})
    await sql.exec('reset role');expect((await sql.query('select * from public.player_accounts')).rows).toEqual([])
  })
  it('restores v5 goals with new references and no links; personal copies require a linked player', async () => {
    const tid=await team(),pid=await pitcher([tid]),player=await playerAccount(pid)
    await login(player);await rpc('manage','saveGoal',goalInput(null,pid,'personal'))
    await login(a);await rpc('manage','saveGoal',goalInput(tid,null));await rpc('manage','saveGoal',goalInput(tid,pid,'coach'))
    const data=await rpc<any>('get_workspace')
    const input={operationId:crypto.randomUUID(),deviceId:device,backup:{...data,format:'pitchwork-backup',version:5}}
    await rpc('manage','restore',input);await rpc('manage','restore',input)
    const restored=await rpc<any>('get_workspace'),copies=restored.goals.filter((g:any) => !data.goals.some((old:any) => old.id===g.id))
    expect(copies).toHaveLength(3)
    expect(copies.every((g:any) => g.teamId!==tid && g.pitcherId!==pid && g.updatedBy===null)).toBe(true)
    const personal=copies.find((g:any) => g.scope==='personal')
    await expect(rpc('manage','saveGoal',{...personal,expectedRevision:1})).rejects.toThrow('linked player')
    await sql.exec('reset role');expect((await sql.query('select * from public.player_accounts')).rows).toHaveLength(1)
    const malformed=structuredClone(input);malformed.operationId=crypto.randomUUID();malformed.backup.goals[0].pitcherId=crypto.randomUUID()
    await login(a);await expect(rpc('manage','restore',malformed)).rejects.toThrow('goal reference')
    expect((await rpc<any>('get_workspace')).teams).toHaveLength(2)
  })
})

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
  it('repairs a legacy ordering rejection against real SQL without accepting changed events', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    const tid = await team(), pid = await pitcher([tid])
    const db = new PitchDatabase(`sql-sync-repair-${crypto.randomUUID()}`)
    const attempts: Upload[] = []
    const gateway: Gateway = {
      workspace: () => rpc<any>('get_workspace'),
      manage: (action, input) => rpc('manage', action, input),
      upload: async operation => {
        attempts.push(structuredClone(operation))
        try {
          return (await sql.query<{ revision: number }>('select public.upload_practice($1::jsonb) revision', [JSON.stringify(operation)])).rows[0].revision
        } catch (error) { throw new CloudError((error as Error).message, (error as { code: string }).code) }
      },
    }
    const repo = new Repository(db, { coachId: a, deviceId: device }, gateway)
    try {
      await repo.sync()
      const sid = await repo.startSession(pid, 'Legacy upload', tid)
      await repo.act(sid, 'pitch', 'ball', 'upIn'); await repo.sync()
      await repo.act(sid, 'pitch', 'ball', 'middle')
      const [legacy] = await repo.pendingUploads()
      legacy.events.reverse(); await db.uploads.put(legacy)
      await repo.sync()
      expect(attempts).toHaveLength(3)
      expect(attempts[1].events.map(e => e.sequence)).toEqual([2, 1])
      expect(attempts[2]).toEqual({ ...attempts[1], events: [...attempts[1].events].reverse() })
      expect(repo.syncMessage).toBe('')
      expect(await repo.hasPending()).toBe(false)
      expect(await gateway.upload(attempts[2])).toBe(legacy.session.revision)
      expect((await rpc<any>('get_workspace')).events).toHaveLength(2)
      await repo.act(sid, 'pitch', 'ball', 'middle')
      const [changed] = await repo.pendingUploads()
      changed.events[0].pitchType = 'called'; await db.uploads.put(changed)
      const before = attempts.length
      await repo.sync()
      expect(attempts).toHaveLength(before + 1)
      expect(repo.syncMessage).toBe('Recorded events cannot change')
      expect((await repo.exportRecovery()).operations[0].events).toHaveLength(3)
      expect((await rpc<any>('get_workspace')).events).toHaveLength(2)
    } finally { await db.delete(); vi.unstubAllGlobals() }
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


async function removal(action: string, kind: string, id: string, extra: Record<string, unknown> = {}) {
  return rpc<any>('manage', action, {kind,id,...extra})
}
async function accountRemoval(action: string, kind: string, id: string, confirmation?: string) {
  await sql.exec('reset role; set role service_role')
  try {
    return (await sql.query<{result:any}>('select public.account_action($1::uuid,$2::text,$3::jsonb) result',[admin,action,JSON.stringify({kind,id,confirmation})])).rows[0].result
  } finally { await login(admin) }
}

describe('record removal and replay protection', () => {
  it('archives teams, cancels invitations, retains history, and blocks archived team use', async () => {
    const tid = await team(), pid = await pitcher([tid]); await invite(tid)
    for (const op of await operations(pid,tid,a,true)) await rpc('upload_practice',op)
    await removal('archiveRecord','team',tid,{archived:true})
    const data = await rpc<any>('get_workspace')
    expect(data.teams[0].archived).toBe(true); expect(data.sessions).toHaveLength(1); expect(data.events).toHaveLength(2)
    expect(data.invitations).toEqual([]); expect(data.teamPitchers).toHaveLength(1)
    await expect(rpc('manage','invite',{teamId:tid,email:'b@example.com'})).rejects.toThrow('Reactivate')
    await removal('archiveRecord','team',tid,{archived:false})
    expect((await rpc<any>('get_workspace')).teams[0].archived).toBe(false)
  })
  it('requires ended practices, keeps archive metadata authoritative, and restores practices', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid,tid,a,true)
    await rpc('upload_practice',ops[0]); const sid = ops[0].sessionId
    await expect(removal('archiveRecord','session',sid,{archived:true})).rejects.toThrow('End related')
    await expect(removal('deleteRecord','session',sid,{confirmation:'Bullpen'})).rejects.toThrow('End related')
    for (const op of ops.slice(1)) await rpc('upload_practice',op)
    await removal('archiveRecord','session',sid,{archived:true})
    expect((await rpc<any>('get_workspace')).sessions[0].archived).toBe(true)
    await expect(rpc('upload_practice',ops.at(-1))).rejects.toThrow('archived')
    await removal('archiveRecord','session',sid,{archived:false})
    expect((await rpc<any>('get_workspace')).sessions[0].archived).toBe(false)
  })
  it('blocks dependent deletion, confirms exact names, deletes practices first, and prevents all stale replays', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid,tid,a,true)
    for (const op of ops) await rpc('upload_practice',op)
    const preview = await removal('removalPreview','pitcher',pid)
    expect(preview.practices).toHaveLength(1); expect(preview.assignments).toBe(1)
    await expect(removal('deleteRecord','pitcher',pid,{confirmation:'Jordan'})).rejects.toThrow('related practices')
    await expect(removal('deleteRecord','team',tid,{confirmation:'Falcons'})).rejects.toThrow('related practices')
    await expect(removal('deleteRecord','session',ops[0].sessionId,{confirmation:'wrong'})).rejects.toThrow('Type the displayed')
    await removal('deleteRecord','session',ops[0].sessionId,{confirmation:'Bullpen'})
    await removal('deleteRecord','session',ops[0].sessionId,{confirmation:'Bullpen'}) // lost acknowledgement
    await expect(rpc('upload_practice',ops[0])).rejects.toThrow('permanently deleted')
    await expect(rpc('upload_practice',{...ops[0],id:crypto.randomUUID()})).rejects.toThrow('permanently deleted')
    await removal('deleteRecord','pitcher',pid,{confirmation:'Jordan'})
    await removal('deleteRecord','team',tid,{confirmation:'Falcons'})
    const data = await rpc<any>('get_workspace')
    expect(data.sessions).toEqual([]); expect(data.events).toEqual([]); expect(data.teamPitchers).toEqual([])
    expect(data.deletions).toHaveLength(3)
    await expect(rpc('manage','saveTeam',{id:tid,name:'Recreate'})).rejects.toThrow('permanently deleted')
    await expect(rpc('manage','savePitcher',{id:pid,name:'Recreate',jersey:'',teamIds:[]})).rejects.toThrow('permanently deleted')
    await sql.exec('reset role')
    const receipts = await sql.query<{request:any}>('select request from public.operation_receipts')
    expect(receipts.rows.every(r => Object.keys(r.request).join() === 'hash')).toBe(true)
  })
  it('protects shared players from a coach with partial access and keeps hidden practice names private', async () => {
    const t1 = await team(), t2 = await team('Private team'), pid = await pitcher([t1,t2])
    for (const op of await operations(pid,t2,a,true)) await rpc('upload_practice',op)
    const iid = await invite(t1); await login(b); await rpc('manage','acceptInvitation',{id:iid})
    const preview = await removal('removalPreview','pitcher',pid)
    expect(preview.canRemove).toBe(false); expect(preview.practices).toEqual([]); expect(preview.hiddenPractices).toBe(1)
    await expect(removal('deleteRecord','pitcher',pid,{confirmation:'Jordan'})).rejects.toThrow('denied')
    await expect(removal('archiveRecord','pitcher',pid,{archived:true})).rejects.toThrow('denied')
    await rpc('manage','setPitcher',{teamId:t1,pitcherId:pid,active:false})
    await expect(removal('deleteRecord','team',t2,{confirmation:'Private team'})).rejects.toThrow('unavailable')
  })
  it('lets an assigned coach delete another recorder’s ended team practice, but denies viewers', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid,tid,a,true)
    for (const op of ops) await rpc('upload_practice',op)
    const iid = await invite(tid); await login(b); await rpc('manage','acceptInvitation',{id:iid})
    await sql.exec(`reset role; update public.coaches set role='viewer' where id='${b}'`); await login(b)
    await expect(removal('deleteRecord','session',ops[0].sessionId,{confirmation:'Bullpen'})).rejects.toThrow('Account cannot')
    await sql.exec(`reset role; update public.coaches set role='coach' where id='${b}'`); await login(b)
    await removal('deleteRecord','session',ops[0].sessionId,{confirmation:'Bullpen'})
    expect((await rpc<any>('get_workspace')).sessions).toEqual([])
    await login(a); expect((await rpc<any>('get_workspace')).deletions).toContainEqual({kind:'session',id:ops[0].sessionId})
  })
  it('keeps player archival blocked by active assignments and any ongoing participation', async () => {
    const tid = await team(), pid = await pitcher([tid]), ops = await operations(pid,tid)
    for (const op of ops) await rpc('upload_practice',op)
    await expect(removal('archiveRecord','pitcher',pid,{archived:true})).rejects.toThrow('active team rosters')
    await rpc('manage','setPitcher',{teamId:tid,pitcherId:pid,active:false})
    await expect(removal('archiveRecord','pitcher',pid,{archived:true})).rejects.toThrow('End related')
  })
  it('protects the admin and last coach, transfers players, and supports retryable auth cleanup', async () => {
    const tid = await team(), pid = await pitcher([])
    await expect(accountRemoval('deleteRecord','coach',admin,'admin@example.com')).rejects.toThrow('unavailable')
    await expect(accountRemoval('suspendRecord','coach',a)).rejects.toThrow('another active coach')
    await login(a); const iid = await invite(tid); await login(b); await rpc('manage','acceptInvitation',{id:iid})
    const result = await accountRemoval('deleteRecord','coach',a,'a@example.com')
    expect(result.deleteAuthId).toBe(a)
    expect((await rpc<any>('get_workspace')).pitchers.find((p:any) => p.id===pid).ownerId).toBe(admin)
    expect((await accountRemoval('deleteRecord','coach',a,'a@example.com')).deleteAuthId).toBe(a)
    expect((await accountRemoval('retryDeletion','coach',a)).deleteAuthId).toBe(a)
    await accountRemoval('finishDeletion','coach',a)
    expect(await accountRemoval('deleteRecord','coach',a,'a@example.com')).toEqual({})
    await sql.exec('reset role')
    expect((await sql.query('select * from public.account_provisions where id=$1',[a])).rows).toEqual([])
  })
  it('blocks deleting coaches with recorded practices and allows admin request deletion', async () => {
    const pid = await pitcher([])
    for (const op of await operations(pid,null,a,true)) await rpc('upload_practice',op)
    const preview = await accountRemoval('removalPreview','coach',a)
    expect(preview.practices).toHaveLength(1)
    await expect(accountRemoval('deleteRecord','coach',a,'a@example.com')).rejects.toThrow('related practices')
    await sql.exec('reset role')
    const id = crypto.randomUUID()
    await sql.query("insert into public.access_requests(id,name,email,requested_team) values($1,'Request','request@example.com','Team')",[id])
    await expect(accountRemoval('deleteRecord','request',id,'wrong')).rejects.toThrow('Type the displayed')
    await accountRemoval('deleteRecord','request',id,'request@example.com')
    await accountRemoval('deleteRecord','request',id,'request@example.com')
  })
})


describe('removal validation at commit time', () => {
  it('rechecks dependencies created after a removal preview', async () => {
    const tid=await team(),pid=await pitcher([tid])
    expect((await removal('removalPreview','team',tid)).deleteBlockers).toEqual([])
    for(const op of await operations(pid,tid,a,true)) await rpc('upload_practice',op)
    await expect(removal('deleteRecord','team',tid,{confirmation:'Falcons'})).rejects.toThrow('related practices')
  })
  it('keeps receipt content private and prevents bypassing the locking wrappers', async () => {
    await expect(sql.query("select public.pw_manage_core('saveTeam','{}'::jsonb)")).rejects.toThrow('permission denied')
    await expect(sql.query("select public.pw_upload_practice_core('{}'::jsonb)")).rejects.toThrow('permission denied')
    await expect(sql.query("select public.account_action($1::uuid,'deleteRecord','{}'::jsonb)",[admin])).rejects.toThrow('permission denied')
    await expect(sql.query('select * from public.record_tombstones')).rejects.toThrow('permission denied')
    await expect(sql.query('select * from public.account_deletions')).rejects.toThrow('permission denied')
    await sql.exec('reset role')
    await expect(sql.query("select public.account_action($1::uuid,'deleteRecord',$2::jsonb)",[a,JSON.stringify({kind:'coach',id:b,confirmation:'b@example.com'})])).rejects.toThrow('Admin access required')
  })
  it('permits suspension on archived teams, protects reactivation, and preserves ownership/history', async () => {
    const tid=await team(),pid=await pitcher([tid])
    for(const op of await operations(pid,tid,a,true)) await rpc('upload_practice',op)
    await removal('archiveRecord','team',tid,{archived:true})
    await accountRemoval('suspendRecord','coach',a)
    await expect(removal('archiveRecord','team',tid,{archived:false})).rejects.toThrow('active coach')
    await sql.exec('reset role')
    await sql.query("select public.account_action($1::uuid,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:true,teamIds:[tid]})])
    await login(a);await removal('archiveRecord','team',tid,{archived:false})
    const data=await rpc<any>('get_workspace')
    expect(data.sessions).toHaveLength(1);expect(data.pitchers[0].ownerId).toBe(a)
  })
  it('round-trips archived teams and ended practices through the production restore RPC', async () => {
    const tid=await team(),pid=await pitcher([tid])
    for(const op of await operations(pid,tid,a,true)) await rpc('upload_practice',op)
    const sid=(await rpc<any>('get_workspace')).sessions[0].id
    await removal('archiveRecord','session',sid,{archived:true});await removal('archiveRecord','team',tid,{archived:true})
    const data=await rpc<any>('get_workspace')
    await rpc('manage','restore',{operationId:crypto.randomUUID(),deviceId:device,backup:{...data,format:'pitchwork-backup',version:3}})
    const after=await rpc<any>('get_workspace')
    expect(after.teams).toHaveLength(2);expect(after.teams.every((t:any)=>t.archived)).toBe(true)
    expect(after.sessions).toHaveLength(2);expect(after.sessions.every((s:any)=>s.archived)).toBe(true)
  })
})


describe('competing uploads and removals', () => {
  it.each([false,true])('serializes competing team deletion and new upload (delete first: %s)', async deleteFirst => {
    const tid=await team(),pid=await pitcher([tid]),op=(await operations(pid,tid))[0]
    const remove=()=>removal('deleteRecord','team',tid,{confirmation:'Falcons'})
    const upload=()=>rpc('upload_practice',op)
    const results=await Promise.allSettled(deleteFirst ? [remove(),upload()] : [upload(),remove()])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const data=await rpc<any>('get_workspace')
    expect(data.sessions.every((s:any)=>data.teams.some((t:any)=>t.id===s.teamId))).toBe(true)
    if(deleteFirst) expect(data.sessions).toEqual([])
    else expect(data.sessions).toHaveLength(1)
  })
  it('runs existing provisioning and account updates through service-role wrapper grants', async () => {
    const tid=await team()
    await sql.exec('reset role;set role service_role')
    const prepared=await sql.query<{result:{id:string}}>("select public.account_action($1::uuid,'prepare',$2::jsonb) result",[admin,JSON.stringify({email:'new@example.com',name:'New'})])
    expect(prepared.rows[0].result.id).toBeTruthy()
    await sql.query("select public.account_action($1::uuid,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:true,teamIds:[tid]})])
  })
})
