// Run the official CLI through a private local Docker pipe which enforces
// loopback publication before container creation. The CLI explicitly overrides
// Docker bridge defaults, so a bridge option alone is insufficient.
import http from 'node:http'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID,randomBytes} from 'node:crypto'
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
const exec=promisify(execFile),project='pitchwork-scale-api',root='.test-artifacts/full-stack'
if(process.platform!=='win32')throw new Error('This local named-pipe launcher requires Windows Docker Desktop.')
const npmCli=process.env.npm_execpath
if(!npmCli)throw new Error('Run with npm run supabase:local:start or supabase:local:stop.')
const action=process.argv[2]??'start'
if(!['start','stop'].includes(action))throw new Error('Use start or stop.')
if(action==='stop')await exec(process.execPath,['scripts/local-api-replica.mjs','stop'],{windowsHide:true})
await mkdir(`${root}/supabase`,{recursive:true})
let secrets
try{secrets=JSON.parse(await readFile(`${root}/secrets.json`,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;secrets={rateSalt:randomBytes(32).toString('hex'),workerSecret:randomBytes(32).toString('hex')};await writeFile(`${root}/secrets.json`,JSON.stringify(secrets),{mode:0o600})}
if(!/^[a-f0-9]{64}$/.test(secrets.rateSalt)||!/^[a-f0-9]{64}$/.test(secrets.workerSecret))throw new Error('Invalid private local test secrets.')
if(!secrets.accountProxySecret){secrets.accountProxySecret=randomBytes(32).toString('hex');await writeFile(`${root}/secrets.json`,JSON.stringify(secrets),{mode:0o600})}
if(!/^[a-f0-9]{64}$/.test(secrets.accountProxySecret))throw new Error('Invalid private local account proxy secret.')
if(action==='start') {
 let config=await readFile('supabase/config.toml','utf8')
 config=config.replace('project_id = "pitchwork"',`project_id = "${project}"`).replace('http://127.0.0.1:54321/auth/v1/callback','http://127.0.0.1:53421/auth/v1/callback')
 config+='\n[api]\nport=53421\nmax_rows=1000\nschemas=["public"]\n[db]\nport=53422\nshadow_port=53420\nmajor_version=17\n[db.seed]\nenabled=false\n[studio]\nenabled=false\n[realtime]\nenabled=false\n[storage]\nenabled=false\n[analytics]\nenabled=false\n[local_smtp]\nenabled=true\nport=53424\n[edge_runtime]\nenabled=true\ninspector_port=8343\n'
 config+='\n[edge_runtime.secrets]\nREQUEST_RATE_SALT="env(PITCHWORK_LOCAL_RATE_SALT)"\nACHIEVEMENT_WORKER_SECRET="env(PITCHWORK_LOCAL_WORKER_SECRET)"\n'
 config+='PITCHWORK_STAGE_TIMING="1"\n'
 config+='ACCOUNT_PROXY_SECRET="env(PITCHWORK_LOCAL_ACCOUNT_PROXY_SECRET)"\n'
 if(!config.includes(`project_id = "${project}"`))throw new Error('Unexpected source project configuration.')
 await writeFile(`${root}/supabase/config.toml`,config)
 for(const path of ['supabase/migrations','supabase/functions','supabase/templates','src'])await cp(path,`${root}/${path}`,{recursive:true,force:true,filter:source=>!/(^|[\\/])(\.env(?:\.[^\\/]*)?|\.git|\.temp|node_modules)([\\/]|$)/.test(source)})
}
const target=(await exec('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{windowsHide:true})).stdout.trim()
if(!/^npipe:\/\/\/\/\.\/pipe\/(dockerDesktopLinuxEngine|docker_engine)$/.test(target))throw new Error('A local Docker Desktop engine is required.')
const engine='\\\\.\\pipe\\'+target.split('/').at(-1),pipe='\\\\.\\pipe\\pitchwork-scale-'+randomUUID(),sockets=new Set()
const server=http.createServer(async(req,res)=>{
 try {
  let body
  if(req.method==='POST' && /\/containers\/create(?:\?|$)/.test(req.url)) {
   const chunks=[];let bytes=0
   for await(const chunk of req){bytes+=chunk.length;if(bytes>2097152)throw new Error('Unexpected container definition size');chunks.push(chunk)}
   const spec=JSON.parse(Buffer.concat(chunks)),name=new URL(req.url,'http://docker').searchParams.get('name')
   if(!name?.startsWith('supabase_')||!name.endsWith(`_${project}`))throw new Error('Refusing to create an unrelated container')
   if(spec.HostConfig?.PublishAllPorts)throw new Error('Unbounded port publication is forbidden')
   for(const bindings of Object.values(spec.HostConfig?.PortBindings??{}))for(const binding of bindings??[])binding.HostIp='127.0.0.1'
   if(name===`supabase_db_${project}`){spec.HostConfig.NanoCpus=8000000000;spec.HostConfig.CpuPeriod=0;spec.HostConfig.CpuQuota=0;spec.HostConfig.Memory=17179869184;spec.HostConfig.MemorySwap=17179869184}
   // Reserve scheduling capacity for the other services on this 12-CPU host.
   if(name===`supabase_rest_${project}`){spec.Env=(spec.Env??[]).filter(entry=>!['GHCRTS=','PGRST_SERVER_TIMING_ENABLED=','PGRST_DB_POOL=','PGRST_ADMIN_SERVER_PORT='].some(prefix=>entry.startsWith(prefix)));spec.Env.push('GHCRTS=-N2 -T','PGRST_SERVER_TIMING_ENABLED=true','PGRST_DB_POOL=32','PGRST_ADMIN_SERVER_PORT=3001')}
   if(name===`supabase_kong_${project}`){
    const settings={KONG_NGINX_WORKER_PROCESSES:'2'}
    spec.Env=(spec.Env??[]).filter(entry=>!Object.keys(settings).some(key=>entry.startsWith(key+'=')))
    for(const [key,value]of Object.entries(settings))spec.Env.push(`${key}=${value}`)
    // The CLI supplies a custom template which omits Kong's events/main
    // injections. Change only its connection directives, failing on template drift.
    const marker='events {\n    multi_accept on;'
    if(!Array.isArray(spec.Cmd)||spec.Cmd.filter(part=>part.includes(marker)).length!==1)throw new Error('Unexpected local gateway template')
    spec.Cmd=spec.Cmd.map(part=>part.replace(marker,'worker_rlimit_nofile 16384;\n\nevents {\n    worker_connections 8192;\n    multi_accept on;'))
   }
   body=Buffer.from(JSON.stringify(spec))
  }
  const headers={...req.headers};if(body){headers['content-length']=String(body.length);delete headers['transfer-encoding']}
  const upstream=http.request({socketPath:engine,path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)})
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Local Docker connection failed')})
  if(body)upstream.end(body);else req.pipe(upstream)
 }catch{res.writeHead(400);res.end('Isolated Docker request rejected')}
})
// Docker exec uses an HTTP upgrade for its binary stdin/stdout stream.
server.on('upgrade',(req,socket,head)=>{
 socket.pause();const length=Number(req.headers['content-length']??0);let buffered=head,started=false
 function forward() {
  if(started||buffered.length<length)return
  started=true;socket.removeListener('data',collect);socket.pause()
  const body=buffered.subarray(0,length),tail=buffered.subarray(length)
  const upstream=http.request({socketPath:engine,path:req.url,method:req.method,headers:req.headers})
  upstream.on('upgrade',(reply,peer,remainder)=>{
   socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${Object.entries(reply.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
   if(remainder.length)socket.write(remainder);if(tail.length)peer.write(tail)
   socket.pipe(peer);peer.pipe(socket);socket.resume();peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy())
  })
  upstream.on('response',reply=>{socket.end(`HTTP/1.1 ${reply.statusCode} Docker error\r\nConnection: close\r\n\r\n`);reply.resume()})
  upstream.on('error',()=>socket.destroy());upstream.end(body)
 }
 function collect(chunk){buffered=Buffer.concat([buffered,chunk]);forward()}
 socket.on('data',collect);forward();if(!started)socket.resume()
})
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve)})
const env={...process.env,DOCKER_HOST:'npipe:////./pipe/'+pipe.split('\\').at(-1),DO_NOT_TRACK:'1',PITCHWORK_LOCAL_RATE_SALT:secrets.rateSalt,PITCHWORK_LOCAL_WORKER_SECRET:secrets.workerSecret,PITCHWORK_LOCAL_ACCOUNT_PROXY_SECRET:secrets.accountProxySecret}
delete env.DOCKER_CONTEXT
const log=createWriteStream(`${root}/${action}.log`,{mode:0o600})
try {
 const args=[npmCli,'exec','--offline','--yes','--package=supabase@3.1.0','--','supabase',action,'--workdir',root,'--network-id','pitchwork-scale-api']
 if(action==='start')args.push('--exclude','realtime,storage-api,imgproxy,postgres-meta,studio,logflare,vector,supavisor')
 const child=spawn(process.execPath,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
 if(code!==0)throw new Error(`Local stack ${action} failed; inspect the ignored private ${action}.log.`)
 if(action==='start') {
  const names=(await exec('docker',['ps','--filter',`name=${project}`,'--format','{{.Names}}'],{windowsHide:true})).stdout.trim().split(/\r?\n/).filter(Boolean)
  if(!names.length)throw new Error('No local stack containers started.')
  const containers=JSON.parse((await exec('docker',['inspect',...names],{windowsHide:true,maxBuffer:2097152})).stdout)
  let unsafe=false
  for(const c of containers)for(const bindings of Object.values(c.HostConfig.PortBindings??{}))for(const binding of bindings??[])if(binding.HostIp!=='127.0.0.1')unsafe=true
  if(unsafe){await exec('docker',['stop',...names],{windowsHide:true});throw new Error('A test service was not bound to localhost; the isolated stack was stopped.')}
  const status=await exec(process.execPath,[npmCli,'exec','--offline','--yes','--package=supabase@3.1.0','--','supabase','status','--output','json','--workdir',root],{env,windowsHide:true})
  const settings=JSON.parse(status.stdout)
  if(settings.API_URL!=='http://127.0.0.1:53421')throw new Error('Unexpected local API address')
  await writeFile('.test-artifacts/full-stack-status.json',JSON.stringify(settings),{mode:0o600})
  const deadline=Date.now()+60000;let ready=0
  while(Date.now()<deadline && ready<3){
   try {
    const headers={apikey:settings.PUBLISHABLE_KEY,authorization:'Bearer invalid-readiness-token'}
    const health=await fetch(settings.API_URL+'/auth/v1/health',{headers,signal:AbortSignal.timeout(2000)});await health.arrayBuffer()
    const account=await fetch(settings.API_URL+'/functions/v1/accounts',{headers,signal:AbortSignal.timeout(2000)})
    const body=await account.json()
    const achievement=await fetch(settings.API_URL+'/functions/v1/achievements',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)})
    const award=await achievement.json()
    ready=health.ok&&account.status===401&&body.code==='reauth'&&achievement.status===401&&award.error==='Sign in again'?ready+1:0
   }catch{ready=0}
   if(ready<3)await delay(250)
  }
  if(ready<3)throw new Error('Local services did not become ready; inspect the private service logs')
 }
 console.log(`Isolated Supabase ${action} completed. Generated credentials remain in the ignored private log.`)
}finally{log.end();for(const socket of sockets)socket.destroy();server.close()}
