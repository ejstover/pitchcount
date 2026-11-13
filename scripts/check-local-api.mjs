// Acceptance checks against real local Auth, Kong, PostgREST, app SQL and Edge
// Functions. Only the dedicated loopback project is accepted. Fixtures are fake;
// private keys, passwords, tokens and response bodies are never reported.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID,randomBytes} from 'node:crypto'
import {createClient} from '@supabase/supabase-js'
import {createServer} from 'vite'
import {operation} from './postgres-test-support.mjs'
import {project} from '../src/domain.ts'
import {forwardAccountRequest} from '../src/account-gateway.ts'
const settings=JSON.parse(await readFile('.test-artifacts/full-stack-status.json','utf8'))
assert.equal(settings.API_URL,'http://127.0.0.1:53421')
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}
const service=createClient(settings.API_URL,settings.SECRET_KEY,options)
const anonymous=createClient(settings.API_URL,settings.PUBLISHABLE_KEY,options)
const results=[],users=[],prefix=randomUUID(),password='F9!'+randomBytes(24).toString('base64url')
const loader=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,watch:null},appType:'custom'})
const {SupabaseGateway}=await loader.ssrLoadModule('/src/cloud.ts')
async function checked(result){if(result.error)throw new Error(`Local API check failed: ${result.error.code??result.error.name??'request'}`);return result.data}
async function check(name,work){await work();results.push({name,passed:true});console.log(`${name}: passed`)}
async function edge(user,name,body){const profile=name==='accounts'&&body?.action==='profile';const response=await fetch(`${settings.FUNCTIONS_URL}/${name}`,{method:profile?'GET':'POST',headers:{apikey:settings.PUBLISHABLE_KEY,authorization:`Bearer ${user?.token??settings.ANON_KEY}`,origin:'https://count.twelvefs.com','content-type':'application/json'},...(profile?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()}}
async function user(name,role='coach',pitcherId) {
 const id=randomUUID(),email=`${prefix}-${name}@scale.example.invalid`
 await checked(await service.from('account_provisions').insert({id,email,name:`Synthetic ${name}`,role,...(pitcherId?{pitcher_id:pitcherId}:{})}))
 await checked(await service.auth.admin.createUser({id,email,password,email_confirm:true}))
 const client=createClient(settings.API_URL,settings.PUBLISHABLE_KEY,options),login=await checked(await client.auth.signInWithPassword({email,password}))
 assert.equal(login.user.id,id);assert.ok(login.user.email_confirmed_at)
 const value={id,email,client,token:login.session.access_token};users.push({coachId:id,email,password,accessToken:value.token,pitcherId});return value
}
const manage=async(u,action,input)=>checked(await u.client.rpc('manage',{action,input}))
try {
 await check('Unsigned public account requests reject forged forwarding headers before Auth',async()=>{
  const response=await fetch(`${settings.FUNCTIONS_URL}/accounts`,{method:'POST',headers:{apikey:settings.PUBLISHABLE_KEY,Origin:'https://count.twelvefs.com','Content-Type':'application/json','CF-Connecting-IP':'198.51.100.1','X-Forwarded-For':'203.0.113.1'},body:JSON.stringify({action:'recover_password',email:`${prefix}-unknown@example.invalid`})})
  assert.equal(response.status,403);assert.match((await response.json()).error,/Open the current Pitchwork app/)
 })
 await check('Signed public account gateway reaches the real function with the private local proof',async()=>{
  const {accountProxySecret}=JSON.parse(await readFile('.test-artifacts/full-stack/secrets.json','utf8'))
  const request=new Request('https://count.twelvefs.com/api/accounts',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://count.twelvefs.com','CF-Connecting-IP':'198.51.100.2'},body:JSON.stringify({action:'recover_password',email:`${prefix}-unknown@example.invalid`})})
  const response=await forwardAccountRequest(request,{APP_URL:'https://count.twelvefs.com/',SUPABASE_URL:settings.API_URL,SUPABASE_PUBLISHABLE_KEY:settings.PUBLISHABLE_KEY,ACCOUNT_PROXY_SECRET:accountProxySecret},'127.0.0.1',{allowLoopback:true})
  assert.equal(response.status,200);assert.match((await response.json()).message,/If an account exists/)
 })
 await check('Real account function rejects anonymous identity',async()=>{assert.equal((await edge(null,'accounts',{action:'profile'})).status,401)})
 await check('Public Auth cannot bypass the provisioned-identity hook',async()=>{
  const result=await anonymous.auth.signUp({email:`${prefix}-unapproved@scale.example.invalid`,password});assert.match(result.error?.message??'',/admin must create your account/);assert.equal(result.data.session,null)
 })
 const a=await user('coach-a'),b=await user('coach-b'),tid=randomUUID(),pid=randomUUID()
 await manage(a,'saveTeam',{id:tid,name:'Synthetic API team'})
 await manage(a,'savePitcher',{id:pid,name:'Synthetic API pitcher',jersey:'10',teamIds:[tid]})
 users.find(u=>u.coachId===a.id).pitcherId=pid
 const gateway=new SupabaseGateway(a.client),first=operation(a.id,pid,tid,{events:1})
 await check('Real sign-in, profile and scoped workspace agree on the current coach',async()=>{
  const profile=await edge(a,'accounts',{action:'profile'});assert.equal(profile.status,200);assert.equal(profile.data.id,a.id)
  const data=await gateway.workspace();assert.ok(data.teams.some(t=>t.id===tid));assert.ok(!data.coaches.some(c=>c.id===b.id))
 })
 await check('Acknowledged source is reused only after a server version match',async()=>{
  assert.equal(await gateway.upload(first),1)
  const rpc=a.client.rpc.bind(a.client);let hit=false
  a.client.rpc=(...args)=>{const result=rpc(...args);return ['get_workspace_page','get_workspace_state','get_workspace_update'].includes(args[0])?result.then(r=>{const row=r.data?.items.find(i=>i.id===first.session.id);if(row && !row.session || r.data?.unchanged && r.data.manifest===args[1].p_manifest)hit=true;return r}):result}
  const data=await gateway.workspace();assert.ok(hit);assert.deepEqual(data.events,first.events);assert.equal(data.sessions.find(s=>s.id===first.session.id).revision,1)
 })
 await check('Unrelated user and raw table endpoints cannot read or replace a practice',async()=>{
  const data=await checked(await b.client.rpc('get_workspace_page'));assert.ok(!data.items.some(p=>p.id===first.session.id))
  assert.equal((await b.client.from('practices').select('id')).error?.code,'42501')
  assert.equal((await b.client.from('coaches').select('id').eq('id',a.id)).data.length,0)
  assert.ok((await b.client.rpc('upload_practice',{operation:{...first,id:randomUUID(),session:{...first.session,recorderId:b.id}}})).error)
  assert.ok((await b.client.rpc('workspace_query_context')).error)
  assert.ok((await b.client.rpc('account_context',{p_actor:a.id})).error)
  assert.ok((await b.client.rpc('achievement_prepare',{p_actor:a.id})).error)
  assert.ok((await b.client.rpc('pw_legacy_workspace_reference')).error)
 })
 await check('Revocation fences a receipt retry and removes cached authorized history',async()=>{
  await checked(await service.from('team_coaches').delete().eq('team_id',tid).eq('coach_id',a.id))
  await assert.rejects(gateway.upload(first));assert.ok(!(await gateway.workspace()).sessions.some(s=>s.id===first.session.id))
  await checked(await service.from('team_coaches').insert({team_id:tid,coach_id:a.id}))
 })
 const timestamp=new Date().toISOString(),ended=structuredClone(first)
 ended.id=randomUUID();ended.expectedRevision=1;ended.session.revision=2;ended.session.status='ended';ended.session.endedAt=timestamp;ended.session.updatedAt=timestamp
 ended.events.push({id:randomUUID(),sessionId:first.session.id,pitcherId:pid,appearanceId:project(first.session,first.events).current.id,nextAppearanceId:randomUUID(),sequence:ended.session.nextSequence++,timestamp,kind:'end',voidedAt:null})
 await gateway.upload(ended)
 const player=await user('player','player',pid),personal=operation(player.id,pid,null,{events:1,ended:true})
 await check('Signed username login returns a real session for only the intended player',async()=>{
  const username='p'+randomUUID().replaceAll('-','').slice(0,20)
  await checked(await service.from('coaches').update({username}).eq('id',player.id))
  const {accountProxySecret}=JSON.parse(await readFile('.test-artifacts/full-stack/secrets.json','utf8'))
  const request=new Request('https://count.twelvefs.com/api/accounts',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://count.twelvefs.com'},body:JSON.stringify({action:'player_login',username,password})})
  const response=await forwardAccountRequest(request,{APP_URL:'https://count.twelvefs.com/',SUPABASE_URL:settings.API_URL,SUPABASE_PUBLISHABLE_KEY:settings.PUBLISHABLE_KEY,ACCOUNT_PROXY_SECRET:accountProxySecret},'127.0.0.1',{allowLoopback:true})
  assert.equal(response.status,200)
  const session=await response.json();assert.equal(typeof session.access_token,'string');assert.equal(typeof session.refresh_token,'string')
  const result=await anonymous.auth.getUser(session.access_token);assert.equal(result.error,null);assert.equal(result.data.user.id,player.id)
 })
 await checked(await player.client.rpc('upload_practice',{operation:personal}))
 await checked(await player.client.rpc('manage',{action:'saveAchievementRecord',input:{id:randomUUID(),record:{id:randomUUID(),pitcherId:pid,kind:'checkin',data:{date:'2026-10-01',action:'warmup',note:'Synthetic private note'}},expectedRevision:0}}))
 await check('Real award evaluation derives its player and keeps private activity isolated',async()=>{
  const result=await edge(player,'achievements',{pitcherId:randomUUID()});assert.equal(result.status,200);assert.equal(result.data.evaluated,1)
  const own=await checked(await player.client.rpc('get_workspace_page'));assert.equal(own.snapshot.achievementRecords.length,1)
  const coach=await gateway.workspace();assert.deepEqual(coach.achievementRecords,[]);assert.ok(!coach.sessions.some(s=>s.id===personal.session.id))
 })
 await check('Award cache hints match actual values and notice a repair without a job revision change',async()=>{
  const playerGateway=new SupabaseGateway(player.client),rpc=player.client.rpc.bind(player.client)
  let hit=false
  player.client.rpc=(...args)=>{const result=rpc(...args);return args[0]==='get_workspace_update'?result.then(r=>{if(r.data?.awardsUnchanged)hit=true;return r}):result}
  await playerGateway.workspace();const before=await playerGateway.workspace();await playerGateway.workspace();assert.ok(hit)
  const marker={id:'cache-repair:'+randomUUID(),pitcherId:pid,definitionId:'synthetic-cache-check',period:'lifetime',earnedAt:new Date().toISOString(),status:'qualified',actual:1,evidence:['Synthetic repair proof'],ruleVersion:1}
  try {
   await checked(await service.from('achievement_awards').insert({id:marker.id,pitcher_id:pid,data:marker}))
   const repaired=await playerGateway.workspace();assert.ok(repaired.achievementAwards.some(a=>a.id===marker.id))
   assert.equal(repaired.achievementEvaluation?.processedRevision,before.achievementEvaluation?.processedRevision)
  }finally{await checked(await service.from('achievement_awards').delete().eq('id',marker.id))}
  assert.ok(!(await playerGateway.workspace()).achievementAwards.some(a=>a.id===marker.id))
 })
 await check('Closed calendar jobs sleep and wake through ordinary authorized activity writes',async()=>{
  const oldPid=randomUUID();await manage(b,'savePitcher',{id:oldPid,name:'Synthetic old-history pitcher',jersey:'',teamIds:[]})
  const returning=await user('old-history-player','player',oldPid),source=operation(returning.id,oldPid,null,{events:1,ended:true}),old='2020-10-20T12:00:00Z'
  Object.assign(source.session,{startedAt:old,updatedAt:old,endedAt:old});for(const event of source.events)event.timestamp=old
  await checked(await returning.client.rpc('upload_practice',{operation:source}))
  assert.equal((await edge(returning,'achievements',{})).data.evaluated,1)
  let snapshot=(await checked(await returning.client.rpc('get_workspace_page'))).snapshot
  assert.equal(snapshot.achievementEvaluation.nextEvaluateAt,'infinity')
  assert.equal(snapshot.achievementEvaluation.revision,snapshot.achievementEvaluation.processedRevision)
  await manage(returning,'saveAchievementRecord',{id:randomUUID(),record:{id:randomUUID(),pitcherId:oldPid,kind:'checkin',data:{date:'2020-10-20',action:'warmup'}},expectedRevision:0})
  snapshot=(await checked(await returning.client.rpc('get_workspace_page'))).snapshot
  assert.ok(snapshot.achievementEvaluation.revision>snapshot.achievementEvaluation.processedRevision)
  assert.notEqual(snapshot.achievementEvaluation.nextEvaluateAt,'infinity')
  assert.equal((await edge(returning,'achievements',{})).data.evaluated,1)
  snapshot=(await checked(await returning.client.rpc('get_workspace_page'))).snapshot
  assert.equal(snapshot.achievementEvaluation.nextEvaluateAt,'infinity')
  assert.equal(snapshot.achievementEvaluation.revision,snapshot.achievementEvaluation.processedRevision)
 })
 await check('An existing signed-in token cannot bypass account suspension',async()=>{
  await checked(await service.from('coaches').update({active:false}).eq('id',a.id))
  await assert.rejects(gateway.workspace(),/Account unavailable/)
  assert.equal((await edge(a,'accounts',{action:'profile'})).status,403)
 })
 await writeFile('.test-artifacts/local-api-users.json',JSON.stringify(users),{mode:0o600})
 await writeFile('.test-artifacts/local-api-checks.json',JSON.stringify({completedAt:new Date().toISOString(),results,passed:true,note:'Real local Auth/API/Edge/SQL acceptance; synthetic accounts only. This is not a hosted capacity result.'},null,2))
 console.log(`Passed ${results.length} real local API acceptance checks.`)
}catch(error){await writeFile('.test-artifacts/local-api-checks.json',JSON.stringify({results,passed:false,failure:error.code??error.message},null,2));console.error(error.message);process.exitCode=1}finally{await loader.close()}
