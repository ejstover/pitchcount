import { isCoach } from './domain'
import { useEffect, useState } from 'react'
import { createId } from './id'
import { gcFingerprint, gcSeasonKey, parseGameChanger, suggestGCMatch, suggestSeason, type GCImport } from './gamechanger'
import type { Snapshot } from './shared'
import type { Repository } from './storage'
import { validCustomRange } from './statistics'
import './gamechanger.css'

export function GameChangerImport({ data, repository, disabled, onPreview }: { data: Snapshot; repository: Repository; disabled: boolean; onPreview: (open: boolean) => void }) {
  const [parsed, setParsed] = useState<ReturnType<typeof parseGameChanger> | null>(null)
  const [fileName, setFileName] = useState(''), [teamId, setTeamId] = useState(''), [season, setSeason] = useState('')
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [coverage, setCoverage] = useState(false)
  const [choices, setChoices] = useState<Record<string, string>>({}), [confirmed, setConfirmed] = useState<Record<string, boolean>>({})
  const [staged, setStaged] = useState<GCImport | null>(null), [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const coach = data.coaches.find(c => c.id === repository.identity.coachId)
  const teams = data.teams.filter(t => !t.archived && (coach?.role === 'admin' || data.teamCoaches.some(m => m.teamId === t.id && m.coachId === repository.identity.coachId)))
  const existing = (data.gcSummaries ?? []).find(s => s.teamId === teamId && gcSeasonKey(s.season) === gcSeasonKey(season))
  const locked = disabled || busy || !navigator.onLine || !isCoach(coach)
  useEffect(() => { onPreview(!!parsed); return () => onPreview(false) }, [parsed, onPreview])
  function resetChoices() { setChoices({}); setConfirmed({}); setStaged(null); setCoverage(false); setError('') }
  function preview() {
    try {
      if (!parsed || !teams.some(t => t.id === teamId) || !season.trim() || !validCustomRange(start, end) || !coverage) throw new Error('Choose a team, season, valid coverage dates, and confirm coverage.')
      const newPitchers: GCImport['newPitchers'] = []
      const players = parsed.players.flatMap(row => {
        const suggested = suggestGCMatch(row, teamId, season, data.pitchers, data.teamPitchers, data.gcMappings ?? [])
        let choice = choices[row.sourceKey] ?? suggested.pitcherId
        if (!choice || !(confirmed[row.sourceKey] || suggested.remembered && choices[row.sourceKey] === undefined)) throw new Error(`Confirm a match, creation, or skip for ${row.name}.`)
        if (choice === 'skip') return []
        if (choice === 'create') { choice = createId(); newPitchers.push({ id: choice, name: row.name, jersey: row.jersey }) }
        return [{ ...row, pitcherId: choice }]
      })
      if (!players.length) throw new Error('Include at least one pitcher.')
      if (new Set(players.map(p => p.pitcherId)).size !== players.length) throw new Error('Each source player must map to a different pitcher.')
      setStaged({ teamId, season: season.trim(), coverageStart: start, coverageEnd: end, fileName, players, teamTotals: parsed.teamTotals, warnings: parsed.warnings, newPitchers, expectedRevision: existing?.revision ?? 0, expectedSummaryId: existing?.id ?? null, operationId: createId(), coverageConfirmed: true })
      setAttempted(false); setError('')
    } catch (cause) { setError((cause as Error).message) }
  }
  async function commit() {
    if (!staged) return
    setBusy(true); setAttempted(true); setError('')
    try { await repository.importGameChanger(staged); setParsed(null); setStaged(null); setMessage('GameChanger summary saved. Practice pitches were kept.'); setAttempted(false) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  const duplicate = !!staged && !!existing && gcFingerprint(staged) === gcFingerprint(existing)
  const sum = (players: { stats: { pitches: number | null; walks: number | null; strikeouts: number | null; batters: number | null } }[], key: 'pitches' | 'walks' | 'strikeouts' | 'batters') => players.reduce((n, p) => n + (p.stats[key] ?? 0), 0)
  return <section className="card settings-card gc-import" aria-labelledby="gc-import-title">
    <span className="eyebrow">GAME RESULTS</span><h2 id="gc-import-title">Import GameChanger CSV</h2>
    <p>Keep one current pitching summary per team and season. A new export replaces that summary. Export all intended games through your cutoff date; GameChanger includes any filters you applied.</p>
    <p className="settings-help">Summaries contain no game dates, pitch sequence, or locations. They support season comparisons, not daily workload or individual-game trends.</p>
    {!navigator.onLine && <p className="settings-notice">Reconnect to import or remove GameChanger summaries. Saved summaries remain available offline.</p>}
    <label className="field-label">GameChanger CSV<input type="file" accept=".csv,text/csv" disabled={locked || !!staged} onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
      setError(''); setMessage(''); setBusy(true); setParsed(null); resetChoices()
      try { if (file.size > 5_000_000) throw new Error('Choose a CSV smaller than 5 MB.'); const result = parseGameChanger(await file.text()); setParsed(result); setFileName(file.name); setSeason(suggestSeason(file.name)); if (teams.length === 1) setTeamId(teams[0].id) }
      catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
    }} /></label>
    {error && <p className="settings-notice error-text" role="alert">{error}</p>}{message && <p role="status" className="settings-notice">{message}</p>}
    {parsed && !staged && <>
      <div className="gc-fields"><label className="field-label">Import team<select aria-label="Import team" value={teamId} disabled={locked} onChange={e => { setTeamId(e.target.value); resetChoices() }}><option value="">Choose team</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="field-label">Season name<input value={season} maxLength={150} disabled={locked} onChange={e => { setSeason(e.target.value); resetChoices() }} /></label>
        <label className="field-label">Season coverage start<input type="date" value={start} disabled={locked} onChange={e => { setStart(e.target.value); setCoverage(false) }} /></label>
        <label className="field-label">Export cutoff date<input type="date" value={end} disabled={locked} onChange={e => { setEnd(e.target.value); setCoverage(false) }} /></label></div>
      {!!teamId && <div className="gc-mappings"><h3>Match pitchers</h3>{parsed.players.map(row => {
        const suggestion = suggestGCMatch(row, teamId, season, data.pitchers, data.teamPitchers, data.gcMappings ?? [])
        const value = choices[row.sourceKey] ?? suggestion.pitcherId
        const checked = confirmed[row.sourceKey] ?? (suggestion.remembered && choices[row.sourceKey] === undefined)
        return <div className="gc-match" key={row.sourceKey}><div><strong>{row.name}{row.jersey ? ` · #${row.jersey}` : ''}</strong><small>{row.stats.pitches} pitches · {row.stats.batters} batters</small></div>
          <label className="field-label">Match for {row.name}<select value={value} disabled={locked} onChange={e => { setChoices(v => ({ ...v, [row.sourceKey]: e.target.value })); setConfirmed(v => ({ ...v, [row.sourceKey]: false })) }}><option value="">Choose a pitcher</option>{data.pitchers.filter(p => data.teamPitchers.some(m => m.teamId === teamId && m.pitcherId === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}{p.jersey ? ` #${p.jersey}` : ''}{p.archived ? ' (archived)' : ''}</option>)}<option value="create">Create {row.name}</option><option value="skip">Skip this row</option></select></label>
          <label className="confirm-replace"><input type="checkbox" checked={!!checked} disabled={locked || !value} onChange={e => setConfirmed(v => ({ ...v, [row.sourceKey]: e.target.checked }))} /><span>{suggestion.remembered && choices[row.sourceKey] === undefined ? 'Remembered match' : 'Confirm selection'}</span></label></div>
      })}</div>}
      <label className="confirm-replace"><input type="checkbox" checked={coverage} disabled={locked} onChange={e => setCoverage(e.target.checked)} /><span>I confirm the season name and that this export includes all intended games from the coverage start through the cutoff date.</span></label>
      <div className="form-actions"><button disabled={locked} onClick={() => setParsed(null)}>Cancel import</button><button className="primary" disabled={locked} onClick={preview}>Review import</button></div>
    </>}
    {staged && <div className="restore-preview"><h3>Review {existing ? 'replacement' : 'import'}</h3><p>{data.teams.find(t => t.id === staged.teamId)?.name} · {staged.season}</p><p>{staged.coverageStart} through {staged.coverageEnd} · {staged.players.length} pitchers · {parsed!.players.length - staged.players.length} skipped</p>
      <ul>{staged.players.map(p => <li key={p.sourceKey}>{p.name} → {staged.newPitchers.some(n => n.id === p.pitcherId) ? `${p.name} (new)` : data.pitchers.find(n => n.id === p.pitcherId)?.name}</li>)}</ul>
      {parsed!.players.filter(p => !staged.players.some(s => s.sourceKey === p.sourceKey)).map(p => <p key={p.sourceKey}>Skipped: {p.name}</p>)}
      <div className="gc-table-wrap"><table className="gc-table"><caption>Pitcher totals</caption><thead><tr><th>Measure</th>{existing && <th>Current</th>}<th>Import</th>{existing && <th>Change</th>}</tr></thead><tbody>{(['pitches', 'batters', 'walks', 'strikeouts'] as const).map(key => <tr key={key}><th>{key}</th>{existing && <td>{sum(existing.players, key)}</td>}<td>{sum(staged.players, key)}</td>{existing && <td>{sum(staged.players, key) - sum(existing.players, key)}</td>}</tr>)}</tbody></table></div>
      {staged.warnings.map(w => <p className="settings-notice" key={w}>{w}</p>)}
      {existing && <p>This replaces the entire summary. Previously included pitchers absent from this import will no longer contribute. Lower totals are allowed for scoring corrections.</p>}
      {duplicate && <p role="status" className="settings-notice">Already imported. These pitching values, mappings, and coverage are unchanged.</p>}
      <div className="form-actions"><button disabled={busy || disabled} onClick={() => { setStaged(null); if (duplicate) setParsed(null); setAttempted(false); setError('') }}>{duplicate ? 'Done' : 'Back to matching'}</button><button className="primary" disabled={locked || duplicate} onClick={() => void commit()}>{busy ? 'Saving…' : attempted ? 'Retry same import' : existing ? 'Replace summary' : 'Import summary'}</button></div>
      {attempted && error && <button disabled={busy || disabled || !navigator.onLine} onClick={async () => { setBusy(true); try { await repository.sync(); setStaged(null); setAttempted(false); setError(''); setChoices({}); setConfirmed({}) } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) } }}>Refresh & review again</button>}
    </div>}
    {!!data.gcSummaries?.length && <div className="gc-saved"><h3>Saved summaries</h3>{data.gcSummaries.map(s => <div className="gc-saved-row" key={s.id}><div><strong>{data.teams.find(t => t.id === s.teamId)?.name} · {s.season}</strong><small>{s.coverageStart} – {s.coverageEnd}</small><small>Imported by {s.importedByName} · Updated {new Date(s.updatedAt).toLocaleString()}</small></div><button disabled={locked || !!parsed || !(coach?.role === 'admin' || data.teamCoaches.some(m => m.teamId === s.teamId && m.coachId === repository.identity.coachId))} onClick={async () => {
      if (!window.confirm(`Remove the ${s.season} GameChanger summary? Practice pitches will remain.`)) return
      setBusy(true); setError(''); try { await repository.removeGameChanger(s); setMessage('GameChanger summary removed.') } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
    }}>Remove summary</button></div>)}</div>}
  </section>
}
