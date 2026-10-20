import { useEffect,useState } from 'react'
import { cachedSessionUserId,setAccountPassword } from './auth'
export function PasswordSetup({initialToken,onComplete,onCancel}:{initialToken:string|null;onComplete:()=>void;onCancel:()=>void}) {
  const [token,setToken] = useState(initialToken)
  const [busy,setBusy] = useState(false),[error,setError] = useState('')
  useEffect(() => {history.replaceState(null,'',window.location.pathname)},[])
  return <main className="account-gate card login-card"><span className="eyebrow">PITCHWORK / ACCOUNT ACCESS</span><h1>Choose your password.</h1><p>This private setup link lets you set or reset the password for your approved account. Use at least 15 characters.</p>{error && <p role="alert" className="settings-notice error-text">{error}</p>}<form onSubmit={async event => {
    event.preventDefault();setBusy(true);setError('')
    const fields = new FormData(event.currentTarget),password = String(fields.get('password'))
    try {
      if (password !== fields.get('confirm')) throw new Error('The passwords do not match.')
      await setAccountPassword(password,token);onComplete()
    } catch(cause) {
      const verifiedUser = sessionStorage.getItem('pitchwork-password-setup')
      if (verifiedUser && verifiedUser === cachedSessionUserId()) setToken(null)
      setError((cause as Error).message)
    } finally {setBusy(false)}
  }}><label>New password<input name="password" type="password" autoComplete="new-password" required minLength={15} maxLength={72}/></label><label>Confirm password<input name="confirm" type="password" autoComplete="new-password" required minLength={15} maxLength={72}/></label><button className="primary" disabled={busy} type="submit">{busy ? 'Saving password…' : 'Save password'}</button><button type="button" disabled={busy} onClick={onCancel}>Back to sign in</button></form><p className="login-footnote">Setup links can be used once and expire. Ask your admin for a new one if needed.</p></main>
}
