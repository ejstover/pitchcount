// Trusted issuer fixtures for RETURNING-user API capacity tests. Tokens traverse
// real JWT verification and Auth user/session lookup. Interactive login/refresh
// rate capacity is a separate test: no provider protection is disabled here.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID,createHash,createHmac} from 'node:crypto'
import {createClient} from '@supabase/supabase-js'
import {Pool} from './postgres-test-support.mjs'
import {setTimeout as delay} from 'node:timers/promises'
const s=JSON.parse(await readFile('.test-artifacts/full-stack-status.json','utf8')),url=new URL(s.DB_URL)
assert.equal(s.API_URL,'http://127.0.0.1:53421');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'53422');assert.equal(url.pathname,'/postgres')
const count=Number(process.env.PITCHWORK_LOCAL_LOAD_USERS??5000);assert.ok(Number.isInteger(count)&&count>=4&&count<=5000)
const db=new Pool({connectionString:s.DB_URL,max:1,application_name:'pitchwork-local-token-fixtures'})
function uuid(kind,n){const h=createHash('md5').update(`native:${kind}:${n}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
function token(payload){const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),p=Buffer.from(JSON.stringify(payload)).toString('base64url');return `${h}.${p}.${createHmac('sha256',s.JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`}
async function readyUser(service,jwt){
 for(let attempt=0;;attempt++){const result=await service.auth.getUser(jwt);if(!result.error || result.error.status<500 || attempt>=9)return result;await delay(1000)}
}
try {
 const manifest=(await db.query('select * from pitchwork_fixture.copy_manifest where singleton')).rows[0];assert.ok(manifest.complete && manifest.population>=count)
 assert.equal((await db.query("select current_setting('session_replication_role') mode")).rows[0].mode,'origin')
 await db.query('create table if not exists pitchwork_fixture.token_sessions(n integer primary key,session_id uuid not null unique)')
 const rows=(await db.query("select n,c.id,c.email,c.role from generate_series(1,$1::integer)n join public.coaches c on c.id=md5('native:user:'||n)::uuid where c.active order by n",[count])).rows
 assert.equal(rows.length,count)
 const sessions=new Map((await db.query('select n,session_id from pitchwork_fixture.token_sessions')).rows.map(r=>[r.n,r.session_id]))
 const issued=Math.floor(Date.now()/1000),expires=issued+3600,users=[]
 for(const row of rows){
  assert.ok(['coach','player'].includes(row.role))
  const session=sessions.get(row.n)??randomUUID()
  await db.query('insert into pitchwork_fixture.token_sessions values($1,$2)on conflict(n)do nothing',[row.n,session])
  await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal,not_after,user_agent,ip)values($1,$2,now(),now(),'aal1',now()+interval '2 hours','Pitchwork synthetic returning-user fixture','127.0.0.1')on conflict(id)do update set updated_at=now(),not_after=excluded.not_after",[session,row.id])
  const accessToken=token({iss:s.API_URL+'/auth/v1',sub:row.id,aud:'authenticated',exp:expires,iat:issued,email:row.email,phone:'',app_metadata:{provider:'email',providers:['email']},user_metadata:{},role:'authenticated',aal:'aal1',amr:[{method:'password',timestamp:issued}],session_id:session,is_anonymous:false})
  const neighbor=row.role==='coach' && row.n%4===3
  users.push({coachId:row.id,accessToken,pitcherId:uuid('pitcher',row.n),forbiddenCoachId:uuid('user',manifest.population),expectedTeamIds:[uuid('team',row.n),...(neighbor?[uuid('team',row.n+1)]:[])],expectedPitcherIds:[uuid('pitcher',row.n),...(neighbor?[uuid('pitcher',row.n+1)]:[])],expectedCoachIds:[row.id,...(row.role==='player'?[uuid('user',row.n-1)]:[])]})
 }
 // Prove a coach and player token cross the real Auth and Edge boundaries.
 const service=createClient(s.API_URL,s.SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
 for(const fixture of [users[0],users[3]]) {
  const verified=await readyUser(service,fixture.accessToken);if(verified.error)throw new Error(`Local Auth fixture verification failed: ${verified.error.status}`);assert.equal(verified.data.user.id,fixture.coachId)
  const response=await fetch(s.FUNCTIONS_URL+'/accounts',{method:'POST',headers:{apikey:s.PUBLISHABLE_KEY,authorization:'Bearer '+fixture.accessToken,'content-type':'application/json'},body:JSON.stringify({action:'profile'})})
  assert.equal(response.status,200);assert.equal((await response.json()).id,fixture.coachId)
 }
 const [header,payload,signature]=users[0].accessToken.split('.'),bad=Buffer.from(signature,'base64url');bad[0]^=1
 const rejected=await service.auth.getUser(`${header}.${payload}.${bad.toString('base64url')}`);assert.ok(rejected.error);assert.equal(rejected.data.user,null)
 await writeFile('.test-artifacts/local-load-users.json',JSON.stringify(users),{mode:0o600})
 const metadata={createdAt:new Date().toISOString(),expiresAt:new Date(expires*1000).toISOString(),users:count,population:manifest.population,sourceFingerprint:manifest.fingerprint,identityMode:'Trusted local issuer fixtures for returning users; real Auth signature/session verification. Interactive signup/login/refresh peak is excluded.'}
 await writeFile('.test-artifacts/local-load-users.meta.json',JSON.stringify(metadata,null,2))
 console.log(JSON.stringify(metadata))
}finally{await db.end()}
