import type {Snapshot} from '../shared.ts'
import {calendarWindow,dateAt} from './calendar.ts'
import {playerProfile} from './profile.ts'

/** Conservative: goals always retain daily evaluation. Otherwise, once every
 * source date's week/month and every season are closed, time cannot change the
 * current rules. Source changes still dirty the job independently. */
export function needsCalendarEvaluation(input:Pick<Snapshot,'sessions'|'achievementSessions'|'achievementRecords'>,pitcherId:string,now=new Date()):boolean{
  const records=(input.achievementRecords??[]).filter(r=>r.pitcherId===pitcherId)
  if(records.some(r=>r.kind==='goal'))return true
  const timezone=playerProfile(records).timezone,today=dateAt(now,timezone)
  const dates=new Map<string,boolean>()
  const open=(date:string)=>{
    const cached=dates.get(date);if(cached!==undefined)return cached
    const pending=calendarWindow(date,'week').end>=today||calendarWindow(date,'month').end>=today
    dates.set(date,pending);return pending
  }
  if(records.some(r=>r.kind==='season'?r.data.end>=today:'date' in r.data&&open(r.data.date)))return true
  return [...input.sessions,...(input.achievementSessions??[])].some(s=>open(dateAt(s.startedAt,timezone)))
}

export function achievementEvaluationDue(job:{revision:number;processedRevision:number;nextEvaluateAt?:string}|undefined,now=Date.now()):boolean {
  if(!job)return false
  if(!job.nextEvaluateAt)return true
  if(job.nextEvaluateAt==='infinity')return false
  const due=Date.parse(job.nextEvaluateAt)
  return !Number.isFinite(due)||due<=now
}
