import type { Coach } from './domain'
import { isCoach } from './domain'
import type { Snapshot } from './shared'

export const goalMetrics = {
  total: 'Total pitches', balls: 'Balls', positive: 'Positive strike outcomes',
  strikePct: 'Strike %', firstPitchPct: 'First-pitch strike %', batters: 'Batters faced',
  walks: 'Walks', strikeouts: 'Strikeouts', walkPct: 'Walk %', pitchesPerBatter: 'Pitches / batter',
} as const
export type GoalMetric = keyof typeof goalMetrics
export type GoalScope = 'team' | 'coach' | 'personal'
export type GoalDirection = 'min' | 'max'
export interface Goal {
  id: string; scope: GoalScope; teamId: string | null; pitcherId: string | null
  metric: GoalMetric; direction: GoalDirection; target: number; revision: number
  updatedAt: string; updatedBy: string | null
}
export type GoalDraft = Pick<Goal, 'scope' | 'teamId' | 'pitcherId' | 'metric' | 'direction' | 'target'>
export const isRateGoal = (metric: GoalMetric) => ['strikePct', 'firstPitchPct', 'walkPct', 'pitchesPerBatter'].includes(metric)
export function fixedDirection(metric: GoalMetric): GoalDirection | null {
  return ['strikePct', 'firstPitchPct'].includes(metric) ? 'min' : ['walkPct', 'pitchesPerBatter'].includes(metric) ? 'max' : null
}
export function validGoal(g: GoalDraft): boolean {
  return Object.hasOwn(goalMetrics, g.metric) && ['team', 'coach', 'personal'].includes(g.scope)
    && ['min', 'max'].includes(g.direction) && Number.isFinite(g.target) && g.target >= 0
    && (g.metric.endsWith('Pct') ? g.target <= 100 : isRateGoal(g.metric) || Number.isSafeInteger(g.target))
    && (!fixedDirection(g.metric) || fixedDirection(g.metric) === g.direction)
    && (g.scope === 'team' ? !!g.teamId && g.pitcherId === null : g.scope === 'coach' ? !!g.teamId && !!g.pitcherId : g.teamId === null && !!g.pitcherId)
}
export function goalValue(metric: GoalMetric, value: number) {
  return metric.endsWith('Pct') ? `${Number(value.toFixed(1))}%` : metric === 'pitchesPerBatter' ? value.toFixed(2) : String(value)
}
export const goalTarget = (g: GoalDraft) => `${g.direction === 'min' ? '≥' : '≤'}${goalValue(g.metric, g.target)}`
export function goalComparison(g: GoalDraft, actual: number | null | undefined) {
  if (actual == null || !Number.isFinite(actual)) return { met: null, text: 'Result unavailable' }
  const difference = actual - g.target
  const met = g.direction === 'min' ? difference >= 0 : difference <= 0
  const precision = g.metric === 'pitchesPerBatter' ? 2 : g.metric.endsWith('Pct') ? 1 : 0
  const amount = Number(Math.abs(difference).toFixed(precision))
  return { met, text: difference === 0 ? 'At goal' : `${amount === 0 ? '<' + (10 ** -precision).toFixed(precision) : amount}${g.metric.endsWith('Pct') ? ' percentage points' : ''} ${difference > 0 ? 'above' : 'below'} goal` }
}
export function canEditGoal(g: Pick<GoalDraft, 'scope' | 'teamId' | 'pitcherId'>, account: Coach, data: Snapshot) {
  if (!account.active) return false
  if (g.scope === 'personal') return account.role === 'player' && account.pitcherId === g.pitcherId && data.pitchers.some(p => p.id === g.pitcherId && !p.archived)
  return isCoach(account) && !!g.teamId && data.teams.some(t => t.id === g.teamId && !t.archived)
    && (account.role === 'admin' || data.teamCoaches.some(m => m.teamId === g.teamId && m.coachId === account.id))
    && (g.scope === 'team' || data.teamPitchers.some(m => m.teamId === g.teamId && m.pitcherId === g.pitcherId && m.active) && data.pitchers.some(p => p.id === g.pitcherId && !p.archived))
}
export function applicableGoals(data: Snapshot, metric: GoalMetric, teamId: string, pitcherId: string) {
  return (data.goals ?? []).filter(g => g.metric === metric && (pitcherId
    ? g.scope === 'personal' && g.pitcherId === pitcherId || g.scope === 'coach' && g.pitcherId === pitcherId && (!teamId || g.teamId === teamId)
      || g.scope === 'team' && isRateGoal(metric) && (!teamId || g.teamId === teamId) && data.teamPitchers.some(m => m.teamId === g.teamId && m.pitcherId === pitcherId && m.active)
    : g.scope === 'team' && !!teamId && g.teamId === teamId))
}
export function goalWarnings(personal: GoalDraft, data: Snapshot): string[] {
  if (personal.scope !== 'personal' || !validGoal(personal)) return []
  const teams = data.teamPitchers.filter(m => m.pitcherId === personal.pitcherId && m.active && data.teams.some(t => t.id === m.teamId && !t.archived)).map(m => m.teamId)
  return (data.goals ?? []).filter(g => g.metric === personal.metric && g.teamId && teams.includes(g.teamId)
    && (g.scope === 'team' && isRateGoal(g.metric) || g.scope === 'coach' && g.pitcherId === personal.pitcherId)).flatMap(g => {
    const label = `${data.teams.find(t => t.id === g.teamId)?.name ?? 'Team'} ${g.scope === 'team' ? 'team standard' : 'coach target'} ${goalTarget(g)}`
    if (personal.direction !== g.direction) return [`${label}: different target direction.`]
    const gap = g.direction === 'min' ? g.target - personal.target : personal.target - g.target
    if (gap <= 0) return []
    const difference = g.metric.endsWith('Pct') ? `${Number(gap.toFixed(1))} percentage points` : goalValue(g.metric, gap)
    return [`Personal goal ${goalTarget(personal)} is less demanding than ${label} by ${difference}. You can still save your goal.`]
  })
}
