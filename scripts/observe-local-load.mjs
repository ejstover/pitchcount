// Operator-only observations of the isolated full local stack. Never emits keys,
// tokens, request bodies, connection strings or complete container environments.
import pg from 'pg'
import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
const exec=promisify(execFile),seconds=Number(process.env.PITCHWORK_OBSERVE_SECONDS??180)
if(!Number.isInteger(seconds)||seconds<30||seconds>7200)throw new Error('Invalid observation duration')
const settings=JSON.parse(await readFile('.test-artifacts/full-stack-status.json','utf8')),url=new URL(settings.DB_URL)
if(settings.API_URL!=='http://127.0.0.1:53421'||url.hostname!=='127.0.0.1'||url.port!=='53422'||url.pathname!=='/postgres')throw new Error('Only the isolated localhost stack is allowed')
const names=['db','kong','auth','rest','edge_runtime'].map(name=>`supabase_${name}_pitchwork-scale-api`)
const replica='supabase_rest_replica_pitchwork-scale-api'
if((await exec('docker',['ps','--filter',`name=^/${replica}$`,'--format','{{.Names}}'],{windowsHide:true})).stdout.trim()===replica)names.push(replica)
const inspect=JSON.parse((await exec('docker',['inspect',...names],{windowsHide:true,maxBuffer:4*1024*1024})).stdout)
const containers=inspect.map(c=>({name:c.Name,image:c.Config.Image,imageId:c.Image,cpuQuota:c.HostConfig.NanoCpus,memoryBytes:c.HostConfig.Memory,
 settings:c.Config.Env.filter(e=>/^(GHCRTS|PGRST_DB_POOL)=/.test(e)),ports:c.NetworkSettings.Ports}))
for(const c of containers)for(const bindings of Object.values(c.ports??{}))for(const binding of bindings??[])if(binding.HostIp!=='127.0.0.1')throw new Error('Non-loopback publication detected')
const client=new pg.Client({connectionString:settings.DB_URL,application_name:'pitchwork-local-observer',connectionTimeoutMillis:10000})
await client.connect()
try {
 const database=(await client.query(`select version(),pg_database_size(current_database()) bytes,
 current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous_commit,current_setting('full_page_writes') full_page_writes,
 current_setting('max_connections') max_connections,current_setting('shared_buffers') shared_buffers,current_setting('session_replication_role') trigger_mode`)).rows[0]
 if(database.fsync!=='on'||database.synchronous_commit!=='on'||database.full_page_writes!=='on'||database.trigger_mode!=='origin')throw new Error('Durability/trigger requirements were changed')
 const migrations=(await client.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(r=>r.version)
 const host={cpuModel:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,memoryBytes:os.totalmem(),sharedWithGenerator:true}
 const report={startedAt:new Date().toISOString(),host,containers,database,migrations,samples:[]},deadline=Date.now()+seconds*1000
 while(Date.now()<deadline){
  const [stats,activity,api,replicaApi]=await Promise.all([
   exec('docker',['stats','--no-stream','--format','{{json .}}',...names],{windowsHide:true}),
   client.query(`select state,wait_event_type,wait_event,
    case when query like '%achievement_claim%' then 'claim' when query like '%achievement_input%' then 'input'
     when query like '%achievement_finish%' then 'finish' when query like '%get_workspace_state%' then 'workspaceState'
     when query like '%get_workspace_page%' then 'workspacePage' when query like '%upload_practice%' then 'upload' else 'other' end kind,count(*)
    from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() group by 1,2,3,4 order by count(*) desc`),
   exec('docker',['exec','supabase_kong_pitchwork-scale-api','sh','-c',"wget -qO- http://supabase_rest_pitchwork-scale-api:3001/metrics | grep -E '^(pgrst_db_pool|ghc_)'"],{windowsHide:true}),
   names.includes(replica)?exec('docker',['exec','supabase_kong_pitchwork-scale-api','sh','-c',"wget -qO- http://supabase_rest_replica_pitchwork-scale-api:3001/metrics | grep -E '^(pgrst_db_pool|ghc_)'"],{windowsHide:true}):Promise.resolve({stdout:''})
  ])
  const apiMetrics=Object.fromEntries(api.stdout.trim().split('\n').filter(Boolean).map(line=>{const [name,value]=line.trim().split(/\s+/);return [name,Number(value)]}))
  const replicaMetrics=Object.fromEntries(replicaApi.stdout.trim().split('\n').filter(Boolean).map(line=>{const [name,value]=line.trim().split(/\s+/);return [name,Number(value)]}))
  const sample={at:new Date().toISOString(),services:stats.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),activity:activity.rows,apiMetrics,replicaMetrics}
  report.samples.push(sample)
  await writeFile(process.env.PITCHWORK_OBSERVE_OUTPUT??'.test-artifacts/local-load-observations.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify({at:sample.at,services:sample.services.map(s=>({name:s.Name,cpu:s.CPUPerc,memory:s.MemUsage}))}))
  await delay(Math.max(0,Math.min(8000,deadline-Date.now())))
 }
}finally{await client.end()}
