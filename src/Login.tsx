import { useState } from 'react'
import { accountApi,configurationError,signInWithGoogle } from './auth'
import { accountRequest,requestConfirmation } from './account-validation'

export function Login({message = '',onRetry,onExportRecovery}:{message?:string;onRetry?:()=>void;onExportRecovery?:()=>Promise<void>}) {
  const [requesting,setRequesting] = useState(false)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [sent,setSent] = useState(false)
  async function login() {
    setError(''); setBusy(true)
    try { await signInWithGoogle() } catch (cause) { setError((cause as Error).message); setBusy(false) }
  }
  return <div className="login-shell"><section className="login-story"><a className="brand" href="/" aria-label="Pitchwork home"><span className="brand-mark">p<span>·</span></span><span>pitchwork<span className="brand-caption">MAKE EVERY PITCH COUNT</span></span></a><div><span className="eyebrow">YOUR TEAM. EVERY REP.</span><h1>A place for<br/> the work.</h1><p>Keep the count. See the progress.<br/>Bring your team’s practice notebook to the field.</p></div><span className="login-field" aria-hidden="true">◇</span><footer>BASEBALL & SOFTBALL / PITCHWORK</footer></section>
    <main className="login-panel"><div className="login-card"><span className="eyebrow">THE COACH’S DUGOUT</span><h2>{requesting ? 'Request a place on the team.' : 'Welcome to Pitchwork.'}</h2><p>{requesting ? 'Tell the admin who you are and which team you’re with. They’ll create your account after approval.' : 'Sign in with your approved Google account to open your teams and practice history.'}</p>
      {configurationError && <div role="alert" className="settings-notice error-text">{configurationError}</div>}
      {(message || error) && <div role="alert" className="settings-notice error-text">{error || message}</div>}
      {!requesting ? <><button className="primary google-button" disabled={busy || !!configurationError} onClick={() => void login()}><span aria-hidden="true">G</span>{busy ? 'Opening Google…' : 'Continue with Google'}</button>{onRetry && <button className="text-button" onClick={onRetry}>Retry account access</button>}<div className="login-divider"/><h3>Need an account?</h3><p>An admin must create your account before you can sign in.</p><button disabled={!!configurationError} onClick={() => {setRequesting(true);setError('')}}>Request an account <span aria-hidden="true">↗</span></button></> : sent ? <><div role="status" className="settings-notice">{requestConfirmation}</div><button onClick={() => {setRequesting(false);setSent(false)}}>Back to sign in</button></> : <form onSubmit={async event => {
        event.preventDefault();setError('');setBusy(true)
        const fields = new FormData(event.currentTarget)
        try { const input = accountRequest(Object.fromEntries(fields)); await accountApi('request',input);setSent(true) }
        catch(cause) {setError((cause as Error).message)} finally {setBusy(false)}
      }}><label>Your name<input name="name" autoComplete="name" required maxLength={100}/></label><label>Google account email<input name="email" autoComplete="email" type="email" required maxLength={254}/></label><label>Requested team<input name="requestedTeam" required maxLength={200} placeholder="Your team’s name"/></label><button className="primary" type="submit" disabled={busy || !!configurationError}>{busy ? 'Sending request…' : 'Send account request'}</button><button className="text-button" type="button" onClick={() => setRequesting(false)}>Back to sign in</button></form>}
      {onExportRecovery && <div className="settings-notice"><p>Unsynced practices are preserved on this device. You can export them for the admin to recover.</p><button onClick={() => void onExportRecovery().catch(cause => setError(cause.message))}>Export unsynced work</button></div>}
      <p className="login-footnote">No Pitchwork password to remember. After your first online setup, your downloaded records are available offline.</p>
    </div></main></div>
}
