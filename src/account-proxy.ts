// Shared by the trusted ingress and account handler. This proof authenticates
// only network provenance; it never grants account or workspace permissions.
const actions=new Set(['request','verify_request','player_login','coach_signup','verify_coach_signup','invitation_details','accept_player_invitation','recover_password'])
export const accountBodyLimit=20_000
export const accountProxyHeaders={ip:'x-pitchwork-peer',time:'x-pitchwork-time',signature:'x-pitchwork-proof'} as const
export function publicAccountAction(action:unknown):action is string{return typeof action==='string'&&actions.has(action)}
export function validProxySecret(secret:unknown):secret is string{return typeof secret==='string'&&/^[a-f0-9]{64}$/.test(secret)}
function hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')}
function ipv6Parts(address:string){const halves=address.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves.length===2&&halves[1]?halves[1].split(':'):[];return halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left}
export function canonicalIp(value:unknown):string|null{
  if(typeof value!=='string'||value.length>45)return null
  if(/^\d+\.\d+\.\d+\.\d+$/.test(value)){
    const parts=value.split('.');return parts.every(p=>Number(p)<=255&&String(Number(p))===p)?value:null
  }
  if(!/^[a-fA-F0-9:.]+$/.test(value)||!value.includes(':'))return null
  try{
    const ip=new URL(`http://[${value}]/`).hostname.slice(1,-1),parts=ipv6Parts(ip).map(p=>parseInt(p,16))
    if(parts.length!==8)return null
    if(parts.slice(0,5).every(p=>p===0)&&parts[5]===65535)return `${parts[6]>>8}.${parts[6]&255}.${parts[7]>>8}.${parts[7]&255}`
    return ip
  }catch{return null}
}
export function networkRateSubject(ip:string):string{
  const address=canonicalIp(ip);if(!address)throw new Error('Invalid peer address')
  return address.includes(':')?ipv6Parts(address).slice(0,4).map(p=>parseInt(p,16).toString(16)).join(':')+'::/64':address
}
async function envelope(origin:string,ip:string,time:string,body:Uint8Array){
  const digest=hex(await crypto.subtle.digest('SHA-256',Uint8Array.from(body)))
  return new TextEncoder().encode(`pitchwork/accounts/v1\n${origin}\n${ip}\n${time}\n${digest}`)
}
async function signingKey(secret:string){return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
export async function signAccountRequest(secret:string,origin:string,peer:string,body:Uint8Array,now=Date.now()):Promise<Record<string,string>>{
  const ip=canonicalIp(peer)
  if(!validProxySecret(secret)||!ip||new URL(origin).origin!==origin||!Number.isSafeInteger(now))throw new Error('Invalid account proxy configuration')
  const time=String(now),signature=hex(await crypto.subtle.sign('HMAC',await signingKey(secret),await envelope(origin,ip,time,body)))
  return {[accountProxyHeaders.ip]:ip,[accountProxyHeaders.time]:time,[accountProxyHeaders.signature]:signature}
}
export async function verifyAccountRequest(secrets:readonly string[],origin:string,headers:Headers,body:Uint8Array,now=Date.now()):Promise<string|null>{
  if(!secrets.length||secrets.length>2||secrets.some(s=>!validProxySecret(s)))return null
  const ip=canonicalIp(headers.get(accountProxyHeaders.ip)),time=headers.get(accountProxyHeaders.time)??'',signature=headers.get(accountProxyHeaders.signature)??''
  if(!ip||!/^\d{13}$/.test(time)||!Number.isSafeInteger(Number(time))||now-Number(time)>60_000||Number(time)-now>10_000||!/^[a-f0-9]{64}$/.test(signature))return null
  const bytes=Uint8Array.from(signature.match(/../g)!,p=>parseInt(p,16)),message=await envelope(origin,ip,time,body)
  for(const secret of secrets)if(await crypto.subtle.verify('HMAC',await signingKey(secret),bytes,message))return ip
  return null
}
