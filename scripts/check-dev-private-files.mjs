// Only public synthetic canaries are fetched. Never probe actual credentials.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile,unlink} from 'node:fs/promises'
import {resolve} from 'node:path'
import {createServer,resolveConfig} from 'vite'
const nonce='pitchwork-synthetic-'+randomUUID(),name='private-canary-'+randomUUID()+'.txt'
const files=[resolve('.test-artifacts',name),resolve('.env.pitchwork-canary-'+randomUUID()),resolve('.dev.vars.canary-'+randomUUID())]
const created=[]
let server
try {
 await mkdir('.test-artifacts',{recursive:true})
 for(const path of files){await writeFile(path,nonce,{flag:'wx'});created.push(path)}
 const defaults=await resolveConfig({configFile:false,logLevel:'silent'},'serve')
 server=await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:5292,strictPort:true}})
 for(const pattern of defaults.server.fs.deny)assert.ok(server.config.server.fs.deny.includes(pattern),'An upgraded Vite default deny rule is missing')
 await server.listen()
 const base='http://127.0.0.1:5292',results=[]
 for(const path of files){
  const relative=path.slice(resolve('.').length).replaceAll('\\','/')
  const routes=[relative,relative+'?raw','/@fs/'+path.replaceAll('\\','/')]
  if(process.platform==='win32')routes.push(relative.toUpperCase())
  for(const route of new Set(routes)){
   const response=await fetch(base+route),body=await response.text()
   assert.ok([403,404].includes(response.status),'A private path was not rejected')
   assert.ok(!body.includes(nonce),'A private canary was served')
   results.push({kind:path===files[0]?'private-artifact':'environment-file',route:route.includes('/@fs/')?'filesystem':route.includes('?')?'raw-import':'direct',status:response.status})
  }
 }
 const source=await fetch(base+'/src/id.ts');assert.equal(source.status,200);assert.match(await source.text(),/createId/)
 const report={completedAt:new Date().toISOString(),passed:true,results,defaultDenyRulesPreserved:true,ordinarySourceAvailable:true,note:'Loopback development server; synthetic canaries only. No actual credentials were fetched.'}
 await writeFile('.test-artifacts/dev-private-files.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}finally{
 if(server)await server.close()
 for(const path of created)await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error})
}
