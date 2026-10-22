import { createClient } from '@supabase/supabase-js'
import type { Coach } from './domain'
import { accountEmail,validatePassword } from './account-validation'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
function validConfiguration() {
  if (!url || !key || url.includes('YOUR_PROJECT') || key.startsWith('sb_secret_')) return false
  try {
    const parsed = new URL(url)
    if (!['http:','https:'].includes(parsed.protocol)) return false
    if (key.split('.').length === 3 && JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role === 'service_role') return false
    return true
  } catch { return false }
}
export const transportError = typeof window !== 'undefined' && !window.isSecureContext ? 'Open Pitchwork using HTTPS before entering a password. The local development server on localhost is also supported.' : ''
export const configurationError = transportError || (!validConfiguration()
  ? 'Login needs configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to public project credentials, then rebuild Pitchwork. See docs/AUTH.md.' : '')
export const authStorageKey = `pitchwork-auth:${url ?? 'unconfigured'}`
export const supabase = configurationError ? null : createClient(url!,key!,{ auth:{ storageKey:authStorageKey,flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true } })
export type AccountProfile = Coach & ({role:'player';pitcherId:string|null}|{role:'admin'|'coach'|'viewer'})
export class AccountError extends Error {
  constructor(message: string,public status = 0,public code = '') { super(message) }
}
export const profileCacheKey = `pitchwork-approved:${url ?? 'unconfigured'}`
export function cachedSessionUserId(): string | null {
  try { return JSON.parse(localStorage.getItem(authStorageKey) ?? 'null')?.user?.id ?? null } catch { return null }
}
export function readCachedProfile(): AccountProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(profileCacheKey) ?? 'null')
    return value && value.id === cachedSessionUserId() && typeof value.name === 'string' && typeof value.email === 'string' && ['admin','coach','viewer','player'].includes(value.role) && value.active === true ? value : null
  } catch { return null }
}
export function cacheProfile(profile: AccountProfile | null) {
  if (profile) localStorage.setItem(profileCacheKey,JSON.stringify(profile))
  else localStorage.removeItem(profileCacheKey)
}
export async function accountApi<T = unknown>(action: string,payload: Record<string,unknown> = {}): Promise<T> {
  if (!supabase) throw new AccountError(configurationError)
  const headers: Record<string,string> = { apikey:key!,'Content-Type':'application/json' }
  if (!['request','player_login'].includes(action)) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const session = await Promise.race([supabase.auth.getSession(),new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new AccountError('Could not renew your session. Sign in again when online.')),15000)
    })]).finally(() => clearTimeout(timer))
    if (!session.data.session) throw new AccountError('Sign in again to reconnect.',401,'reauth')
    headers.Authorization = `Bearer ${session.data.session.access_token}`
  }
  let response: Response
  try {
    response = await fetch(`${url}/functions/v1/accounts`,{method:'POST',headers,body:JSON.stringify({...payload,action}),signal:AbortSignal.timeout(12000)})
  } catch { throw new AccountError('Could not connect. Check your connection and retry.') }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new AccountError(body.error ?? 'The request could not be completed.',response.status,body.code ?? '')
  return body as T
}
export const loadProfile = () => accountApi<AccountProfile>('profile')
export async function signInWithPassword(email:string,password:string) {
  if (!supabase) throw new AccountError(configurationError)
  if (!navigator.onLine) throw new AccountError('Connect to the internet to sign in.')
  if(!email.includes('@')) {
    const session=await accountApi<{access_token:string;refresh_token:string}>('player_login',{username:email.trim().toLowerCase(),password})
    const {error}=await supabase.auth.setSession(session)
    if(error) throw new AccountError('Could not sign in. Check your username and password.')
    return
  }
  const {error} = await supabase.auth.signInWithPassword({email:accountEmail(email),password})
  if (error) throw new AccountError(error.status === 429 ? 'Too many sign-in attempts. Wait a little before retrying.' : 'Could not sign in. Check your email and password, or ask the admin to approve your account.')
}
export function authRedirectError(): string {
  const query = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const code = query.get('error') ?? hash.get('error')
  if (!code) return ''
  history.replaceState(null,'',window.location.pathname)
  return 'This sign-in link could not be used. Ask the admin for a new password setup link.'
}
export function readSetupToken():string|null {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  return fragment.get('password-setup')
}
export async function setAccountPassword(password:string,token:string|null) {
  if (!supabase) throw new AccountError(configurationError)
  validatePassword(password)
  if (token) {
    const {data,error} = await supabase.auth.verifyOtp({token_hash:token,type:'recovery'})
    if (error || !data.user) throw new AccountError('This setup link has expired or has already been used. Ask the admin for a new one.')
    sessionStorage.setItem('pitchwork-password-setup',data.user.id)
  }
  const profile = await loadProfile()
  if (sessionStorage.getItem('pitchwork-password-setup') !== profile.id) throw new AccountError('Ask the admin for a new password setup link.')
  const {error} = await supabase.auth.updateUser({password})
  if (error) throw new AccountError('Could not save your password. Check the connection and password requirements, then retry.')
  sessionStorage.removeItem('pitchwork-password-setup')
}
