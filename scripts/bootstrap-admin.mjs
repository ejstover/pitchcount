import { createClient } from '@supabase/supabase-js'
const [email, name = 'Pitchwork admin'] = process.argv.slice(2)
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key || !email) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run: node scripts/bootstrap-admin.mjs your-google-email "Your name"')
const client = createClient(url,key,{ auth:{ persistSession:false,autoRefreshToken:false } })
const { data:id,error } = await client.rpc('bootstrap_admin',{ p_email:email,p_name:name })
if (error) throw new Error(error.message)
const existing = await client.auth.admin.getUserById(id)
if (!existing.data.user) {
  const { error:creationError } = await client.auth.admin.createUser({ id,email:email.trim().toLowerCase(),email_confirm:true,user_metadata:{ name } })
  if (creationError) throw new Error(creationError.message)
}
console.log('Admin is ready. Sign in with the matching Google account.')
