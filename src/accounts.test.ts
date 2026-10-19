import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { accountRequest } from './account-validation'
let db:PGlite
const admin = '10000000-0000-4000-8000-000000000001'
const coach = '10000000-0000-4000-8000-000000000002'
const other = '10000000-0000-4000-8000-000000000003'
const team = '20000000-0000-4000-8000-000000000001'
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role,supabase_auth_admin;`)
  await db.exec(readFileSync(new URL('../supabase/migrations/202610190001_accounts.sql',import.meta.url),'utf8'))
  await db.exec(`create table public.teams(id uuid primary key);create table public.team_coaches(team_id uuid references public.teams,coach_id uuid references public.coaches,primary key(team_id,coach_id));
    insert into public.account_provisions(id,email,name,role) values('${admin}','admin@example.com','Admin','admin'),('${coach}','coach@example.com','Coach','coach'),('${other}','other@example.com','Other','coach');
    insert into auth.users values('${admin}','admin@example.com'),('${coach}','coach@example.com'),('${other}','other@example.com');
    insert into public.teams values('${team}');insert into public.team_coaches values('${team}','${coach}');`)
},30000)
afterAll(async () => {await db.close()})
async function action(actor:string,data:unknown) {return db.query('select public.account_action($1,\'update\',$2::jsonb)',[actor,JSON.stringify(data)])}

describe('account approval and administration',() => {
  it('blocks direct registration even for an approved email with a different UUID',async () => {
    const result = await db.query<{result:{error?:unknown}}>('select public.before_user_created($1::jsonb) result',[JSON.stringify({user:{id:other,email:'coach@example.com'}})])
    expect(result.rows[0].result.error).toBeDefined()
    const approved = await db.query<{result:object}>('select public.before_user_created($1::jsonb) result',[JSON.stringify({user:{id:coach,email:'coach@example.com'}})])
    expect(approved.rows[0].result).toEqual({})
  })
  it('creates profiles only from server provisions and defaults new accounts to coach',async () => {
    await db.exec(`insert into auth.users values('10000000-0000-4000-8000-000000000099','unapproved@example.com')`)
    const result = await db.query<{n:number}>('select count(*)::int n from public.coaches')
    expect(result.rows[0].n).toBe(3)
    const prepared = await db.query<{result:{id:string}}>('select public.account_action($1,\'prepare\',$2::jsonb) result',[admin,JSON.stringify({email:'NEW@example.com',name:'New coach'})])
    await db.query('insert into auth.users values($1,$2)',[prepared.rows[0].result.id,'new@example.com'])
    const profile = await db.query<{role:string}>('select role from public.coaches where email=\'new@example.com\'')
    expect(profile.rows[0].role).toBe('coach')
  })
  it('never allows another admin to bootstrap',async () => {
    await expect(db.query('select public.bootstrap_admin($1,$2)',['second@example.com','Second'])).rejects.toThrow()
  })
  it('does not allow coaches to call admin actions',async () => {
    await expect(action(coach,{id:other,active:false,teamIds:[]})).rejects.toThrow('Admin access required')
  })
  it('prevents suspension or removal of the last active team coach',async () => {
    await expect(action(admin,{id:coach,active:false,teamIds:[team]})).rejects.toThrow('last coach')
    await expect(action(admin,{id:coach,active:true,teamIds:[]})).rejects.toThrow('last coach')
    await db.exec(`insert into public.team_coaches values('${team}','${other}')`)
    await action(admin,{id:coach,active:false,teamIds:[team]})
    const result = await db.query<{active:boolean}>('select active from public.coaches where id=$1',[coach])
    expect(result.rows[0].active).toBe(false)
    await action(admin,{id:coach,active:true,teamIds:[team]})
  })
  it('deduplicates requests and rate limits without creating accounts or revealing status',async () => {
    for(let i=0;i<8;i++) await db.query('select public.submit_access_request($1,$2,$3,$4)',['Requester',`request${i}@example.com`,'Falcons','same-client'])
    await db.query('select public.submit_access_request($1,$2,$3,$4)',['Other name','request0@example.com','Other team','another-client'])
    const result = await db.query<{n:number}>('select count(*)::int n from public.access_requests')
    expect(result.rows[0].n).toBe(5)
    const accounts = await db.query<{n:number}>('select count(*)::int n from public.coaches')
    expect(accounts.rows[0].n).toBe(4)
  })
  it('denies browser RPC access and all direct request/provision writes',async () => {
    await db.exec('set role authenticated')
    try {
      await expect(db.query('select public.bootstrap_admin($1,$2)',['hacker@example.com','Hacker'])).rejects.toThrow('permission denied')
      await expect(db.query('select public.account_action($1,\'prepare\',\'{}\')',[admin])).rejects.toThrow('permission denied')
      await expect(db.exec('select * from public.account_provisions')).rejects.toThrow('permission denied')
      await expect(db.exec("insert into public.access_requests(name,email,requested_team) values('X','x@example.com','X')")).rejects.toThrow('permission denied')
    } finally {await db.exec('reset role')}
  })
  it('gives the service role the table privileges used by account endpoints',async () => {
    await db.exec('set role service_role')
    try {
      expect((await db.query('select id from public.coaches')).rows.length).toBeGreaterThan(0)
      await db.query('select public.submit_access_request($1,$2,$3,$4)',['Service test','service@example.com','Falcons','service-client'])
    } finally {await db.exec('reset role')}
  })
})
describe('request input validation',() => {
  it('normalizes a complete request',() => {expect(accountRequest({name:' Coach ',email:'COACH@Example.com ',requestedTeam:' Falcons '})).toEqual({name:'Coach',email:'coach@example.com',requestedTeam:'Falcons'})})
  it.each([{name:'',email:'a@example.com',requestedTeam:'A'},{name:'A',email:'invalid',requestedTeam:'A'},{name:'A',email:'a@example.com',requestedTeam:' '},{name:'x'.repeat(101),email:'a@example.com',requestedTeam:'A'}])('rejects incomplete or excessive input',value => {expect(() => accountRequest(value)).toThrow()})
})
