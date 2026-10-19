import { useEffect, useState, type ChangeEvent } from 'react'
import { backupTotals, downloadBackup, parseBackup, type Backup } from './backup'
import { repository } from './storage'

interface Props {
  disabled: boolean
  unsavedNotes: boolean
  run: (work: () => Promise<unknown>, done?: () => void) => void
  onRestored: () => void
  onPreview: (open: boolean) => void
  offlineReady: boolean
}
export function Settings({ disabled, unsavedNotes, run, onRestored, onPreview, offlineReady }: Props) {
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
    setError(''); setMessage(''); setBackup(null); setChecked(false); setReading(true); onPreview(true)
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
    <section className="card settings-card"><span className="eyebrow">YOUR PRACTICE NOTEBOOK</span><h2>Backup & restore</h2><p>Your records live in this browser. A backup lets you move them to another device or recover them later.</p>
      {unsavedNotes && <p className="settings-notice">Save your coaching notes before exporting or restoring.</p>}
      <button className="primary" disabled={locked} onClick={exportFile}>Download backup <span aria-hidden="true">↓</span></button>
      <p className="settings-help">Includes every team, pitcher, session, note, and pitch, including undone pitches. No records are uploaded.</p>
      <div className="restore-input"><label htmlFor="backup-file">Restore from a JSON backup</label><input id="backup-file" type="file" accept=".json,application/json" disabled={locked} onChange={readFile} /></div>
      {reading && <p>Checking backup…</p>}
      {error && <p className="settings-notice error-text" role="alert">{error}</p>}
      {message && <p className="settings-notice" role="status">{message}</p>}
      {backup && totals && <div className="restore-preview"><span className="eyebrow">BACKUP PREVIEW</span><h3>Ready to restore</h3><p>Exported {new Date(backup.exportedAt).toLocaleString()}</p><dl className="metric-grid compact"><div><dt>Pitchers</dt><dd>{totals.pitchers}</dd></div><div><dt>Sessions</dt><dd>{totals.sessions}</dd></div><div><dt>Pitches</dt><dd>{totals.pitches}</dd></div></dl><p>This replaces all records on this device, including an ongoing practice. Download your current backup first if you want to keep it. Records from the two files will not be combined.</p>
        <label className="confirm-replace"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={locked} /><span>I understand this replaces this device’s records.</span></label>
        <div className="form-actions"><button disabled={disabled} onClick={() => { setBackup(null); onPreview(false); setChecked(false) }}>Cancel restore</button><button className="primary" disabled={locked || !checked} onClick={() => run(() => repository.restoreBackup(backup), () => { setBackup(null); onPreview(false); setChecked(false); setMessage('Backup restored. Your roster and sessions are ready.'); onRestored() })}>Replace & restore</button></div>
      </div>}
    </section>
    <div className="settings-stack"><section className="card settings-card"><span className="eyebrow">TAKE IT TO THE FIELD</span><h2>Install on your iPhone</h2><ol><li>Open <a href="https://count.twelvefs.com">count.twelvefs.com</a> in Safari.</li><li>Tap Share, then Add to Home Screen. Choose Open as Web App if shown.</li><li>Open Pitchwork from its home-screen icon while online. Wait for “Ready offline” before leaving coverage.</li></ol><p className="settings-notice">{offlineReady ? 'Ready offline on this browser. You can reopen the app without a connection.' : 'Offline setup completes on the published site or a local production preview. Keep the app open online until it is ready.'}</p><p className="settings-help">Browser and home-screen storage may be separate. If your roster is missing after installation, restore your backup inside the installed app.</p></section>
      <section className="card settings-card"><span className="eyebrow">KEEP YOUR WORK</span><h2>Device storage</h2><p>{persistent === true ? 'This browser has granted persistent storage.' : 'Browser storage can be removed by the browser or by clearing site data. Keep backups outside this device.'}</p><button disabled={!navigator.storage?.persist || persistent === true} onClick={async () => {
        try {
          const granted = await navigator.storage.persist()
          setPersistent(granted); setStorageMessage(granted ? 'Storage protection granted. Keep backups too.' : 'This browser did not grant storage protection. Your data still saves locally; keep regular backups.')
        } catch { setStorageMessage('Storage protection is unavailable. Keep regular backups.') }
      }}>{persistent ? 'Storage protection granted' : 'Request storage protection'}</button>{storageMessage && <p className="settings-notice" role="status">{storageMessage}</p>}<p className="settings-help">Backups replace records when restored. They do not provide automatic syncing between devices.</p></section>
    </div>
  </div>
}
