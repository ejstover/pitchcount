import { useState, type FormEvent } from 'react'
import { accountApi } from './auth'
import type { Repository } from './storage'

/** Admin access is on demand; opening the app must never mirror every tenant. */
export function AdminWorkspace({repository,disabled}:{repository:Repository;disabled:boolean}) {
  const [search,setSearch]=useState(''),[teams,setTeams]=useState<{id:string;name:string;archived:boolean}[]>([])
  const [selected,setSelected]=useState('My assigned teams'),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function find(event:FormEvent) {
    event.preventDefault();setBusy(true);setError('')
    try {setTeams(await accountApi('find_teams',{search}))}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
  }
  async function select(id:string|null,name:string) {
    if(disabled)return
    setBusy(true);setError('')
    try {await repository.selectWorkspaceTeam(id);setSelected(name);setTeams([])}catch(cause){setError((cause as Error).message)}finally{setBusy(false)}
  }
  return <details className="card admin-workspace"><summary>Admin workspace · {selected}</summary><p>Your workspace includes your assigned teams and the team selected here. Search by the beginning of a team name.</p>
    <form onSubmit={event=>void find(event)}><label className="field-label">Find a team<input value={search} minLength={2} maxLength={100} required onChange={e=>setSearch(e.target.value)}/></label><button disabled={disabled || busy || !navigator.onLine}>Search teams</button></form>
    {error && <p role="alert">{error}</p>}
    {teams.map(t=><p key={t.id}>{t.name}{t.archived?' (archived)':''} <button disabled={disabled || busy} onClick={()=>void select(t.id,t.name)}>Open team</button></p>)}
    {teams.length===25 && <p>Showing 25 matches. Enter more of the name to narrow the results.</p>}
    <button disabled={disabled || busy} onClick={()=>void select(null,'My assigned teams')}>My assigned teams</button>
  </details>
}
