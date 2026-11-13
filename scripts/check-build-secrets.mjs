// Synthetic values only; test the actual config hook and emitted browser files.
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {readFile,readdir,stat,writeFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {build,resolveConfig} from 'vite'
const canary=randomBytes(32).toString('hex'),results=[]
const names=['VITE_SUPABASE_URL','VITE_SUPABASE_PUBLISHABLE_KEY','ACCOUNT_PROXY_SECRET','VITE_ACCOUNT_PROXY_SECRET','VITE_ACCOUNT_PROXY_PREVIOUS_SECRET'],before=names.map(name=>process.env[name])
const publicKey='sb_publishable_synthetic_build_check'
const token=role=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({role})).toString('base64url')}.synthetic`
try{
 Object.assign(process.env,{VITE_SUPABASE_URL:'https://synthetic-build.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:publicKey,ACCOUNT_PROXY_SECRET:canary,VITE_ACCOUNT_PROXY_SECRET:'',VITE_ACCOUNT_PROXY_PREVIOUS_SECRET:''})
 for(const [name,value]of [['VITE_ACCOUNT_PROXY_SECRET',canary],['VITE_ACCOUNT_PROXY_PREVIOUS_SECRET',canary],['VITE_SUPABASE_PUBLISHABLE_KEY','sb_secret_synthetic_build_canary'],['VITE_SUPABASE_PUBLISHABLE_KEY',token('service_role')],['VITE_SUPABASE_PUBLISHABLE_KEY',token('authenticated')]]){
  process.env[name]=value
  await assert.rejects(resolveConfig({logLevel:'silent'},'build'),/must (not use a VITE_|contain a public)/)
  process.env[name]=name==='VITE_SUPABASE_PUBLISHABLE_KEY'?publicKey:''
  results.push({name:name==='VITE_SUPABASE_PUBLISHABLE_KEY'?'Private/non-anon API key rejected before bundle emission':'Public-prefix signing key rejected before bundle emission',passed:true})
 }
 for(const value of ['postgres://synthetic:synthetic@db.example.invalid/postgres','https://synthetic:synthetic@project.example.invalid/','https://project.example.invalid/?key=synthetic','http://public.example.invalid/']){
  process.env.VITE_SUPABASE_URL=value
  await assert.rejects(resolveConfig({logLevel:'silent'},'build'),/must be a public HTTPS project root/)
  results.push({name:'Credential-bearing or unsafe browser project URL rejected',passed:true})
 }
 process.env.VITE_SUPABASE_URL='https://synthetic-build.supabase.co'
 const outDir=resolve('.test-artifacts','build-secret-canary-'+randomUUID())
 assert.ok(outDir.startsWith(resolve('.test-artifacts')+sep))
 await build({logLevel:'silent',build:{outDir,emptyOutDir:false}})
 let files=0
 for(const name of await readdir(outDir,{recursive:true})){
  const path=resolve(outDir,name);if(!(await stat(path)).isFile())continue
  assert.ok(!(await readFile(path)).includes(Buffer.from(canary)),'A private server canary reached a browser artifact')
  files++
 }
 assert.ok(files>10)
 results.push({name:'Private server signing key absent from all emitted browser files',passed:true})
 await writeFile('.test-artifacts/build-secret-checks.json',JSON.stringify({completedAt:new Date().toISOString(),passed:true,files,results,note:'Synthetic canary only; no actual credential was inspected or emitted.'},null,2))
 console.log(`Browser build secret checks passed (${results.length} checks; ${files} emitted files inspected).`)
}finally{
 names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index]})
}
