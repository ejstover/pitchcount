import {afterEach,expect,it,vi} from 'vitest'
import {accountProxyHeaders,verifyAccountRequest} from './account-proxy'
import {forwardAccountRequest,type AccountGatewayConfig} from './account-gateway'
import {onRequest} from '../functions/api/accounts'

const config:AccountGatewayConfig={APP_URL:'https://count.twelvefs.com/',SUPABASE_URL:'https://project.supabase.co/',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test_0123456789',ACCOUNT_PROXY_SECRET:'c'.repeat(64)}
const origin=new URL(config.APP_URL).origin
function request(body:unknown={action:'coach_signup'},headers:Record<string,string>={}){return new Request(origin+'/api/accounts',{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(body)})}
afterEach(()=>vi.unstubAllGlobals())

it('signs only the platform peer and actual bytes, drops caller credentials and does not reflect proof headers',async()=>{
 const source=request({action:'player_login',username:'player',password:'private fixture'},{'cf-connecting-ip':'198.51.100.1','x-real-ip':'198.51.100.2','x-forwarded-for':'198.51.100.3',authorization:'Bearer caller',cookie:'caller=value',[accountProxyHeaders.signature]:'forged'})
 let checked=false
 const send=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  expect(String(input)).toBe('https://project.supabase.co/functions/v1/accounts')
  const headers=new Headers(init?.headers),bytes=new Uint8Array(init?.body as ArrayBuffer)
  expect(await verifyAccountRequest([config.ACCOUNT_PROXY_SECRET],origin,headers,bytes)).toBe('203.0.113.9')
  expect(headers.get('authorization')).toBeNull();expect(headers.get('cookie')).toBeNull();expect(headers.get('cf-connecting-ip')).toBeNull()
  expect(headers.get('apikey')).toBe(config.SUPABASE_PUBLISHABLE_KEY);expect(init?.redirect).toBe('error');checked=true
  return new Response('{"ok":true}',{headers:{'set-cookie':'unsafe=value',[accountProxyHeaders.signature]:'unsafe'}})
 })
 const result=await forwardAccountRequest(source,config,'203.0.113.9',{send})
 expect(result.status).toBe(200);expect(checked).toBe(true);expect(result.headers.get('cache-control')).toBe('no-store')
 expect(result.headers.get('set-cookie')).toBeNull();expect(result.headers.get(accountProxyHeaders.signature)).toBeNull()
})
it('rejects public-action confusion, foreign origins, malformed data and oversized streams before forwarding',async()=>{
 const send=vi.fn(async()=>new Response('{}'))
 expect((await forwardAccountRequest(request({action:'list'}),config,'203.0.113.9',{send})).status).toBe(400)
 expect((await forwardAccountRequest(request({}, {origin:'https://foreign.example'}),config,'203.0.113.9',{send})).status).toBe(403)
 expect((await forwardAccountRequest(request({action:'request',padding:'x'.repeat(20000)}),config,'203.0.113.9',{send})).status).toBe(413)
 const malformed=new Request(origin+'/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:'{'})
 expect((await forwardAccountRequest(malformed,config,'203.0.113.9',{send})).status).toBe(400)
 expect(send).not.toHaveBeenCalled()
})
it('rejects unsafe targets, private API keys and absent configuration without sending data',async()=>{
 const send=vi.fn(async()=>new Response('{}'))
 for(const changed of [{APP_URL:'https://user:password@count.twelvefs.com/'},{SUPABASE_URL:'http://project.example/'},{SUPABASE_URL:'https://user:password@project.example/'},{SUPABASE_URL:'https://project.example/other'},{SUPABASE_PUBLISHABLE_KEY:'sb_secret_private'},{ACCOUNT_PROXY_SECRET:''}]){
  expect((await forwardAccountRequest(request(),{...config,...changed},'203.0.113.9',{send})).status).toBe(503)
 }
 expect(send).not.toHaveBeenCalled()
})
it('requires actual platform metadata and a real network address for API ingress',async()=>{
 const env={...config},send=vi.fn(async()=>new Response('{}'))
 vi.stubGlobal('fetch',send)
 expect((await onRequest({request:request(),env})).status).toBe(503)
 expect(send).not.toHaveBeenCalled()
 for(const peer of ['240.1.2.3','::ffff:240.1.2.3','not-an-address']){
  const invalid=request({}, {'cf-connecting-ip':peer});Object.defineProperty(invalid,'cf',{value:{colo:'test'}})
  const response=await onRequest({request:invalid,env});expect(response.status).toBe(503);expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
 }
 const fake=request({}, {'cf-connecting-ip':'203.0.113.9'});Object.defineProperty(fake,'cf',{value:'caller string'})
 expect((await onRequest({request:fake,env})).status).toBe(503);expect(send).not.toHaveBeenCalled()
 const incoming=request({action:'recover_password',email:'player@example.invalid'},{'cf-connecting-ip':'203.0.113.9'})
 Object.defineProperty(incoming,'cf',{value:{colo:'test'}})
 expect((await onRequest({request:incoming,env})).status).toBe(200);expect(send).toHaveBeenCalledTimes(1)
})
