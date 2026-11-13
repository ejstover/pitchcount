import {loadEnv,type Plugin} from 'vite'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {accountApiPath,forwardAccountRequest,publicApiKey,type AccountGatewayConfig} from './src/account-gateway'
import {accountBodyLimit,canonicalIp} from './src/account-proxy'

/** Development adapter only. Production uses the managed Pages Function. */
export function accountDevelopmentProxy():Plugin{
 let config:AccountGatewayConfig
 return {
  name:'pitchwork-account-development-proxy',
  configResolved(resolved){
   const env=loadEnv(resolved.mode,resolved.envDir,'')
   if(env.VITE_ACCOUNT_PROXY_SECRET||env.VITE_ACCOUNT_PROXY_PREVIOUS_SECRET)throw new Error('Account proxy signing keys must not use a VITE_ variable.')
   if(env.VITE_SUPABASE_PUBLISHABLE_KEY&&!publicApiKey(env.VITE_SUPABASE_PUBLISHABLE_KEY))throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must contain a public publishable or anon key. Administrative and user-session keys must never enter a browser build.')
   if(env.VITE_SUPABASE_URL){
    let valid=false
    try{const url=new URL(env.VITE_SUPABASE_URL);valid=!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))}catch{/* Reject before client emission, without reflecting the supplied value. */}
    if(!valid)throw new Error('VITE_SUPABASE_URL must be a public HTTPS project root, without credentials, query or fragment. Loopback HTTP is supported for local tests.')
   }
   config={APP_URL:env.APP_URL??'https://count.twelvefs.com/',SUPABASE_URL:env.VITE_SUPABASE_URL??'',SUPABASE_PUBLISHABLE_KEY:env.VITE_SUPABASE_PUBLISHABLE_KEY??'',ACCOUNT_PROXY_SECRET:env.ACCOUNT_PROXY_SECRET??''}
  },
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(req.url?.split('?')[0]!==accountApiPath)return next()
   try{
    const local=canonicalIp(req.socket.localAddress),peer=canonicalIp(req.socket.remoteAddress),port=req.socket.localPort,protocol=server.config.server.https?'https:':'http:'
    if(!local||!peer||!port){res.statusCode=503;res.end('Verified development ingress unavailable');return}
    const host=local.includes(':')?`[${local}]`:local
    const allowed=[`${protocol}//${host}:${port}`,`${protocol}//localhost:${port}`,`${protocol}//127.0.0.1:${port}`]
    const url=new URL(`${protocol}//${req.headers.host??`${host}:${port}`}${req.url}`)
    if(!allowed.includes(url.origin)){res.statusCode=403;res.end('Invalid development host');return}
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value)
    const chunks:Buffer[]=[];let size=0
    const tooLarge=()=>{req.pause();res.statusCode=413;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('Connection','close');res.end(JSON.stringify({error:'Request too large.'}))}
    if(Number(req.headers['content-length'])>accountBodyLimit){tooLarge();return}
    if(req.method==='POST')for await(const chunk of req.iterator({destroyOnReturn:false})){
     const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length
     if(size>accountBodyLimit){tooLarge();return}chunks.push(value)
    }
    const init={method:req.method,headers,...(req.method==='POST'?{body:Uint8Array.from(Buffer.concat(chunks))}:{})}
    const result=await forwardAccountRequest(new Request(url,init),config,peer,{inboundOrigin:url.origin,allowLoopback:true})
    if(res.destroyed)return
    res.statusCode=result.status;result.headers.forEach((value,key)=>res.setHeader(key,value))
    if(result.body)await pipeline(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]),res)
    else res.end()
   }catch(error){if(!res.destroyed)next(error)}
  })}
 }
}
