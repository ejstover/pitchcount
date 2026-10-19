import { createClient } from '@supabase/supabase-js'
import type { Coach } from './domain'

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
export const configurationError = !validConfiguration()
  ? 'Google login needs configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to public project credentials, then rebuild Pitchwork. See docs/AUTH.md.' : ''
export const authStorageKey = `pitchwork-auth:${url ?? 'unconfigured'}`
export const supabase = configurationError ? null : createClient(url!,key!,{ auth:{ storageKey:authStorageKey,flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true } })
export type AccountProfile = Coach
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
    return value && value.id === cachedSessionUserId() && typeof value.name === 'string' && typeof value.email === 'string' && ['admin','coach','viewer'].includes(value.role) && value.active === true ? value : null
  } catch { return null }
}
export function cacheProfile(profile: AccountProfile | null) {
  if (profile) localStorage.setItem(profileCacheKey,JSON.stringify(profile))
  else localStorage.removeItem(profileCacheKey)
}
export async function accountApi<T = unknown>(action: string,payload: Record<string,unknown> = {}): Promise<T> {
  if (!supabase) throw new AccountError(configurationError)
  const headers: Record<string,string> = { apikey:key!,'Content-Type':'application/json' }
  if (action !== 'request') {
    let timer: ReturnType<typeof setTimeout> | undefined
    const session = await Promise.race([supabase.auth.getSession(),new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new AccountError('Could not renew your session. Reconnect with Google when online.')),15000)
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
export async function signInWithGoogle() {
  if (!supabase) throw new AccountError(configurationError)
  if (!navigator.onLine) throw new AccountError('Connect to the internet to sign in with Google.')
  const {error} = await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:`${window.location.origin}/`,queryParams:{prompt:'select_account'}}})
  if (error) throw new AccountError('Could not start Google sign-in. Please retry.')
}
export function oauthError(): string {
  const query = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const code = query.get('error') ?? hash.get('error')
  if (!code) return ''
  history.replaceState(null,'',window.location.pathname)
  return code === 'access_denied' ? 'Google sign-in was canceled or your account has not been approved. Retry or request an account.' : 'Google sign-in could not finish. Retry, or request an account if an admin has not created yours.'
}
