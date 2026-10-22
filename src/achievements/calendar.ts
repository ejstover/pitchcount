import type { GoalScope } from './types.ts'
export function dateAt(value: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const p = (type: string) => parts.find(p => p.type === type)!.value
  return `${p('year')}-${p('month')}-${p('day')}`
}
export function addDays(date: string, days: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10) }
export function calendarWindow(date: string, scope: 'week' | 'month') {
  if (scope === 'week') { const start = addDays(date, -new Date(`${date}T12:00:00Z`).getUTCDay()); return {start, end:addDays(start,6)} }
  const start = date.slice(0,7)+'-01', d = new Date(`${start}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth()+1)
  return {start, end:addDays(d.toISOString().slice(0,10),-1)}
}
export function nextEffective(date: string, scope: GoalScope, seasonEnd?: string) { return addDays(scope === 'season' ? seasonEnd ?? date : calendarWindow(date, scope).end, 1) }
