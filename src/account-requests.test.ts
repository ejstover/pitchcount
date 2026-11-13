import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {readFileSync,readdirSync} from 'node:fs'
import {PGlite} from '@electric-sql/pglite'
let db:PGlite
const admin='10000000-0000-4000-8000-000000000001'
const coach='10000000-0000-4000-8000-000000000002'
async function rpc(name:string,...args:unknown[]) {
 const result=await db.query<{value:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)
 return result.rows[0].value
}
async function request(role='player',team='',email='player@example.com',username:string|null='practice.kid',bucket:string=crypto.randomUUID()) {
 return rpc('reserve_access_request','New Player',email,team,role,username,bucket)
}
async function identity(provision:{id:string;email:string},verified=false) {
 await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3 then now() end)',[provision.id,provision.email,verified])
}
async function approve(id:string,team:string|null=null,actor=admin) {return rpc('approve_access_request',actor,id,team)}
async function row(table:string) {return (await db.query<any>(`select * from public.${table}`)).rows}
beforeAll(async()=>{
 db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`)
 for(const name of readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${name}`,'utf8'))
},30000)
beforeEach(async()=>{
 await db.exec(`reset role;truncate auth.users,public.account_provisions,public.teams,public.request_limits,public.access_requests cascade;
 insert into public.account_provisions(id,email,name,role)values('${admin}','admin@example.com','Admin','admin'),('${coach}','coach@example.com','Coach','coach');
 insert into auth.users(id,email,email_confirmed_at)select id,email,now() from public.account_provisions;`)
})
afterAll(async()=>{await db.close()})
describe('verified account requests',()=>{
 it('reserves an inactive, unlinked player and denies workspace access even after verification',async()=>{
  const p=await request();await identity(p,true)
  expect((await row('coaches')).find(c=>c.id===p.id)).toMatchObject({active:false,username:'practice.kid',role:'player'})
  expect(await row('pitchers')).toHaveLength(0);expect(await row('player_accounts')).toHaveLength(0)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[p.id]);await db.exec('set role authenticated')
  expect(await rpc('pw_active')).toBe(false)
  const workspace=await rpc('get_workspace')
  for(const value of Object.values(workspace)) if(Array.isArray(value)) expect(value).toHaveLength(0)
  await expect(approve(crypto.randomUUID(),null,p.id)).rejects.toThrow()
  await db.exec('reset role')
 })
 it('requires verified email and admin approval; other account actions cannot activate a request',async()=>{
  const p=await request();await identity(p);const r=(await row('access_requests'))[0]
  await expect(approve(r.id)).rejects.toThrow('verification')
  await expect(approve(r.id,null,coach)).rejects.toThrow('Admin')
  await expect(rpc('account_action',admin,'update',JSON.stringify({id:p.id,active:true,teamIds:[]}))).rejects.toThrow('verified request approval')
  await expect(rpc('account_action',admin,'prepare',JSON.stringify({email:p.email,name:'Bypass'}))).rejects.toThrow('verified request approval')
  expect(await row('pitchers')).toHaveLength(0)
 })
 it('creates exactly one independent pitcher on approval and retries safely',async()=>{
  const p=await request();await identity(p,true);const r=(await row('access_requests'))[0]
  await rpc('sync_request_verification');expect((await row('access_requests'))[0].verified_at).toBeTruthy()
  expect(await approve(r.id)).toEqual({id:p.id});await approve(r.id)
  expect(await row('pitchers')).toHaveLength(1)
  expect((await row('pitchers'))[0]).toMatchObject({name:'New Player',owner_id:admin})
  expect(await row('player_accounts')).toHaveLength(1);expect(await row('team_coaches')).toHaveLength(0);expect(await row('teams')).toHaveLength(0)
  expect((await row('coaches')).find(c=>c.id===p.id).active).toBe(true)
 })
 it('creates and reuses teams for coach and player with different membership permissions',async()=>{
  const c=await request('coach',' Falcons ','newcoach@example.com',null);await identity(c,true)
  await approve((await row('access_requests'))[0].id)
  const p=await request('player','falcons');await identity(p,true)
  await approve((await row('access_requests')).find(r=>r.account_id===p.id).id)
  expect(await row('teams')).toHaveLength(1)
  expect(await row('team_coaches')).toEqual([expect.objectContaining({coach_id:c.id})])
  expect(await row('team_pitchers')).toHaveLength(1)
 })
 it('requires selection among duplicate names and excludes archived teams',async()=>{
  const t1=crypto.randomUUID(),t2=crypto.randomUUID()
  await db.query("insert into public.teams(id,name) values($1,'Falcons'),($2,' FALCONS ')",[t1,t2])
  const p=await request('player','Falcons');await identity(p,true);const r=(await row('access_requests'))[0]
  await expect(approve(r.id)).rejects.toThrow('Multiple teams')
  await expect(approve(r.id,crypto.randomUUID())).rejects.toThrow('matching active team')
  expect(await row('pitchers')).toHaveLength(0)
  await approve(r.id,t2);expect((await row('team_pitchers'))[0].team_id).toBe(t2)
  await db.query('update public.teams set archived=true')
  const c=await request('coach','Falcons','newcoach@example.com',null);await identity(c,true)
  await approve((await row('access_requests')).find(r=>r.account_id===c.id).id)
  expect(await row('teams')).toHaveLength(3)
 })
 it('deduplicates requests, reserves usernames, throttles resend, and retains submitted identity',async()=>{
  const p=await request();expect(await request()).toBeNull()
  expect(await request('player','','different@example.com')).toEqual({usernameUnavailable:true})
  await db.exec("update public.access_requests set last_verification_sent_at=now()-interval '61 seconds'")
  const retry=await request('coach','Different','player@example.com',null)
  expect(retry.id).toBe(p.id);expect((await row('access_requests'))[0]).toMatchObject({role:'player',username:'practice.kid',requested_team:''})
  expect(await row('access_requests')).toHaveLength(1)
 })
 it('rate limits new reservations and resends together without creating excess identities',async()=>{
  const bucket='same-client'
  for(let i=0;i<6;i++) {
   const result=await request('coach','Team',`coach${i}@example.com`,null,bucket)
   if(i<5)expect(result.id).toBeTruthy();else expect(result).toBeNull()
  }
  expect(await row('access_requests')).toHaveLength(5)
  expect(await row('account_provisions')).toHaveLength(7)
 })
 it('does not permit activation after the pending request row is removed',async()=>{
  const p=await request();await identity(p,true)
  await db.query('delete from public.access_requests where account_id=$1',[p.id])
  await expect(rpc('account_action',admin,'update',JSON.stringify({id:p.id,active:true,teamIds:[]}))).rejects.toThrow('verified request approval')
  await expect(rpc('account_action',admin,'preparePlayer',JSON.stringify({email:p.email}))).rejects.toThrow('verified request approval')
 })
 it('rejects access requests without granting access and cannot later approve or reactivate them',async()=>{
  const p=await request();await identity(p,true);const r=(await row('access_requests'))[0]
  await rpc('account_action',admin,'reject',JSON.stringify({id:r.id}))
  await expect(approve(r.id)).rejects.toThrow('unavailable')
  await expect(rpc('account_action',admin,'update',JSON.stringify({id:p.id,active:true,teamIds:[]}))).rejects.toThrow('verified request approval')
  expect(await request()).toBeNull();expect((await row('coaches')).find(c=>c.id===p.id).active).toBe(false)
 })
 it('keeps existing approved accounts untouched and restricts all new RPCs',async()=>{
  expect(await request('coach','Falcons','coach@example.com',null)).toBeNull()
  expect((await row('coaches')).find(c=>c.id===coach).active).toBe(true)
  await db.exec('set role authenticated')
  await expect(request()).rejects.toThrow('permission denied')
  await expect(rpc('sync_request_verification')).rejects.toThrow('permission denied')
  await expect(approve(crypto.randomUUID())).rejects.toThrow('permission denied')
  await db.exec('reset role')
 })
})

describe('self-service coaches and private player invitations',()=>{
 async function signup(email='self@example.com',name='New Coach',team='Falcons') {
  return rpc('reserve_coach_signup',name,email,team,crypto.randomUUID())
 }
 async function readyCoach() {
  const p=await signup();await identity(p,true)
  const teamId=await rpc('complete_coach_signup',p.id)
  return {...p,teamId}
 }
 const hash='a'.repeat(64),replacement='b'.repeat(64)
 async function invite(c:{id:string;teamId:string},data:Record<string,unknown>={}) {
  return rpc('manage_player_invitation',c.id,'create',JSON.stringify({teamId:c.teamId,name:'New Player',tokenHash:hash,...data}))
 }
 it('verifies before activation, creates a distinct team, and completes atomically only once',async()=>{
  await db.query("insert into public.teams(id,name) values(gen_random_uuid(),'Falcons')")
  const p=await signup();await identity(p)
  await expect(rpc('complete_coach_signup',p.id)).rejects.toThrow('Verify your email')
  expect((await row('coaches')).find(c=>c.id===p.id).active).toBe(false)
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[p.id])
  const tid=await rpc('complete_coach_signup',p.id)
  expect(await rpc('complete_coach_signup',p.id)).toBe(tid)
  expect(await row('teams')).toHaveLength(2)
  expect(await row('team_coaches')).toEqual([expect.objectContaining({team_id:tid,coach_id:p.id})])
  expect((await row('coaches')).find(c=>c.id===p.id)).toMatchObject({active:true,role:'coach'})
 })
 it('does not convert existing, rejected, pending, or suspended identities into self-service accounts',async()=>{
  expect(await signup('coach@example.com')).toBeNull()
  const p=await request('coach','Existing','pending@example.com',null);await identity(p,true)
  expect(await signup(p.email)).toBeNull()
  await expect(rpc('complete_coach_signup',p.id)).rejects.toThrow('Verify your email')
  const c=await readyCoach();await db.query('update public.coaches set active=false where id=$1',[c.id])
  expect(await signup(c.email)).toBeNull()
  await rpc('complete_coach_signup',c.id)
  expect((await row('coaches')).find(p=>p.id===c.id).active).toBe(false)
 })
 it('retains original details on resend and throttles per address',async()=>{
  const p=await signup();expect(await signup()).toBeNull()
  await db.query("update public.coach_signups set last_sent_at=now()-interval '61 seconds'")
  expect((await signup(p.email,'Changed Name','Changed Team')).id).toBe(p.id)
  expect((await row('coach_signups'))[0].team_name).toBe('Falcons')
  expect((await row('account_provisions')).find(c=>c.id===p.id).name).toBe('New Coach')
 })
 it('creates one roster record and one player account with no coach privileges; links are one-use',async()=>{
  const c=await readyCoach(),i=await invite(c)
  expect(await rpc('player_invitation_details',hash)).toMatchObject({teamName:'Falcons',playerName:'New Player'})
  expect((await row('player_invitations'))[0]).toMatchObject({token_hash:hash,accepted_at:null})
  const p=await rpc('reserve_invited_player',hash,'new.player')
  expect(await rpc('reserve_invited_player',hash,'new.player')).toEqual(p)
  await identity(p,true)
  await expect(rpc('reserve_invited_player',hash,'different')).rejects.toThrow('originally chosen')
  await rpc('complete_player_invitation',hash,p.id)
  expect(await row('player_accounts')).toEqual([{account_id:p.id,pitcher_id:i.pitcherId}])
  expect(await row('pitchers')).toHaveLength(1)
  expect((await row('coaches')).find(c=>c.id===p.id)).toMatchObject({role:'player',active:true})
  expect(await row('team_coaches')).toHaveLength(1)
  expect(await rpc('player_invitation_details',hash)).toBeNull()
  await expect(rpc('complete_player_invitation',hash,p.id)).rejects.toThrow('unavailable')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[p.id]);await db.exec('set role authenticated')
  const workspace=await rpc('get_workspace');expect(workspace.teams.map((t:any)=>t.id)).toContain(c.teamId)
  await expect(rpc('manage','saveTeam',JSON.stringify({id:crypto.randomUUID(),name:'Forbidden'}))).rejects.toThrow()
  await db.exec('reset role')
 })
 it('checks team membership at create/list/revoke, and does not expose private token hashes',async()=>{
  const c=await readyCoach();await invite(c)
  for(const operation of ['create','list','revoke']) await expect(rpc('manage_player_invitation',coach,operation,JSON.stringify({teamId:c.teamId,tokenHash:replacement,name:'Intruder'}))).rejects.toThrow('coach access')
  const listed=await rpc('manage_player_invitation',c.id,'list',JSON.stringify({teamId:c.teamId}))
  expect(listed).toHaveLength(1);expect(JSON.stringify(listed)).not.toContain(hash)
  await db.query('update public.coaches set active=false where id=$1',[c.id])
  expect(await rpc('player_invitation_details',hash)).toBeNull()
 })
 it('returns the same invitation for an uncertain creation retry without duplicating roster records',async()=>{
  const c=await readyCoach(),requestId=crypto.randomUUID(),i=await invite(c,{requestId})
  expect(await invite(c,{requestId})).toEqual(i)
  expect(await row('pitchers')).toHaveLength(1);expect(await row('player_invitations')).toHaveLength(1)
  await expect(invite(c,{requestId,tokenHash:replacement})).rejects.toThrow('already been used')
 })
 it.each(['expired','revoked','archived','removed','lost-coach'])('rejects %s invitations, including after identity reservation',async reason=>{
  const c=await readyCoach(),i=await invite(c),p=await rpc('reserve_invited_player',hash,'new.player');await identity(p,true)
  if(reason==='expired') await db.exec("update public.player_invitations set expires_at=now()-interval '1 second'")
  if(reason==='revoked') await rpc('manage_player_invitation',c.id,'revoke',JSON.stringify({teamId:c.teamId,id:i.id}))
  if(reason==='archived') await db.exec('update public.teams set archived=true')
  if(reason==='removed') await db.exec('update public.team_pitchers set active=false')
  if(reason==='lost-coach') await db.exec('delete from public.team_coaches')
  expect(await rpc('player_invitation_details',hash)).toBeNull()
  await expect(rpc('complete_player_invitation',hash,p.id)).rejects.toThrow('unavailable')
  expect(await row('player_accounts')).toHaveLength(0)
  expect((await row('coaches')).find(c=>c.id===p.id).active).toBe(false)
 })
 it('replaces links without duplicating pitchers and rejects another team’s pitcher or a linked pitcher',async()=>{
  const c=await readyCoach(),i=await invite(c)
  await invite(c,{pitcherId:i.pitcherId,tokenHash:replacement})
  expect(await row('pitchers')).toHaveLength(1)
  expect(await rpc('player_invitation_details',hash)).toBeNull()
  const foreign=crypto.randomUUID();await db.query("insert into public.pitchers(id,name,owner_id) values($1,'Foreign',$2)",[foreign,coach])
  await expect(invite(c,{pitcherId:foreign,tokenHash:'c'.repeat(64)})).rejects.toThrow('active pitcher')
  const p=await rpc('reserve_invited_player',replacement,'new.player');await identity(p,true);await rpc('complete_player_invitation',replacement,p.id)
  await expect(invite(c,{pitcherId:i.pitcherId,tokenHash:'c'.repeat(64)})).rejects.toThrow('already has an account')
 })
 it('grants no direct public table access or RPC execution',async()=>{
  await db.exec('set role authenticated')
  await expect(signup()).rejects.toThrow('permission denied')
  await expect(rpc('onboarding_limit','attack',100)).rejects.toThrow('permission denied')
  await expect(rpc('player_invitation_details',hash)).rejects.toThrow('permission denied')
  await expect(db.query('select * from public.player_invitations')).rejects.toThrow('permission denied')
  await db.exec('reset role')
 })
})
