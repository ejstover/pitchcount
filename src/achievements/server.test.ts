import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAchievements, reconcileAwards } from './engine'
import type { Snapshot } from '../shared'
import {workspaceManifestHash} from '../workspace-version'
let sql:PGlite
const adult='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',player='10000000-0000-4000-8000-000000000003'
const pid='20000000-0000-4000-8000-000000000001',mate='20000000-0000-4000-8000-000000000002',team='30000000-0000-4000-8000-000000000001',device='40000000-0000-4000-8000-000000000001'
async function login(id:string){await sql.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','${id}',false)`)}
async function rpc<T=any>(name:string,...args:unknown[]):Promise<T>{const parameters=args.map((v,i)=>`$${i+1}${typeof v==='object'?'::jsonb':''}`).join(',');return (await sql.query<{r:T}>(`select public.${name}(${parameters}) r`,args.map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].r}
beforeAll(async()=>{sql=new PGlite();await sql.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`);for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort())await sql.exec(readFileSync(`supabase/migrations/${f}`,'utf8'))},30000)
beforeEach(async()=>{await sql.exec(`reset role;truncate auth.users,public.account_provisions,public.teams,public.pitchers,public.operation_receipts cascade;
insert into public.account_provisions(id,email,name,role) values('${adult}','coach@test.com','Coach','admin'),('${other}','other@test.com','Other','coach');insert into auth.users(id,email) select id,email from public.account_provisions;
insert into public.teams(id,name)values('${team}','Team');insert into public.team_coaches values('${team}','${adult}');
insert into public.pitchers(id,name,jersey,owner_id)values('${pid}','Player','1','${adult}'),('${mate}','Teammate','2','${adult}');insert into public.team_pitchers values('${team}','${pid}',true),('${team}','${mate}',true);
insert into public.account_provisions(id,email,name,role,pitcher_id)values('${player}','player@test.com','Player','player','${pid}');insert into auth.users(id,email) values('${player}','player@test.com');`);await login(player)})
afterAll(async()=>{await sql?.close()})
function record(kind:string,data:unknown,extra={}){return {id:crypto.randomUUID(),record:{id:crypto.randomUUID(),pitcherId:pid,kind,data},expectedRevision:0,...extra}}
function operation(pitcher=pid,teamId:string|null=null){const sid=crypto.randomUUID(),appearance=crypto.randomUUID();return {id:crypto.randomUUID(),expectedRevision:0,session:{id:sid,teamId,recorderId:player,deviceId:device,revision:1,name:'Private',notes:'Private notes',startedAt:'2026-10-20T12:00:00Z',updatedAt:'2026-10-20T12:01:00Z',endedAt:'2026-10-20T12:01:00Z',status:'ended',initialPitcherId:pitcher,selectedPitcherId:pitcher,initialAppearanceId:appearance,pitcherIds:[pitcher],nextSequence:3},events:[{id:crypto.randomUUID(),sessionId:sid,pitcherId:pitcher,appearanceId:appearance,nextAppearanceId:crypto.randomUUID(),sequence:1,timestamp:'2026-10-20T12:00:00Z',kind:'pitch',pitchType:'called',voidedAt:null},{id:crypto.randomUUID(),sessionId:sid,pitcherId:pitcher,appearanceId:appearance,nextAppearanceId:crypto.randomUUID(),sequence:2,timestamp:'2026-10-20T12:01:00Z',kind:'end',voidedAt:null}]}}
describe('achievement migrations and player boundaries',()=>{
 it('bounds rule refresh batches and applies a fixed cutoff once per job',async()=>{
  await sql.exec('reset role')
  await sql.query('insert into public.achievement_jobs(pitcher_id)values($1)on conflict do nothing',[mate])
  await sql.query("update public.achievement_jobs set next_evaluate_at='infinity',rules_requested_at=now()-interval '1 day'")
  const cutoff=(await sql.query<{cutoff:string}>('select now()::text as cutoff')).rows[0].cutoff
  const first=await rpc('achievement_requeue_rules',cutoff,1);expect(first.updated).toBe(1);expect(first.remaining).toBe(true)
  const revisions=(await sql.query<{pitcher_id:string;revision:number}>('select pitcher_id,revision from public.achievement_jobs order by pitcher_id')).rows
  let result=first
  for(let i=0;i<10&&result.remaining;i++)result=await rpc('achievement_requeue_rules',cutoff,1)
  expect(result.remaining).toBe(false)
  expect((await rpc('achievement_requeue_rules',cutoff,1000)).updated).toBe(0)
  const after=(await sql.query<{pitcher_id:string;revision:number}>('select pitcher_id,revision from public.achievement_jobs order by pitcher_id')).rows
  expect(after.every((j,i)=>Number(j.revision)===Number(revisions[i].revision)+(i===0?0:1))).toBe(true)
  expect((await sql.query<{pending:boolean}>('select bool_and(revision>processed_revision and next_evaluate_at<=now()) as pending from public.achievement_jobs')).rows[0].pending).toBe(true)
  await login(player);await expect(rpc('achievement_requeue_rules',cutoff,1)).rejects.toThrow('permission denied')
 })
 it('sleeps a confirmed idle job, wakes it on an actual activity write, and rejects stale completion',async()=>{
  await sql.exec('reset role')
  let job=(await rpc('achievement_claim',pid,1))[0]
  expect(await rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],false,new Date().toISOString())).toBe(true)
  expect((await sql.query<{due:string}>('select next_evaluate_at::text as due from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].due).toBe('infinity')
  expect(await rpc('achievement_claim',pid,1)).toEqual([])
  await login(player)
  await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-01',action:'warmup'}))
  await sql.exec('reset role');job=(await rpc('achievement_claim',pid,1))[0];expect(job).toBeTruthy()
  await login(player);await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-02',action:'reflection'}));await sql.exec('reset role')
  expect(await rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],false,new Date().toISOString())).toBe(false)
  const pending=(await sql.query<{pending:boolean;due:boolean}>('select revision>processed_revision as pending,next_evaluate_at<=now() as due from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0]
  expect(pending).toEqual({pending:true,due:true})
 })
 it('retains a calendar timer and makes a previous-day calculation immediately due',async()=>{
  await sql.exec('reset role')
  let job=(await rpc('achievement_claim',pid,1))[0]
  expect(await rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],true,new Date().toISOString())).toBe(true)
  expect((await sql.query<{finite:boolean}>('select isfinite(next_evaluate_at) as finite from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].finite).toBe(true)
  await rpc('achievement_dirty',pid);job=(await rpc('achievement_claim',pid,1))[0]
  expect(await rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],true,new Date(Date.now()-86400000).toISOString())).toBe(true)
  expect((await sql.query<{due:boolean}>('select next_evaluate_at<=now() as due from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].due).toBe(true)
 })
 it('does not let a player park derived work or accept an invalid future evaluation clock',async()=>{
  await sql.exec('reset role');const job=(await rpc('achievement_claim',pid,1))[0]
  await expect(rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],false,'infinity')).rejects.toThrow('Invalid evaluation timestamp')
  await expect(rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],false,new Date(Date.now()+3600000).toISOString())).rejects.toThrow('Invalid evaluation timestamp')
  await login(player)
  await expect(rpc('achievement_finish_scheduled',pid,job.revision,job.lease_token,[],false,new Date().toISOString())).rejects.toThrow('permission denied')
 })
 it('advances the job without rewriting identical evidence, while retaining correction and revision fences',async()=>{
  await sql.exec('reset role')
  const award={id:'unchanged-proof',pitcherId:pid,definitionId:'001',period:'career',earnedAt:'2026-10-20',status:'qualified',actual:1,evidence:['Proof'],ruleVersion:1}
  let revision=(await sql.query<{revision:number}>('select revision from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].revision
  expect(await rpc('achievement_commit',pid,revision,[award])).toBe(true)
  const row=async()=>(await sql.query<{tuple:string;data:typeof award}>('select ctid::text as tuple,data from public.achievement_awards where id=$1',[award.id])).rows[0]
  const original=await row()
  await rpc('achievement_dirty',pid)
  revision=(await sql.query<{revision:number}>('select revision from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].revision
  expect(await rpc('achievement_commit',pid,revision,[award])).toBe(true)
  expect(await row()).toEqual(original)
  expect((await sql.query<{current:boolean}>('select processed_revision=revision as current from public.achievement_jobs where pitcher_id=$1',[pid])).rows[0].current).toBe(true)
  expect(await rpc('achievement_commit',pid,revision-1,[{...award,actual:999}])).toBe(false)
  expect(await row()).toEqual(original)
  expect(await rpc('achievement_commit',pid,revision,[{...award,status:'withdrawn',actual:2}])).toBe(true)
  const corrected=await row();expect(corrected.tuple).not.toBe(original.tuple);expect(corrected.data).toEqual({...award,status:'withdrawn',actual:2})
 })
 it('hashes current authorized award values and invalidates hints after a repair or role change',async()=>{
  const award={id:'cache-proof',pitcherId:pid,definitionId:'proof',period:'lifetime',earnedAt:'2026-10-20',status:'qualified',actual:1,evidence:['Own proof'],ruleVersion:1}
  await sql.exec('reset role');await sql.query('insert into public.achievement_awards values($1,$2,$3::jsonb)',[award.id,pid,JSON.stringify(award)])
  await sql.query('insert into public.achievement_awards values($1,$2,$3::jsonb)',['foreign-proof',mate,JSON.stringify({...award,id:'foreign-proof',pitcherId:mate,evidence:['Foreign private sentinel']})])
  await login(player);const page=await rpc('get_workspace_page'),manifest=await workspaceManifestHash(page.epoch,page.items.map((p:any)=>[p.id,p.version]))
  const update=async(known:string|null=null)=>(await sql.query<{r:any}>('select public.get_workspace_update($1,$2,\'{}\',null,$3) r',[manifest,page.epoch,known])).rows[0].r
  const first=await update();expect(first.snapshot.achievementAwards).toEqual([award]);expect(JSON.stringify(first)).not.toContain('Foreign private sentinel')
  const hit=await update(first.awardsVersion);expect(hit.awardsUnchanged).toBe(true);expect(hit.snapshot.achievementAwards).toEqual([])
  await sql.exec('reset role');await sql.query("update public.achievement_awards set data=jsonb_set(data,'{actual}','2') where id=$1",[award.id]);await login(player)
  const repaired=await update(first.awardsVersion);expect(repaired.awardsUnchanged).toBe(false);expect(repaired.snapshot.achievementAwards[0].actual).toBe(2);expect(repaired.awardsVersion).not.toBe(first.awardsVersion)
  await sql.exec('reset role');await sql.query("update public.coaches set role='viewer' where id=$1",[player]);await login(player)
  const revoked=await update(repaired.awardsVersion);expect(revoked.awardsUnchanged).toBe(false);expect(revoked.snapshot.achievementAwards).toEqual([])
  await sql.exec('reset role;set role anon');await expect(update()).rejects.toThrow('permission denied')
 })
 it('keeps combined service contexts private, derives linkage and never reclaims a live lease',async()=>{
  await expect(rpc('account_context',player)).rejects.toThrow('permission denied')
  await expect(rpc('achievement_prepare',player)).rejects.toThrow('permission denied')
  await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'reflection',note:'Own private evidence'}))
  await sql.exec('reset role;set role service_role')
  const context=await rpc('account_context',player);expect(context.profile.id).toBe(player);expect(context.pitcherId).toBe(pid)
  expect((await rpc('achievement_prepare',adult)).kind).toBe('notPlayer')
  const prepared=await rpc('achievement_prepare',player)
  expect(prepared.kind).toBe('ready');expect(prepared.pitcherId).toBe(pid);expect(prepared.job.pitcher_id).toBe(pid)
  expect(prepared.input.achievementRecords.every((r:any)=>r.pitcherId===pid)).toBe(true)
  expect((await rpc('achievement_prepare',player)).job).toBeNull()
  await sql.exec('reset role');await sql.query('update public.coaches set active=false where id=$1',[player]);await sql.exec('set role service_role')
  expect((await rpc('achievement_prepare',player)).kind).toBe('denied');expect((await rpc('account_context',player)).profile.active).toBe(false)
 })
 it('coalesces pitches to a fixed deadline and immediately handles urgent source changes',async()=>{
  const initial=operation();initial.events=initial.events.slice(0,1);initial.session={...initial.session,status:'active',endedAt:null as any,nextSequence:2}
  await sql.exec('reset role');await sql.query('update public.achievement_jobs set processed_revision=revision,evaluated_at=now(),next_evaluate_at=now()+interval \'1 day\',evaluation_urgent=false where pitcher_id=$1',[pid]);await login(player)
  await rpc('upload_practice',initial)
  const first=(await rpc('get_workspace_page')).snapshot.achievementEvaluation
  expect(Date.parse(first.nextEvaluateAt)).toBeGreaterThan(Date.now());expect(first.revision).toBeGreaterThan(first.processedRevision)
  await sql.exec('reset role;set role service_role');expect(await rpc('achievement_claim',pid,1)).toEqual([])
  const second={...initial,id:crypto.randomUUID(),expectedRevision:1,session:{...initial.session,revision:2,nextSequence:3},events:[...initial.events,{...initial.events[0],id:crypto.randomUUID(),nextAppearanceId:crypto.randomUUID(),sequence:2}]}
  await login(player);await rpc('upload_practice',second)
  expect((await rpc('get_workspace_page')).snapshot.achievementEvaluation.nextEvaluateAt).toBe(first.nextEvaluateAt)
  await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'warmup'}))
  const undo={...second,id:crypto.randomUUID(),expectedRevision:2,session:{...second.session,revision:3},events:second.events.map((e,i)=>i===0?{...e,voidedAt:'2026-10-20T12:01:00Z'}:e)}
  await rpc('upload_practice',undo)
  await sql.exec('reset role;set role service_role');let jobs=await rpc('achievement_claim',pid,1);expect(jobs).toHaveLength(1)
  expect(await rpc('achievement_finish',pid,jobs[0].revision,jobs[0].lease_token,[])).toBe(true)
  const end={...undo,id:crypto.randomUUID(),expectedRevision:3,session:{...undo.session,revision:4,status:'ended',endedAt:'2026-10-20T12:01:00Z',nextSequence:4},events:[...undo.events,{id:crypto.randomUUID(),sessionId:undo.session.id,pitcherId:pid,appearanceId:undo.session.initialAppearanceId,nextAppearanceId:crypto.randomUUID(),sequence:3,timestamp:'2026-10-20T12:01:00Z',kind:'end',voidedAt:null}]}
  await login(player);await rpc('upload_practice',end)
  await sql.exec('reset role;set role service_role');jobs=await rpc('achievement_claim',pid,1);expect(jobs).toHaveLength(1)
 })
 it('applies player append/undo deltas without weakening recorder, link or immutable-undo checks',async()=>{
  const first=operation();first.events=first.events.slice(0,1);first.session={...first.session,status:'active',endedAt:null as any,nextSequence:2}
  await rpc('upload_practice',first)
  const second={...first.events[0],id:crypto.randomUUID(),nextAppearanceId:crypto.randomUUID(),sequence:2}
  const delta={id:crypto.randomUUID(),expectedRevision:1,session:{...first.session,revision:2,nextSequence:3},baseEventCount:1,appendEvents:[second],voidedEvents:[] as any[]}
  await rpc('upload_practice_delta',delta)
  const undo={...delta,id:crypto.randomUUID(),expectedRevision:2,session:{...delta.session,revision:3},baseEventCount:2,appendEvents:[],voidedEvents:[{sequence:1,voidedAt:'2026-10-20T12:02:00Z'}]}
  await rpc('upload_practice_delta',undo);await rpc('upload_practice_delta',undo)
  expect((await rpc('get_workspace')).events[0].voidedAt).toBe('2026-10-20T12:02:00Z')
  const tampered={...undo,id:crypto.randomUUID(),expectedRevision:3,session:{...undo.session,revision:4},voidedEvents:[{sequence:1,voidedAt:'2026-10-20T12:03:00Z'}]}
  await expect(rpc('upload_practice_delta',tampered)).rejects.toThrow('Recorded events cannot change')
  await expect(rpc('upload_practice_delta',{...tampered,voidedEvents:[],appendEvents:[{...second,id:crypto.randomUUID(),sequence:3,pitcherId:mate}]})).rejects.toThrow('other-player')
  await login(other);await expect(rpc('upload_practice_delta',undo)).rejects.toThrow('Team access was removed')
 })
 it('uses the same private projections and teammate metadata in paged downloads',async()=>{
  const op=operation();await rpc('upload_practice',op)
  await rpc('manage','saveAchievementRecord',record('checkin',{date:'2026-10-20',action:'reflection',note:'Private journal'}))
  const legacy=await rpc('get_workspace'),page=await rpc('get_workspace_page')
  const ordered=(rows:any[])=>[...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  for(const key of ['pitchers','teams','coaches','teamPitchers','teamCoaches','goals','achievementRecords'])expect(ordered(page.snapshot[key])).toEqual(ordered(legacy[key]))
  expect(page.items[0].achievement.session).toEqual(legacy.achievementSessions[0]);expect(page.items[0].achievement.events).toEqual(legacy.achievementEvents)
  await login(other);const outside=await rpc('get_workspace_page')
  expect(outside.items).toEqual([]);expect(outside.snapshot.achievementRecords).toEqual([])
  await sql.exec(`reset role;update public.coaches set active=false where id='${player}'`);await login(player)
  await expect(rpc('get_workspace_page')).rejects.toThrow('Account unavailable')
 })
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
  await login(other);expect((await rpc('get_workspace')).achievementRecords).toEqual([]);await expect(sql.query('select * from public.achievement_records')).rejects.toThrow('permission denied')
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
