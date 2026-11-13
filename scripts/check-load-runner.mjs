// Three synthetic users against a loopback fake server. No real Auth or cloud.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {loadFetch} from './load-target.ts'
const root=resolve('.test-artifacts','load-runner-check-'+randomUUID())
await mkdir(root,{recursive:true})
const fixtures=Array.from({length:3},()=>{
 const coachId=randomUUID(),claims={sub:coachId,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600}
 return {coachId,pitcherId:randomUUID(),accessToken:`e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`}
})
const fixturePath=resolve(root,'synthetic-users.json');await writeFile(fixturePath,JSON.stringify(fixtures),{mode:0o600})
let wrongIdentity=false,calls=0,redirectSinkCalls=0
const server=createServer(async(req,res)=>{
 if(req.url==='/redirect'){res.writeHead(302,{Location:'/credential-sink'});res.end();return}
 if(req.url==='/credential-sink'){redirectSinkCalls++;res.end('{}');return}
 calls++;for await(const chunk of req){void chunk}
 const claims=JSON.parse(Buffer.from(req.headers.authorization.split('.')[1],'base64url'))
 res.setHeader('Content-Type','application/json')
 const value=req.url==='/functions/v1/accounts'?{id:wrongIdentity&&claims.sub===fixtures[0].coachId?randomUUID():claims.sub,role:'coach'}:{epoch:'synthetic',next:null,items:[],snapshot:{teams:[],pitchers:[],coaches:[],achievementRecords:[],achievementAwards:[]}}
 res.end(JSON.stringify(value))
})
async function run(name,protectedProbe=false,sharded=false){
 const output=resolve(root,name+'.json')
 const code=await new Promise((done,reject)=>{
  const child=spawn(process.execPath,[sharded?'scripts/sharded-load-test.mjs':'scripts/load-test.mjs'],{stdio:['ignore','ignore','pipe'],env:{...process.env,PITCHWORK_LOAD_ENVIRONMENT:'staging',PITCHWORK_LOAD_PROTECTED_URL:protectedProbe?'https://127.0.0.1/':'https://production.synthetic.invalid/',PITCHWORK_LOAD_URL:`http://127.0.0.1:${server.address().port}`,PITCHWORK_LOAD_PUBLIC_KEY:'sb_publishable_synthetic_load_check',PITCHWORK_LOAD_USERS:fixturePath,PITCHWORK_LOAD_VUS:'3',PITCHWORK_LOAD_SECONDS:'30',PITCHWORK_LOAD_RAMP_SECONDS:wrongIdentity?'25':'0',PITCHWORK_LOAD_WRITE_FRACTION:'0',PITCHWORK_LOAD_MIN_PEAK_SECONDS:'15',PITCHWORK_LOAD_MAX_DRIVER_P99_MS:'50',PITCHWORK_LOAD_PROCESSES:'2',PITCHWORK_LOAD_OUTPUT:output}})
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk});child.on('error',reject);child.on('close',code=>done({code,errors}))
 })
 assert.ok([0,1].includes(code.code),'The load runner failed before producing its assessment')
 return {code:code.code,diagnostic:code.errors,summary:protectedProbe?null:JSON.parse(await readFile(output,'utf8'))}
}
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 await assert.rejects(loadFetch(`http://127.0.0.1:${server.address().port}/redirect`,{headers:{Authorization:'Bearer synthetic'}}))
 assert.equal(redirectSinkCalls,0)
 console.log('Workload redirects are rejected without reaching the credential sink: passed')
 const protectedResult=await run('protected-target',true);assert.equal(protectedResult.code,1);assert.match(protectedResult.diagnostic,/protected production API host/);assert.equal(calls,0)
 console.log('Protected API host is rejected before the fake server receives a request: passed')
 const healthy=await run('healthy')
 assert.equal(healthy.code,0);assert.equal(healthy.summary.passed,true)
 assert.equal(healthy.summary.readiedUsers,3);assert.equal(healthy.summary.peakActiveUsers,3)
 assert.ok(healthy.summary.fullPeakSeconds>=15);assert.equal(healthy.summary.assessment.generatorValid,true)
 console.log('Three-user HTTP probe proves ready population, sustained hold and driver assessment: passed')
 wrongIdentity=true;calls=0
 const rejected=await run('wrong-identity')
 assert.equal(rejected.code,1);assert.equal(rejected.summary.passed,false);assert.ok(rejected.summary.securityFailures>0)
 assert.ok(calls<20);assert.equal(rejected.summary.assessment.populationValid,false)
 assert.ok(rejected.summary.durationSeconds<8,'Cancelled ramp timers kept the failed run alive')
 console.log('A mismatched authenticated identity fails the run and stops ordinary workload: passed')
 wrongIdentity=false
 const distributed=await run('distributed',false,true)
 assert.equal(distributed.code,0);assert.equal(distributed.summary.passed,true);assert.equal(distributed.summary.processes,2);assert.equal(distributed.summary.virtualUsers,3);assert.ok(distributed.summary.fullPeakSeconds>=15)
 console.log('Two processes merge three distinct users and measure their shared peak window: passed')
 wrongIdentity=true;calls=0
 const started=Date.now(),peerFailure=await run('peer-failure',false,true)
 assert.equal(peerFailure.code,1);assert.equal(peerFailure.summary.passed,false);assert.ok(peerFailure.summary.securityFailures>0);assert.ok(Date.now()-started<10000);assert.ok(calls<20)
 console.log('A single process identity failure cancels peer traffic and queued starts: passed')
 await writeFile('.test-artifacts/load-runner-checks.json',JSON.stringify({completedAt:new Date().toISOString(),passed:true,users:3,checks:6,note:'Synthetic loopback server only. This verifies runner mechanics, not app capacity.'},null,2))
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
