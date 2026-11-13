// Copy trusted synthetic fixtures between two explicitly isolated loopback DBs.
// No production config, passwords or user tokens are accepted as arguments.
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {pipeline} from 'node:stream/promises'
import {from as copyFrom,to as copyTo} from 'pg-copy-streams'
import {pool,Pool} from './postgres-test-support.mjs'
const local=JSON.parse(await readFile('.test-artifacts/full-stack-status.json','utf8')),url=new URL(local.DB_URL)
assert.equal(local.API_URL,'http://127.0.0.1:53421');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'53422');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres')
const sourcePool=await pool('pitchwork_scale_population',1),targetPool=new Pool({connectionString:local.DB_URL,max:1,application_name:'pitchwork-fixture-copy'})
const source=await sourcePool.connect(),target=await targetPool.connect(),q=value=>'"'+value.replaceAll('"','""')+'"'
let failed=false
async function phase(name,work){
 if((await target.query('select complete from pitchwork_fixture.copy_state where phase=$1',[name])).rows[0]?.complete)return
 const started=performance.now();await target.query('begin')
 try{await target.query("set local session_replication_role='replica'");await work();await target.query('insert into pitchwork_fixture.copy_state(phase,complete)values($1,true)on conflict(phase)do update set complete=true',[name]);await target.query('commit');console.log(JSON.stringify({phase:name,completed:true,milliseconds:Math.round(performance.now()-started)}))}
 catch(error){failed=true;throw error}
}
try {
 const state=(await source.query('select * from public.native_scale_state where singleton')).rows[0]
 const metadata=(await source.query('select * from public.native_metadata_state where singleton')).rows[0]
 assert.ok(state.complete && metadata.complete && metadata.seeded===state.seeded)
 const ledger={};for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())ledger[file]=createHash('sha256').update(await readFile(`supabase/migrations/${file}`)).digest('hex')
 assert.deepEqual(ledger,state.migrations)
 const latest=(await target.query('select version from supabase_migrations.schema_migrations order by version desc limit 1')).rows[0].version
 assert.equal(latest,Object.keys(ledger).sort().at(-1).split('_')[0])
 const busy=(await source.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name='pitchwork-native-tests'")).rows[0].n
 assert.equal(busy,0,'Finish native workloads before taking the fixture snapshot.')
 await source.query('begin isolation level repeatable read read only')
 const tables=(await source.query("select relname,n_tup_ins,n_tup_upd,n_tup_del from pg_stat_user_tables where schemaname='public' and relname not like 'native\\_%' escape '\\' order by relname")).rows
 const manifest={database:'pitchwork_scale_population',population:state.seeded,ledger,tables},fingerprint=createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
 await target.query('create schema if not exists pitchwork_fixture;create table if not exists pitchwork_fixture.copy_manifest(singleton boolean primary key default true check(singleton),fingerprint text not null,population integer not null,complete boolean not null default false);create table if not exists pitchwork_fixture.copy_state(phase text primary key,complete boolean not null)')
 const previous=(await target.query('select * from pitchwork_fixture.copy_manifest where singleton')).rows[0]
 if(previous)assert.equal(previous.fingerprint,fingerprint,'The native source changed after this checkpoint; use a fresh isolated API stack.')
 else await target.query('insert into pitchwork_fixture.copy_manifest(fingerprint,population)values($1,$2)',[fingerprint,state.seeded])
 await target.query('update pitchwork_fixture.copy_manifest set complete=false where singleton')
 // Populate real GoTrue users before their app profiles. Background accounts
 // intentionally have no password/login session; no public Auth rules change.
 for(let start=1;start<=state.seeded;start+=25000){const end=Math.min(state.seeded,start+24999);await phase(`auth:${end}`,()=>target.query(`insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,is_super_admin,created_at,updated_at,encrypted_password,confirmation_token,recovery_token,email_change_token_new,email_change)
  select md5('native:user:'||n)::uuid,'00000000-0000-0000-0000-000000000000'::uuid,'authenticated','authenticated','native-'||n||'@scale.example.invalid',now(),'{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,false,now(),now(),'','','','','' from generate_series($1::integer,$2::integer)n`,[start,end]))}
 // GoTrue's user reader expects empty token strings, not SQL NULL, despite
 // nullable schema columns. Upgrade earlier fixture checkpoints accordingly.
 for(let start=1;start<=state.seeded;start+=25000){const end=Math.min(state.seeded,start+24999);await phase(`auth-strings:${end}`,()=>target.query(`update auth.users u set encrypted_password=coalesce(encrypted_password,''),confirmation_token=coalesce(confirmation_token,''),recovery_token=coalesce(recovery_token,''),email_change_token_new=coalesce(email_change_token_new,''),email_change=coalesce(email_change,'')
  from generate_series($1::integer,$2::integer)n where u.id=md5('native:user:'||n)::uuid and (encrypted_password is null or confirmation_token is null or recovery_token is null or email_change_token_new is null or email_change is null)`,[start,end]))}
 for(const table of tables){
  const name=table.relname
  const columns=async client=>(await client.query("select a.attname,format_type(a.atttypid,a.atttypmod) type from pg_attribute a where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped and a.attgenerated='' order by a.attnum",[`public.${q(name)}`])).rows
  const src=await columns(source),dst=await columns(target);assert.deepEqual(dst,src,`Column mismatch: ${name}`)
  await phase(`table:${name}`,async()=>{
   const countBefore=Number((await target.query(`select count(*) n from public.${q(name)}`)).rows[0].n),fields=src.map(c=>q(c.attname)).join(',')
   const out=source.query(copyTo(`copy public.${q(name)}(${fields}) to stdout with(format binary)`)),input=target.query(copyFrom(`copy public.${q(name)}(${fields}) from stdin with(format binary)`))
   await pipeline(out,input)
   assert.equal(input.rowCount,out.rowCount,`Stream count mismatch: ${name}`)
   const countAfter=Number((await target.query(`select count(*) n from public.${q(name)}`)).rows[0].n)
   assert.equal(countAfter-countBefore,input.rowCount,`Stored count mismatch: ${name}`)
  })
 }
 await source.query('commit')
 // The loader skips derived/FK triggers only in its own transactions. Validate
 // every public FK independently before permitting API workload generation.
 const constraints=(await target.query(`select c.conname,c.confmatchtype,n.nspname child_schema,t.relname child,pn.nspname parent_schema,p.relname parent,
  array(select a.attname::text from unnest(c.conkey)with ordinality k(num,ord)join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord) child_columns,
  array(select a.attname::text from unnest(c.confkey)with ordinality k(num,ord)join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord) parent_columns
  from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_class p on p.oid=c.confrelid join pg_namespace pn on pn.oid=p.relnamespace where c.contype='f' and n.nspname='public' order by c.conname`)).rows
 for(const fk of constraints){assert.equal(fk.confmatchtype,'s');const present=fk.child_columns.map(c=>`c.${q(c)} is not null`).join(' and '),match=fk.child_columns.map((c,i)=>`p.${q(fk.parent_columns[i])}=c.${q(c)}`).join(' and ')
  const invalid=(await target.query(`select exists(select 1 from ${q(fk.child_schema)}.${q(fk.child)} c where ${present} and not exists(select 1 from ${q(fk.parent_schema)}.${q(fk.parent)} p where ${match})) invalid`)).rows[0].invalid
  assert.equal(invalid,false,`Invalid fixture FK: ${fk.conname}`);console.log(JSON.stringify({validatedForeignKey:fk.conname}))
 }
 assert.equal((await target.query("select current_setting('session_replication_role') mode")).rows[0].mode,'origin')
 assert.equal((await target.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgenabled='D'")).rows[0].n,0)
 await target.query('analyze')
 await target.query('update pitchwork_fixture.copy_manifest set complete=true where singleton')
 console.log(JSON.stringify({complete:true,syntheticAccounts:state.seeded,tables:tables.length,foreignKeysValidated:constraints.length,note:'Real local Supabase schema; no hosted or production data touched.'}))
}catch(error){failed=true;console.error(error.message);process.exitCode=1}
finally{source.release(failed);target.release(failed);await sourcePool.end();await targetPool.end()}
