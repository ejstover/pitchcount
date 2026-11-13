// Optional stateless API replica for the isolated local stack. Credentials stay
// in memory and travel over Docker's local pipe, never command-line arguments.
import http from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile),project='pitchwork-scale-api',primaryName=`supabase_rest_${project}`,name=`supabase_rest_replica_${project}`
const action=process.argv[2]??'start'
if(process.platform!=='win32'||!['start','stop'].includes(action))throw new Error('Use start/stop with the Windows localhost stack')
const host=(await exec('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{windowsHide:true})).stdout.trim()
if(!/^npipe:\/\/\/\/\.\/pipe\/(dockerDesktopLinuxEngine|docker_engine)$/.test(host))throw new Error('Only local Docker Desktop is allowed')
const socketPath='\\\\.\\pipe\\'+host.split('/').at(-1)
function api(method,path,value){return new Promise((resolve,reject)=>{
 const body=value===undefined?undefined:Buffer.from(JSON.stringify(value))
 const request=http.request({socketPath,method,path,headers:body?{'content-type':'application/json','content-length':String(body.length)}:{}},response=>{
  const parts=[];response.on('data',chunk=>parts.push(chunk));response.on('end',()=>{
   if(response.statusCode<200||response.statusCode>=300){reject(new Error(`Local replica operation failed (${response.statusCode})`));return}
   const text=Buffer.concat(parts).toString();resolve(text?JSON.parse(text):null)
  })
 });request.on('error',()=>reject(new Error('Local Docker connection unavailable')));request.end(body)
})}
const list=await api('GET','/containers/json?all=1'),existing=list.find(c=>c.Names.includes('/'+name))
if(existing && existing.Labels?.['pitchwork.local-replica']!=='1')throw new Error('An unrelated container owns the replica name')
if(action==='stop'){
 if(existing){if(existing.State==='running')await api('POST',`/containers/${existing.Id}/stop?t=10`);await api('DELETE',`/containers/${existing.Id}`)}
 if(existing&&list.some(c=>c.Names.includes(`/supabase_kong_${project}`)&&c.State==='running')){
  await exec('docker',['exec',`supabase_kong_${project}`,'sh','-c',`sed -i 's#http://rest:3000#http://${primaryName}:3000#g' /home/kong/kong.yml`],{windowsHide:true})
  await exec('docker',['restart',`supabase_kong_${project}`],{windowsHide:true})
 }
 console.log('Optional local API replica stopped; database volumes preserved.')
}else{
 if(existing)throw new Error('Replica already exists; stop it before changing configuration')
 const primary=await api('GET',`/containers/${primaryName}/json`)
 if(primary.Name!=='/'+primaryName||primary.State.Status!=='running'||primary.Mounts.length!==0||Object.keys(primary.HostConfig.PortBindings??{}).length!==0||Object.keys(primary.NetworkSettings.Networks).join(',')!==project)throw new Error('Unexpected primary API configuration')
 const spec={Image:primary.Image,Env:primary.Config.Env,Cmd:primary.Config.Cmd,Entrypoint:primary.Config.Entrypoint,User:primary.Config.User,WorkingDir:primary.Config.WorkingDir,
  Labels:{...primary.Config.Labels,'pitchwork.local-replica':'1'},ExposedPorts:primary.Config.ExposedPorts,
  HostConfig:{NetworkMode:project,NanoCpus:2000000000,Memory:2147483648,MemorySwap:2147483648,PortBindings:{}},
  NetworkingConfig:{EndpointsConfig:{[project]:{Aliases:primary.NetworkSettings.Networks[project].Aliases??['rest']}}}}
 const created=await api('POST','/containers/create?name='+encodeURIComponent(name),spec)
 await api('POST',`/containers/${created.Id}/start`)
 await exec('docker',['exec',`supabase_kong_${project}`,'sh','-c',`sed -i 's#http://${primaryName}:3000#http://rest:3000#g' /home/kong/kong.yml`],{windowsHide:true})
 await exec('docker',['restart',`supabase_kong_${project}`],{windowsHide:true})
 console.log('Optional local API replica started with the same image/security configuration and no host ports. Combined API pool limit: 64 of 100 database connections.')
}
