import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { accountEmail,accountRequest,requiredText,requestConfirmation,playerUsername,validatePassword } from '../../../src/account-validation.ts'
import {publicAccountAction,validProxySecret,verifyAccountRequest,networkRateSubject} from '../../../src/account-proxy.ts'
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const serviceKey=secretKeys.default??Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const service = createClient(Deno.env.get('SUPABASE_URL')!,secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{ auth:{ persistSession:false,autoRefreshToken:false } })
const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://count.twelvefs.com').split(',').map(s => s.trim())
const appUrl = new URL(Deno.env.get('APP_URL') ?? 'https://count.twelvefs.com/')
if (appUrl.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(appUrl.hostname)) throw new Error('APP_URL must use HTTPS')
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('Invalid identifier'); return v }
async function checked<T>(query: PromiseLike<{ data:T;error:{message:string;code?:string}|null }>): Promise<T> {
  let result
  try{result=await query}catch{if(Deno.env.get('PITCHWORK_STAGE_TIMING')==='1')console.warn(JSON.stringify({event:'staging_account_backend_failure',code:'network'}));throw Object.assign(new Error('Account service is temporarily unavailable. Please retry.'),{status:503})}
  const {data,error} = result
  if (error) {
    const transient=/^(08|PGRST00[0-3]$|57P0[123]$|53300$|57014$)/.test(error.code??'')
    if(transient && Deno.env.get('PITCHWORK_STAGE_TIMING')==='1')console.warn(JSON.stringify({event:'staging_account_backend_failure',code:error.code}))
    throw Object.assign(new Error(transient?'Account service is temporarily unavailable. Please retry.':error.message),{ status:transient?503:error.code === '42501' ? 403 : 400 })
  }
  return data
}
Deno.serve(async req => {
  const timing=Deno.env.get('PITCHWORK_STAGE_TIMING')==='1',started=Date.now(),spans:Record<string,number>={}
  async function timed<T>(name:string,query:PromiseLike<T>):Promise<T>{const begin=Date.now();try{return await query}finally{if(timing)spans[name]=(spans[name]??0)+Date.now()-begin}}
  const origin = req.headers.get('origin') ?? ''
  const headers = { 'Access-Control-Allow-Origin':origins.includes(origin) ? origin : origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin','Content-Type':'application/json' }
  const reply = (body: unknown,status = 200) => new Response(JSON.stringify(body),{status,headers:{...headers,...(timing?{'Server-Timing':Object.entries({...spans,total:Date.now()-started}).map(([name,duration])=>`${name};dur=${duration}`).join(', ')}:{})}})
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers})
  if (req.method !== 'POST' && req.method !== 'GET') return reply({error:'Method not allowed'},405)
  if (origin && !origins.includes(origin)) return reply({error:'Origin not allowed'},403)
  try {
    // Profile reads are idempotent and carry no body. This also lets the runtime
    // safely reassign them when an isolate retires before accepting a request.
    let body:Record<string,any>={action:'profile'}
    let rawBody=new Uint8Array(0)
    if(req.method==='GET' && req.body!==null)return reply({error:'Invalid profile request'},400)
    if(req.method==='POST') {
    if(Number(req.headers.get('content-length'))>20_000)return reply({error:'Request too large'},413)
    const reader=req.body?.getReader(),chunks:Uint8Array[]=[]
    let total=0
    if(reader)try {
      while(true) {
        const part=await reader.read()
        if(part.done)break
        total+=part.value.byteLength
        if(total>20_000){await reader.cancel();return reply({error:'Request too large'},413)}
        chunks.push(part.value)
      }
    }finally{reader.releaseLock()}
    const input=new Uint8Array(total);let offset=0
    for(const chunk of chunks){input.set(chunk,offset);offset+=chunk.byteLength}
    rawBody=input
    try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input));if(!body||Array.isArray(body)||typeof body!=='object')throw new Error()}
    catch{throw new Error('Invalid account request')}
    }
    let peer:string|null=null
    if(publicAccountAction(body.action)){
      const current=Deno.env.get('ACCOUNT_PROXY_SECRET'),previous=Deno.env.get('ACCOUNT_PROXY_PREVIOUS_SECRET')
      if(!validProxySecret(current)||previous!==undefined&&!validProxySecret(previous))return reply({error:'Account setup is temporarily unavailable. Please try again later.'},503)
      try{peer=await verifyAccountRequest(previous?[current,previous]:[current],appUrl.origin,req.headers,rawBody)}
      catch{return reply({error:'Account verification is temporarily unavailable. Please retry.'},503)}
      if(!peer)return reply({error:'Open the current Pitchwork app and retry this request.'},403)
    }
    const network=peer?networkRateSubject(peer):null,forwardIp=Deno.env.get('AUTH_TRUSTED_IP_FORWARDING')==='1'
    if(peer&&forwardIp&&!serviceKey.startsWith('sb_secret_'))return reply({error:'Account setup is temporarily unavailable. Please try again later.'},503)
    const newAuthClient=()=>createClient(Deno.env.get('SUPABASE_URL')!,serviceKey,{auth:{persistSession:false,autoRefreshToken:false},...(peer&&forwardIp?{global:{headers:{'Sb-Forwarded-For':peer}}}:{})})
    async function hash(value:string) {
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
      return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')
    }
    async function limit(scope:string,max=20,subject?:string) {
      const salt=Deno.env.get('REQUEST_RATE_SALT')
      if(!salt) throw Object.assign(new Error('Account setup is temporarily unavailable. Please try again later.'),{status:503})
      if(!subject&&!network)throw Object.assign(new Error('Verified account ingress is required.'),{status:503})
      const allowed=await checked(service.rpc('onboarding_limit',{p_bucket:await hash(`${salt}:${scope}:${subject??network}`),p_max:max}))
      if(!allowed) throw Object.assign(new Error('Too many attempts. Please try again later.'),{status:429})
    }
    if(body.action==='coach_signup') {
      const name=requiredText(body.name,100),email=accountEmail(body.email),team=requiredText(body.teamName,200)
      await limit('coach-signup',10)
      const provision=await checked(service.rpc('reserve_coach_signup',{p_name:name,p_email:email,p_team:team,p_bucket:await hash(`email:${email}`)}))
      if(provision) {
        const existing=await service.auth.admin.getUserById(provision.id)
        if(!existing.data.user) {
          const {error}=await service.auth.admin.createUser({id:provision.id,email:provision.email,email_confirm:false})
          if(error) throw new Error('Could not prepare your account. Wait a minute and retry.')
        }
        const sender=newAuthClient()
        const {error}=await sender.auth.signInWithOtp({email:provision.email,options:{shouldCreateUser:false}})
        if(error) throw Object.assign(new Error('Could not send your code. Wait a minute and resend it.'),{status:503})
      }
      return reply({message:'If this email can create a new account, a verification code is on its way. Already registered? Sign in instead.'})
    }
    if(body.action==='verify_coach_signup') {
      await limit('verify-signup')
      const email=accountEmail(body.email)
      await limit('verify-signup-email',20,email)
      if(typeof body.password!=='string') throw new Error('Choose a password.')
      validatePassword(body.password)
      if(typeof body.code!=='string' || !/^[0-9]{6,10}$/.test(body.code)) throw new Error('Enter the code from your email.')
      const provision=await checked(service.from('account_provisions').select('id').eq('email',email).maybeSingle())
      const signup=provision && await checked(service.from('coach_signups').select('account_id,completed_at').eq('account_id',provision.id).maybeSingle())
      if(!signup) throw new Error('This code is invalid or expired. Resend the code or sign in to your existing account.')
      const verifier=newAuthClient()
      const {data,error}=await verifier.auth.verifyOtp({email,token:body.code,type:'email'})
      if(error || !data.session || data.user?.id!==signup.account_id || !data.user?.email_confirmed_at) throw new Error('This code is invalid or expired. Resend it and try again.')
      // Never reset a completed/suspended account through the signup endpoint.
      if(signup.completed_at) throw new Error('Your account is already created. Sign in or reset your password.')
      const saved=await service.auth.admin.updateUserById(data.user.id,{password:body.password})
      if(saved.error) throw new Error('Could not save your password. Resend your code and try again.')
      await checked(service.rpc('complete_coach_signup',{p_account:data.user.id}))
      // Establish a fresh session after the password change, including when
      // Auth revokes earlier verification sessions as part of that change.
      const signedIn=await verifier.auth.signInWithPassword({email,password:body.password})
      if(signedIn.error || !signedIn.data.session || signedIn.data.user?.id!==data.user.id) throw new Error('Your team is ready. Sign in with your email and new password to continue.')
      return reply({access_token:signedIn.data.session.access_token,refresh_token:signedIn.data.session.refresh_token})
    }
    if(['invitation_details','accept_player_invitation'].includes(body.action)) {
      await limit('player-invitation',30)
      if(typeof body.token!=='string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new Error('This invitation is invalid. Ask your coach for a new link.')
      const tokenHash=await hash(body.token)
      await limit('player-invitation-token',30,tokenHash)
      const details=await checked(service.rpc('player_invitation_details',{p_hash:tokenHash}))
      if(!details) throw new Error('This invitation is unavailable or expired. Ask your coach for a new link.')
      if(body.action==='invitation_details') return reply(details)
      const username=playerUsername(body.username)
      if(typeof body.password!=='string') throw new Error('Choose a password.')
      validatePassword(body.password)
      const provision=await checked(service.rpc('reserve_invited_player',{p_hash:tokenHash,p_username:username}))
      const existing=await service.auth.admin.getUserById(provision.id)
      if(!existing.data.user) {
        const {error}=await service.auth.admin.createUser({id:provision.id,email:provision.email,password:body.password,email_confirm:true})
        if(error) throw new Error('Could not create your player account. Retry with the same username and password.')
      }
      const verifier=newAuthClient()
      const {data,error}=await verifier.auth.signInWithPassword({email:provision.email,password:body.password})
      if(error || !data.session || data.user?.id!==provision.id) throw new Error('Retry with the username and password originally chosen for this link, or ask your coach for a replacement.')
      await checked(service.rpc('complete_player_invitation',{p_hash:tokenHash,p_account:provision.id}))
      return reply({access_token:data.session.access_token,refresh_token:data.session.refresh_token})
    }
    if(body.action==='recover_password') {
      await limit('password-recovery',5)
      const email=accountEmail(body.email)
      await limit('password-recovery-email',5,email)
      const sender=newAuthClient()
      const {error}=await sender.auth.resetPasswordForEmail(email,{redirectTo:appUrl.toString()})
      if(error) throw Object.assign(new Error('Could not send a reset email. Please try again later.'),{status:503})
      return reply({message:'If an account exists, a password reset email is on its way. Check your inbox and spam folder.'})
    }
    if(body.action==='player_login') {
      const salt=Deno.env.get('REQUEST_RATE_SALT')
      if(!salt)return reply({error:'Player sign-in is not configured.'},503)
      const username=typeof body.username==='string'?body.username.trim().toLowerCase():''
      for(const value of [`ip:${network}`,`user:${username}`]) {
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${salt}:${value}`))
        const bucket=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')
        const {error}=await service.rpc('player_login_limit',{p_bucket:bucket})
        if(error)return reply({error:'Could not sign in. Try again later.'},429)
      }
      const failure=()=>reply({error:'Could not sign in. Check your username and password.'},401)
      if(!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(username) || typeof body.password!=='string' || body.password.length>72)return failure()
      const {data:target}=await service.from('coaches').select('email,active').eq('username',username).eq('role','player').maybeSingle()
      const authClient=newAuthClient()
      const {data,error}=await authClient.auth.signInWithPassword({email:target?.email??'unknown@players.pitchwork.invalid',password:body.password})
      if(error || !data.session || !target?.active)return failure()
      return reply({access_token:data.session.access_token,refresh_token:data.session.refresh_token})
    }
    if (body.action === 'verify_request') {
      const email=accountEmail(body.email)
      if(typeof body.code!=='string' || !/^[0-9]{6,10}$/.test(body.code)) throw new Error('Enter the verification code from your email.')
      await limit('verify-request-email',20,email)
      const pending=await checked(service.from('access_requests').select('account_id').eq('email',email).eq('status','pending').maybeSingle())
      if(!pending?.account_id) throw new Error('This code is invalid or expired. Request a new code and try again.')
      const verifier=newAuthClient()
      const {data,error}=await verifier.auth.verifyOtp({email,token:body.code,type:'email'})
      if(error || data.user?.id!==pending.account_id || !data.user?.email_confirmed_at) throw new Error('This code is invalid or expired. Request a new code and try again.')
      await checked(service.rpc('confirm_access_request',{p_account:data.user.id}))
      return reply({message:'Email verified—waiting for admin approval.'})
    }
    if (body.action === 'request') {
      const request = accountRequest(body)
      const salt = Deno.env.get('REQUEST_RATE_SALT')
      if (!salt) return reply({error:'Account requests are not configured. Contact the admin.'},503)
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${salt}:${network}`))
      const bucket = Array.from(new Uint8Array(digest),n => n.toString(16).padStart(2,'0')).join('')
      const provision=await checked(service.rpc('reserve_access_request',{p_name:request.name,p_email:request.email,p_team:request.requestedTeam,p_role:request.role,p_username:request.username,p_bucket:bucket}))
      if(provision?.usernameUnavailable) return reply({error:'That player username is unavailable. Choose another username.'},400)
      if(provision) {
        const existing=await service.auth.admin.getUserById(provision.id)
        if(!existing.data.user) {
          const {error}=await service.auth.admin.createUser({id:provision.id,email:provision.email,email_confirm:false})
          if(error) throw new Error('Could not prepare email verification. Retry in a minute.')
        }
        const sender=newAuthClient()
        const {error}=await sender.auth.signInWithOtp({email:provision.email,options:{shouldCreateUser:false}})
        if(error) return reply({error:'Could not send your verification email. Wait a minute and retry, or contact the admin.'},503)
      }
      return reply({message:requestConfirmation})
    }
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i,'') ?? ''
    let verification
    try{verification=await timed('auth',service.auth.getUser(token))}catch{return reply({error:'Sign-in verification is temporarily unavailable. Please retry.',code:'auth_unavailable'},503)}
    const {data:auth,error:authError}=verification
    if(authError && (!authError.status || authError.status>=500 || authError.status===429))return reply({error:'Sign-in verification is temporarily unavailable. Please retry.',code:'auth_unavailable'},503)
    if (authError || !auth.user) return reply({error:'Sign in again to reconnect.',code:'reauth'},401)
    const context=body.action==='profile'?await timed('context',checked(service.rpc('account_context',{p_actor:auth.user.id}))):null
    const profile = body.action==='profile'?context?.profile:await timed('profile',checked(service.from('coaches').select('*').eq('id',auth.user.id).maybeSingle()))
    if(profile && !profile.active) {
      const pending=body.action==='profile'?{status:context?.requestStatus}:await checked(service.from('access_requests').select('status').eq('account_id',profile.id).maybeSingle())
      if(pending?.status==='pending') return reply({error:auth.user.email_confirmed_at?'Email verified—waiting for admin approval.':'Verify your email before the admin can approve your account.',code:'approval_pending'},403)
    }
    if (!profile || !profile.active || !auth.user.email_confirmed_at || profile.email !== auth.user.email?.toLowerCase()) return reply({error:'Your account is unapproved or suspended. Contact the admin.',code:'access_denied'},403)
    if (body.action === 'profile') {
      return reply({...profile,pitcherId:context?.pitcherId??null,onboardingTeamId:context?.onboardingTeamId??null})
    }
    if(body.action==='finish_onboarding' && profile.role==='coach') {
      await checked(service.from('coach_signups').update({onboarding_finished_at:new Date().toISOString()}).eq('account_id',profile.id))
      return reply({})
    }
    if(body.action==='player_invitations' && ['coach','admin'].includes(profile.role)) {
      const input:{teamId:string;id?:string;requestId?:string;pitcherId?:string|null;name?:string;tokenHash?:string}={teamId:uuid(body.teamId)}
      if(!['list','create','revoke'].includes(body.operation)) throw new Error('Unknown invitation action')
      if(body.operation==='revoke') input.id=uuid(body.id)
      let token=''
      if(body.operation==='create') {
        input.requestId=uuid(body.requestId)
        const salt=Deno.env.get('REQUEST_RATE_SALT')
        if(!salt) throw Object.assign(new Error('Invitations are temporarily unavailable.'),{status:503})
        // Stable across an uncertain retry, without persisting the bearer secret.
        const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(salt),{name:'HMAC',hash:'SHA-256'},false,['sign'])
        const signature=await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(`player-invite:${profile.id}:${input.requestId}`))
        token=Array.from(new Uint8Array(signature),n=>n.toString(16).padStart(2,'0')).join('')
        input.tokenHash=await hash(token)
        input.pitcherId=body.pitcherId ? uuid(body.pitcherId) : null
        if(!input.pitcherId) input.name=requiredText(body.name,100)
      }
      const result=await checked(service.rpc('manage_player_invitation',{p_actor:profile.id,p_action:body.operation,p_data:input}))
      if(result?.limited) return reply({error:'Invitation limit reached. Please try again later.'},429)
      if(!token) return reply(result)
      const link=new URL(appUrl);link.hash=new URLSearchParams({'player-invite':token}).toString()
      return reply({...result,inviteLink:link.toString()})
    }
    if(body.action==='provision_player' && ['admin','coach'].includes(profile.role)) {
      const username=requiredText(body.username,24).toLowerCase()
      const pending=await checked(service.from('account_provisions').select('id').eq('username',username).eq('active',false).maybeSingle())
      if(pending) throw new Error('This username belongs to an account request. Ask the admin to review it.')
      const provision=await checked(service.rpc('prepare_username_player',{p_actor:profile.id,p_pitcher:uuid(body.pitcherId),p_username:username}))
      const existing=await service.auth.admin.getUserById(provision.id)
      if(!existing.data.user){const {error}=await service.auth.admin.createUser({id:provision.id,email:provision.email,email_confirm:true});if(error)throw new Error('Player setup failed. Retry with the same username.')}
      await checked(service.from('coaches').update({username}).eq('id',provision.id))
      const {data,error}=await service.auth.admin.generateLink({type:'recovery',email:provision.email})
      if(error || !data.properties?.hashed_token)throw new Error('Could not create player setup link. Use password recovery.')
      const link=new URL(appUrl);link.hash=new URLSearchParams({'password-setup':data.properties.hashed_token}).toString()
      return reply({username,setupLink:link.toString()})
    }
    if(profile.role==='coach' && body.action==='reset_password') {
      const link=await checked(service.from('player_accounts').select('pitcher_id').eq('account_id',uuid(body.id)).maybeSingle())
      const pitcher=link && await checked(service.from('pitchers').select('owner_id').eq('id',link.pitcher_id).single())
      if(pitcher?.owner_id!==profile.id)return reply({error:'Only the player owner or admin can recover this account.'},403)
      const target=await checked(service.from('coaches').select('email,active').eq('id',body.id).single())
      if(!target.active)return reply({error:'Ask the admin to reactivate this account.'},403)
      const {data,error}=await service.auth.admin.generateLink({type:'recovery',email:target.email})
      if(error || !data.properties?.hashed_token)throw new Error('Could not create recovery link')
      const setup=new URL(appUrl);setup.hash=new URLSearchParams({'password-setup':data.properties.hashed_token}).toString()
      return reply({setupLink:setup.toString()})
    }
    if (profile.role !== 'admin') return reply({error:'Only the admin can manage accounts.'},403)
    const action = (name:string,data:unknown) => checked(service.rpc('account_action',{p_actor:profile.id,p_action:name,p_data:data}))
    async function setupLink(id:string) {
      const target = await checked(service.from('coaches').select('email,active').eq('id',id).single())
      if (!target?.active) throw new Error('Reactivate the account before creating a password setup link.')
      const {data,error} = await service.auth.admin.generateLink({type:'recovery',email:target.email})
      if (error || !data.properties?.hashed_token) throw new Error('Could not create the password setup link. Retry from the account list.')
      const link = new URL(appUrl)
      link.hash = new URLSearchParams({'password-setup':data.properties.hashed_token}).toString()
      return {setupLink:link.toString()}
    }
    if (body.action === 'list') {
      return reply(await checked(service.rpc('admin_directory',{p_actor:profile.id,p_after:body.after?uuid(body.after):null,p_request_after:body.requestAfter?uuid(body.requestAfter):null,p_filter:body.filter??'active',p_search:typeof body.search==='string'?body.search:''})))
    }
    if(body.action==='find_teams') return reply(await checked(service.rpc('admin_find_teams',{p_actor:profile.id,p_search:requiredText(body.search,100)})))
    if (['removalPreview','deleteRecord','suspendRecord','retryDeletion'].includes(body.action)) {
      if (!['coach','request'].includes(body.kind)) throw new Error('Unsupported account removal')
      const result = await action(body.action,{kind:body.kind,id:uuid(body.id),confirmation:body.confirmation})
      if (result?.deleteAuthId) {
        const {error} = await service.auth.admin.deleteUser(uuid(result.deleteAuthId))
        if (error && error.code !== 'user_not_found' && error.status !== 404) throw new Error('Account access was removed. Authentication cleanup failed; retry Delete permanently to finish.')
        await action('finishDeletion',{kind:'coach',id:uuid(result.deleteAuthId)})
      }
      return reply(result)
    }
    if (body.action === 'approve_request') {
      const approved=await checked(service.rpc('approve_access_request',{p_actor:profile.id,p_request:uuid(body.requestId),p_team:body.teamId?uuid(body.teamId):null}))
      return reply(await setupLink(approved.id))
    }
    if (body.action === 'reject') return reply(await action('reject',{id:uuid(body.id)}))
    if (body.action === 'reset_password') return reply(await setupLink(uuid(body.id)))
    if (body.action === 'create') throw new Error('Send an account request and verify the email before approving a new account.')
    if (body.action === 'update') {
      if (!Array.isArray(body.teamIds) || typeof body.active !== 'boolean') throw new Error('Invalid account details')
      const teamIds = [...new Set(body.teamIds.map(uuid))]
      let id = body.id
      const target = await checked(service.from('coaches').select('role').eq('id',uuid(id)).single())
      await action('update',{id:uuid(id),active:body.active,teamIds,pitcherId:target.role === 'player' ? uuid(body.pitcherId) : null})
      return reply({})
    }
    return reply({error:'Unknown action'},400)
  } catch (error) {
    return reply({error:error instanceof Error ? error.message : 'Request failed'},(error as {status?:number})?.status ?? 400)
  }
})
