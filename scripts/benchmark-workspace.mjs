// A disposable, single-connection query benchmark. This is NOT a capacity test.
import {PGlite} from '@electric-sql/pglite'
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
const population=Number(process.env.PITCHWORK_BENCH_POPULATION??10000)
if(!Number.isInteger(population)||population<100||population>100000)throw new Error('Use 100–100000 background tenants; use real PostgreSQL for million-user capacity tests.')
const db=new PGlite(),actor=randomUUID(),team=randomUUID(),pitcher=randomUUID()
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`)
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
  try {await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))}catch(error){throw new Error(`${file}: ${error.message} (position ${error.position}, internal ${error.internalPosition??''})`)}
 }
 // Bulk historical fixtures, in an isolated memory database only. Disabling these
 // metadata triggers avoids measuring fixture creation rather than query cost.
 for(const table of ['coaches','teams','pitchers','team_coaches','team_pitchers'])await db.exec(`alter table public.${table} disable trigger workspace_structure_changed`)
 await db.exec(`insert into auth.users(id,email)select md5('bench-user-'||n)::uuid,'bench-'||n||'@example.invalid' from generate_series(1,${population})n;
 insert into public.coaches(id,email,name,role)select id,email,'Background coach','coach' from auth.users;
 insert into public.teams(id,name)select md5('bench-team-'||n)::uuid,'Background team '||n from generate_series(1,${population})n;
 insert into public.team_coaches select md5('bench-team-'||n)::uuid,md5('bench-user-'||n)::uuid from generate_series(1,${population})n;
 insert into public.pitchers(id,name,owner_id)select md5('bench-pitcher-'||n)::uuid,'Background pitcher',md5('bench-user-'||n)::uuid from generate_series(1,${population})n;
 insert into public.team_pitchers select md5('bench-team-'||n)::uuid,md5('bench-pitcher-'||n)::uuid,true from generate_series(1,${population})n;`)
 await db.query("insert into public.account_provisions(id,email,name,role)values($1,'foreground@example.invalid','Foreground','coach')",[actor])
 await db.query("insert into auth.users(id,email)values($1,'foreground@example.invalid')",[actor])
 await db.query("insert into public.teams(id,name)values($1,'Foreground')",[team])
 await db.query('insert into public.team_coaches values($1,$2)',[team,actor])
 await db.query("insert into public.pitchers(id,name,owner_id)values($1,'Foreground',$2)",[pitcher,actor])
 await db.query('insert into public.team_pitchers values($1,$2,true)',[team,pitcher])
 await db.exec('analyze')
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${actor}',false)`)
 const samples=[];let last
 for(let i=0;i<25;i++) {
  const start=performance.now();last=(await db.query('select public.get_workspace_page() result')).rows[0].result
  if(i>=5)samples.push(performance.now()-start)
 }
 if(last.snapshot.teams.length!==1||last.snapshot.pitchers.length!==1||last.snapshot.coaches.length!==1)throw new Error('Tenant isolation failed')
 samples.sort((a,b)=>a-b)
 const result={backgroundTenants:population,measuredReads:samples.length,p50Ms:samples[Math.floor(samples.length*0.5)],p95Ms:samples[Math.ceil(samples.length*0.95)-1],responseBytes:Buffer.byteLength(JSON.stringify(last)),isolated:true,note:'PGlite single connection; empty practice history; no network/Auth/CPU contention. Does not certify concurrent-user or million-user capacity.'}
 await mkdir('.test-artifacts',{recursive:true});await writeFile('.test-artifacts/workspace-benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){console.error(error.message);process.exitCode=1}finally{await db.close()}
