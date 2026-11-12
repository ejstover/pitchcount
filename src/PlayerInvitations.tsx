import {useEffect,useRef,useState} from 'react'
import {accountApi} from './auth'
import {createId} from './id'
type Invitation={id:string;pitcherId:string;name:string;expiresAt:string;acceptedAt:string|null;revokedAt:string|null}
type Pitcher={id:string;name:string;archived?:boolean}
export function PlayerInvitations({teamId,pitchers,onChange,disabled=false,onBusyChange}:{teamId:string;pitchers:Pitcher[];onChange:()=>Promise<unknown>|void;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}) {
  const [invitations,setInvitations]=useState<Invitation[]>([]),[selection,setSelection]=useState(''),[name,setName]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const [created,setCreated]=useState<{id:string;inviteLink:string;expiresAt:string;name:string}|null>(null)
  const requestId=useRef(createId())
  useEffect(()=>{onBusyChange?.(busy)},[busy,onBusyChange])
  const locked=disabled || busy || !navigator.onLine
  async function refresh(){setInvitations(await accountApi<Invitation[]>('player_invitations',{teamId,operation:'list'}))}
  useEffect(()=>{let current=true;setCreated(null);setError('');if(navigator.onLine)void accountApi<Invitation[]>('player_invitations',{teamId,operation:'list'}).then(value=>{if(current)setInvitations(value)},cause=>{if(current)setError(cause.message)});return()=>{current=false}},[teamId])
  return <section className="player-invites" aria-label="Player invitations"><div className="invite-heading"><span className="eyebrow">BRING THE TEAM TOGETHER</span><h3>Invite your players</h3></div><p className="form-intro">Create a private link for each player. They’ll choose their own username and password. You share the link; no email is sent.</p>{error && <p role="alert" className="settings-notice error-text">{error}</p>}{message && <p role="status" className="settings-notice">{message}</p>}{!navigator.onLine && <p className="settings-notice">Reconnect to create or manage invitations.</p>}
    <form aria-busy={busy} onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setMessage('');try{
      const result=await accountApi<{id:string;inviteLink:string;expiresAt:string}>('player_invitations',{teamId,operation:'create',requestId:requestId.current,pitcherId:selection || null,name})
      requestId.current=createId();setCreated({...result,name:selection?pitchers.find(p=>p.id===selection)?.name ?? 'Player':name.trim()});setName('');setSelection('');await refresh();await onChange()
    }catch(cause){setError((cause as Error).message)}finally{setBusy(false)}}}>
      {!!pitchers.length && <label className="field-label">Roster player<select value={selection} onChange={e=>{requestId.current=createId();setSelection(e.target.value)}} disabled={locked}><option value="">Add a new player</option>{pitchers.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {!selection && <label className="field-label">Player’s name<input value={name} onChange={e=>{requestId.current=createId();setName(e.target.value)}} required maxLength={100} autoComplete="off" disabled={locked} placeholder="Player’s full name"/></label>}
      <button className="primary" disabled={locked || (!selection && !name.trim())}>{busy?'Working…':'Create player invitation'}</button>
    </form>
    {created && <div className="invitation-row new-invitation"><strong>Ready to share with {created.name}</strong><small>Expires {new Date(created.expiresAt).toLocaleDateString()}. Copy this link now; it’s shown only here.</small><input aria-label={`Player invitation link for ${created.name}`} readOnly value={created.inviteLink} onFocus={e=>e.target.select()}/><div className="form-actions"><button onClick={()=>{if(!navigator.clipboard){setMessage('Select and copy the link above.');return}void navigator.clipboard.writeText(created.inviteLink).then(()=>setMessage('Player invitation link copied.'),()=>setMessage('Select and copy the link above.'))}}>Copy player link</button>{typeof navigator.share==='function' && <button onClick={()=>void navigator.share({title:'Join our team on Pitchwork',text:`${created.name}, here’s your private team invitation.`,url:created.inviteLink}).catch(()=>{})}>Share invitation</button>}</div></div>}
    {!!invitations.length && <div className="invitation-list"><h4>Player invitations</h4>{invitations.map(invite=>{const pending=!invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime()>Date.now();return <div className="member-row" key={invite.id}><div><strong>{invite.name}</strong><small>{invite.acceptedAt?'Joined team':invite.revokedAt?'Revoked':pending?`Pending · expires ${new Date(invite.expiresAt).toLocaleDateString()}`:'Expired'}</small></div>{pending && <button disabled={locked} aria-label={`Revoke invitation for ${invite.name}`} onClick={async()=>{setBusy(true);setError('');try{await accountApi('player_invitations',{teamId,operation:'revoke',id:invite.id});if(created?.id===invite.id)setCreated(null);await refresh();setMessage('Invitation revoked. That link can no longer be used.')}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}}}>Revoke</button>}</div>})}<p className="signup-help">Need a replacement link? Select the roster player above and create a new invitation. Earlier links for that player stop working.</p></div>}
  </section>
}
