// Enrich ONLY the isolated synthetic population; checkpoint committed batches.
import assert from 'node:assert/strict'
import {pool} from './postgres-test-support.mjs'
const db=await pool('pitchwork_scale_population',1),client=await db.connect()
try {
 const base=(await client.query('select * from public.native_scale_state where singleton')).rows[0]
 assert.ok(base.complete,'Finish the base fixture and migrations first.')
 await client.query('create table if not exists public.native_metadata_state(singleton boolean primary key default true check(singleton),seeded integer not null default 0,target integer not null,complete boolean not null default false)')
 await client.query('insert into public.native_metadata_state(target)values($1)on conflict(singleton)do update set target=excluded.target,complete=false',[base.seeded])
 const state=(await client.query('select * from public.native_metadata_state where singleton')).rows[0]
 for(let start=state.seeded+1;start<=base.seeded;start+=25000) {
  const end=Math.min(base.seeded,start+24999),firstPlayer=start+((4-start%4)%4),started=performance.now()
  await client.query('begin')
  try {
   // Trusted construction only. Real workload sessions retain origin triggers,
   // RLS, current access checks, receipts, revision checks and durable commits.
   await client.query("set local session_replication_role='replica'")
   await client.query(`delete from public.team_coaches tc using generate_series($1::integer,$2::integer,4)n where tc.coach_id=md5('native:user:'||n)::uuid and tc.team_id=md5('native:team:'||n)::uuid`,[firstPlayer,end])
   await client.query(`update public.coaches c set role='player' from generate_series($1::integer,$2::integer,4)n where c.id=md5('native:user:'||n)::uuid and c.role<>'player'`,[firstPlayer,end])
   await client.query(`insert into public.team_coaches select md5('native:team:'||n)::uuid,md5('native:user:'||(n-1))::uuid from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query(`update public.pitchers p set owner_id=md5('native:user:'||(n-1))::uuid from generate_series($1::integer,$2::integer,4)n where p.id=md5('native:pitcher:'||n)::uuid and p.owner_id<>md5('native:user:'||(n-1))::uuid`,[firstPlayer,end])
   await client.query(`insert into public.player_accounts select md5('native:user:'||n)::uuid,md5('native:pitcher:'||n)::uuid from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query(`insert into public.goals(id,scope,team_id,metric,direction,target,revision)select md5('native:goal-team:'||n)::uuid,'team',md5('native:team:'||n)::uuid,'total','min',20,1 from generate_series($1::integer,$2::integer)n on conflict do nothing`,[start,end])
   await client.query(`insert into public.goals(id,scope,team_id,pitcher_id,metric,direction,target,revision)select md5('native:goal-coach:'||n)::uuid,'coach',md5('native:team:'||n)::uuid,md5('native:pitcher:'||n)::uuid,'strikePct','min',65,1 from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query(`insert into public.goals(id,scope,pitcher_id,metric,direction,target,revision)select md5('native:goal-personal:'||n)::uuid,'personal',md5('native:pitcher:'||n)::uuid,'total','min',30,1 from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query(`insert into public.achievement_records(id,pitcher_id,kind,revision,data)select md5('native:profile:'||n)::uuid,md5('native:pitcher:'||n)::uuid,'profile',1,jsonb_build_object('sport','baseball','ageBand','11–13','timezone','America/New_York','pins','[]'::jsonb,'sound',false) from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query(`insert into public.achievement_records(id,pitcher_id,kind,revision,data)select md5('native:checkin:'||n)::uuid,md5('native:pitcher:'||n)::uuid,'checkin',1,jsonb_build_object('date','2026-10-01','action','warmup','note','Synthetic private activity') from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   // Initially due, rather than pretending these accounts have been evaluated.
   await client.query(`insert into public.achievement_jobs(pitcher_id)select md5('native:pitcher:'||n)::uuid from generate_series($1::integer,$2::integer,4)n on conflict do nothing`,[firstPlayer,end])
   await client.query('update public.native_metadata_state set seeded=$1 where singleton',[end])
   await client.query('commit');console.log(JSON.stringify({enriched:end,batchMs:Math.round(performance.now()-started)}))
  }catch(error){await client.query('rollback');throw error}
 }
 await client.query('update public.native_metadata_state set complete=true where singleton')
 await client.query('analyze')
 const counts=(await client.query("select (select count(*) from public.player_accounts) players,(select count(*) from public.goals) goals,(select count(*) from public.achievement_records) activities,(select count(*) from public.achievement_jobs) jobs,pg_size_pretty(pg_database_size(current_database())) size,current_setting('session_replication_role') trigger_mode")).rows[0]
 console.log(JSON.stringify(counts))
}catch(error){console.error(error.message);process.exitCode=1}finally{client.release();await db.end()}
