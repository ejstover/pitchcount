import {describe,expect,it,vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {accountEmail,accountRequest,requiredText,requestConfirmation,playerUsername,validatePassword} from './account-validation'
import {publicAccountAction,validProxySecret,verifyAccountRequest,networkRateSubject,signAccountRequest} from './account-proxy'

// Execute the actual Deno handler with its Supabase transport replaced; SQL behavior is tested separately.
function endpoint(modernKey=false) {
 let handler:(req:Request)=>Promise<Response>
 const tables:Record<string,unknown>={access_requests:{account_id:'pending-id'},account_provisions:{id:'pending-id'},coach_signups:{account_id:'pending-id',completed_at:null}}
 const from=vi.fn((table:string)=>{
  const query:any={}
  for(const key of ['select','eq','neq','update','order'])query[key]=()=>query
  query.maybeSingle=query.single=async()=>({data:tables[table]??null,error:null})
  query.then=(resolve:any,reject:any)=>Promise.resolve({data:tables[table]??null,error:null}).then(resolve,reject)
  return query
 })
 const service={from,rpc:vi.fn(async(name:string):Promise<any>=>({data:name==='account_context'?{profile:tables.coaches,requestStatus:(tables.access_requests as any)?.status,pitcherId:(tables.player_accounts as any)?.pitcher_id,onboardingTeamId:null}:name==='onboarding_limit'?true:['reserve_access_request','reserve_coach_signup','reserve_invited_player'].includes(name)?{id:'pending-id',email:'player@example.com'}:name==='player_invitation_details'?{teamName:'Falcons',playerName:'Player'}:null,error:null})),auth:{
  getUser:vi.fn(async()=>({data:{user:null},error:null})),
  admin:{getUserById:vi.fn(async()=>({data:{user:null},error:null})),createUser:vi.fn(async()=>({error:null})),updateUserById:vi.fn(async()=>({error:null as unknown}))}
 }}
 const session={access_token:'access',refresh_token:'refresh'}
 const sender={auth:{signInWithOtp:vi.fn(async()=>({error:null as unknown})),verifyOtp:vi.fn(async()=>({data:{user:{id:'pending-id',email_confirmed_at:'2026-10-22'},session},error:null as unknown})),signInWithPassword:vi.fn(async()=>({data:{user:{id:'pending-id'},session},error:null as unknown})),resetPasswordForEmail:vi.fn(async()=>({error:null as unknown}))}}
 let first=true
 const proxySecret='a'.repeat(64),clients:Record<string,any>[]=[]
 const env:Record<string,string>={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',REQUEST_RATE_SALT:'test-salt',APP_URL:'https://count.twelvefs.com/',ACCOUNT_PROXY_SECRET:proxySecret,...(modernKey?{SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test_only'})}:{})}
 const source=readFileSync('supabase/functions/accounts/index.ts','utf8').replace(/^import .*\r?\n/gm,'')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
 runInNewContext(js,{createClient:(_url:unknown,_key:unknown,options:Record<string,any>)=>{clients.push(options);if(first){first=false;return service}return sender},accountEmail,accountRequest,requiredText,requestConfirmation,playerUsername,validatePassword,publicAccountAction,validProxySecret,verifyAccountRequest,networkRateSubject,URL,URLSearchParams,Response,crypto,TextEncoder,TextDecoder,
  Deno:{env:{get:(name:string)=>env[name]},serve:(fn:typeof handler)=>{handler=fn}}})
 return {service,sender,tables,env,clients,get:async(headers:Record<string,string>={},query='')=>handler(new Request('https://example.supabase.co/functions/v1/accounts'+query,{headers:{origin:'https://count.twelvefs.com',...headers}})),call:async(body:unknown,headers:Record<string,string>={},peer='203.0.113.7')=>{
  const text=JSON.stringify(body),proof=await signAccountRequest(proxySecret,'https://count.twelvefs.com',peer,new TextEncoder().encode(text))
  return handler(new Request('https://example.supabase.co/functions/v1/accounts',{method:'POST',headers:{origin:'https://count.twelvefs.com','content-type':'application/json',...proof,...headers},body:text}))}}
}
const request={action:'request',role:'player',name:'Player',email:'player@example.com',username:'Practice.Kid',requestedTeam:''}
describe('account email endpoint',()=>{
 it('rejects unsigned public requests before counters, provisioning or password verification',async()=>{
  const e=endpoint()
  expect((await e.call(request,{'x-pitchwork-proof':''})).status).toBe(403)
  expect(e.service.rpc).not.toHaveBeenCalled();expect(e.service.auth.admin.createUser).not.toHaveBeenCalled();expect(e.sender.auth.signInWithPassword).not.toHaveBeenCalled()
  delete e.env.ACCOUNT_PROXY_SECRET
  expect((await e.call(request)).status).toBe(503);expect(e.service.rpc).not.toHaveBeenCalled()
 })
 it('does not let arbitrary forwarding headers reset the verified network bucket',async()=>{
  const e=endpoint(),body={action:'recover_password',email:'player@example.com'}
  await e.call(body,{'cf-connecting-ip':'192.0.2.1','x-forwarded-for':'192.0.2.2'})
  await e.call(body,{'cf-connecting-ip':'192.0.2.9','x-forwarded-for':'192.0.2.10'})
  const buckets=e.service.rpc.mock.calls.filter(c=>c[0]==='onboarding_limit') as unknown as [string,{p_bucket:string}][]
  expect(buckets).toHaveLength(4);expect(buckets[0][1].p_bucket).toBe(buckets[2][1].p_bucket)
 })
 it('forwards only each verified peer with modern keys and leaves the shared service client unchanged',async()=>{
  const e=endpoint(true);e.env.AUTH_TRUSTED_IP_FORWARDING='1'
  const responses=await Promise.all(['203.0.113.1','203.0.113.2'].map((peer,i)=>e.call({action:'recover_password',email:`player${i}@example.com`},{'Sb-Forwarded-For':'198.51.100.8'},peer)))
  expect(responses.map(r=>r.status)).toEqual([200,200])
  expect(e.clients[0].global).toBeUndefined()
  expect(e.clients.slice(1).map(c=>c.global.headers['Sb-Forwarded-For']).sort()).toEqual(['203.0.113.1','203.0.113.2'])
 })
 it('does not silently enable trusted Auth IP forwarding with a legacy key',async()=>{
  const e=endpoint();e.env.AUTH_TRUSTED_IP_FORWARDING='1'
  expect((await e.call({action:'recover_password',email:'player@example.com'})).status).toBe(503)
  expect(e.service.rpc).not.toHaveBeenCalled();expect(e.sender.auth.resetPasswordForEmail).not.toHaveBeenCalled()
 })
 it('fails closed when the joined profile lookup is temporarily unavailable',async()=>{
  const e=endpoint();e.service.auth.getUser.mockResolvedValue({data:{user:{id:'pending-id',email:'player@example.com',email_confirmed_at:'2026-10-22'} as any},error:null})
  e.service.rpc.mockResolvedValueOnce({data:null,error:{code:'PGRST003',message:'Private backend sentinel'}})
  const response=await e.get({authorization:'Bearer user-token'})
  expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('sentinel')
 })
 it('serves noncached GET profiles through current identity and approval checks, ignoring query actions',async()=>{
  const e=endpoint();expect((await e.get()).status).toBe(401)
  e.service.auth.getUser.mockResolvedValue({data:{user:{id:'pending-id',email:'player@example.com',email_confirmed_at:'2026-10-22'} as any},error:null})
  e.tables.coaches={id:'pending-id',email:'player@example.com',role:'coach',active:true}
  const response=await e.get({authorization:'Bearer valid'},'?action=coach_signup&email=intruder@example.com')
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect((await response.json()).id).toBe('pending-id')
  expect(e.service.rpc).toHaveBeenCalledWith('account_context',{p_actor:'pending-id'});expect(e.service.auth.admin.createUser).not.toHaveBeenCalled()
  e.tables.coaches={id:'pending-id',active:false}
  expect((await e.get({authorization:'Bearer valid'})).status).toBe(403)
  expect((await e.get({origin:'https://untrusted.invalid',authorization:'Bearer valid'})).status).toBe(403)
 })
 it.each([429,500,503])('keeps identity-service failure %s retryable without granting access',async status=>{
  const e=endpoint();e.service.auth.getUser.mockResolvedValue({data:{user:null},error:{status,message:'Private internal sentinel'}} as any)
  const response=await e.call({action:'profile'},{authorization:'Bearer user-token'})
  expect(response.status).toBe(503);const body=await response.json();expect(body.code).toBe('auth_unavailable');expect(JSON.stringify(body)).not.toContain('sentinel')
  expect(e.service.from).not.toHaveBeenCalled();expect(e.service.rpc).not.toHaveBeenCalled()
 })
 it('keeps an invalid identity token rejected instead of treating it as an outage',async()=>{
  const e=endpoint();e.service.auth.getUser.mockResolvedValue({data:{user:null},error:{status:401}} as any)
  const response=await e.call({action:'profile'},{authorization:'Bearer invalid-token'})
  expect(response.status).toBe(401);expect((await response.json()).code).toBe('reauth');expect(e.service.from).not.toHaveBeenCalled()
 })
 it('rejects oversized byte payloads before provisioning or authentication work',async()=>{
  const e=endpoint(),res=await e.call({...request,name:'é'.repeat(11000)})
  expect(res.status).toBe(413);expect(e.service.rpc).not.toHaveBeenCalled();expect(e.service.auth.getUser).not.toHaveBeenCalled()
 })
 it('creates an unconfirmed identity and sends OTP without allowing public auth signup',async()=>{
  const e=endpoint();expect((await e.call(request)).status).toBe(200)
  expect(e.service.auth.admin.createUser).toHaveBeenCalledWith({id:'pending-id',email:'player@example.com',email_confirm:false})
  expect(e.sender.auth.signInWithOtp).toHaveBeenCalledWith({email:'player@example.com',options:{shouldCreateUser:false}})
  expect(e.service.rpc).toHaveBeenCalledWith('reserve_access_request',expect.objectContaining({p_username:'practice.kid',p_team:'',p_role:'player'}))
 })
 it('returns a retryable email-delivery error without granting access',async()=>{
  const e=endpoint();e.sender.auth.signInWithOtp.mockResolvedValue({error:{message:'SMTP unavailable'}})
  const res=await e.call(request);expect(res.status).toBe(503);expect((await res.json()).error).toContain('Could not send')
  expect(e.service.rpc).not.toHaveBeenCalledWith('approve_access_request',expect.anything())
 })
 it('reuses an existing identity when resending after a failed mail attempt',async()=>{
  const e=endpoint();e.service.auth.admin.getUserById.mockResolvedValue({data:{user:{id:'pending-id'} as any},error:null})
  await e.call(request);expect(e.service.auth.admin.createUser).not.toHaveBeenCalled();expect(e.sender.auth.signInWithOtp).toHaveBeenCalledTimes(1)
 })
 it('returns the same public confirmation for duplicates and throttled requests',async()=>{
  const e=endpoint();e.service.rpc.mockResolvedValue({data:null,error:null})
  const res=await e.call(request);expect(await res.json()).toEqual({message:requestConfirmation});expect(e.sender.auth.signInWithOtp).not.toHaveBeenCalled()
 })
 it('reports unavailable player usernames without creating another identity or sending mail',async()=>{
  const e=endpoint();e.service.rpc.mockResolvedValue({data:{usernameUnavailable:true} as any,error:null})
  const res=await e.call(request);expect(res.status).toBe(400);expect((await res.json()).error).toContain('username is unavailable')
  expect(e.service.auth.admin.createUser).not.toHaveBeenCalled();expect(e.sender.auth.signInWithOtp).not.toHaveBeenCalled()
 })
 it('verifies a code but does not return a session or activate the account',async()=>{
  const e=endpoint();const res=await e.call({action:'verify_request',email:request.email,code:'123456'})
  expect(await res.json()).toEqual({message:'Email verified—waiting for admin approval.'})
  expect(e.sender.auth.verifyOtp).toHaveBeenCalledWith({email:request.email,token:'123456',type:'email'})
  expect(e.service.rpc).toHaveBeenCalledWith('confirm_access_request',{p_account:'pending-id'})
  expect(e.service.from).not.toHaveBeenCalledWith('coaches')
 })
 it.each(['incorrect','expired','reused'])('rejects a %s code and does not record verification',async()=>{
  const e=endpoint();e.sender.auth.verifyOtp.mockResolvedValue({data:{user:null as any,session:null as any},error:{message:'Invalid token'}})
  const res=await e.call({action:'verify_request',email:request.email,code:'000000'})
  expect(res.status).toBe(400);expect((await res.json()).error).toContain('invalid or expired');expect(e.service.rpc).not.toHaveBeenCalledWith('confirm_access_request',expect.anything())
 })
 it('does not accept codes for another identity or rejected requests',async()=>{
  const e=endpoint();e.tables.access_requests={account_id:'different-id'}
  expect((await e.call({action:'verify_request',email:request.email,code:'123456'})).status).toBe(400)
  e.tables.access_requests=null;e.sender.auth.verifyOtp.mockClear()
  expect((await e.call({action:'verify_request',email:request.email,code:'123456'})).status).toBe(400)
  expect(e.sender.auth.verifyOtp).not.toHaveBeenCalled()
 })
 it('reports missing mail/request configuration and validates input before provisioning',async()=>{
  const e=endpoint();delete e.env.REQUEST_RATE_SALT
  expect((await e.call(request)).status).toBe(503)
  expect((await e.call({...request,role:'admin'})).status).toBe(400)
  expect(e.service.auth.admin.createUser).not.toHaveBeenCalled()
 })
 it('reports waiting for approval separately from suspension and rejects unconfirmed access',async()=>{
  const e=endpoint()
  e.service.auth.getUser.mockResolvedValue({data:{user:{id:'pending-id',email:'player@example.com',email_confirmed_at:'2026-10-22'} as any},error:null})
  e.tables.coaches={id:'pending-id',email:'player@example.com',role:'player',active:false}
  e.tables.access_requests={status:'pending'}
  let res=await e.call({action:'profile'})
  expect(res.status).toBe(403);expect(await res.json()).toMatchObject({code:'approval_pending',error:'Email verified—waiting for admin approval.'})
  e.service.auth.getUser.mockResolvedValue({data:{user:{id:'pending-id',email:'player@example.com'} as any},error:null})
  res=await e.call({action:'profile'});expect(res.status).toBe(403);expect((await res.json()).error).toContain('Verify your email')
  e.tables.access_requests={status:'rejected'}
  res=await e.call({action:'profile'});expect(res.status).toBe(403);expect((await res.json()).code).toBe('access_denied')
 })
})

describe('self-service account endpoint',()=>{
 const password='some unrelated practice words'
 it('reserves a coach without activating access, and sends an email code',async()=>{
  const e=endpoint(),res=await e.call({action:'coach_signup',name:'Coach',email:'NEW@example.com',teamName:'Falcons'})
  expect(res.status).toBe(200)
  expect(e.service.rpc).toHaveBeenCalledWith('reserve_coach_signup',expect.objectContaining({p_email:'new@example.com',p_team:'Falcons'}))
  expect(e.service.auth.admin.createUser).toHaveBeenCalledWith({id:'pending-id',email:'player@example.com',email_confirm:false})
  expect(e.sender.auth.signInWithOtp).toHaveBeenCalledWith({email:'player@example.com',options:{shouldCreateUser:false}})
  expect(e.service.rpc).not.toHaveBeenCalledWith('complete_coach_signup',expect.anything())
 })
 it('returns sessions only after verification, password setup and atomic team creation',async()=>{
  const e=endpoint(),res=await e.call({action:'verify_coach_signup',email:'new@example.com',code:'123456',password})
  expect(res.status).toBe(200);expect(await res.json()).toEqual({access_token:'access',refresh_token:'refresh'})
  expect(e.service.auth.admin.updateUserById).toHaveBeenCalledWith('pending-id',{password})
  expect(e.service.rpc).toHaveBeenCalledWith('complete_coach_signup',{p_account:'pending-id'})
 })
 it('rejects invalid, other-account and already-completed signup codes without password changes',async()=>{
  const e=endpoint();e.sender.auth.verifyOtp.mockResolvedValue({data:{user:null as any,session:null as any},error:{message:'expired'}})
  expect((await e.call({action:'verify_coach_signup',email:'new@example.com',code:'123456',password})).status).toBe(400)
  expect(e.service.auth.admin.updateUserById).not.toHaveBeenCalled()
  e.sender.auth.verifyOtp.mockResolvedValue({data:{user:{id:'other-id',email_confirmed_at:'today'},session:{access_token:'a',refresh_token:'r'}},error:null})
  expect((await e.call({action:'verify_coach_signup',email:'new@example.com',code:'123456',password})).status).toBe(400)
  e.tables.coach_signups={account_id:'other-id',completed_at:'today'}
  expect((await e.call({action:'verify_coach_signup',email:'new@example.com',code:'123456',password})).status).toBe(400)
  expect(e.service.auth.admin.updateUserById).not.toHaveBeenCalled()
 })
 it('fails closed when rate limiting is unavailable or exceeded',async()=>{
  const e=endpoint();e.service.rpc.mockResolvedValue({data:false,error:null})
  expect((await e.call({action:'invitation_details',token:'a'.repeat(64)})).status).toBe(429)
  expect(e.service.auth.admin.createUser).not.toHaveBeenCalled()
  delete e.env.REQUEST_RATE_SALT
  expect((await e.call({action:'coach_signup',name:'Coach',email:'a@example.com',teamName:'Team'})).status).toBe(503)
 })
 it('hashes invitation secrets and creates only the reserved player before activation',async()=>{
  const e=endpoint(),token='a'.repeat(64)
  const res=await e.call({action:'accept_player_invitation',token,username:'New.Player',password})
  expect(res.status).toBe(200)
  expect(e.service.rpc).toHaveBeenCalledWith('reserve_invited_player',{p_hash:expect.stringMatching(/^[a-f0-9]{64}$/),p_username:'new.player'})
  expect(e.service.rpc.mock.calls.some(call=>JSON.stringify(call).includes(token))).toBe(false)
  expect(e.service.auth.admin.createUser).toHaveBeenCalledWith({id:'pending-id',email:'player@example.com',password,email_confirm:true})
  expect(e.service.rpc).toHaveBeenCalledWith('complete_player_invitation',{p_hash:expect.any(String),p_account:'pending-id'})
 })
 it('never overwrites an existing player password on interrupted invite retries',async()=>{
  const e=endpoint();e.service.auth.admin.getUserById.mockResolvedValue({data:{user:{id:'pending-id'} as any},error:null})
  e.sender.auth.signInWithPassword.mockResolvedValue({data:{user:null as any,session:null as any},error:{message:'Invalid password'}})
  const res=await e.call({action:'accept_player_invitation',token:'a'.repeat(64),username:'new.player',password})
  expect(res.status).toBe(400)
  expect(e.service.auth.admin.createUser).not.toHaveBeenCalled();expect(e.service.auth.admin.updateUserById).not.toHaveBeenCalled()
  expect(e.service.rpc).not.toHaveBeenCalledWith('complete_player_invitation',expect.anything())
 })
 it('uses self-service recovery without revealing account existence',async()=>{
  const e=endpoint(),res=await e.call({action:'recover_password',email:'coach@example.com'})
  expect(res.status).toBe(200);expect((await res.json()).message).toContain('If an account exists')
  expect(e.sender.auth.resetPasswordForEmail).toHaveBeenCalledWith('coach@example.com',{redirectTo:'https://count.twelvefs.com/'})
 })
 it('keeps the per-email recovery bucket stable when the verified network address changes',async()=>{
  const e=endpoint(),body={action:'recover_password',email:'coach@example.com'}
  await e.call(body,{},'192.0.2.1');await e.call(body,{},'192.0.2.2')
  const buckets=e.service.rpc.mock.calls.filter(c=>c[0]==='onboarding_limit') as unknown as [string,{p_bucket:string;p_max:number}][]
  expect(buckets).toHaveLength(4);expect(buckets[0][1].p_bucket).not.toBe(buckets[2][1].p_bucket)
  expect(buckets[1][1].p_bucket).toBe(buckets[3][1].p_bucket);expect(JSON.stringify(buckets)).not.toContain(body.email)
 })
 it('derives stable private invitation links for retries, and passes only a hash to SQL',async()=>{
  const e=endpoint(),actor='10000000-0000-4000-8000-000000000002',teamId='20000000-0000-4000-8000-000000000001',requestId='30000000-0000-4000-8000-000000000001'
  e.service.auth.getUser.mockResolvedValue({data:{user:{id:actor,email:'coach@example.com',email_confirmed_at:'today'} as any},error:null})
  e.tables.coaches={id:actor,email:'coach@example.com',active:true,role:'coach'}
  const input={action:'player_invitations',operation:'create',teamId,requestId,name:'Player'}
  const first=await e.call(input),second=await e.call(input)
  expect(first.status,JSON.stringify(await first.clone().json())).toBe(200);const link=(await first.json()).inviteLink
  expect((await second.json()).inviteLink).toBe(link)
  expect(link).toMatch(/^https:\/\/count.twelvefs.com\/#player-invite=[a-f0-9]{64}$/)
  const calls=e.service.rpc.mock.calls.filter(c=>c[0]==='manage_player_invitation') as unknown as [string,{p_data:{tokenHash:string;requestId:string}}][]
  expect(calls[0][1].p_data.requestId).toBe(requestId)
  expect(calls[0][1].p_data.tokenHash).not.toBe(link.split('=')[1])
  expect(JSON.stringify(calls)).not.toContain(link.split('=')[1])
 })
})
