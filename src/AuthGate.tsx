import { useEffect,useRef,useState } from 'react'
import { App } from './App'
import { Login } from './Login'
import { AccountError,cacheProfile,cachedSessionUserId,configurationError,transportError,loadProfile,authRedirectError,readCachedProfile,readSetupToken,supabase,type AccountProfile } from './auth'
import { PasswordSetup } from './PasswordSetup'
import { SupabaseGateway,getDeviceId } from './cloud'
import { PitchDatabase,Repository } from './storage'
import { usePwa } from './pwa'
type Access = {profile:AccountProfile;repository:Repository}

export function AuthGate() {
  const [access,setAccess] = useState<Access|null>(null)
  const [loading,setLoading] = useState(!configurationError)
  const [message,setMessage] = useState(authRedirectError)
  const [setup,setSetup] = useState<string|null>(() => readSetupToken() ?? (sessionStorage.getItem('pitchwork-password-setup') ? '' : null))
  const setupMode = useRef(setup !== null)
  const [lockedRecovery,setLockedRecovery] = useState<Repository|null>(null)
  const recovery = useRef<Repository|null>(null)
  const setRecovery = (repository:Repository|null) => {recovery.current = repository;setLockedRecovery(repository)}
  const current = useRef<Access|null>(null)
  const mounted = useRef(false)
  const checking = useRef<Promise<void>|null>(null)
  usePwa()
  async function open(profile:AccountProfile,offline:boolean) {
    if (!mounted.current || !supabase) return
    if (profile.id !== cachedSessionUserId()) throw new AccountError('Account changed. Checking the new session.',401)
    recovery.current?.db.close();setRecovery(null)
    if (current.current?.profile.id === profile.id) {
      if (!offline) await current.current.repository.sync()
      if (profile.id !== cachedSessionUserId() || !current.current) return
      current.current = {...current.current,profile};setAccess(current.current);return
    }
    current.current?.repository.db.close()
    const repository = new Repository(new PitchDatabase(`pitchwork-account-${profile.id}`),{coachId:profile.id,deviceId:getDeviceId()},new SupabaseGateway(supabase))
    if (offline && !await repository.db.coaches.get(profile.id)) {repository.db.close();throw new Error('Connect once to download your teams before opening Pitchwork offline.')}
    if (!offline) {
      await repository.sync()
      if (repository.syncMessage && !await repository.db.coaches.get(profile.id)) {repository.db.close();throw new Error(repository.syncMessage)}
    }
    if (!mounted.current || profile.id !== cachedSessionUserId()) {repository.db.close();return}
    cacheProfile(profile)
    current.current = {profile,repository};setAccess(current.current)
  }
  async function verify() {
    if (checking.current) return checking.current
    checking.current = Promise.resolve().then(async () => {
      try {
        if (configurationError || setupMode.current) return
        const cached = readCachedProfile()
        if (!navigator.onLine) {
          if (cached) {await open(cached,true);setMessage('Offline access · showing records previously downloaded to this device.')}
          else setMessage('Connect to the internet for your first sign-in.')
          return
        }
        const profile = await loadProfile()
        await open(profile,false);if (mounted.current) setMessage('')
      } catch(cause) {
        const error = cause as AccountError
        if (error.status === 403) {
          // Stop normal access immediately. Pending records stay isolated for
          // recovery and cannot upload until server access is restored.
          cacheProfile(null)
          const previous = current.current
          current.current = null;setAccess(null)
          const userId = previous?.profile.id ?? cachedSessionUserId()
          const repository = previous?.repository ?? (recovery.current?.identity.coachId === userId ? recovery.current : userId && supabase ? new Repository(new PitchDatabase(`pitchwork-account-${userId}`),{coachId:userId,deviceId:getDeviceId()},new SupabaseGateway(supabase)) : null)
          if (repository) {
            if (await repository.hasPending()) setRecovery(repository)
            else {await repository.clearCache();repository.db.close()}
          }
        } else if (!error.status && !current.current) {
          const cached = readCachedProfile()
          if (cached) {
            try {await open(cached,true)} catch { /* No downloaded cache available. */ }
          }
        }
        if (mounted.current && !(error.status === 401 && !cachedSessionUserId())) setMessage(error.message || 'Could not check account access. Retry when connected.')
      } finally {if (mounted.current) setLoading(false);checking.current = null}
    })
    return checking.current
  }
  useEffect(() => {
    mounted.current = true;void verify()
    const refresh = () => {if (!document.hidden) void verify()}
    const setupLink = () => {const token = readSetupToken();if (token) {setupMode.current = true;setSetup(token);setLoading(false)}}
    window.addEventListener('hashchange',setupLink)
    window.addEventListener('online',refresh);window.addEventListener('offline',refresh);window.addEventListener('focus',refresh)
    document.addEventListener('visibilitychange',refresh)
    const timer = window.setInterval(refresh,30000)
    // Do not await Supabase calls inside its auth event callback (SDK lock).
    const subscription = supabase?.auth.onAuthStateChange((event,session) => {
      if (event === 'PASSWORD_RECOVERY') {setupMode.current = true;setSetup(previous => previous ?? '');setLoading(false)}
      if (event === 'SIGNED_IN' && recovery.current && recovery.current.identity.coachId !== session?.user.id) {recovery.current.db.close();setRecovery(null)}
      if (event === 'SIGNED_IN' && current.current && session?.user.id !== current.current.profile.id) {
        current.current.repository.db.close();current.current = null;setAccess(null);setLoading(true)
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') setTimeout(() => {void (async () => {await checking.current;refresh()})()},0)
      if (event === 'SIGNED_OUT' && navigator.onLine) {
        current.current?.repository.db.close();current.current = null;setAccess(null)
        cacheProfile(null);setLoading(false);setMessage('Sign in again to reconnect. Saved practices remain isolated on this device.')
      }
    })
    return () => {
      mounted.current = false;clearInterval(timer)
      window.removeEventListener('hashchange',setupLink)
      window.removeEventListener('online',refresh);window.removeEventListener('offline',refresh);window.removeEventListener('focus',refresh)
      document.removeEventListener('visibilitychange',refresh);subscription?.data.subscription.unsubscribe()
    }
  },[])
  if (transportError) return <main className="account-gate card"><h1>Secure connection required.</h1><p role="alert">{transportError}</p></main>
  async function signOut() {
    const previous = current.current
    if (!previous || !supabase) return
    if (await previous.repository.hasPending()) throw new Error('Sync pending practices or export and recover them in Settings before signing out.')
    const snapshot = await previous.repository.snapshot()
    if (current.current?.repository !== previous.repository) throw new Error('The active account changed. Retry from the current account.')
    if (snapshot.sessions.some(s => previous.repository.owns(s) && s.status === 'active')) throw new Error('Pause or end your practice before signing out.')
    // Clear the account's local data before removing credentials; failure keeps
    // the current account open so it can retry safely.
    await previous.repository.clearCache()
    cacheProfile(null)
    current.current = null;setAccess(null);previous.repository.db.close()
    await supabase.auth.signOut({scope:'local'})
    setMessage('You’re signed out. This account’s downloaded records have been cleared.')
  }
  if (setup !== null) return <PasswordSetup initialToken={setup || null} onComplete={() => {setupMode.current = false;setSetup(null);setLoading(true);void verify()}} onCancel={() => {sessionStorage.removeItem('pitchwork-password-setup');setupMode.current = false;setSetup(null);setLoading(false);setMessage('Sign in with your email and password.')}}/>
  if (loading) return <main className="account-gate"><span className="eyebrow">PITCHWORK</span><h1>Opening your dugout…</h1><p>Checking your account and downloading your teams.</p></main>
  async function exportLockedRecovery() {
    if (!lockedRecovery) return
    const value = await lockedRecovery.exportRecovery()
    const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}))
    const anchor = document.createElement('a');anchor.href = url;anchor.download = `pitchwork-unsynced-${new Date().toISOString().replace(/[:.]/g,'-')}.json`
    document.body.append(anchor);anchor.click();anchor.remove();setTimeout(() => URL.revokeObjectURL(url),60000)
  }
  if (!access) return <Login message={message} onRetry={() => {setLoading(true);void verify()}} onExportRecovery={lockedRecovery ? exportLockedRecovery : undefined}/>
  return <>{message && <div className="account-status" role="alert"><span>{message}</span>{navigator.onLine && <><button onClick={() => void verify()}>Retry access</button><button onClick={() => {current.current = null;setAccess(null)}}>Sign in again</button></>}</div>}<App key={`${access.profile.id}:${access.profile.role}`} repository={access.repository} coach={access.profile} onSignOut={signOut}/></>
}
