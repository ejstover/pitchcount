import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {mkdir,writeFile} from 'node:fs/promises'
import {pool,migrate,actor,rpc,identity,team,pitcher,operation} from './postgres-test-support.mjs'

const root=await pool(),database=`pitchwork_scale_check_${randomUUID().replaceAll('-','')}`
const results=[]
let db,operator,left,right,created=false
async function check(name,work) {
 const started=performance.now()
 try{await work();results.push({name,passed:true,ms:Math.round(performance.now()-started)});console.log(`${name}: passed`)}
 finally{for(const client of [left,right])if(client)await client.query('rollback').catch(()=>{})}
}
async function within(promise,ms=1500) {
 let timeout
 try{return await Promise.race([promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Independent operation was blocked')),ms)})])}
 finally{clearTimeout(timeout)}
}
async function blocked(promise) {
 let finished=false;promise.then(()=>{finished=true},()=>{finished=true})
 await delay(120);assert.equal(finished,false,'Conflicting operation should wait for the transaction')
}
try {
 await root.query(`create database ${database}`);created=true
 db=await pool(database);operator=await db.connect();await migrate(operator)
 left=await db.connect();right=await db.connect()
 const a=await identity(operator,'Coach A'),b=await identity(operator,'Coach B'),admin=await identity(operator,'Admin','admin')
 const ta=await team(operator,'Team A',[a,b]),tb=await team(operator,'Team B',[b])
 const pa=await pitcher(operator,a,[ta]),pb=await pitcher(operator,b,[tb])
 await check('Unrelated practice uploads run concurrently',async()=>{
  await actor(left,a);await rpc(left,'upload_practice',operation(a,pa,ta))
  const independent=(async()=>{await actor(right,b);await rpc(right,'upload_practice',operation(b,pb,tb));await right.query('commit')})()
  await within(independent);await left.query('commit')
 })
 await check('Same-practice writes serialize and reject a stale revision',async()=>{
  const op=operation(a,pa,ta);await actor(left,a);await rpc(left,'upload_practice',op)
  const competing=(async()=>{await actor(right,a);return rpc(right,'upload_practice',{...op,id:randomUUID()})})()
  await blocked(competing);await left.query('commit');await assert.rejects(competing,error=>error.code==='40001')
 })
 await check('Revocation waits for in-flight scoring, then blocks later scoring',async()=>{
  await actor(left,a);await rpc(left,'upload_practice',operation(a,pa,ta))
  const revoke=(async()=>{await actor(right,admin,'service_role');await right.query("select public.account_action($1,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:false,teamIds:[]})]);await right.query('commit')})()
  await blocked(revoke);await left.query('commit');await revoke
  await actor(left,a);await assert.rejects(rpc(left,'upload_practice',operation(a,pa,ta)),error=>error.code==='42501');await left.query('rollback')
  await operator.query("select public.account_action($1,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:true,teamIds:[ta]})])
 })
 await check('Scoring waits for an uncommitted revocation and then rechecks access',async()=>{
  await actor(left,admin,'service_role');await left.query("select public.account_action($1,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:false,teamIds:[]})])
  const upload=(async()=>{await actor(right,a);return rpc(right,'upload_practice',operation(a,pa,ta))})()
  await blocked(upload);await left.query('commit');await assert.rejects(upload,error=>error.code==='42501');await right.query('rollback')
  await operator.query("select public.account_action($1,'update',$2::jsonb)",[admin,JSON.stringify({id:a,active:true,teamIds:[ta]})])
 })
 await check('Delete tombstones fence an already-acknowledged delta retry',async()=>{
  const first=operation(a,pa,ta,{events:0});await actor(left,a);await rpc(left,'upload_practice',first);await left.query('commit')
  const end={id:randomUUID(),sessionId:first.sessionId,expectedRevision:1,session:{...first.session,revision:2,nextSequence:2,status:'ended',endedAt:new Date().toISOString()},baseEventCount:0,voidedEvents:[],appendEvents:[{id:randomUUID(),sessionId:first.sessionId,pitcherId:pa,appearanceId:first.session.initialAppearanceId,nextAppearanceId:randomUUID(),sequence:1,timestamp:new Date().toISOString(),kind:'end',voidedAt:null}]}
  await actor(left,a);await rpc(left,'upload_practice_delta',end);await left.query('commit')
  await actor(left,admin);await left.query("select public.manage('deleteRecord',$1::jsonb)",[JSON.stringify({kind:'session',id:first.sessionId,confirmation:first.session.name})])
  const retry=(async()=>{await actor(right,a);return rpc(right,'upload_practice_delta',end)})()
  await blocked(retry);await left.query('commit');await assert.rejects(retry,error=>error.code==='40001')
  assert.equal((await operator.query('select count(*)::integer n from public.practices where id=$1',[first.sessionId])).rows[0].n,0)
 })
 const tc=await team(operator,'Shared',[a,b]),p1=await pitcher(operator,a,[tc]),p2=await pitcher(operator,b,[tc])
 const player1=await identity(operator,'Player 1','player',p1),player2=await identity(operator,'Player 2','player',p2)
 await check('Different players can save activities concurrently',async()=>{
  const activity=pid=>({id:randomUUID(),expectedRevision:0,record:{id:randomUUID(),pitcherId:pid,kind:'checkin',data:{date:new Date().toISOString().slice(0,10),action:'warmup'}}})
  await actor(left,player1);await left.query("select public.manage('saveAchievementRecord',$1::jsonb)",[JSON.stringify(activity(p1))])
  const other=(async()=>{await actor(right,player2);await right.query("select public.manage('saveAchievementRecord',$1::jsonb)",[JSON.stringify(activity(p2))]);await right.query('commit')})()
  await within(other);await left.query('commit')
 })
 await check('Worker claims skip locked jobs and never claim the same player',async()=>{
  await actor(left,null,'service_role');await actor(right,null,'service_role')
  const a=(await left.query('select public.achievement_claim(null,1) jobs')).rows[0].jobs
  const b=(await within(right.query('select public.achievement_claim(null,1) jobs'))).rows[0].jobs
  assert.equal(a.length,1);assert.equal(b.length,1);assert.notEqual(a[0].pitcher_id,b[0].pitcher_id)
  await left.query('commit');await right.query('commit')
 })
 await check('Foreground claims use only the requested player and skip a competing claim',async()=>{
  await operator.query('update public.achievement_jobs set lease_token=null,leased_until=null')
  await actor(left,null,'service_role');await actor(right,null,'service_role')
  await left.query('set local plan_cache_mode=force_generic_plan');await right.query('set local plan_cache_mode=force_generic_plan')
  const own=(await left.query('select public.achievement_claim($1,25) jobs',[p1])).rows[0].jobs
  assert.equal(own.length,1);assert.equal(own[0].pitcher_id,p1)
  const competing=(await within(right.query('select public.achievement_claim($1,25) jobs',[p1]))).rows[0].jobs
  assert.deepEqual(competing,[])
  const independent=(await within(right.query('select public.achievement_claim($1,25) jobs',[p2]))).rows[0].jobs
  assert.equal(independent.length,1);assert.equal(independent[0].pitcher_id,p2)
  await left.query('commit');await right.query('commit')
 })
 await check('A source write waiting for idle completion always wakes the job after commit',async()=>{
  await operator.query('update public.achievement_jobs set lease_token=null,leased_until=null,next_evaluate_at=now() where pitcher_id=$1',[p1])
  await actor(left,null,'service_role')
  const job=(await left.query('select public.achievement_claim($1,1) jobs',[p1])).rows[0].jobs[0]
  const done=await left.query('select public.achievement_finish_scheduled($1,$2,$3,\'[]\',false,now()) done',[p1,job.revision,job.lease_token])
  assert.equal(done.rows[0].done,true)
  const activity={id:randomUUID(),expectedRevision:0,record:{id:randomUUID(),pitcherId:p1,kind:'checkin',data:{date:new Date().toISOString().slice(0,10),action:'warmup'}}}
  const changed=(async()=>{await actor(right,player1);await right.query("select public.manage('saveAchievementRecord',$1::jsonb)",[JSON.stringify(activity)]);await right.query('commit')})()
  await blocked(changed);await left.query('commit');await changed
  const pending=(await operator.query('select revision>processed_revision pending,next_evaluate_at<=now() due from public.achievement_jobs where pitcher_id=$1',[p1])).rows[0]
  assert.deepEqual(pending,{pending:true,due:true})
 })
 await check('Rules refresh skips locked jobs without losing them or requeuing a cutoff twice',async()=>{
  await operator.query("update public.achievement_jobs set rules_requested_at=now()-interval '1 day',next_evaluate_at='infinity'")
  const cutoff=(await operator.query('select clock_timestamp()::text cutoff')).rows[0].cutoff
  await actor(left,null,'service_role');await left.query('select pitcher_id from public.achievement_jobs where pitcher_id=$1 for update',[p1])
  const partial=(await within(operator.query('select public.achievement_requeue_rules($1,1000) result',[cutoff]))).rows[0].result
  assert.equal(partial.remaining,true);assert.ok(partial.updated>=1)
  const locked=(await within(operator.query('select public.achievement_requeue_rules($1,1000) result',[cutoff]))).rows[0].result
  assert.deepEqual(locked,{updated:0,remaining:true})
  await left.query('commit')
  const final=(await operator.query('select public.achievement_requeue_rules($1,1000) result',[cutoff])).rows[0].result
  assert.deepEqual(final,{updated:1,remaining:false})
  assert.deepEqual((await operator.query('select public.achievement_requeue_rules($1,1000) result',[cutoff])).rows[0].result,{updated:0,remaining:false})
 })
 await check('Reversed participant order cannot deadlock dirty-job updates',async()=>{
  await operator.query(`create function public.native_race_yield()returns trigger language plpgsql as $$begin if current_setting('pitchwork.native_race',true)='on' then perform pg_sleep(0.02);end if;return new;end $$;
  create trigger native_race_yield before update on public.achievement_jobs for each row execute function public.native_race_yield()`)
  for(let i=0;i<6;i++)await Promise.all([[left,a,p1,[p1,p2]],[right,b,p2,[p2,p1]]].map(async([client,coach,pid,ids])=>{
   await actor(client,coach);await client.query("select set_config('pitchwork.native_race','on',true)");await rpc(client,'upload_practice',operation(coach,pid,tc,{events:0,pitcherIds:ids}));await client.query('commit')
  }))
 })
 await check('Concurrent rate limits keep every denied attempt counted',async()=>{
  const bucket=`native:${randomUUID()}`
  const allowed=await Promise.all(Array.from({length:100},()=>db.query('select public.onboarding_limit($1,20) allowed',[bucket])))
  assert.equal(allowed.filter(r=>r.rows[0].allowed).length,20)
  assert.equal((await operator.query('select attempts from public.request_limits where bucket=$1',[bucket])).rows[0].attempts,100)
 })
 await check('Rate expiry skips locked buckets and remains bounded without dropping current attempts',async()=>{
  const prefix=`expired:${randomUUID()}:`,current=`active:${randomUUID()}`
  await operator.query("insert into public.request_limits select $1||n,now()-interval '3 hours',1 from generate_series(1,200)n",[prefix])
  await actor(left,null,'service_role');await left.query('select bucket from public.request_limits where bucket=$1 for update',[prefix+'1'])
  const allowed=await within(operator.query('select public.onboarding_limit($1,1) allowed',[current]));assert.equal(allowed.rows[0].allowed,true)
  const remaining=Number((await operator.query('select count(*) n from public.request_limits where bucket like $1',[prefix+'%'])).rows[0].n)
  assert.equal(remaining,136);assert.equal((await operator.query('select attempts from public.request_limits where bucket=$1',[current])).rows[0].attempts,1)
  await left.query('commit');assert.equal((await operator.query('select public.onboarding_limit($1,1) allowed',[current])).rows[0].allowed,false)
  assert.equal((await operator.query('select attempts from public.request_limits where bucket=$1',[current])).rows[0].attempts,2)
 })
 await check('Anonymous and player roles retain private-worker boundaries',async()=>{
  await actor(left,null,'anon');await assert.rejects(left.query('select public.get_workspace_page()'),error=>error.code==='42501');await left.query('rollback')
  await actor(left,player1);await assert.rejects(left.query("select public.achievement_finish_scheduled($1,1,gen_random_uuid(),'[]',false,now())",[p1]),error=>error.code==='42501');await left.query('rollback')
  await actor(left,player1);await assert.rejects(left.query('select public.achievement_requeue_rules(now(),1000)'),error=>error.code==='42501');await left.query('rollback')
  await actor(left,player1);await assert.rejects(left.query('select public.achievement_claim(null,1)'),error=>error.code==='42501')
 })
 const version=(await operator.query('select version()')).rows[0].version
 await mkdir('.test-artifacts',{recursive:true});await writeFile('.test-artifacts/postgres-concurrency.json',JSON.stringify({version,results,passed:true,note:'Real PostgreSQL 17 connections using app SQL roles. This does not include hosted Auth, Edge Functions, CDN or production hardware.'},null,2))
 console.log(`Passed ${results.length} real PostgreSQL concurrency and authorization checks.`)
}catch(error){console.error(error.message);process.exitCode=1}
finally {
 for(const client of [left,right,operator])if(client){await client.query('rollback').catch(()=>{});client.release()}
 if(db)await db.end()
 if(created){assert.match(database,/^pitchwork_scale_check_[a-f0-9]{32}$/);await root.query(`drop database ${database}`)}
 await root.end()
}
