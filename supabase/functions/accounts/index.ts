import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { accountEmail,accountRequest,requiredText,requestConfirmation } from '../../../src/account-validation.ts'
const service = createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{ auth:{ persistSession:false,autoRefreshToken:false } })
const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://count.twelvefs.com').split(',').map(s => s.trim())
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('Invalid identifier'); return v }
async function checked<T>(query: PromiseLike<{ data:T;error:{message:string;code?:string}|null }>): Promise<T> {
  const {data,error} = await query
  if (error) throw Object.assign(new Error(error.message),{ status:error.code === '42501' ? 403 : 400 })
  return data
}
Deno.serve(async req => {
  const origin = req.headers.get('origin') ?? ''
  const headers = { 'Access-Control-Allow-Origin':origins.includes(origin) ? origin : origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin','Content-Type':'application/json' }
  const reply = (body: unknown,status = 200) => new Response(JSON.stringify(body),{status,headers})
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers})
  if (req.method !== 'POST') return reply({error:'Method not allowed'},405)
  if (origin && !origins.includes(origin)) return reply({error:'Origin not allowed'},403)
  try {
    const raw = await req.text()
    if (raw.length > 20_000) return reply({error:'Request too large'},413)
    const body = JSON.parse(raw)
    if (body.action === 'request') {
      const request = accountRequest(body)
      const salt = Deno.env.get('REQUEST_RATE_SALT')
      if (!salt) return reply({error:'Account requests are not configured. Contact the admin.'},503)
      const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${salt}:${ip}`))
      const bucket = Array.from(new Uint8Array(digest),n => n.toString(16).padStart(2,'0')).join('')
      await checked(service.rpc('submit_access_request',{p_name:request.name,p_email:request.email,p_team:request.requestedTeam,p_bucket:bucket}))
      return reply({message:requestConfirmation})
    }
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i,'') ?? ''
    const {data:auth,error:authError} = await service.auth.getUser(token)
    if (authError || !auth.user) return reply({error:'Sign in again to reconnect.',code:'reauth'},401)
    const profile = await checked(service.from('coaches').select('*').eq('id',auth.user.id).maybeSingle())
    if (!profile || !profile.active || !auth.user.identities?.some(i => i.provider === 'google') || !auth.user.email_confirmed_at || profile.email !== auth.user.email?.toLowerCase()) return reply({error:'Your account is unapproved or suspended. Contact the admin.',code:'access_denied'},403)
    if (body.action === 'profile') return reply(profile)
    if (profile.role !== 'admin') return reply({error:'Only the admin can manage accounts.'},403)
    const action = (name:string,data:unknown) => checked(service.rpc('account_action',{p_actor:profile.id,p_action:name,p_data:data}))
    if (body.action === 'list') {
      const [profiles,requests,memberships] = await Promise.all([
        checked(service.from('coaches').select('*').order('name')),
        checked(service.from('access_requests').select('*').order('created_at',{ascending:false})),
        checked(service.from('team_coaches').select('*')),
      ])
      return reply({profiles,requests,memberships})
    }
    if (body.action === 'reject') return reply(await action('reject',{id:uuid(body.id)}))
    if (body.action === 'create' || body.action === 'update') {
      if (!Array.isArray(body.teamIds) || typeof body.active !== 'boolean') throw new Error('Invalid account details')
      const teamIds = [...new Set(body.teamIds.map(uuid))]
      let id = body.id
      if (body.action === 'create') {
        const email = accountEmail(body.email),name = requiredText(body.name,100)
        const provision = await action('prepare',{email,name})
        id = provision.id
        const existing = await service.auth.admin.getUserById(id)
        if (!existing.data.user) {
          const {error} = await service.auth.admin.createUser({id,email,email_confirm:true,user_metadata:{name}})
          if (error) throw new Error('Account creation failed. Check the auth hook and retry.')
        }
      }
      return reply(await action('update',{id:uuid(id),active:body.active,teamIds}))
    }
    return reply({error:'Unknown action'},400)
  } catch (error) {
    return reply({error:error instanceof Error ? error.message : 'Request failed'},(error as {status?:number})?.status ?? 400)
  }
})
