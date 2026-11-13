// Database-layer capacity experiment. Uses the actual app SQL/RLS with pooled
// connections and distinct actors; it deliberately makes no hosted Auth claim.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {execFileSync} from 'node:child_process'
import {pool,actor,operation} from './postgres-test-support.mjs'
import {project} from '../src/domain.ts'
import {acceptedPracticeChunk,preparePracticeTransfer,practiceUploadRequest} from '../src/practice-transfer.ts'
import {workspaceManifestHash} from '../src/workspace-version.ts'
const database='pitchwork_scale_population'
function option(key,fallback,min,max){const n=Number(process.env[key]??fallback);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return n}
const vus=option('PITCHWORK_NATIVE_VUS',1000,1,5000),seconds=option('PITCHWORK_NATIVE_SECONDS',120,30,3600),ramp=option('PITCHWORK_NATIVE_RAMP_SECONDS',30,0,seconds/2)
const writeFraction=option('PITCHWORK_NATIVE_WRITE_FRACTION',0.2,0,1),connections=option('PITCHWORK_NATIVE_POOL',64,4,120)
if(!Number.isInteger(vus)||!Number.isInteger(connections))throw new Error('Use integer user/connection counts.')
const db=await pool(database,connections),buckets=[5,10,25,50,100,250,500,1000,1500,2000,2500,3000,3500,4000,5000,10000,Infinity],metrics=new Map(),errors=new Map()
let failures=0,securityFailures=0,integrityFailures=0,clientErrors=0,requests=0,active=0,progress
const finalPractices=[]
const loop=monitorEventLoopDelay({resolution:20})
function uuid(kind,index){const h=createHash('md5').update(`native:${kind}:${index}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`}
function metric(name,started,ok){const m=metrics.get(name)??{requests:0,errors:0,buckets:Array(buckets.length).fill(0)};m.requests++;m.errors+=ok?0:1;m.buckets[buckets.findIndex(b=>performance.now()-started<=b)]++;metrics.set(name,m);requests++;if(!ok)failures++}
async function execute(user,name,work){
 const started=performance.now();let client
 try{client=await db.connect();await actor(client,user.id);const data=await work(client);await client.query('commit');metric(name,started,true);return data}
 catch(error){if(client)await client.query('rollback').catch(()=>{});metric(name,started,false);errors.set(error.code??'client',1+(errors.get(error.code??'client')??0));throw error}
 finally{client?.release()}
}
function isolation(condition){if(!condition){securityFailures++;throw new Error('Tenant isolation assertion failed')}}
async function workspace(user,cache){
 let after=null,epoch=null,index=0,pages=0;const ids=[...cache.keys()].sort(),received=new Map()
 const manifest=cache.epoch?await workspaceManifestHash(cache.epoch,cache):null
 do {
  while(index<ids.length && after!==null && ids[index]<=after)index++
  const known=Object.fromEntries(ids.slice(index,index+100).map(id=>[id,cache.get(id)]))
  const page=await execute(user,'workspace',async client=>(after===null&&manifest!==null
   ?await client.query('select public.get_workspace_state($1,$2,$3::jsonb) r',[manifest,cache.epoch,JSON.stringify(known)])
   :await client.query('select public.get_workspace_page($1::uuid,$2::jsonb,50,$3::text) r',[after,JSON.stringify(known),epoch])).rows[0].r)
  assert.ok(Array.isArray(page.items));if(epoch)assert.equal(epoch,page.epoch);epoch=page.epoch
  if(page.unchanged){assert.equal(page.manifest,manifest);assert.equal(page.epoch,cache.epoch);assert.equal(page.next,null);assert.equal(page.items.length,0);for(const [id,version]of cache)received.set(id,version)}
  if(page.snapshot){
   isolation(page.snapshot.coaches.some(c=>c.id===user.id))
   isolation(page.snapshot.teams.every(t=>user.teams.has(t.id)))
   isolation(page.snapshot.pitchers.every(p=>user.pitchers.has(p.id)))
   isolation((page.snapshot.achievementRecords??[]).every(r=>r.pitcherId===user.pitcher))
  }
  for(const item of page.items){
   if(item.session)isolation(item.session.teamId===null?item.session.recorderId===user.id:user.teams.has(item.session.teamId))
   received.set(item.id,item.version)
  }
  if(page.next!==null && after!==null)assert.ok(page.next>after)
  after=page.next;if(++pages>100)throw new Error('Unexpected fixture history size')
 }while(after!==null)
 cache.clear();for(const [id,version]of received)cache.set(id,version);cache.epoch=epoch
}
function newPractice(user){const op=operation(user.id,user.pitcher,null,{events:0});return {session:{...op.session,revision:0},events:[],base:undefined,pending:null}}
async function upload(user,p,end=false,kind='upload'){
 if(!p.pending){
  const s=structuredClone(p.session),events=structuredClone(p.events),expected=s.revision,timestamp=new Date().toISOString()
  if(expected>0){const current=project(s,events).current;events.push({id:randomUUID(),sessionId:s.id,pitcherId:user.pitcher,appearanceId:current.id,nextAppearanceId:randomUUID(),sequence:s.nextSequence++,timestamp,kind:end?'end':'pitch',...(end?{}:{pitchType:['ball','called','foul','inPlay'][events.length%4],pitchLocation:'middle'}),voidedAt:null})}
  s.revision++;s.updatedAt=timestamp;if(end){s.status='ended';s.endedAt=timestamp}
  p.pending=preparePracticeTransfer({id:randomUUID(),sessionId:s.id,expectedRevision:expected,session:s,events},p.base)
 }
 const op=p.pending,request=practiceUploadRequest(op),input=Object.values(request.input)[0]
 const revision=await execute(user,kind,async client=>(await client.query(`select public.${request.name}($1::jsonb) r`,[JSON.stringify(input)])).rows[0].r)
 assert.equal(revision,op.session.revision)
 p.session=op.session;p.events=op.events;p.base={session:op.session,events:op.events};p.pending=null
}
function quantile(row,q){let n=0;for(let i=0;i<buckets.length;i++){n+=row.buckets[i];if(n>=row.requests*q)return Number.isFinite(buckets[i])?buckets[i]:'over 10000'}return null}
try{
 const state=(await db.query('select * from public.native_scale_state where singleton')).rows[0]
 assert.ok(state.complete && state.seeded>=1000,'Finish seeding the population before running load.')
 assert.ok(vus<=Math.min(state.seeded,5000))
 const enriched=(await db.query("select to_regclass('public.native_metadata_state') present")).rows[0].present
 const metadataFixture=enriched?(await db.query('select seeded,target,complete from public.native_metadata_state where singleton')).rows[0]:null
 if(enriched)assert.ok(metadataFixture?.complete && metadataFixture.seeded===state.seeded,'Finish metadata enrichment before measuring.')
 const ledger={}
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())ledger[file]=createHash('sha256').update(await readFile(`supabase/migrations/${file}`)).digest('hex')
 assert.deepEqual(ledger,state.migrations,'Apply the current migration chain to the isolated population database before measuring.')
 const sourceHash=createHash('sha256')
 for(const file of ['package-lock.json','scripts/benchmark-native-load.mjs','scripts/postgres-test-support.mjs','scripts/seed-native-scale.mjs','scripts/seed-native-metadata.mjs','src/domain.ts','src/shared.ts','src/practice-transfer.ts','src/workspace-version.ts'])sourceHash.update(file).update(await readFile(file))
 const fingerprints={source:sourceHash.digest('hex'),migrations:createHash('sha256').update(JSON.stringify(ledger)).digest('hex')}
 const hardware=JSON.parse(execFileSync('docker',['inspect','pitchwork-scale-postgres','--format','{"cpuQuota":{{.HostConfig.NanoCpus}},"memoryBytes":{{.HostConfig.Memory}},"image":"{{.Config.Image}}","imageId":"{{.Image}}","testLabel":"{{index .Config.Labels "pitchwork.test"}}"}'],{encoding:'utf8',windowsHide:true}))
 assert.equal(hardware.testLabel,'scale')
 const settings=(await db.query("select version() version,current_setting('max_connections') max_connections,current_setting('shared_buffers') shared_buffers,current_setting('session_replication_role') trigger_mode,current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous_commit,current_setting('full_page_writes') full_page_writes,current_setting('wal_compression') wal_compression,current_setting('max_wal_size') max_wal_size,current_setting('checkpoint_timeout') checkpoint_timeout")).rows[0]
 assert.equal(settings.trigger_mode,'origin')
 assert.equal(settings.fsync,'on');assert.equal(settings.synchronous_commit,'on');assert.equal(settings.full_page_writes,'on')
 const started=Date.now(),deadline=started+seconds*1000
 console.log(JSON.stringify({event:'starting',backgroundAccounts:state.seeded,virtualUsers:vus,connections,seconds,ramp,writeFraction}))
 loop.enable();progress=setInterval(()=>console.log(JSON.stringify({event:'progress',elapsedSeconds:Math.round((Date.now()-started)/1000),active,requests,failures,securityFailures,queuedConnections:db.waitingCount})),10000)
 await Promise.all(Array.from({length:vus},async(_,i)=>{
  const n=i+1,user={id:uuid('user',n),pitcher:uuid('pitcher',n),teams:new Set([uuid('team',n)]),pitchers:new Set([uuid('pitcher',n)])}
  if(n%4===3 && n+1<=Math.min(state.seeded,5000)){user.teams.add(uuid('team',n+1));user.pitchers.add(uuid('pitcher',n+1))}
  const writing=i<Math.ceil(vus*writeFraction),cache=new Map();let p=writing?newPractice(user):null,nextProfile=0,nextRead=0,nextWrite=0
  await delay(ramp*1000*i/vus);active++
  try{
   while(Date.now()<deadline && securityFailures===0){const now=Date.now();try{
    if(now>=nextProfile){const profile=await execute(user,'profile',async client=>(await client.query('select id,role,active from public.coaches where id=$1',[user.id])).rows[0]);isolation(profile?.id===user.id && profile.active);user.playerPitcherId=profile.role==='player'?user.pitcher:null;nextProfile=now+25000+Math.random()*10000}
    let wrote=false
    if(p && now>=nextWrite){await upload(user,p,p.events.length>=100);cache.set(p.session.id,acceptedPracticeChunk(p,user.playerPitcherId).version);wrote=true;nextWrite=now+2500+Math.random()*1000;if(p.session.status==='ended'){finalPractices.push(structuredClone(p));p=newPractice(user)}}
    if(wrote||now>=nextRead){await workspace(user,cache);nextRead=now+25000+Math.random()*10000}
   }catch{clientErrors++;await delay(1000)}await delay(250)}
  }finally{
   if(p?.session.revision)try{if(p.pending)await upload(user,p,false,'cleanup');if(p.session.status!=='ended')await upload(user,p,true,'cleanup');finalPractices.push(structuredClone(p))}catch{/* Counted by execute. */}
   active--
  }
 }))
 clearInterval(progress);loop.disable()
 // After measured traffic stops, check canonical storage against every writer's
 // complete expected source. This operator read is verification, never workload.
 for(let start=0;start<finalPractices.length;start+=100) {
  const expected=finalPractices.slice(start,start+100)
  const rows=(await db.query('select id,revision,data,events from public.practices where id=any($1::uuid[])',[expected.map(p=>p.session.id)])).rows
  const actual=new Map(rows.map(r=>[r.id,r]))
  for(const p of expected)try {
   const row=actual.get(p.session.id);assert.ok(row);assert.equal(row.revision,p.session.revision)
   assert.deepEqual({...row.data,archived:false},{...p.session,archived:false});assert.deepEqual(row.events,p.events)
  }catch{integrityFailures++}
 }
 const summaryMetrics=Object.fromEntries([...metrics].map(([name,row])=>[name,{requests:row.requests,errors:row.errors,p95UpperBoundMs:quantile(row,0.95),p99UpperBoundMs:quantile(row,0.99)}]))
 const p95Good=['workspace','profile','upload'].every(name=>!summaryMetrics[name] || typeof summaryMetrics[name].p95UpperBoundMs==='number'&&summaryMetrics[name].p95UpperBoundMs<=(name==='upload'?1500:1000))
 const output={completedAt:new Date().toISOString(),database,backgroundAccounts:state.seeded,metadataFixture,virtualUsers:vus,writeFraction,connections,durationSeconds:(Date.now()-started)/1000,requests,failures,securityFailures,integrityFailures,verifiedPractices:finalPractices.length,clientErrors,errorCodes:Object.fromEntries(errors),metrics:summaryMetrics,generatorEventLoopP99Ms:Math.round(loop.percentile(99)/1e6),hardware,fingerprints,settings,passed:failures/Math.max(requests,1)<0.001 && securityFailures===0 && integrityFailures===0 && clientErrors===0 && p95Good,note:'Local real PostgreSQL and app SQL/RLS only. Auth, Edge Functions, HTTPS/CDN and browser work are excluded. Histogram values are bucket upper bounds, not exact percentiles.'}
 await mkdir('.test-artifacts',{recursive:true});await writeFile(`.test-artifacts/native-load-${vus}-${Math.round(writeFraction*100)}.json`,JSON.stringify(output,null,2));console.log(JSON.stringify(output));process.exitCode=output.passed?0:1
}catch(error){console.error(error.message);process.exitCode=1}finally{clearInterval(progress);loop.disable();await db.end()}
