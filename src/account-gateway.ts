import {accountBodyLimit,canonicalIp,publicAccountAction,signAccountRequest,validProxySecret} from './account-proxy.ts'

export interface AccountGatewayConfig{APP_URL:string;SUPABASE_URL:string;SUPABASE_PUBLISHABLE_KEY:string;ACCOUNT_PROXY_SECRET:string}
export const accountApiPath='/api/accounts'
const responseHeaders={'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Strict-Transport-Security':'max-age=31536000'}
function reply(error:string,status:number){return new Response(JSON.stringify({error}),{status,headers:responseHeaders})}
export function accountIngressUnavailable(){return reply('Verified ingress is unavailable.',503)}
export function publicApiKey(key:string):boolean{
 if(typeof key!=='string')return false
 if(/^sb_publishable_[a-zA-Z0-9_-]{10,}$/.test(key))return true
 try{return key.split('.').length===3&&JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role==='anon'}catch{return false}
}
/** peer comes only from the platform/socket adapter, never forwarding headers.
 * The adapter may allow loopback targets for local tests, never production. */
export async function forwardAccountRequest(request:Request,config:AccountGatewayConfig,peer:string,
 options:{inboundOrigin?:string;allowLoopback?:boolean;send?:typeof fetch}={}):Promise<Response>{
 try{
  const app=new URL(config.APP_URL),target=new URL(config.SUPABASE_URL),ip=canonicalIp(peer)
  if(app.username||app.password||app.protocol!=='https:'&&!(options.allowLoopback&&['localhost','127.0.0.1'].includes(app.hostname)))return reply('Account service is not configured.',503)
  if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||target.protocol!=='https:'&&!(options.allowLoopback&&target.protocol==='http:'&&['localhost','127.0.0.1'].includes(target.hostname)))return reply('Account service is not configured.',503)
  if(!ip||!validProxySecret(config.ACCOUNT_PROXY_SECRET)||!publicApiKey(config.SUPABASE_PUBLISHABLE_KEY))return reply('Account service is not configured.',503)
  const inbound=options.inboundOrigin??app.origin,url=new URL(request.url),origin=request.headers.get('origin')
  if(url.origin!==inbound||url.pathname!==accountApiPath||url.search||origin&&origin!==inbound)return reply('Request not allowed.',403)
  if(request.method!=='POST')return reply('Method not allowed.',405)
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply('Use a JSON account request.',415)
  if(Number(request.headers.get('content-length'))>accountBodyLimit)return reply('Request too large.',413)
  const chunks:Uint8Array[]=[],reader=request.body?.getReader();let size=0
  if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>accountBodyLimit){await reader.cancel();return reply('Request too large.',413)}chunks.push(part.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  let body
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return reply('Invalid account request.',400)}
  if(!body||Array.isArray(body)||!publicAccountAction(body.action))return reply('Invalid public account action.',400)
  const proof=await signAccountRequest(config.ACCOUNT_PROXY_SECRET,app.origin,ip,bytes)
  const headers={...proof,apikey:config.SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json',Origin:app.origin}
  const result=await (options.send??fetch)(new URL('/functions/v1/accounts',target),{method:'POST',headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(12_000)})
  // Never reflect signed ingress headers, cookies or infrastructure details.
  return new Response(result.body,{status:result.status,headers:responseHeaders})
 }catch{return reply('Account service is temporarily unavailable. Please retry.',503)}
}
