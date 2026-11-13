import {readFile} from 'node:fs/promises'
import {publicApiKey} from '../src/account-gateway.ts'
/** A redirect must not move workload traffic or credentials outside the target. */
export const loadFetch:typeof fetch=(input,init)=>fetch(input,{...init,redirect:'error'})
/** Validate before issuing even a preflight request. Never echo URL contents. */
export function loadTarget(value:string,protectedUrls:string[]):URL{
 let target:URL
 try{target=new URL(value)}catch{throw new Error('Provide a valid staging API root URL.')}
 const local=['127.0.0.1','localhost'].includes(target.hostname)
 if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||!(target.protocol==='https:'||local&&target.protocol==='http:'))throw new Error('Use a credential-free HTTPS staging API root; loopback HTTP is supported.')
 const protectedHosts=new Set<string>()
 for(const value of protectedUrls){
  try{const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:')throw new Error();protectedHosts.add(url.hostname.replace(/\.$/,''))}catch{throw new Error('A protected production API URL is invalid.')}
 }
 if(protectedHosts.has(target.hostname.replace(/\.$/,'')))throw new Error('Refusing load traffic to a protected production API host.')
 if(!local&&!protectedHosts.size)throw new Error('Declare the protected production API URL before running remote staging traffic.')
 return target
}
export async function loadEnvironment(env:Record<string,string|undefined>){
 if(env.PITCHWORK_LOAD_ENVIRONMENT!=='staging')throw new Error('Designate a staging environment before running load traffic.')
 const protectedUrls:string[]=[],production=env.PITCHWORK_LOAD_PROTECTED_URL??env.VITE_SUPABASE_URL
 if(production)protectedUrls.push(production)
 try{const reference=(await readFile('supabase/.temp/project-ref','utf8')).trim();if(!/^[a-z0-9]{20}$/.test(reference))throw new Error('The root linked-project reference is invalid; keep staging in an isolated work directory.');protectedUrls.push(`https://${reference}.supabase.co/`)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const target=loadTarget(env.PITCHWORK_LOAD_URL??'',protectedUrls),key=env.PITCHWORK_LOAD_PUBLIC_KEY
 if(typeof key!=='string'||!publicApiKey(key))throw new Error('A public publishable or anon API key is required; never use administrative or user-session keys for load traffic.')
 return {target,key}
}
