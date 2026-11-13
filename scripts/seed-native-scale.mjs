// Synthetic data only, in the dedicated localhost PostgreSQL test instance.
import {createHash} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {pool,migrate} from './postgres-test-support.mjs'
const database='pitchwork_scale_population',population=Number(process.env.PITCHWORK_NATIVE_POPULATION??2000000)
if(!Number.isInteger(population)||population<1000||population>5000000)throw new Error('Choose 1000–5000000 synthetic identities.')
const root=await pool(),db=await pool(database,4)
let client
try {
 const exists=(await root.query('select exists(select 1 from pg_database where datname=$1) present',[database])).rows[0].present
 const files=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort(),ledger={}
 for(const file of files)ledger[file]=createHash('sha256').update(await readFile(`supabase/migrations/${file}`)).digest('hex')
 if(!exists) {
  await root.query(`create database ${database}`);client=await db.connect();await migrate(client)
  await client.query('create table public.native_scale_state(singleton boolean primary key default true check(singleton),seeded integer not null default 0,target integer not null,complete boolean not null default false,migrations jsonb not null)')
  await client.query('insert into public.native_scale_state(singleton,target,migrations)values(true,$1,$2::jsonb)',[population,JSON.stringify(ledger)])
 }else client=await db.connect()
 const state=(await client.query('select * from public.native_scale_state where singleton')).rows[0]
 for(const [file,hash]of Object.entries(state.migrations))if(ledger[file]!==hash)throw new Error(`An applied test migration changed: ${file}. Recreate the isolated population database before continuing.`)
 for(const file of files.filter(f=>!state.migrations[f])) {
  await client.query('begin');try{await client.query(await readFile(`supabase/migrations/${file}`,'utf8'));await client.query('update public.native_scale_state set migrations=$1::jsonb',[JSON.stringify(ledger)]);await client.query('commit')}catch(error){await client.query('rollback');throw error}
 }
 if(population<state.seeded)throw new Error('Use at least the already seeded population; this script never deletes fixture records.')
 await client.query('update public.native_scale_state set target=$1,complete=false where singleton',[population])
 console.log(`Seeding ${population.toLocaleString('en-US')} synthetic accounts, rosters and one historical practice per account.`)
 for(let start=state.seeded+1;start<=population;start+=25000) {
  const end=Math.min(population,start+24999),started=performance.now()
  await client.query('begin')
  try {
   // Only this trusted fixture-loading transaction suppresses derived/metadata
   // triggers. Workload connections use origin mode, RLS and real app functions.
   await client.query("set local session_replication_role='replica'")
   await client.query(`
    insert into auth.users(id,email,email_confirmed_at)select md5('native:user:'||n)::uuid,'native-'||n||'@scale.example.invalid',now() from generate_series($1::integer,$2::integer)n;
   `,[start,end])
   await client.query(`insert into public.coaches(id,email,name,role)select md5('native:user:'||n)::uuid,'native-'||n||'@scale.example.invalid','Synthetic coach '||n,'coach' from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query(`insert into public.teams(id,name)select md5('native:team:'||n)::uuid,'Synthetic team '||n from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query(`insert into public.pitchers(id,name,owner_id)select md5('native:pitcher:'||n)::uuid,'Synthetic pitcher '||n,md5('native:user:'||n)::uuid from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query(`insert into public.team_coaches select md5('native:team:'||n)::uuid,md5('native:user:'||n)::uuid from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query(`insert into public.team_pitchers select md5('native:team:'||n)::uuid,md5('native:pitcher:'||n)::uuid,true from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query(`insert into public.practices(id,team_id,recorder_id,device_id,revision,data,events)
    select md5('native:practice:'||n)::uuid,md5('native:team:'||n)::uuid,md5('native:user:'||n)::uuid,md5('native:device:'||n)::uuid,1,
    jsonb_build_object('id',md5('native:practice:'||n)::uuid,'name','Synthetic history','notes','','teamId',md5('native:team:'||n)::uuid,'recorderId',md5('native:user:'||n)::uuid,'deviceId',md5('native:device:'||n)::uuid,'revision',1,'startedAt','2026-10-01T12:00:00Z','updatedAt','2026-10-01T12:01:00Z','endedAt','2026-10-01T12:01:00Z','status','ended','initialPitcherId',md5('native:pitcher:'||n)::uuid,'selectedPitcherId',md5('native:pitcher:'||n)::uuid,'initialAppearanceId',md5('native:appearance:'||n)::uuid,'pitcherIds',jsonb_build_array(md5('native:pitcher:'||n)::uuid),'nextSequence',3),
    jsonb_build_array(
     jsonb_build_object('id',md5('native:event:'||n)::uuid,'sessionId',md5('native:practice:'||n)::uuid,'pitcherId',md5('native:pitcher:'||n)::uuid,'appearanceId',md5('native:appearance:'||n)::uuid,'nextAppearanceId',md5('native:reserved:'||n)::uuid,'sequence',1,'timestamp','2026-10-01T12:00:00Z','kind','pitch','pitchType','called','pitchLocation','middle','voidedAt',null),
     jsonb_build_object('id',md5('native:end:'||n)::uuid,'sessionId',md5('native:practice:'||n)::uuid,'pitcherId',md5('native:pitcher:'||n)::uuid,'appearanceId',md5('native:appearance:'||n)::uuid,'nextAppearanceId',md5('native:endreserved:'||n)::uuid,'sequence',2,'timestamp','2026-10-01T12:01:00Z','kind','end','voidedAt',null))
    from generate_series($1::integer,$2::integer)n`,[start,end])
   await client.query('update public.native_scale_state set seeded=$1 where singleton',[end]);await client.query('commit')
   console.log(JSON.stringify({seeded:end,batchMs:Math.round(performance.now()-started)}))
  }catch(error){await client.query('rollback');throw error}
 }
 // A quarter of the active cohort are real linked-player SQL accounts. Their
 // adjacent coach owns the roster record and remains the active team coach.
 const cohort=Math.min(population,5000)
 await client.query('begin')
 try {
  await client.query(`delete from public.team_coaches where coach_id in(select md5('native:user:'||n)::uuid from generate_series(4,$1::integer,4)n)`,[cohort])
  await client.query(`update public.coaches set role='player' where id in(select md5('native:user:'||n)::uuid from generate_series(4,$1::integer,4)n)`,[cohort])
  await client.query(`insert into public.team_coaches select md5('native:team:'||n)::uuid,md5('native:user:'||(n-1))::uuid from generate_series(4,$1::integer,4)n on conflict do nothing`,[cohort])
  await client.query(`update public.pitchers p set owner_id=md5('native:user:'||(n-1))::uuid from generate_series(4,$1::integer,4)n where p.id=md5('native:pitcher:'||n)::uuid`,[cohort])
  await client.query(`insert into public.player_accounts select md5('native:user:'||n)::uuid,md5('native:pitcher:'||n)::uuid from generate_series(4,$1::integer,4)n on conflict do nothing`,[cohort])
  await client.query('update public.native_scale_state set complete=true where singleton');await client.query('commit')
 }catch(error){await client.query('rollback');throw error}
 await client.query('analyze')
 const counts=(await client.query('select (select count(*) from public.coaches) accounts,(select count(*) from public.practices) practices,pg_size_pretty(pg_database_size(current_database())) size,current_setting(\'session_replication_role\') trigger_mode')).rows[0]
 console.log(JSON.stringify({database,...counts,note:'Synthetic SQL fixtures; hosted Auth and Edge Functions are not included.'}))
}catch(error){console.error(error.message);process.exitCode=1}finally{client?.release();await db.end();await root.end()}
