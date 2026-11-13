// Separate Node processes use the generator's cores. Never forward raw child
// output or credentials; only bounded progress counters reach the console.
import {spawn} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {loadEnvironment} from './load-target.ts'
import {loadFixtures,partitionLoad,fixtureFingerprint} from './load-fixtures.ts'
import {aggregateLoad} from './load-aggregate.ts'
if(process.argv.includes('--help')){
 console.log('Uses the same protected staging settings as test:load. PITCHWORK_LOAD_PROCESSES=4 (1..16); distinct users and exact writer counts are distributed round-robin. Only aggregate counters are logged. Missing/failed processes cannot pass.');process.exit(0)
}
const {target}=await loadEnvironment(process.env)
function setting(name,fallback,min,max){const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<min||value>max)throw new Error(`Invalid ${name}`);return value}
const vus=setting('PITCHWORK_LOAD_VUS',10,1,10000),seconds=setting('PITCHWORK_LOAD_SECONDS',600,30,7200),ramp=setting('PITCHWORK_LOAD_RAMP_SECONDS',60,0,seconds),writeFraction=setting('PITCHWORK_LOAD_WRITE_FRACTION',0.2,0,1)
const processes=setting('PITCHWORK_LOAD_PROCESSES',Math.min(4,vus),1,Math.min(16,vus)),minimumPeakSeconds=setting('PITCHWORK_LOAD_MIN_PEAK_SECONDS',Math.max(1,seconds-ramp-12),1,seconds),maximumGeneratorEventLoopP99Ms=setting('PITCHWORK_LOAD_MAX_DRIVER_P99_MS',50,20,50)
let input;try{input=JSON.parse(await readFile(process.env.PITCHWORK_LOAD_USERS,'utf8'))}catch{throw new Error('Cannot read the private workload fixture JSON.')}
const users=loadFixtures(input,vus,seconds),groups=partitionLoad(users,processes,writeFraction)
const runId=randomUUID(),root=resolve('.test-artifacts','load-processes-'+runId),children=[]
await mkdir(root,{recursive:true,mode:0o700})
const expected={runId,targetOrigin:target.origin,writeFraction,durationSeconds:seconds,minimumPeakSeconds,maximumGeneratorEventLoopP99Ms,shards:groups.map(group=>({virtualUsers:group.users.length,expectedWriters:group.writers,fixtureFingerprint:fixtureFingerprint(group.users)}))}
let stopped=false,forced=false
function stop(){if(stopped)return;stopped=true;for(const child of children)if(child.connected)child.send({event:'stop-workload'},()=>{})}
const interrupt=()=>{stop();const timer=setTimeout(()=>{forced=true;for(const child of children)if(child.exitCode===null)child.kill()},8000);timer.unref()}
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt)
const timeout=setTimeout(interrupt,(seconds+120)*1000)
try{
 const running=[]
 for(const [index,group]of groups.entries()){
  const fixturePath=resolve(root,`users-${index}.json`),output=resolve(root,`result-${index}.json`)
  await writeFile(fixturePath,JSON.stringify(group.users),{mode:0o600,flag:'wx'})
  const log=createWriteStream(resolve(root,`process-${index}.log`),{flags:'wx',mode:0o600})
  const child=spawn(process.execPath,['scripts/load-test.mjs'],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PITCHWORK_LOAD_USERS:fixturePath,PITCHWORK_LOAD_VUS:String(group.users.length),PITCHWORK_LOAD_WRITERS:String(group.writers),PITCHWORK_LOAD_MIN_PEAK_SECONDS:String(minimumPeakSeconds),PITCHWORK_LOAD_MAX_DRIVER_P99_MS:String(maximumGeneratorEventLoopP99Ms),PITCHWORK_LOAD_OUTPUT:output,PITCHWORK_LOAD_RUN_ID:runId,PITCHWORK_LOAD_SHARD_INDEX:String(index)}})
  children.push(child);let buffered=''
  if(stopped&&child.connected)child.send({event:'stop-workload'},()=>{})
  child.on('message',message=>{if(message?.event==='workload-failure'&&['security','integrity'].includes(message.kind))stop();if(message?.event==='workload-ready'&&stopped&&child.connected)child.send({event:'stop-workload'},()=>{})})
  child.stdout.on('data',chunk=>{
   log.write(chunk);buffered+=chunk.toString();if(buffered.length>1_000_000){stop();buffered='';return}
   let newline;while((newline=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);try{const event=JSON.parse(line);if(event.event==='progress'){const safe={event:'process-progress',process:index};for(const key of ['active','requests','failures','securityFailures'])if(Number.isSafeInteger(event[key])&&event[key]>=0)safe[key]=event[key];console.log(JSON.stringify(safe))}}catch{/* Raw output stays in the ignored private log. */}}
  })
  child.stderr.on('data',chunk=>log.write(chunk))
  running.push(new Promise(done=>{
   child.on('error',()=>stop())
   child.on('close',async code=>{log.end();let report=null;try{report=JSON.parse(await readFile(output,'utf8'))}catch{stop()};if(code!==0&&(!report||report.passed))stop();done({code,report})})
  }))
 }
 const results=await Promise.all(running)
 let summary
 try{if(results.some(result=>!result.report))throw new Error('A traffic process did not produce a complete report.');summary=aggregateLoad(results.map(result=>result.report),expected);if(results.some(result=>result.code!==0)||stopped||forced){summary.passed=false;summary.assessment.passed=false;summary.assessment.reasons.push('A traffic process failed or the controller stopped the run.')}}catch(error){summary={completedAt:new Date().toISOString(),runId,targetOrigin:target.origin,virtualUsers:vus,processes,passed:false,reason:error.message}}
 const output=process.env.PITCHWORK_LOAD_OUTPUT??'.test-artifacts/sharded-load-summary.json'
 await writeFile(output,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));process.exitCode=summary.passed?0:1
}finally{
 clearTimeout(timeout);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt)
 for(const child of children)if(child.exitCode===null)child.kill()
}
