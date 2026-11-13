// Creates only a labeled, localhost-bound disposable test instance. No production
// connection settings are read, and credentials never appear in command arguments.
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
const exec=promisify(execFile),name='pitchwork-scale-postgres',image='postgres:17.11-alpine'
const action=process.argv[2]??'start'
if(!['start','stop'].includes(action))throw new Error('Use start or stop.')
async function docker(args,timeout=120000) {return (await exec('docker',args,{timeout,maxBuffer:2*1024*1024})).stdout.trim()}
let existing
try{existing=JSON.parse(await docker(['inspect',name]))[0]}catch(error){if(!error.stderr?.includes('No such object'))throw new Error('Docker is unavailable. Start Docker Desktop before the local tests.')}
if(existing && (existing.Config.Labels?.['pitchwork.test']!=='scale'||existing.HostConfig.PortBindings?.['5432/tcp']?.[0]?.HostIp!=='127.0.0.1'||existing.HostConfig.PortBindings?.['5432/tcp']?.[0]?.HostPort!=='55432'))throw new Error('The named container is not the isolated test instance.')
if(action==='stop') {
 if(existing?.State.Running)await docker(['stop',name])
 console.log('The isolated local database is stopped; test data is preserved.')
}else {
 await mkdir('.test-artifacts',{recursive:true})
 let config
 try{config=JSON.parse(await readFile('.test-artifacts/scale-postgres.json','utf8'))}catch(error){
  if(error.code!=='ENOENT'||existing)throw new Error('The private local test configuration is missing or invalid.')
  config={host:'127.0.0.1',port:55432,database:'pitchwork_scale',user:'postgres',password:randomBytes(32).toString('hex')}
  await writeFile('.test-artifacts/scale-postgres.json',JSON.stringify(config),{mode:0o600})
  await writeFile('.test-artifacts/scale-postgres.env',`POSTGRES_DB=pitchwork_scale\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${config.password}\nPOSTGRES_INITDB_ARGS=--data-checksums --auth-host=scram-sha-256\n`,{mode:0o600})
 }
 if(config.host!=='127.0.0.1'||config.port!==55432||config.database!=='pitchwork_scale'||!config.password)throw new Error('Invalid local test configuration.')
 if(!existing) {
  const cpus=process.env.PITCHWORK_NATIVE_CPUS??'4',memory=process.env.PITCHWORK_NATIVE_MEMORY??'8g'
  if(!/^[1-8]$/.test(cpus)||!/^([2-9]|1[0-6])g$/.test(memory))throw new Error('Invalid local resource limits.')
  await docker(['run','--name',name,'--label','pitchwork.test=scale','--restart','no','--publish','127.0.0.1:55432:5432','--mount','type=volume,source=pitchwork-scale-pg17,target=/var/lib/postgresql/data','--memory',memory,'--cpus',cpus,'--shm-size','256m','--env-file','.test-artifacts/scale-postgres.env','--detach',image,'-c','max_connections=160','-c','shared_buffers=512MB','-c','effective_cache_size=3GB','-c','wal_compression=on','-c','max_wal_size=4GB','-c','checkpoint_timeout=15min','-c','log_statement=none','-c','log_min_error_statement=panic'],300000)
 }else if(!existing.State.Running)await docker(['start',name])
 let ready=false
 for(let attempt=0;attempt<30;attempt++) {
  try{await docker(['exec',name,'pg_isready','-U','postgres','-d','pitchwork_scale'],5000);ready=true;break}catch{await delay(1000)}
 }
 if(!ready)throw new Error('The local database did not become ready.')
 console.log('Isolated PostgreSQL 17 is ready on localhost:55432. Credentials are in the ignored test directory.')
}
