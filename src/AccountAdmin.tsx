import { useEffect,useState } from 'react'
import { accountApi,type AccountProfile } from './auth'
interface Team {id:string;name:string}
interface AccessRequest {id:string;name:string;email:string;requested_team:string;status:'pending'|'approved'|'rejected'}
interface AdminData {profiles:AccountProfile[];requests:AccessRequest[];memberships:{coach_id:string;team_id:string}[]}
export function AccountAdmin({teams,onChanged}:{teams:Team[];onChanged:()=>void}) {
  const [data,setData] = useState<AdminData>({profiles:[],requests:[],memberships:[]})
  const [editing,setEditing] = useState<{id?:string;name:string;email:string;teamIds:string[];active:boolean}|null>(null)
  const [busy,setBusy] = useState(false),[error,setError] = useState(''),[message,setMessage] = useState('')
  async function refresh() {setData(await accountApi<AdminData>('list'))}
  useEffect(() => {void refresh().catch(cause => setError(cause.message))},[])
  async function act(action:string,payload:Record<string,unknown>) {
    setBusy(true);setError('');setMessage('')
    try {await accountApi(action,payload);setEditing(null);await refresh();onChanged();setMessage('Account access saved.')}
    catch(cause) {setError((cause as Error).message)} finally {setBusy(false)}
  }
  return <section className="card account-admin"><div className="section-heading"><div><span className="eyebrow">ADMIN ONLY</span><h2>Accounts & access</h2></div><button disabled={busy || !navigator.onLine} onClick={() => setEditing({name:'',email:'',teamIds:[],active:true})}>Create account</button></div><p>Only the admin creates accounts. Approved coaches manage and record practices for their assigned teams.</p>
    {error && <p role="alert" className="settings-notice error-text">{error}</p>}{message && <p role="status" className="settings-notice">{message}</p>}
    <button className="text-button" disabled={busy || !navigator.onLine} onClick={() => void refresh().catch(cause => setError(cause.message))}>Refresh account requests</button>
    <h3>Pending requests</h3>{!data.requests.some(r => r.status === 'pending') && <p className="quiet-empty">No pending requests.</p>}
    {data.requests.filter(r => r.status === 'pending').map(r => <article className="account-row" key={r.id}><div><strong>{r.name}</strong><p>{r.email}</p><small>Requested team: {r.requested_team}</small></div><div className="account-row-actions"><button disabled={busy || !navigator.onLine} onClick={() => setEditing({name:r.name,email:r.email,teamIds:[],active:true})}>Review & create</button><button disabled={busy || !navigator.onLine} onClick={() => void act('reject',{id:r.id})}>Reject</button></div></article>)}
    {editing && <form className="account-editor" onSubmit={event => {event.preventDefault();void act(editing.id ? 'update' : 'create',editing)}}><h3>{editing.id ? 'Edit account access' : 'Create approved coach account'}</h3><label>Name<input required maxLength={100} value={editing.name} disabled={!!editing.id} onChange={e => setEditing({...editing,name:e.target.value})}/></label><label>Google account email<input type="email" required maxLength={254} value={editing.email} disabled={!!editing.id} onChange={e => setEditing({...editing,email:e.target.value})}/></label><fieldset><legend>Assigned teams</legend>{!teams.length && <p>Create a team first, or assign teams later.</p>}{teams.map(t => <label className="check-label" key={t.id}><input type="checkbox" checked={editing.teamIds.includes(t.id)} onChange={e => setEditing({...editing,teamIds:e.target.checked ? [...editing.teamIds,t.id] : editing.teamIds.filter(id => id !== t.id)})}/>{t.name}</label>)}</fieldset>{editing.id && <label className="check-label"><input type="checkbox" checked={editing.active} onChange={e => setEditing({...editing,active:e.target.checked})}/>Account active</label>}<div className="form-actions"><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button className="primary" disabled={busy || !navigator.onLine} type="submit">{busy ? 'Saving…' : editing.id ? 'Save account access' : 'Create account'}</button></div></form>}
    <h3>Approved accounts</h3>{data.profiles.map(p => <article className="account-row" key={p.id}><div><strong>{p.name}</strong><p>{p.email}</p><small>{p.role} · {p.active ? 'Active' : 'Suspended'} · {data.memberships.filter(m => m.coach_id === p.id).map(m => teams.find(t => t.id === m.team_id)?.name).filter(Boolean).join(', ') || 'No assigned teams'}</small></div>{p.role !== 'admin' && <button disabled={busy || !navigator.onLine} onClick={() => setEditing({...p,teamIds:data.memberships.filter(m => m.coach_id === p.id).map(m => m.team_id)})}>Edit access</button>}</article>)}
  </section>
}
