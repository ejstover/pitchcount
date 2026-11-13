// All native tests are restricted to the dedicated localhost test database.
import pg from 'pg'
import {readFile,readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {project} from '../src/domain.ts'
export const {Pool}=pg
export async function settings(database) {
 const value=JSON.parse(await readFile('.test-artifacts/scale-postgres.json','utf8'))
 if(value.host!=='127.0.0.1'||value.port!==55432||value.database!=='pitchwork_scale'||value.user!=='postgres')throw new Error('Native tests require the isolated localhost database.')
 if(database && !/^pitchwork_scale_[a-z0-9_]+$/.test(database))throw new Error('Invalid isolated test database name.')
 return {...value,...(database?{database}:{}),application_name:'pitchwork-native-tests',connectionTimeoutMillis:10000,idleTimeoutMillis:10000}
}
export async function pool(database,max=16) {return new Pool({...await settings(database),max})}
export async function migrate(client) {
 await client.query(`do $$begin
 if not exists(select 1 from pg_roles where rolname='anon')then create role anon nologin;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated')then create role authenticated nologin;end if;
 if not exists(select 1 from pg_roles where rolname='service_role')then create role service_role nologin bypassrls;end if;
 if not exists(select 1 from pg_roles where rolname='supabase_auth_admin')then create role supabase_auth_admin nologin;end if;
 end $$;
 create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`)
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) {
  await client.query('begin')
  try{await client.query(await readFile(`supabase/migrations/${file}`,'utf8'));await client.query('commit')}
  catch(error){await client.query('rollback');throw new Error(`${file}: ${error.message}`)}
 }
}
export async function actor(client,id,role='authenticated') {
 if(!['authenticated','service_role','anon'].includes(role))throw new Error('Invalid test role')
 await client.query('begin')
 await client.query(`set local role ${role}`)
 await client.query("select set_config('request.jwt.claim.sub',$1,true)",[id??''])
}
export async function rpc(client,name,input) {
 if(!/^[a-z_]+$/.test(name))throw new Error('Invalid test RPC')
 return (await client.query(`select public.${name}($1::jsonb) result`,[JSON.stringify(input)])).rows[0].result
}
export async function identity(client,name,role='coach',pitcherId=null) {
 const id=randomUUID(),email=`${id}@scale.example.invalid`
 await client.query('insert into public.account_provisions(id,email,name,role,pitcher_id)values($1,$2,$3,$4,$5)',[id,email,name,role,pitcherId])
 await client.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[id,email])
 return id
}
export async function team(client,name,coaches) {
 const id=randomUUID();await client.query('insert into public.teams(id,name)values($1,$2)',[id,name])
 for(const coach of coaches)await client.query('insert into public.team_coaches values($1,$2)',[id,coach])
 return id
}
export async function pitcher(client,owner,teams) {
 const id=randomUUID();await client.query("insert into public.pitchers(id,name,owner_id)values($1,'Native pitcher',$2)",[id,owner])
 for(const team of teams)await client.query('insert into public.team_pitchers values($1,$2,true)',[team,id])
 return id
}
export function operation(coach,pitcherId,teamId=null,{events=1,ended=false,pitcherIds=[pitcherId]}={}) {
 const timestamp=new Date().toISOString(),sid=randomUUID()
 const session={id:sid,name:'Native concurrency test',notes:'',teamId,recorderId:coach,deviceId:randomUUID(),revision:1,startedAt:timestamp,updatedAt:timestamp,endedAt:null,status:'active',initialPitcherId:pitcherId,initialAppearanceId:randomUUID(),selectedPitcherId:pitcherId,pitcherIds,nextSequence:1}
 const source=[]
 for(let i=0;i<events+(ended?1:0);i++) {
  const kind=i===events?'end':'pitch',current=project(session,source).current
  source.push({id:randomUUID(),sessionId:sid,pitcherId,appearanceId:current.id,nextAppearanceId:randomUUID(),sequence:session.nextSequence++,timestamp,kind,...(kind==='pitch'?{pitchType:['ball','called','inPlay','foul'][i%4],pitchLocation:'middle'}:{}),voidedAt:null})
 }
 if(ended){session.status='ended';session.endedAt=timestamp}
 return {id:randomUUID(),sessionId:sid,expectedRevision:0,session,events:source}
}
