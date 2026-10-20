import { createClient } from '@supabase/supabase-js'
const [email, name = 'Pitchwork admin'] = process.argv.slice(2)
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key || !email) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run: node scripts/bootstrap-admin.mjs your-email "Your name"')
const client = createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false } })
const { data:id,error } = await client.rpc('bootstrap_admin',{ p_email:email,p_name:name })
if (error) throw new Error(error.message)
const existing = await client.auth.admin.getUserById(id)
if (!existing.data.user) {
  const { error:creationError } = await client.auth.admin.createUser({ id,email:email.trim().toLowerCase(),email_confirm:true,user_metadata:{ name } })
  if (creationError) throw new Error(creationError.message)
}
const {data:link,error:linkError} = await client.auth.admin.generateLink({type:'recovery',email:email.trim().toLowerCase()})
if (linkError || !link.properties?.hashed_token) throw new Error('Admin created, but setup link could not be generated. Retry the command.')
const setup = new URL(process.env.PITCHWORK_APP_URL ?? 'https://count.twelvefs.com/')
if (setup.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(setup.hostname)) throw new Error('PITCHWORK_APP_URL must use HTTPS')
setup.hash = new URLSearchParams({'password-setup':link.properties.hashed_token}).toString()
console.log('Admin is ready. Open this PRIVATE, single-use link to choose your password:')
console.log(setup.toString())
