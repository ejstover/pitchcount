import { useEffect, useId, useRef, useState } from 'react'
import type { RemovalInput, RemovalPreview, RemovalTarget } from './shared'

interface Props {
  target: RemovalTarget
  preview: (input: RemovalInput) => Promise<RemovalPreview>
  perform: (input: RemovalInput, permanent: boolean) => Promise<void>
  close: () => void
  onPractice: (id: string) => void
  disabled: boolean
}

/** Removal failures stay here rather than entering the scoring command queue. */
export function RemovalDialog({ target, preview, perform, close, onPractice, disabled }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [data, setData] = useState<RemovalPreview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [permanent, setPermanent] = useState(target.kind === 'request')
  const [confirmation, setConfirmation] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLElement>('select, input, button')?.focus()
    return () => dialog.current?.close()
  }, [])
  useEffect(() => {
    let alive = true
    setData(undefined); setError('')
    void preview(target).then(value => { if (alive) setData(value) }, cause => { if (alive) setError((cause as Error).message) })
    return () => { alive = false }
  }, [target.id, attempt])
  const action = target.kind === 'coach' ? (target.archived ? 'Reactivate account' : 'Suspend account') : target.archived ? 'Reactivate' : 'Archive'
  const blockers = data ? permanent ? data.deleteBlockers : target.archived ? [] : data.archiveBlockers : []
  const label = data?.name ?? target.name
  async function submit() {
    setBusy(true); setError('')
    try {
      await perform({ kind: target.kind, id: target.id, confirmation, archived: !target.archived }, permanent)
      close()
    } catch (cause) {
      setError((cause as Error).message)
      // Dependencies may have changed since this dialog opened. Keep the
      // original preview if account deletion is awaiting auth cleanup.
      try { setData(await preview(target)) } catch { /* Keep the actionable failure. */ }
    }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="modal removal-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <div className="modal-heading"><h2 id={titleId}>Remove {target.name}</h2><button className="icon-button" aria-label="Close removal dialog" disabled={busy} onClick={close}>×</button></div>
    {error && <p role="alert" className="settings-notice error-text">{error}</p>}
    {!data ? <><p role="status">{error ? 'Could not check removal requirements.' : 'Checking related records…'}</p>{error && <button onClick={() => setAttempt(n => n + 1)}>Retry check</button>}</> : <>
      <label className="field-label">Removal option<select value={permanent ? 'delete' : 'archive'} disabled={busy} onChange={event => setPermanent(event.target.value === 'delete')}>
        {target.kind !== 'request' && <option value="archive">{action} — keep history</option>}
        <option value="delete">Delete permanently</option>
      </select></label>
      <p className="form-intro">{permanent ? 'This permanently deletes this record. It cannot be undone. Related practices must be deleted individually first.' : target.kind === 'coach' ? target.archived ? 'Reactivation restores account access. Past practice history and coach attribution stay available.' : 'Suspension prevents sign-in and syncing. Past practice history and coach attribution stay available.' : 'Archived records stay in history and statistics. You can reactivate them later.'}</p>
      <p className="removal-counts">{data.assignments} assignments · {data.invitations} invitations{target.kind === 'coach' && data.ownedPitchers ? ` · ${data.ownedPitchers} players will transfer to the admin if this account is deleted` : ''}</p>
      {target.kind === 'team' && !target.archived && !permanent && <p className="form-intro">Archiving also cancels pending invitations. Existing roster and coach assignments stay with the team.</p>}
      {!!blockers.length && <ul className="removal-blockers">{blockers.map(message => <li key={message}>{message}</li>)}</ul>}
      {!!data.practices.length && <div className="removal-practices"><h3>Related practices</h3>{data.practices.map(practice => <button className="text-button" key={practice.id} disabled={busy} onClick={() => { close(); onPractice(practice.id) }}>{practice.name} →</button>)}</div>}
      {data.hiddenPractices > 0 && <p className="form-intro">{data.hiddenPractices} related practices are outside your access. Contact an admin.</p>}
      {permanent && <label className="field-label">Type {label} to confirm<input autoComplete="off" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>}
      {disabled && <p className="form-intro">Save notes and sync pending changes before removing records. Reconnect if offline.</p>}
      <div className="form-actions"><button disabled={busy} onClick={close}>Cancel</button><button className={permanent ? 'danger-button' : 'primary'} disabled={busy || disabled || !data.canRemove || blockers.length > 0 || (permanent && confirmation !== label)} onClick={() => void submit()}>{busy ? 'Saving…' : permanent ? 'Delete permanently' : action}</button></div>
    </>}
  </dialog>
}
