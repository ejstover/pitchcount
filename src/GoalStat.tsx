import { useState } from 'react'
import type { Coach } from './domain'
import type { Snapshot } from './shared'
import type { Repository } from './storage'
import { applicableGoals, canEditGoal, fixedDirection, goalComparison, goalMetrics, goalTarget, goalWarnings, validGoal, type Goal, type GoalDirection, type GoalDraft, type GoalMetric } from './goals'
import './goals.css'

export interface GoalContext { data: Snapshot; account: Coach; repository: Repository; teamId: string; pitcherId: string; disabled?: boolean }
function label(g: Pick<GoalDraft, 'scope' | 'teamId'>, data: Snapshot) {
  return g.scope === 'personal' ? 'Personal' : `${g.scope === 'coach' ? 'Coach' : 'Team'} · ${data.teams.find(t => t.id === g.teamId)?.name ?? 'Team'}`
}
export function GoalStat({ context, metric, actual, editable = true }: { context: GoalContext; metric: GoalMetric; actual: number | null | undefined; editable?: boolean }) {
  const { data, account, teamId, pitcherId } = context
  const goals = applicableGoals(data, metric, teamId, pitcherId)
  const drafts: GoalDraft[] = []
  if (pitcherId) drafts.push({ scope: 'personal', teamId: null, pitcherId, metric, target: 0, direction: fixedDirection(metric) ?? 'min' })
  for (const team of data.teams.filter(t => (teamId || pitcherId) && (!teamId || t.id === teamId))) {
    drafts.push({ scope: pitcherId ? 'coach' : 'team', teamId: team.id, pitcherId: pitcherId || null, metric, target: 0, direction: fixedDirection(metric) ?? 'min' })
  }
  const editableDrafts = editable ? drafts.filter(g => canEditGoal(g, account, data)) : []
  return <div className="stat-goals" aria-label={`${goalMetrics[metric]} goals`}>
    {goals.map(g => {
      const comparison = goalComparison(g, actual)
      return <div className="goal-annotation" data-goal-met={comparison.met == null ? 'unavailable' : String(comparison.met)} key={g.id}>
        <span>{label(g, data)} goal {goalTarget(g)} · {comparison.text}</span>
        {goalWarnings(g, data).map(w => <span className="goal-warning" key={w}>{w}</span>)}
      </div>
    })}
    {editableDrafts.length > 0 && <details className="goal-editor"><summary>{goals.some(g => canEditGoal(g, account, data)) ? 'Edit goals' : 'Set goal'}<span className="sr-only"> for {goalMetrics[metric]}</span></summary>
      <p className="goal-help">Ongoing targets apply to the selected statistics filters and all data sources.</p>
      {editableDrafts.map(draft => {
        const existing = (data.goals ?? []).find(g => g.scope === draft.scope && g.teamId === draft.teamId && g.pitcherId === draft.pitcherId && g.metric === metric)
        return <GoalForm key={`${draft.scope}:${draft.teamId}:${draft.pitcherId}:${draft.metric}`} context={context} draft={draft} existing={existing} />
      })}
    </details>}
  </div>
}
function GoalForm({ context, draft, existing }: { context: GoalContext; draft: GoalDraft; existing?: Goal }) {
  const [target, setTarget] = useState(existing ? String(existing.target) : '')
  const [direction, setDirection] = useState<GoalDirection>(existing?.direction ?? draft.direction)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [conflict, setConflict] = useState(false)
  // The revision belongs to the values the user opened, not a subsequently refreshed snapshot.
  const [opened, setOpened] = useState(existing)
  const value = { ...draft, target: target === '' ? NaN : Number(target), direction }
  const disabled = context.disabled || busy || !navigator.onLine || conflict
  async function act(remove: boolean) {
    setBusy(true); setError(''); setMessage('')
    try {
      let updated: Goal | undefined
      if (remove && opened) await context.repository.deleteGoal(opened)
      else updated = await context.repository.saveGoal(value, opened)
      setOpened(updated); setTarget(updated ? String(updated.target) : ''); setMessage(remove ? 'Goal removed.' : 'Goal saved.')
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'Could not save goal.'
      setError(reason); if (reason.includes('Refresh')) setConflict(true)
    } finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true)
    try {
      await context.repository.sync()
      if (context.repository.syncMessage) throw new Error(context.repository.syncMessage)
      const current = (await context.repository.snapshot()).goals?.find(g => g.scope === draft.scope && g.teamId === draft.teamId && g.pitcherId === draft.pitcherId && g.metric === draft.metric)
      setOpened(current); setTarget(current ? String(current.target) : ''); setDirection(current?.direction ?? draft.direction); setConflict(false); setError(''); setMessage('Latest goal loaded. Review before saving.')
    } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }
  return <form className="goal-form" onSubmit={event => { event.preventDefault(); void act(false) }}>
    <strong>{label(draft, context.data)}</strong>
    <label>Direction<select aria-label="Direction" value={direction} disabled={disabled || !!fixedDirection(draft.metric)} onChange={e => setDirection(e.target.value as GoalDirection)}><option value="min">At least</option><option value="max">At most</option></select></label>
    <label>Target<input type="number" min="0" max={draft.metric.endsWith('Pct') ? 100 : undefined} step={fixedDirection(draft.metric) ? 'any' : '1'} required value={target} disabled={disabled} onChange={e => setTarget(e.target.value)} /></label>
    {goalWarnings(value, context.data).map(w => <p className="goal-warning" role="status" key={w}>{w}</p>)}
    {error && <p className="goal-warning" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!navigator.onLine && <p>Reconnect to edit goals.</p>}
    <div className="goal-actions"><button type="submit" disabled={disabled || !validGoal(value)}>{busy ? 'Saving…' : 'Save goal'}</button>{opened && <button type="button" disabled={disabled} onClick={() => void act(true)}>Remove goal</button>}{conflict && <button type="button" disabled={busy || !navigator.onLine} onClick={() => void refresh()}>Refresh goal</button>}</div>
  </form>
}
