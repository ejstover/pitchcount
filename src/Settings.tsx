import { createId } from './id'
import { useEffect, useState, type ChangeEvent } from 'react'
import { backupTotals, downloadBackup, parseBackup, type Backup } from './backup'
import type { Repository } from './storage'

interface Props {
  repository: Repository
  canRestore: boolean
  disabled: boolean
  unsavedNotes: boolean
  run: (work: () => Promise<unknown>, done?: () => void) => void
  onRestored: () => void
  onPreview: (open: boolean) => void
  offlineReady: boolean
}
export function Settings({ repository, canRestore, disabled, unsavedNotes, run, onRestored, onPreview, offlineReady }: Props) {
  const [restoreId, setRestoreId] = useState(createId)
  const [recoverySaved, setRecoverySaved] = useState(false)
  const [backup, setBackup] = useState<Backup | null>(null)
  const [checked, setChecked] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [storageMessage, setStorageMessage] = useState('')
  useEffect(() => {
    let mounted = true
    navigator.storage?.persisted?.().then(value => { if (mounted) setPersistent(value) }).catch(() => undefined)
    return () => { mounted = false; onPreview(false) }
    // onPreview is the stable React state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(''); setMessage(''); setBackup(null); setRestoreId(createId()); setChecked(false); setReading(true); onPreview(true)
    try { setBackup(parseBackup(await file.text())) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read this file.'); onPreview(false) }
    finally { setReading(false) }
  }
  function exportFile() {
    setMessage('')
    run(async () => downloadBackup(await repository.exportBackup()), () => setMessage('Backup download started. Keep the JSON file somewhere you can find it.'))
  }
  const totals = backup ? backupTotals(backup) : null
  const locked = disabled || unsavedNotes || reading
  return <div className="settings-grid">
    <section className="card settings-card"><span className="eyebrow">YOUR PRACTICE NOTEBOOK</span><h2>Backup & restore</h2><p>Your downloaded records and pending pitches are saved here. Keep a backup to recover practice history later.</p>
      {unsavedNotes && <p className="settings-notice">Save your coaching notes before exporting or restoring.</p>}
      <button className="primary" disabled={locked} onClick={exportFile}>Download backup <span aria-hidden="true">↓</span></button>
      <p className="settings-help">Includes the teams, pitchers, and practices you can access, including notes, locations, and undone pitches. Account credentials and coach permissions are excluded.</p>
      <button disabled={disabled} onClick={() => run(async () => {
        const recovery = await repository.exportRecovery()
        const url = URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = `pitchwork-unsynced-${Date.now()}.json`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }, () => { setRecoverySaved(true); setMessage('Unsynced recovery file downloaded. Keep this file until synchronization is resolved.') })}>Export unsynced work</button>
      {recoverySaved && <button disabled={disabled} onClick={() => {
        if (window.confirm('Keep your recovery file. Remove blocked uploads from this device? Successfully synced practices are kept.')) run(() => repository.discardBlockedUploads(), () => setMessage('Blocked uploads removed. Your recovery file contains the saved work.'))
      }}>Remove recovered blocked uploads</button>}
      {canRestore && <><div className="restore-input"><label htmlFor="backup-file">Restore from a JSON backup</label><input id="backup-file" type="file" accept=".json,application/json" disabled={locked} onChange={readFile} /></div>
      {reading && <p>Checking backup…</p>}
      {error && <p className="settings-notice error-text" role="alert">{error}</p>}
      {message && <p className="settings-notice" role="status">{message}</p>}
      {backup && totals && <div className="restore-preview"><span className="eyebrow">BACKUP PREVIEW</span><h3>Ready to restore</h3><p>Exported {new Date(backup.exportedAt).toLocaleString()}</p><dl className="metric-grid compact"><div><dt>Pitchers</dt><dd>{totals.pitchers}</dd></div><div><dt>Sessions</dt><dd>{totals.sessions}</dd></div><div><dt>Pitches</dt><dd>{totals.pitches}</dd></div></dl><p>Import creates new copies of teams, pitchers, and practice history for your account. It never changes existing shared records or restores other coaches’ permissions. Imported practices are read-only history.</p>
        <label className="confirm-replace"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={locked} /><span>I understand this imports separate copies into my account.</span></label>
        <div className="form-actions"><button disabled={disabled} onClick={() => { setBackup(null); onPreview(false); setChecked(false) }}>Cancel restore</button><button className="primary" disabled={locked || !checked || !navigator.onLine} onClick={() => run(() => repository.restoreBackup(backup, restoreId), () => { setBackup(null); onPreview(false); setChecked(false); setMessage('Backup copies imported. Your existing teams and practices were kept.'); onRestored() })}>Import backup copies</button></div>
      </div>}</>}
    </section>
    <div className="settings-stack"><section className="card settings-card"><span className="eyebrow">TAKE IT TO THE FIELD</span><h2>Install on your iPhone</h2><ol><li>Open <a href="https://count.twelvefs.com">count.twelvefs.com</a> in Safari.</li><li>Tap Share, then Add to Home Screen. Choose Open as Web App if shown.</li><li>Open Pitchwork from its home-screen icon while online. Open the save and sync status beside the page title and check for “Ready offline” before leaving coverage.</li></ol><p className="settings-notice">{offlineReady ? 'Ready offline on this browser. You can reopen the app without a connection.' : 'Offline setup completes on the published site or a local production preview. Keep the app open online until it is ready.'}</p><p className="settings-help">Browser and home-screen storage may be separate. Sign in to download your teams inside the installed app. Reconnect the original device to upload any pending practices.</p></section>
      <section className="card settings-card"><span className="eyebrow">KEEP YOUR WORK</span><h2>Device storage</h2><p>{persistent === true ? 'This browser has granted persistent storage.' : 'Browser storage can be removed by the browser or by clearing site data. Keep backups outside this device.'}</p><button disabled={!navigator.storage?.persist || persistent === true} onClick={async () => {
        try {
          const granted = await navigator.storage.persist()
          setPersistent(granted); setStorageMessage(granted ? 'Storage protection granted. Keep backups too.' : 'This browser did not grant storage protection. Your data still saves locally; keep regular backups.')
        } catch { setStorageMessage('Storage protection is unavailable. Keep regular backups.') }
      }}>{persistent ? 'Storage protection granted' : 'Request storage protection'}</button>{storageMessage && <p className="settings-notice" role="status">{storageMessage}</p>}<p className="settings-help">Practices sync between authorized coach accounts when online. Keep an external backup for recovery.</p></section>
    </div>
  </div>
}
