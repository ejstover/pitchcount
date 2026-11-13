// Temporary synthetic queue only. Verify the deployed global candidate shape
// still uses its ordered index when most accounts have no scheduled work.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import pg from 'pg'
const settings=JSON.parse(await readFile('.test-artifacts/full-stack-status.json','utf8')),url=new URL(settings.DB_URL)
assert.equal(settings.API_URL,'http://127.0.0.1:53421');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'53422');assert.equal(url.pathname,'/postgres')
const rows=Number(process.env.PITCHWORK_QUEUE_PROBE_ROWS??500000)
assert.ok(Number.isInteger(rows)&&rows>=10000&&rows<=1000000)
const db=new pg.Client({connectionString:settings.DB_URL,application_name:'pitchwork-temporary-queue-probe'})
await db.connect()
try {
 const definition=(await db.query("select pg_get_functiondef('public.achievement_claim(uuid,integer)'::regprocedure) definition")).rows[0].definition
 assert.ok(definition.replace(/\s/g,'').includes('wherenext_evaluate_at<=now()and(leased_untilisnullorleased_until<now())orderbynext_evaluate_at,requested_at,pitcher_idlimitp_limitforupdateskiplocked'),'Global candidate query changed; update the probe deliberately.')
 await db.query(`create temporary table pitchwork_queue_probe as
  select md5('idle-queue:'||n)::uuid pitcher_id,now() requested_at,'infinity'::timestamptz next_evaluate_at,null::timestamptz leased_until from generate_series(1,$1::integer)n`,[rows])
 await db.query('create index pitchwork_queue_probe_due on pitchwork_queue_probe(next_evaluate_at,requested_at,pitcher_id)')
 await db.query('analyze pitchwork_queue_probe')
 await db.query('set plan_cache_mode=force_generic_plan')
 await db.query(`prepare pitchwork_queue_probe_claim(integer) as select pitcher_id from pg_temp.pitchwork_queue_probe
  where next_evaluate_at<=now() and (leased_until is null or leased_until<now())
  order by next_evaluate_at,requested_at,pitcher_id limit $1 for update skip locked`)
 const scenarios=[]
 async function check(name,expected){
  const data=(await db.query('explain(analyze,buffers,format json) execute pitchwork_queue_probe_claim(1)')).rows[0]['QUERY PLAN'][0]
  const nodes=[];function walk(plan){nodes.push({type:plan['Node Type'],index:plan['Index Name'],actualRows:plan['Actual Rows'],rowsRemoved:plan['Rows Removed by Filter']??0});for(const child of plan.Plans??[])walk(child)}walk(data.Plan)
  assert.equal(data.Plan['Actual Rows'],expected)
  assert.ok(nodes.some(n=>n.index==='pitchwork_queue_probe_due'))
  assert.ok(!nodes.some(n=>n.type==='Seq Scan'||n.type==='Sort'))
  scenarios.push({name,executionMs:data['Execution Time'],nodes})
 }
 await check('all accounts asleep',0)
 await db.query('update pg_temp.pitchwork_queue_probe set next_evaluate_at=now() where pitcher_id=(select pitcher_id from pg_temp.pitchwork_queue_probe order by pitcher_id limit 1)')
 await db.query('analyze pitchwork_queue_probe')
 await check('one due account among sleeping accounts',1)
 const report={completedAt:new Date().toISOString(),rows,sourceDefinitionHash:createHash('sha256').update(definition).digest('hex'),scenarios,passed:true,note:'Temporary synthetic candidate selection, forced generic plan, real local PostgreSQL. Public queue/source data is unchanged. This does not measure complete worker throughput or hosted capacity.'}
 await writeFile('.test-artifacts/idle-queue-benchmark.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}finally{await db.end()}
