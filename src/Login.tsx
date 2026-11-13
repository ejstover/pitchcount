import { userMessage } from './user-message'
import { useEffect,useState } from 'react'
import { accountApi,configurationError,signInWithPassword } from './auth'
import { accountRequest,requestConfirmation } from './account-validation'
import {CoachSignup} from './Onboarding'

export function Login({message = '',onRetry,onExportRecovery}:{message?:string;onRetry?:()=>void;onExportRecovery?:()=>Promise<void>}) {
  const [requesting,setRequesting] = useState(false)
  const [signup,setSignup]=useState(()=>!!sessionStorage.getItem('pitchwork-coach-signup'))
  const [resetMessage,setResetMessage]=useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [sent,setSent] = useState(false)
  const [role,setRole] = useState<'player'|'coach'>('player')
  const [draft,setDraft] = useState<ReturnType<typeof accountRequest>|null>(null)
  const [verified,setVerified] = useState(false)
  const [resendSeconds,setResendSeconds] = useState(0)
  const [resendAt,setResendAt] = useState(0)
  useEffect(() => {
    if (!resendAt) return
    const tick=()=>setResendSeconds(Math.max(0,Math.ceil((resendAt-Date.now())/1000)))
    tick();const timer=setInterval(tick,1000);return ()=>clearInterval(timer)
  },[resendAt])
  const [forgot,setForgot] = useState(false)
  if(signup) return <CoachSignup onCancel={()=>{sessionStorage.removeItem('pitchwork-coach-signup');setSignup(false)}} onComplete={()=>onRetry?.()}/>
  return <div className="login-shell"><section className="login-story"><a className="brand" href="/" aria-label="Pitchwork home"><span className="brand-mark">p<span>·</span></span><span>pitchwork<span className="brand-caption">MAKE EVERY PITCH COUNT</span></span></a><div><span className="eyebrow">YOUR TEAM. EVERY REP.</span><h1>A place for<br/> the work.</h1><p>Keep the count. See the progress.<br/>Bring your team’s practice notebook to the field.</p></div><span className="login-field" aria-hidden="true">◇</span><footer>BASEBALL & SOFTBALL / PITCHWORK</footer></section>
    <main className="login-panel"><div className="login-card"><span className="eyebrow">YOUR TEAM’S DUGOUT</span><h2>{requesting ? 'Request a place on the team.' : 'Welcome to Pitchwork.'}</h2><p>{requesting ? 'Choose Player or Coach, verify your email, then wait for admin approval.' : 'Sign in with your email or player username and password.'}</p>
      {configurationError && <div role="alert" className="settings-notice error-text">{configurationError}</div>}
      {(message || error) && <div role="alert" className="settings-notice error-text">{userMessage(error || message)}</div>}
      {!requesting ? <><form onSubmit={async event => {
        event.preventDefault();setError('');setBusy(true)
        const fields = new FormData(event.currentTarget)
        try {await signInWithPassword(String(fields.get('email')),String(fields.get('password')));onRetry?.()}
        catch(cause) {setError((cause as Error).message)} finally {setBusy(false)}
      }}><label>Email address or player username<input name="email" autoComplete="username" type="text" required maxLength={254}/></label><label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={72}/></label><button className="primary" type="submit" disabled={busy || !!configurationError}>{busy ? 'Signing in…' : 'Sign in'}</button></form><button className="text-button" onClick={() => setForgot(!forgot)}>Forgot your password?</button>{forgot && <form className="password-recovery" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setResetMessage('');try{const result=await accountApi<{message:string}>('recover_password',{email:String(new FormData(e.currentTarget).get('recoveryEmail'))});setResetMessage(result.message)}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}}}><label>Account email<input name="recoveryEmail" type="email" autoComplete="email" required maxLength={254}/></label><button disabled={busy}>Send password reset email</button>{resetMessage && <p role="status" className="settings-notice">{resetMessage}</p>}<small>Players who sign in with a username can ask their coach for a private reset link.</small></form>}{onRetry && <button className="text-button" onClick={onRetry}>Retry account access</button>}<div className="login-divider"/><h3>Bring your team to Pitchwork.</h3><p>Coaches can create an account and a team in minutes. Invite your players now or later.</p><button className="primary signup-entry" disabled={!!configurationError} onClick={()=>setSignup(true)}>Create a team <span aria-hidden="true">↗</span></button><p className="signup-help">Joining as a player? Open the private link your coach shared, or <button className="text-button" disabled={!!configurationError} onClick={() => {setRequesting(true);setError('');setVerified(false)}}>Request an account</button>.</p></> : sent ? <>{verified ? <div role="status" className="settings-notice">Email verified—waiting for admin approval. Your admin will provide a private password setup link after approval.</div> : <><div role="status" className="settings-notice">{requestConfirmation}</div><p>Enter the code sent to {draft?.email}. If it does not arrive, check spam or contact your admin.</p><form onSubmit={async event=>{
        event.preventDefault();setBusy(true);setError('')
        const code=String(new FormData(event.currentTarget).get('code')).trim()
        try {await accountApi('verify_request',{email:draft?.email,code});setVerified(true)}
        catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
      }}><label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required/></label><button className="primary" disabled={busy}>Verify email</button></form><button type="button" disabled={busy || resendSeconds>0} onClick={async()=>{
        setBusy(true);setError('')
        try {await accountApi('request',draft ?? {});setResendAt(Date.now()+60000)}
        catch(cause){setError((cause as Error).message);setResendAt(Date.now()+60000)}finally{setBusy(false)}
      }}>{resendSeconds ? `Resend code in ${resendSeconds}s` : 'Resend code'}</button><button className="text-button" disabled={busy} onClick={()=>{setSent(false);setError('')}}>Change request details</button></>}<button disabled={busy} onClick={() => {setRequesting(false);setSent(false);setError('')}}>Back to sign in</button></> : <form onSubmit={async event => {
        event.preventDefault();setError('');setBusy(true)
        const fields = new FormData(event.currentTarget)
        try {const request=accountRequest(Object.fromEntries(fields));setDraft(request);await accountApi('request',request);setSent(true);setResendAt(Date.now()+60000)}
        catch(cause) {setError((cause as Error).message)} finally {setBusy(false)}
      }}><label>Account type<select name="role" value={role} onChange={e=>{setRole(e.target.value as 'player'|'coach');setError('')}} disabled={busy}><option value="player">Player</option><option value="coach">Coach</option></select></label><label>Your name<input defaultValue={draft?.name} name="name" autoComplete="name" required maxLength={100}/></label>{role==='player' && <label>Player username<input name="username" defaultValue={draft?.username ?? ''} required minLength={3} maxLength={24} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}" autoComplete="username" autoCapitalize="none"/><small>3–24 letters, numbers, dots, underscores or hyphens.</small></label>}<label>Email address<input defaultValue={draft?.email} name="email" autoComplete="email" type="email" required maxLength={254}/></label><label>{role==='player' ? 'Team name (optional)' : 'Team name'}<input defaultValue={draft?.requestedTeam} name="requestedTeam" required={role==='coach'} maxLength={200} placeholder="Your team’s name"/></label><button className="primary" type="submit" disabled={busy || !!configurationError}>{busy ? 'Sending request…' : 'Send account request'}</button><button className="text-button" type="button" onClick={() => setRequesting(false)}>Back to sign in</button></form>}
      {onExportRecovery && <div className="settings-notice"><p>Unsynced practices are preserved on this device. You can export them for the admin to recover.</p><button onClick={() => void onExportRecovery().catch(cause => setError(cause.message))}>Export unsynced work</button></div>}
      <p className="login-footnote">Players use a username; coaches use email. After your first online setup, downloaded records are available offline.</p>
    </div></main></div>
}
