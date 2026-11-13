// Node 24+. Real authenticated HTTP traffic against a designated staging project.
// Never put tokens/passwords in command-line arguments, logs, or source control.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {setMaxListeners} from 'node:events'
import {project} from '../src/domain.ts'
import {acceptedPracticeChunk,preparePracticeTransfer,practiceUploadRequest} from '../src/practice-transfer.ts'
import {workspaceManifestHash} from '../src/workspace-version.ts'
import {achievementEvaluationDue} from '../src/achievements/scheduling.ts'
import {readAwardCache} from '../src/achievements/cache.ts'
import {assessLoad,loadBounds as bounds,histogramMetrics} from './load-report.ts'
import {loadEnvironment,loadFetch} from './load-target.ts'
import {loadFixtures,fixtureFingerprint} from './load-fixtures.ts'

try{await run()}finally{if(process.connected)process.disconnect()}
async function run() {
if(process.argv.includes('--help')) {
  console.log(`Authenticated staging load test (Node 24+)
Required environment: PITCHWORK_LOAD_ENVIRONMENT=staging, PITCHWORK_LOAD_URL,
PITCHWORK_LOAD_PUBLIC_KEY, PITCHWORK_LOAD_USERS (private JSON file).
Remote runs also require a protected production API URL, from
PITCHWORK_LOAD_PROTECTED_URL or VITE_SUPABASE_URL, or the root linked project.
Optional: PITCHWORK_LOAD_VUS=10, PITCHWORK_LOAD_SECONDS=600,
PITCHWORK_LOAD_RAMP_SECONDS=60, PITCHWORK_LOAD_WRITE_FRACTION=0.2,
PITCHWORK_LOAD_MIN_PEAK_SECONDS=duration-ramp-12 (at least 1),
PITCHWORK_LOAD_MAX_DRIVER_P99_MS=50,
PITCHWORK_LOAD_OUTPUT=.test-artifacts/load-summary.json.
Each fixture: {coachId,accessToken,pitcherId,forbiddenCoachId?}.
Use distinct non-admin, approved staging identities with their own independent
pitcher. Writing VUs create real staging practices. Auth tokens must remain valid
through the test. The summary contains timings/counts, never fixture content.`)
  return
}
const {target,key}=await loadEnvironment(process.env)
let fixtures;try{fixtures=JSON.parse(await readFile(process.env.PITCHWORK_LOAD_USERS,'utf8'))}catch{throw new Error('Cannot read the private workload fixture JSON.')}
function number(name,fallback,min,max) {
  const n=Number(process.env[name]??fallback)
  if(!Number.isFinite(n)||n<min||n>max)throw new Error(`Invalid ${name}`)
  return n
}
const vus=number('PITCHWORK_LOAD_VUS',10,1,10000),seconds=number('PITCHWORK_LOAD_SECONDS',600,30,7200)
const ramp=number('PITCHWORK_LOAD_RAMP_SECONDS',60,0,seconds),writeFraction=number('PITCHWORK_LOAD_WRITE_FRACTION',0.2,0,1)
const minimumPeakSeconds=number('PITCHWORK_LOAD_MIN_PEAK_SECONDS',Math.max(1,seconds-ramp-12),1,seconds)
const maximumGeneratorEventLoopP99Ms=number('PITCHWORK_LOAD_MAX_DRIVER_P99_MS',50,20,50)
const writerCount=number('PITCHWORK_LOAD_WRITERS',Math.ceil(vus*writeFraction),0,vus)
if(!Number.isInteger(writerCount))throw new Error('Writer count must be an integer.')
const users=loadFixtures(fixtures,vus,seconds)
const runId=process.env.PITCHWORK_LOAD_RUN_ID??null,shardIndex=number('PITCHWORK_LOAD_SHARD_INDEX',0,0,15)
if(runId!==null&&!/^[a-f0-9-]{36}$/i.test(runId)||!Number.isInteger(shardIndex))throw new Error('Invalid load cohort identity.')
if(process.env.PITCHWORK_LOAD_WRITERS!==undefined&&runId===null)throw new Error('Exact writer overrides are reserved for an identified controller cohort.')
const stats=new Map(),timingStats=new Map()
const errorCounts=new Map()
let securityFailures=0,failures=0,requests=0,bytes=0,active=0,clientErrors=0,pendingEvaluations=0,integrityFailures=0,finalPracticesVerified=0,cleanupFailures=0,awardCacheHits=0,practiceManifestHits=0
let peakActiveUsers=0,fullPopulationReadyAt=null,firstUserStoppedAt=null,workloadRequests=0,workloadFailures=0,cleanupSkippedAfterFailure=0
const readiedUsers=new Set()
const failureStop=new AbortController()
let externalStop=false
if(process.connected)process.on('message',message=>{if(message?.event==='stop-workload'){externalStop=true;failureStop.abort()}})
if(process.connected)process.send({event:'workload-ready'},()=>{})
// One bounded ramp timer per user subscribes until it starts or is cancelled.
setMaxListeners(vus+10,failureStop.signal)
function notifyFailure(kind){if(process.connected)process.send({event:'workload-failure',kind},()=>{})}
function securityFailure(){securityFailures++;failureStop.abort();notifyFailure('security')}
const verifiedWriters=new Set()
function record(kind,elapsed,ok) {
  const row=stats.get(kind)??{requests:0,errors:0,buckets:Array(bounds.length).fill(0)}
  row.requests++;row.errors+=ok?0:1;row.buckets[bounds.findIndex(b=>elapsed<=b)]++;stats.set(kind,row)
  requests++;if(!ok)failures++
  if(kind!=='cleanup'&&kind!=='integrityRead'){workloadRequests++;if(!ok)workloadFailures++}
}
async function call(user,path,body,kind,{expectedStatus,privateRead=false}={}) {
  if(failureStop.signal.aborted)throw Object.assign(new Error('Workload stopped after a security or integrity failure'),{recorded:true})
  const started=performance.now()
  try {
    const res=await loadFetch(new URL(path,target),{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:`Bearer ${user.accessToken}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(12000),failureStop.signal])})
    const text=await res.text();bytes+=Buffer.byteLength(text)
    for(const part of (res.headers.get('server-timing')??'').split(',')){
      const span=part.trim().match(/^([a-zA-Z0-9_-]+);dur=([0-9.]+)/)
      if(span){const duration=Number(span[2]),label=kind+':'+span[1];if(Number.isFinite(duration)&&duration>=0){const row=timingStats.get(label)??{requests:0,buckets:Array(bounds.length).fill(0)};row.requests++;row.buckets[bounds.findIndex(b=>duration<=b)]++;timingStats.set(label,row)}}
    }
    const value=JSON.parse(text||'null')
    const ok=expectedStatus?res.status===expectedStatus:res.ok
    record(kind,performance.now()-started,ok)
    if(privateRead && (!res.ok || !Array.isArray(value) || value.length!==0))securityFailure()
    if(!ok){const category=`${kind}:${res.status}:${value?.code??'http'}`;errorCounts.set(category,1+(errorCounts.get(category)??0));throw Object.assign(new Error('Request failed'),{recorded:true,code:value?.code,status:res.status})}
    return value
  }catch(error) {
    if(!error.recorded){record(kind,performance.now()-started,false);const category=`${kind}:network:${error.cause?.code??error.code??error.name??'Error'}`;errorCounts.set(category,1+(errorCounts.get(category)??0));error.recorded=true}
    // Deliberately omit response bodies and credentials from diagnostics.
    throw error
  }
}
async function workspace(user,cache) {
  const syncStarted=performance.now()
  for(let attempt=0;attempt<3;attempt++) {
    let after=null,epoch=null,updated=new Map(),pages=0,evaluation=null
    let awards=cache.awards??null
    const ids=[...cache.keys()].sort();let index=0
    const manifest=cache.epoch?await workspaceManifestHash(cache.epoch,cache):null
    try {
      do {
        while(index<ids.length && after!==null && ids[index]<=after)index++
        const known=Object.fromEntries(ids.slice(index,index+100).map(id=>[id,cache.get(id)]))
        const page=after===null&&manifest!==null
          ?await call(user,'/rest/v1/rpc/get_workspace_update',{p_manifest:manifest,p_epoch:cache.epoch,p_known:known,p_awards:awards?.version??null},'workspace')
          :await call(user,'/rest/v1/rpc/get_workspace_page',{p_after:after,p_known:known,p_limit:50,p_epoch:epoch},'workspace')
        if(!Array.isArray(page?.items)||typeof page.epoch!=='string'||page.next!==null&&after!==null&&page.next<=after)throw new Error('Invalid page')
        epoch=page.epoch
        if(page.unchanged){
          if(manifest===null||page.manifest!==manifest||page.epoch!==cache.epoch||page.next!==null||page.items.length!==0)throw new Error('Invalid manifest confirmation')
          for(const [id,version]of cache)updated.set(id,version)
          practiceManifestHits++
        }
        if(page.snapshot){
          const decoded=readAwardCache(page,awards);awards=decoded.cache
          if(page.awardsUnchanged)awardCacheHits++
          const data=decoded.snapshot;let scoped=true
          if(user.expectedTeamIds)scoped&&=data.teams.every(t=>user.expectedTeamIds.includes(t.id))
          if(user.expectedPitcherIds)scoped&&=data.pitchers.every(p=>user.expectedPitcherIds.includes(p.id))
          if(user.expectedCoachIds)scoped&&=data.coaches.every(c=>user.expectedCoachIds.includes(c.id))
          scoped&&=(data.achievementRecords??[]).every(r=>user.role==='player' && r.pitcherId===user.pitcherId)
          scoped&&=(data.achievementAwards??[]).every(r=>user.role==='player' && r.pitcherId===user.pitcherId)
          if(!scoped){securityFailure();throw new Error('Workspace isolation assertion failed')}
          evaluation=data.achievementEvaluation
        }
        for(const item of page.items){
          if(item.session && (item.session.teamId===null?item.session.recorderId!==user.coachId:user.expectedTeamIds&&!user.expectedTeamIds.includes(item.session.teamId))){securityFailure();throw new Error('Practice isolation assertion failed')}
          if(item.achievement && (user.role!=='player'||item.achievement.events.some(e=>e.pitcherId!==user.pitcherId))){securityFailure();throw new Error('Player projection isolation assertion failed')}
          updated.set(item.id,item.version)
        }
        after=page.next
        if(++pages>2000)throw new Error('Unexpectedly large fixture workspace')
      }while(after!==null)
      if(user.role==='player' && achievementEvaluationDue(evaluation)) {
        // The application retains saved source when optional award confirmation
        // fails. Still count every failed request and report pending confirmation.
        let result
        try{result=await call(user,'/functions/v1/achievements',{},'evaluation')}catch{pendingEvaluations++}
        if(result?.evaluated){
          const currentManifest=await workspaceManifestHash(epoch,updated)
          const refreshed=currentManifest
            ?await call(user,'/rest/v1/rpc/get_workspace_update',{p_manifest:currentManifest,p_epoch:epoch,p_known:{},p_awards:awards?.version??null},'awardMetadata')
            :await call(user,'/rest/v1/rpc/get_workspace_page',{p_limit:1,p_epoch:epoch},'awardMetadata')
          if(refreshed.epoch!==epoch)throw Object.assign(new Error('Workspace changed'),{code:'40001'})
          const decoded=readAwardCache(refreshed,awards);awards=decoded.cache
          if(refreshed.awardsUnchanged)awardCacheHits++
          if(!decoded.snapshot||(decoded.snapshot.achievementAwards??[]).some(r=>r.pitcherId!==user.pitcherId)){securityFailure();throw new Error('Award metadata isolation assertion failed')}
        }
      }
      cache.clear();for(const [id,version]of updated)cache.set(id,version);cache.epoch=epoch;cache.awards=awards
      for(const kind of ['completeWorkspace',`completeWorkspace:${user.role}`]){
        const row=stats.get(kind)??{requests:0,errors:0,buckets:Array(bounds.length).fill(0)}
        row.requests++;row.buckets[bounds.findIndex(b=>performance.now()-syncStarted<=b)]++;stats.set(kind,row)
      }
      return
    }catch(error){if(error.code==='40001'&&attempt<2)continue;throw error}
  }
}
function newPractice(user) {
  const timestamp=new Date().toISOString()
  return {session:{id:randomUUID(),name:'Staging capacity test',notes:'',teamId:null,recorderId:user.coachId,deviceId:randomUUID(),revision:0,startedAt:timestamp,updatedAt:timestamp,endedAt:null,status:'active',initialPitcherId:user.pitcherId,initialAppearanceId:randomUUID(),selectedPitcherId:user.pitcherId,pitcherIds:[user.pitcherId],nextSequence:1},events:[],pending:null,base:null}
}
function nextUpload(practice,user,end=false) {
  if(practice.pending)return practice.pending
  const expected=practice.session.revision,timestamp=new Date().toISOString()
  if(expected>0) {
    const current=project(practice.session,practice.events).current
    practice.events.push({id:randomUUID(),sessionId:practice.session.id,pitcherId:user.pitcherId,appearanceId:current.id,nextAppearanceId:randomUUID(),sequence:practice.session.nextSequence++,timestamp,kind:end?'end':'pitch',...(end?{}:{pitchType:['ball','called','foul','inPlay'][practice.events.length%4],pitchLocation:'middle'}),voidedAt:null})
  }
  if(end){practice.session.status='ended';practice.session.endedAt=timestamp}
  practice.session.revision++;practice.session.updatedAt=timestamp
  practice.pending=preparePracticeTransfer(structuredClone({id:randomUUID(),sessionId:practice.session.id,expectedRevision:expected,session:practice.session,events:practice.events}),practice.base)
  return practice.pending
}
async function upload(user,practice,end,kind) {
  const op=nextUpload(practice,user,end),request=practiceUploadRequest(op)
  const revision=await call(user,`/rest/v1/rpc/${request.name}`,request.input,kind)
  if(revision!==op.session.revision)throw new Error('Unexpected upload acknowledgement')
  practice.base={session:structuredClone(op.session),events:structuredClone(op.events)}
  practice.pending=null
}
async function verifyPractice(user,practice){
  // A predecessor UUID selects the exact source through the normal scoped RPC.
  const raw=(BigInt('0x'+practice.session.id.replaceAll('-',''))-1n).toString(16).padStart(32,'0')
  const cursor=`${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
  const page=await call(user,'/rest/v1/rpc/get_workspace_page',{p_after:cursor,p_limit:1},'integrityRead')
  try{assert.equal(page.items[0]?.id,practice.session.id);assert.deepEqual(page.items[0].session,{...practice.session,archived:false});assert.deepEqual(page.items[0].events,practice.events);finalPracticesVerified++;verifiedWriters.add(user.coachId)}
  catch{integrityFailures++;failureStop.abort();notifyFailure('integrity');throw new Error('Acknowledged practice content did not match its source')}
}
const fingerprint=createHash('sha256')
async function sourceFiles(root){
 const files=[]
 for(const entry of await readdir(root,{withFileTypes:true})){
  const path=root+'/'+entry.name
  if(entry.isDirectory())files.push(...await sourceFiles(path))
  else if(/\.(ts|tsx|sql)$/.test(entry.name)&&!entry.name.endsWith('.test.ts'))files.push(path)
 }
 return files
}
for(const path of ['scripts/load-test.mjs','scripts/load-report.ts','scripts/load-target.ts','scripts/load-fixtures.ts','scripts/load-aggregate.ts','scripts/sharded-load-test.mjs','package-lock.json','vite.config.ts','build-hosting.ts','build-account-proxy.ts','wrangler.example.jsonc','supabase/config.toml','supabase/achievement-scheduler.sql',...await sourceFiles('src'),...await sourceFiles('functions'),...await sourceFiles('supabase/functions'),...await sourceFiles('supabase/migrations')].sort())fingerprint.update(path).update(await readFile(path))
const sourceFingerprint=fingerprint.digest('hex'),started=Date.now(),cpuStarted=process.cpuUsage(),deadline=started+seconds*1000
const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable()
console.log(JSON.stringify({event:'starting',virtualUsers:vus,durationSeconds:seconds,rampSeconds:ramp,writeFraction,minimumPeakSeconds,maximumGeneratorEventLoopP99Ms}))
const progress=setInterval(()=>console.log(JSON.stringify({event:'progress',elapsedSeconds:Math.round((Date.now()-started)/1000),active,requests,failures,securityFailures})),10000)
await Promise.all(users.map(async(user,i)=>{
  try{await delay(ramp*1000*i/vus,undefined,{signal:failureStop.signal})}catch(error){if(error.name==='AbortError')return;throw error}
  if(Date.now()>=deadline||failureStop.signal.aborted)return
  active++;peakActiveUsers=Math.max(peakActiveUsers,active)
  const writing=i<writerCount,cache=new Map()
  let practice=writing?newPractice(user):null,nextRead=0,nextProfile=0,nextWrite=0,nextSecurity=0
  try {
    while(Date.now()<deadline && !failureStop.signal.aborted) {
      const now=Date.now()
      try {
        if(now>=nextProfile){const profile=await call(user,'/functions/v1/accounts',undefined,'profile');if(profile?.id!==user.coachId||!['coach','player'].includes(profile?.role)){securityFailure();throw new Error('Use approved non-admin fixtures')};user.role=profile.role;user.playerPitcherId=profile.role==='player'?user.pitcherId:null;nextProfile=now+25000+Math.random()*10000}
        if(now>=nextSecurity && user.forbiddenCoachId){await call(user,`/rest/v1/coaches?id=eq.${encodeURIComponent(user.forbiddenCoachId)}&select=id,email`,undefined,'isolation',{privateRead:true});nextSecurity=now+60000}
        let wrote=false
        if(practice && now>=nextWrite) {
          await upload(user,practice,practice.events.length>=100,'upload')
          cache.set(practice.session.id,acceptedPracticeChunk(practice,user.playerPitcherId).version)
          wrote=true;nextWrite=now+2500+Math.random()*1000
          if(practice.session.status==='ended'){await verifyPractice(user,practice);practice=newPractice(user)}
        }
        if(now>=nextRead||wrote){await workspace(user,cache);nextRead=now+25000+Math.random()*10000;readiedUsers.add(user.coachId);if(readiedUsers.size===vus&&fullPopulationReadyAt===null)fullPopulationReadyAt=Date.now()}
      }catch(error){if(!error.recorded)clientErrors++;await delay(1000+Math.random()*1000)}
      await delay(250)
    }
  }finally{
    firstUserStoppedAt??=Date.now()
    if(practice?.session.revision&&failureStop.signal.aborted)cleanupSkippedAfterFailure++
    else if(practice?.session.revision)try {
      // Retry an uncertain last operation before ending its practice.
      if(practice.pending)await upload(user,practice,false,'cleanup')
      if(practice.session.status!=='ended')await upload(user,practice,true,'cleanup')
      await verifyPractice(user,practice)
    }catch{cleanupFailures++}
    active--
  }
}))
clearInterval(progress)
eventLoop.disable()
const histograms=Object.fromEntries(stats),serverTimingHistograms=Object.fromEntries(timingStats),metrics=histogramMetrics(histograms)
const fullPeakSeconds=fullPopulationReadyAt===null?0:Math.max(0,(Math.min(deadline,firstUserStoppedAt??deadline)-fullPopulationReadyAt)/1000)
const generatorEventLoopP99Ms=Math.round(eventLoop.percentile(99)/1e6)
const assessment=assessLoad({virtualUsers:vus,writeFraction,expectedWriters:writerCount,readiedUsers:readiedUsers.size,peakActiveUsers,fullPeakSeconds,minimumPeakSeconds,generatorEventLoopP99Ms,maximumGeneratorEventLoopP99Ms,workloadRequests,workloadFailures,securityFailures,integrityFailures,cleanupFailures,verifiedWriters:verifiedWriters.size,clientErrors,metrics})
if(externalStop){assessment.passed=false;assessment.reasons.push('Stopped by the traffic controller after a peer or operator failure.')}
const {passed}=assessment
const serverTimings=histogramMetrics(serverTimingHistograms)
const generatorCpu=process.cpuUsage(cpuStarted)
const summary={completedAt:new Date().toISOString(),sourceFingerprint,virtualUsers:vus,durationSeconds:(Date.now()-started)/1000,requests,failures,securityFailures,clientErrors,pendingEvaluations,bytes,errorCounts:Object.fromEntries(errorCounts),generatorCpuSeconds:{user:generatorCpu.user/1e6,system:generatorCpu.system/1e6},generatorEventLoopP99Ms:Math.round(eventLoop.percentile(99)/1e6),metrics,serverTimings,passed,note:'API traffic includes real player evaluation/confirmation. Failed optional confirmations remain counted as request errors and pendingEvaluations; saved source still completes sync as in the application. Database size, server utilization, lease backlog and browser timings must be recorded separately; returning-user fixture tokens do not measure interactive login/refresh peaks.'}
const output=process.env.PITCHWORK_LOAD_OUTPUT??'.test-artifacts/load-summary.json'
Object.assign(summary,{integrityFailures,finalPracticesVerified,verifiedWriters:verifiedWriters.size,cleanupFailures,awardCacheHits,practiceManifestHits})
Object.assign(summary,{assessment,readiedUsers:readiedUsers.size,peakActiveUsers,fullPeakSeconds,minimumPeakSeconds,maximumGeneratorEventLoopP99Ms,workloadRequests,workloadFailures,cleanupSkippedAfterFailure})
Object.assign(summary,{schemaVersion:2,targetOrigin:target.origin,runId,shardIndex,expectedWriters:writerCount,writeFraction:writerCount/vus,requestedWriteFraction:writeFraction,fixtureFingerprint:fixtureFingerprint(users),cohort:{startedAt:started,deadlineAt:deadline,readyAt:fullPopulationReadyAt,stoppedAt:firstUserStoppedAt},histograms,serverTimingHistograms,externalStop})
await mkdir(new URL('../.test-artifacts/',import.meta.url),{recursive:true})
await writeFile(output,JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary));process.exitCode=passed?0:1
}
