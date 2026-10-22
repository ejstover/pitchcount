import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAchievements, reconcileAwards } from './engine'
import type { Snapshot } from '../shared'
let sql:PGlite
const adult='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',player='10000000-0000-4000-8000-000000000003'
const pid='20000000-0000-4000-8000-000000000001',mate='20000000-0000-4000-8000-000000000002',team='30000000-0000-4000-8000-000000000001',device='40000000-0000-4000-8000-000000000001'
async function login(id:string){await sql.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false)`)}
async function rpc<T=any>(name:string,...args:unknown[]):Promise<T>{const parameters=args.map((v,i)=>`$${i+1}${typeof v==='object'?'::jsonb':''}`).join(',');return (await sql.query<{r:T}>(`select public.${name}(${parameters}) r`,args.map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].r}
beforeAll(async()=>{sql=new PGlite();await sql.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`);for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await sql.exec(readFileSync(`supabase/migrations/${f}`,'utf8'))},30000)
beforeEach(async()=>{await sql.exec(`reset role;truncate auth.users,public.account_provisions,public.teams,public.pitchers,public.operation_receipts cascade;
insert into public.account_provisions(id,email,name,role) values('${adult}','coach@test.com','Coach','admin'),('${other}','other@test.com','Other','coach');insert into auth.users select id,email from public.account_provisions;
insert into public.teams(id,name)values('${team}','Team');insert into public.team_coaches values('${team}','${adult}');
insert into public.pitchers(id,name,jersey,owner_id)values('${pid}','Player','1','${adult}'),('${mate}','Teammate','2','${adult}');insert into public.team_pitchers values('${team}','${pid}',true),('${team}','${mate}',true);
insert into public.account_provisions(id,email,name,role,pitcher_id)values('${player}','player@test.com','Player','player','${pid}');insert into auth.users values('${player}','player@test.com');`);await login(player)})
afterAll(async()=>{await sql?.close()})
function record(kind:string,data:unknown,extra={}){return {id:crypto.randomUUID(),record:{id:crypto.randomUUID(),pitcherId:pid,kind,data},expectedRevision:0,...extra}}
function operation(pitcher=pid,teamId:string|null=null){const sid=crypto.randomUUID(),appearance=crypto.randomUUID();return {id:crypto.randomUUID(),expectedRevision:0,session:{id:sid,teamId,recorderId:player,deviceId:device,revision:1,name:'Private',notes:'Private notes',startedAt:'2026-10-20T12:00:00Z',updatedAt:'2026-10-20T12:01:00Z',endedAt:'2026-10-20T12:01:00Z',status:'ended',initialPitcherId:pitcher,selectedPitcherId:pitcher,initialAppearanceId:appearance,pitcherIds:[pitcher],nextSequence:3},events:[{id:crypto.randomUUID(),sessionId:sid,pitcherId:pitcher,appearanceId:appearance,nextAppearanceId:crypto.randomUUID(),sequence:1,timestamp:'2026-10-20T12:00:00Z',kind:'pitch',pitchType:'called',voidedAt:null},{id:crypto.randomUUID(),sessionId:sid,pitcherId:pitcher,appearanceId:appearance,nextAppearanceId:crypto.randomUUID(),sequence:2,timestamp:'2026-10-20T12:01:00Z',kind:'end',voidedAt:null}]}}
describe('achievement migrations and player boundaries',()=>{
 it('accepts only own independent practices, retains immutable events and idempotent receipts',async()=>{
  const op=operation();await rpc('upload_practice',op);await rpc('upload_practice',op)
  expect((await rpc('get_workspace')).sessions).toHaveLength(1)
  await expect(rpc('upload_practice',operation(mate))).rejects.toThrow('other-player')
  await expect(rpc('upload_practice',operation(pid,team))).rejects.toThrow('cannot record')
  const changed=structuredClone(op);changed.id=crypto.randomUUID();changed.expectedRevision=1;changed.session.revision=2;changed.events[0].pitchType='ball'
  await expect(rpc('upload_practice',changed)).rejects.toThrow('Recorded events')
 })
 it('keeps teammate statistics and ongoing goals shared while activity and award tables stay private',async()=>{
  await login(adult);await rpc('manage','saveGoal',{id:crypto.randomUUID(),scope:'coach',teamId:team,pitcherId:mate,metric:'strikePct',direction:'min',target:60,expectedRevision:0})
  await login(player);await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'reflection',note:'Private journal'}))
  const own=await rpc('get_workspace');expect(own.pitchers.map((p:any)=>p.id)).toContain(mate);expect(own.goals).toHaveLength(1);expect(own.achievementRecords).toHaveLength(1)
  await login(other);expect((await rpc('get_workspace')).achievementRecords).toEqual([]);expect((await sql.query('select * from public.achievement_records')).rows).toEqual([])
  await login(player);await expect(sql.exec(`insert into public.achievement_awards values('forged','${pid}','{}')`)).rejects.toThrow('permission denied')
  await expect(rpc('achievement_input',pid)).rejects.toThrow('permission denied')
 })
 it('saves activities atomically, rejects cross-player writes, stale changes and deleted-ID resurrection',async()=>{
  const op=record('checkin',{date:'2026-10-20',action:'warmup'});await rpc('manage','saveAchievementRecord',op);await rpc('manage','saveAchievementRecord',op)
  await expect(rpc('manage','saveAchievementRecord',{...op,id:crypto.randomUUID()})).rejects.toThrow('Activity changed')
  await expect(rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'warmup'},{record:{...op.record,id:crypto.randomUUID(),pitcherId:mate}}))).rejects.toThrow('Linked player')
  await rpc('manage','saveAchievementRecord',{...op,id:crypto.randomUUID(),expectedRevision:1,deleted:true})
  await expect(rpc('manage','saveAchievementRecord',{...op,id:crypto.randomUUID()})).rejects.toThrow('Activity changed')
 })
 it('rejects overlapping seasons and mutation of frozen targets',async()=>{
  const season=record('season',{name:'Fall',start:'2026-09-01',end:'2026-12-01'});await rpc('manage','saveAchievementRecord',season)
  await expect(rpc('manage','saveAchievementRecord',record('season',{name:'Overlap',start:'2026-11-01',end:'2027-01-01'}))).rejects.toThrow('nonoverlapping')
  const goal=record('goal',{metric:'strike',scope:'week',target:52,effectiveFrom:new Date().toISOString().slice(0,10)});await rpc('manage','saveAchievementRecord',goal)
  await expect(rpc('manage','saveAchievementRecord',{...goal,id:crypto.randomUUID(),expectedRevision:1,record:{...goal.record,data:{...goal.record.data as object,target:40}}})).rejects.toThrow('frozen')
 })
 it('commits only the evaluated source revision and quietly withdraws corrected awards',async()=>{
  const op=operation();await rpc('upload_practice',op)
  await sql.exec('reset role')
  const source=await rpc<Snapshot>('achievement_input',pid), first=evaluateAchievements(source,pid,new Date('2026-10-23T12:00:00Z'))
  const revision=(await sql.query<{revision:number}>('select revision from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].revision
  expect(first.awards.some(a=>a.definitionId==='001')).toBe(true)
  expect(await rpc('achievement_commit',pid,revision-1,first.awards)).toBe(false)
  expect(await rpc('achievement_commit',pid,revision,first.awards)).toBe(true)
  await sql.query('delete from public.practices where id=$1',[op.session.id])
  const next=evaluateAchievements(await rpc<Snapshot>('achievement_input',pid),pid)
  const ledger=reconcileAwards(first.awards,next.awards,new Date().toISOString())
  expect(ledger.find(a=>a.definitionId==='001')?.status).toBe('withdrawn')
 })
 it('provisions reserved usernames without adding coaching membership',async()=>{
  await sql.exec('reset role');await sql.exec(`delete from auth.users where id='${player}';delete from public.account_provisions where id='${player}'`)
  const prepared=await rpc('prepare_username_player',adult,pid,'practice.star')
  expect(prepared.email).toMatch(/@players\.pitchwork\.invalid$/)
  await sql.query('insert into auth.users(id,email)values($1,$2)',[prepared.id,prepared.email])
  expect((await sql.query('select * from public.team_coaches where coach_id=$1',[prepared.id])).rows).toHaveLength(0)
  await expect(rpc('prepare_username_player',other,pid,'outsider')).rejects.toThrow('owner or admin')
 })
 it('allows removal only of the player’s own ended independent practice and prevents resurrection',async()=>{
  const op=operation();await rpc('upload_practice',op)
  expect((await rpc('manage','removalPreview',{kind:'session',id:op.session.id})).canRemove).toBe(true)
  await rpc('manage','archiveRecord',{kind:'session',id:op.session.id,archived:true})
  expect((await rpc('get_workspace')).sessions[0].archived).toBe(true)
  await expect(rpc('manage','deleteRecord',{kind:'session',id:op.session.id,confirmation:'wrong'})).rejects.toThrow('Type the practice name')
  await rpc('manage','deleteRecord',{kind:'session',id:op.session.id,confirmation:'Private'})
  await expect(rpc('upload_practice',{...op,id:crypto.randomUUID()})).rejects.toThrow('deleted')
 })
 it('restores activity references and source provenance without restoring player access or award grants',async()=>{
  await rpc('upload_practice',operation())
  await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'reflection',note:'My learning'}))
  const backup={...await rpc('get_workspace'),format:'pitchwork-backup',version:5,exportedAt:new Date().toISOString()}
  await login(adult);await rpc('manage','restore',{operationId:crypto.randomUUID(),deviceId:device,backup})
  await sql.exec('reset role')
  const copies=(await sql.query<{pitcher_id:string;data:{note:string}}>('select pitcher_id,data from public.achievement_records')).rows
  expect(copies).toHaveLength(2);expect(copies.every(r=>r.data.note==='My learning')).toBe(true);expect(new Set(copies.map(r=>r.pitcher_id)).size).toBe(2)
  expect((await sql.query('select * from public.player_accounts')).rows).toHaveLength(1)
  expect((await sql.query<{data:{originSessionId:string}}>("select data from public.practices where data->>'recovered'='true'")).rows[0].data.originSessionId).toBe(backup.sessions[0].id)
  expect((await sql.query('select * from public.achievement_awards')).rows).toEqual([])
 })
 it('rate limits public username sign-in without storing the raw IP or username',async()=>{
  await sql.exec('reset role')
  for(let i=0;i<20;i++)await rpc('player_login_limit','salted-hash')
  await expect(rpc('player_login_limit','salted-hash')).rejects.toThrow('Try signing in')
  expect((await sql.query<{bucket:string}>('select bucket from public.request_limits')).rows[0].bucket).toBe('login:salted-hash')
 })
})
