import { metrics, project, type Appearance, type SessionEvent } from '../domain.ts'
import type { Snapshot } from '../shared.ts'
import { catalog, isMeta } from './catalog.ts'
import { addDays, calendarWindow, dateAt } from './calendar.ts'
import { defaultProfile, drillTypes, type AchievementAward, type AchievementRecord, type EvaluationResult, type GoalWindow, type PlayerProfile } from './types.ts'

type Practice = { id: string; date: string; events: SessionEvent[]; appearances: Appearance[] }
const unique = <T>(values: T[]) => [...new Set(values)]
const percent = (n: number, d: number) => d ? n / d * 100 : null
const natural = (a: Appearance) => a.outcome === 'walk' || a.outcome === 'strikeout' || a.outcome === 'inPlay'
function totals(practices: Practice[]) {
  const appearances = practices.flatMap(p => p.appearances), m = metrics(appearances), finished = appearances.filter(natural)
  return { ...m, completed: finished.length, completedWalk: percent(finished.filter(a => a.outcome === 'walk').length, finished.length), firstPositive: appearances.filter(a => a.pitches.length && a.pitches[0] !== 'ball').length }
}
export function playerProfile(records: AchievementRecord[]): PlayerProfile {
  return records.filter(r => r.kind === 'profile').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)?.data as PlayerProfile ?? defaultProfile()
}
export function evaluateAchievements(input: Pick<Snapshot, 'sessions'|'events'> & Pick<Snapshot,'achievementRecords'|'achievementSessions'|'achievementEvents'>, pitcherId: string, now = new Date()): EvaluationResult {
  const sessions=new Map((input.achievementSessions??[]).map(s=>[s.id,s]))
  const localIds=new Set<string>()
  for(const s of input.sessions)if(!sessions.has(s.id)||s.revision>=sessions.get(s.id)!.revision){sessions.set(s.id,s);localIds.add(s.id)}
  const data={...input,sessions:[...sessions.values()],events:[...(input.achievementEvents??[]).filter(e=>!localIds.has(e.sessionId)),...input.events.filter(e=>localIds.has(e.sessionId))]}
  const records = (data.achievementRecords ?? []).filter(r => r.pitcherId === pitcherId)
  const profile = playerProfile(records), today = dateAt(now, profile.timezone), earnedAt = now.toISOString()
  const seasons = records.filter(r => r.kind === 'season')
  const seasonAt = (date: string) => seasons.find(r => r.data.start <= date && date <= r.data.end)
  const seen = new Set<string>()
  const practices: Practice[] = data.sessions.filter(s => s.status === 'ended' && (!s.recovered || !!s.originSessionId)).sort((a,b) => a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id)).flatMap(s => {
    const origin = s.originSessionId ?? s.id
    if (seen.has(origin)) return []
    const events = data.events.filter(e => e.sessionId === s.id).sort((a,b) => a.sequence-b.sequence)
    const appearances = project(s,events).appearances.filter(a => a.pitcherId === pitcherId && a.pitches.length)
    const date = dateAt(s.startedAt, profile.timezone)
    if (!appearances.length || date > today) return []
    seen.add(origin)
    return [{id:s.id,date,events,appearances}]
  })
  const all = totals(practices), result: EvaluationResult = { awards: [], progress: [], windows: [] }
  const inRange = (start: string, end: string) => practices.filter(p => start <= p.date && p.date <= end)
  const checks = records.filter(r => r.kind === 'checkin').filter(r => r.data.date <= today)
  const plans = records.filter(r => r.kind === 'plan')
  const drills = records.filter(r => r.kind === 'drill').filter(r => r.data.complete && r.data.date <= today).sort((a,b)=>a.data.date.localeCompare(b.data.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
  const restCache=new Map<string,boolean>(), actionCache=new Map<string,typeof checks>()
  const restValid = (date: string) => {if(!restCache.has(date))restCache.set(date,plans.some(r=>r.data.date===date&&r.data.activity==='rest'&&dateAt(r.createdAt,profile.timezone)<date));return restCache.get(date)!}
  const actionRecords = (action: string) => {if(!actionCache.has(action))actionCache.set(action,checks.filter(r=>r.data.action===action&&(action!=='rest'||restValid(r.data.date))&&(action!=='adaptation'||plans.some(p=>p.data.date===r.data.date&&p.data.adapted))));return actionCache.get(action)!}
  const emit = (family: number, actual: number | null, period = 'career', evidence: string[] = [], eligible = true, seasonId?: string, goal?: GoalWindow, remainingSample?: string) => {
    for (const def of catalog.filter(d => d.family === family)) {
      const qualified = eligible && actual !== null && Number.isFinite(actual) && ([25,26].includes(family) ? actual <= def.threshold+1e-9 : actual+1e-9 >= def.threshold)
      result.progress.push({definitionId:def.id,period,actual:actual ?? 0,eligible,remainingSample})
      if (qualified) result.awards.push({id:`${pitcherId}:${def.id}:${period}`,pitcherId,definitionId:def.id,period,seasonId,earnedAt,status:'qualified',actual:actual!,evidence:unique(evidence),goal,ruleVersion:1})
    }
  }
  const career = (family: number, n: number, evidence: string[] = practices.map(p => p.id)) => emit(family,n,'career',evidence)
  const checkCount = (family: number, action: string) => {const rows=actionRecords(action);career(family,unique(rows.map(r=>r.data.date)).length,rows.map(r=>r.id))}
  const buckets = (scope: 'week'|'month') => unique([...practices.map(p => calendarWindow(p.date,scope).start), ...records.flatMap(r => 'date' in r.data ? [calendarWindow(r.data.date,scope).start] : [])]).sort().map(start => ({...calendarWindow(start,scope),scope}))
  const targets = drills.flatMap(d => {
    const p=practices.find(p => p.id===d.data.sessionId)
    if (!p || !['target','left','right'].includes(d.data.type)) return []
    const events=p.events.filter(e=>e.kind==='pitch' && !e.voidedAt && e.pitcherId===pitcherId && e.drillId===d.id && e.sequence>=(d.data.startSequence ?? 0) && e.sequence<=(d.data.endSequence ?? Infinity))
    return [{id:d.id,date:p.date,seasonId:seasonAt(p.date)?.id,events,hits:events.filter(e=>e.intendedTarget && e.pitchLocation===e.intendedTarget).length,eligible:events.length>=10 && events.every(e=>e.intendedTarget && e.pitchLocation)}]
  })
  const targetTotals = (start: string,end: string) => {const t=targets.filter(t=>t.date>=start && t.date<=end && t.eligible);return {rate:percent(t.reduce((n,t)=>n+t.hits,0),t.reduce((n,t)=>n+t.events.length,0)),attempts:t.reduce((n,t)=>n+t.events.length,0)}}
  // Goal versions are append-only. Their effective dates freeze the target selected for a window.
  const goals = records.filter(r=>r.kind==='goal').sort((a,b)=>a.data.effectiveFrom.localeCompare(b.data.effectiveFrom)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
  const goalKeys = unique(goals.map(g=>`${g.data.metric}:${g.data.scope}:${g.data.seasonId ?? ''}`))
  for (const key of goalKeys) {
    const versions=goals.filter(g=>`${g.data.metric}:${g.data.scope}:${g.data.seasonId ?? ''}`===key), first=versions[0]
    let cursor=first.data.effectiveFrom
    for (let guard=0; cursor<=today && guard<2000; guard++) {
      const scope=first.data.scope, season=seasons.find(s=>s.id===first.data.seasonId)
      if (scope==='season' && !season) break
      const range=scope==='season' ? {start:season!.data.start,end:season!.data.end} : calendarWindow(cursor,scope)
      const g=versions.filter(g=>g.data.effectiveFrom<=range.end).at(-1)!
      if (g.data.effectiveFrom>range.start && g!==first) {cursor=addDays(range.end,1);continue}
      const start=g===first && g.data.effectiveFrom>range.start ? g.data.effectiveFrom : range.start
      const m=totals(inRange(start,range.end)), samples=scope==='week' ? [25,10,15] : scope==='month' ? [50,20,30] : [100,40,50]
      let actual: number|null=null, enough=true
      switch(g.data.metric) {
        case 'strike': actual=m.strikePct;enough=m.total>=samples[0];break
        case 'firstPitch':actual=m.firstPitchPct;enough=m.batters>=samples[1];break
        case 'walk':actual=m.completedWalk;enough=m.completed>=samples[2];break
        case 'target': {const t=targetTotals(start,range.end);actual=t.rate;enough=t.attempts>=10;break}
        case 'practice':actual=inRange(start,range.end).length;break
        case 'pitches':actual=m.total;break
        case 'habit':actual=unique(actionRecords(g.data.habit ?? 'warmup').filter(r=>r.data.date>=start && r.data.date<=range.end).map(r=>r.data.date)).length;break
        case 'reflection':actual=unique(actionRecords('reflection').filter(r=>r.data.date>=start && r.data.date<=range.end).map(r=>r.data.date)).length;break
      }
      const closed=range.end<today, paused=!!g.data.pausedAt && g.data.pausedAt<=range.end
      const met=closed && !paused && enough && actual!==null && (g.data.metric==='walk' ? actual<=g.data.target : actual>=g.data.target)
      result.windows.push({id:`${key}:${range.start}`,goalId:g.id,scope,start,end:range.end,target:g.data.target,actual,met,revision:g.revision,metric:g.data.metric,timezone:profile.timezone,ruleVersion:1})
      if (scope==='season') break
      cursor=addDays(range.end,1)
    }
  }
  const met=result.windows.filter(w=>w.met && w.metric!=='pitches')
  career(1,practices.length);career(2,all.total);career(3,unique(practices.map(p=>calendarWindow(p.date,'week').start)).length)
  career(4,unique(practices.map(p=>p.date.slice(0,7))).length);career(5,unique(practices.map(p=>seasonAt(p.date)?.id).filter(Boolean)).length);career(6,unique(practices.map(p=>p.date.slice(0,4))).length)
  career(11,unique(met.filter(w=>w.scope==='week').map(w=>w.start)).length,met.map(w=>w.goalId));career(12,unique(met.filter(w=>w.scope==='month').map(w=>w.start)).length,met.map(w=>w.goalId))
  career(15,unique(met.filter(w=>w.scope==='month' && ['strike','firstPitch','walk','target'].includes(w.metric)).map(w=>w.start)).length,met.map(w=>w.goalId))
  const balanced=buckets('week').filter(b=>drills.some(d=>d.data.date>=b.start && d.data.date<=b.end) && actionRecords('reflection').some(r=>r.data.date>=b.start && r.data.date<=b.end) && actionRecords('rest').some(r=>r.data.date>=b.start && r.data.date<=b.end))
  career(16,balanced.length,balanced.map(b=>b.start))
  for (const b of [...buckets('week'),...buckets('month')]) {
    const ps=inRange(b.start,b.end), m=totals(ps), evidence=ps.map(p=>p.id), closed=b.end<today
    emit(b.scope==='week'?9:10,m.total,b.start,evidence,true,seasonAt(b.start)?.id)
    const scheduled=unique(plans.filter(r=>r.data.activity==='practice' && r.data.date>=b.start && r.data.date<=b.end && dateAt(r.createdAt,profile.timezone)<=r.data.date).map(r=>r.data.date))
    const done=scheduled.filter(date=>ps.some(p=>p.date===date)).length
    emit(b.scope==='week'?13:14,percent(done,scheduled.length),b.start,scheduled,closed && scheduled.length>0)
    emit(b.scope==='week'?18:19,m.strikePct,b.start,evidence,closed && m.total>=(b.scope==='week'?25:50),seasonAt(b.start)?.id,undefined,'Needs enough pitches and a closed window')
    emit(b.scope==='week'?22:23,m.firstPitchPct,b.start,evidence,closed && m.batters>=(b.scope==='week'?10:20),seasonAt(b.start)?.id,undefined,'Needs enough batters and a closed window')
    if (b.scope==='month') emit(26,m.completedWalk,b.start,evidence,closed && m.completed>=30,seasonAt(b.start)?.id)
  }
  for (const p of practices) {
    const m=totals([p]), sid=seasonAt(p.date)?.id
    emit(17,m.strikePct,p.id,[p.id],m.total>=10,sid,undefined,'Minimum 10 pitches')
    emit(21,m.firstPitchPct,p.id,[p.id],m.batters>=5,sid,undefined,'Minimum 5 batters')
    emit(25,m.completedWalk,p.id,[p.id],m.completed>=10,sid,undefined,'Minimum 10 completed batters')
    let positive=0, best=0, starts=0, bestStarts=0
    const appearances=new Set<string>()
    for (const e of p.events) {
      if (e.voidedAt) continue
      if (e.pitcherId!==pitcherId || e.kind!=='pitch') {positive=0;starts=0;continue}
      positive=e.pitchType==='ball'?0:positive+1;best=Math.max(best,positive)
      if (!appearances.has(e.appearanceId)) {appearances.add(e.appearanceId);starts=e.pitchType==='ball'?0:starts+1;bestStarts=Math.max(bestStarts,starts)}
    }
    emit(29,best,p.id,[p.id],true,sid);emit(30,bestStarts,p.id,[p.id],true,sid)
  }
  career(27,all.firstPositive);career(28,all.strikeouts)
  for (const t of targets) emit(31,percent(t.hits,t.events.length),t.id,[t.id],t.eligible,t.seasonId,undefined,'Minimum 10 fully located target attempts')
  career(32,targets.filter(t=>t.eligible).reduce((n,t)=>n+t.hits,0),targets.filter(t=>t.eligible).map(t=>t.id))
  for (const s of seasons) {
    const ps=inRange(s.data.start,s.data.end), m=totals(ps), ids=ps.map(p=>p.id), closed=s.data.end<today
    emit(20,m.strikePct,s.id,ids,closed && m.total>=100,s.id);emit(24,m.firstPitchPct,s.id,ids,closed && m.batters>=40,s.id)
    for (const [family,key,min] of [[33,'strikePct',30],[34,'firstPitchPct',15],[35,'completedWalk',30]] as const) {
      const eligible=ps.filter(p=>{const m=totals([p]);return family===33?m.total>=10:family===34?m.batters>=5:m.completed>=10})
      let best: number|null=null
      for (let i=3;i+3<=eligible.length;i+=3) {
        const prev=totals(eligible.slice(i-3,i)),next=totals(eligible.slice(i,i+3)), a=prev[key],b=next[key]
        const size=(x:ReturnType<typeof totals>)=>family===33?x.total:family===34?x.batters:x.completed
        if(a!==null && b!==null && size(prev)>=min && size(next)>=min) best=Math.max(best??-Infinity,family===35?a-b:b-a)
      }
      emit(family,best,s.id,ids,best!==null,s.id)
    }
    let targetGain: number|null=null
    // Compare the same intended region, never a new/easier target mix.
    for (const region of ['upIn','upOut','downIn','downOut','middle']) {
      const ts=targets.filter(t=>t.seasonId===s.id && t.eligible && t.events.every(e=>e.intendedTarget===region))
      for(let i=3;i+3<=ts.length;i+=3) {
        const rate=(a:typeof ts)=>percent(a.reduce((n,t)=>n+t.hits,0),a.reduce((n,t)=>n+t.events.length,0))!
        targetGain=Math.max(targetGain??-Infinity,rate(ts.slice(i,i+3))-rate(ts.slice(i-3,i)))
      }
    }
    emit(36,targetGain,s.id,ids,targetGain!==null,s.id)
    const eligible=ps.filter(p=>totals([p]).total>=10), baseline=totals(eligible.slice(0,3)).strikePct
    let run=0,longest=0
    if(eligible.length>=3 && baseline!==null) for(const p of eligible.slice(3)){run=totals([p]).strikePct!>=baseline+2?run+1:0;longest=Math.max(longest,run)}
    emit(37,longest,s.id,ids,eligible.length>=3,s.id)
    const strikes=goals.filter(g=>g.data.metric==='strike' && g.data.effectiveFrom<=s.data.end)
    const raised:number[]=[]
    for(const scope of ['week','month','season']) {
      const versions=strikes.filter(g=>g.data.scope===scope && (scope!=='season'||g.data.seasonId===s.id))
      const original=versions.filter(g=>g.data.effectiveFrom<=s.data.start).at(-1)??versions[0]
      if(original)raised.push(...met.filter(w=>w.metric==='strike' && w.scope===scope && w.start>=s.data.start && w.end<=s.data.end && versions.some(g=>g.id===w.goalId)).map(w=>w.target-original.data.target))
    }
    emit(38,raised.length?Math.max(...raised):null,s.id,strikes.map(g=>g.id),raised.length>0,s.id)
  }
  let personalBests=0,best=-Infinity
  const bestDates:string[]=[]
  const eligible=practices.filter(p=>totals([p]).total>=10)
  eligible.forEach((p,i)=>{const value=totals([p]).strikePct!;if(i>=3 && value>best){personalBests++;bestDates.push(p.date)}best=Math.max(best,value)})
  career(39,personalBests,eligible.map(p=>p.id))
  career(40,goals.filter(g=>g.data.resumedFrom && result.windows.filter(w=>w.goalId===g.id).sort((a,b)=>a.start.localeCompare(b.start))[0]?.met && g.data.metric!=='pitches').length,goals.map(g=>g.id))
  for (const [i,metric] of ['strike','firstPitch','walk','target','practice','habit','reflection'].entries()) {const ws=met.filter(w=>w.metric===metric);emit(41+i,ws.length,'career',ws.map(w=>w.goalId),true,undefined,ws.at(-1))}
  const combo=unique(met.map(w=>`${w.scope}:${w.start}`)).filter(key=>unique(met.filter(w=>`${w.scope}:${w.start}`===key).map(w=>w.metric)).length>=2)
  career(48,combo.length,met.map(w=>w.goalId))
  Object.keys(drillTypes).forEach((type,i)=>{const rows=drills.filter(d=>d.data.type===type);career(49+i,unique(rows.map(r=>r.data.date)).length,rows.map(r=>r.id))})
  ;['warmup','cooldown','readiness','rest','adaptation'].forEach((a,i)=>checkCount(57+i,a))
  const offseason=plans.filter(p=>p.data.activity==='offseason' && p.data.complete && p.data.date<=today)
  career(62,unique(offseason.map(r=>seasonAt(r.data.date)?.id ?? r.data.date.slice(0,4))).length,offseason.map(r=>r.id))
  checkCount(63,'gear');checkCount(64,'routine')
  ;['focus','reflection','learning','nextStep','visualization','reset','feedbackAsked','feedbackApplied','encouragement','setup','cleanup','sharedLearning','commitment'].forEach((a,i)=>checkCount(65+i,a))
  const contributions=records.filter(r=>r.kind==='participation').filter(r=>r.data.complete && r.data.date<=today)
  career(78,unique(contributions.map(r=>r.data.challengeId)).length,contributions.map(r=>r.id))
  const scrapbooks=records.filter(r=>r.kind==='scrapbook').filter(r=>r.data.goalReviewed && r.data.learning.trim() && result.awards.some(a=>a.definitionId===r.data.favorite && a.seasonId===r.data.seasonId) && seasons.some(s=>s.id===r.data.seasonId && s.data.end<today))
  career(79,unique(scrapbooks.map(r=>r.data.seasonId)).length,scrapbooks.map(r=>r.id))
  // Attribute a career milestone to the season where its threshold was crossed,
  // rather than every season whose old records contributed to the career total.
  const units=new Map<number,string[]>()
  const setUnits=(family:number,dates:string[])=>units.set(family,[...dates].sort())
  const weighted=(family:number,values:{date:string;n:number}[])=>{const dates:string[]=[],limit=Math.max(...catalog.filter(d=>d.family===family).map(d=>d.threshold));for(const item of [...values].sort((a,b)=>a.date.localeCompare(b.date)))for(let i=0;i<item.n&&dates.length<limit;i++)dates.push(item.date);setUnits(family,dates)}
  const firstDates=(values:{key:string;date:string}[])=>{const map=new Map<string,string>();for(const v of values.sort((a,b)=>a.date.localeCompare(b.date)))if(!map.has(v.key))map.set(v.key,v.date);return [...map.values()]}
  setUnits(1,practices.map(p=>p.date));weighted(2,practices.map(p=>({date:p.date,n:totals([p]).total})))
  setUnits(3,firstDates(practices.map(p=>({key:calendarWindow(p.date,'week').start,date:p.date}))));setUnits(4,firstDates(practices.map(p=>({key:p.date.slice(0,7),date:p.date}))))
  setUnits(5,firstDates(practices.filter(p=>seasonAt(p.date)).map(p=>({key:seasonAt(p.date)!.id,date:p.date}))));setUnits(6,firstDates(practices.map(p=>({key:p.date.slice(0,4),date:p.date}))))
  setUnits(11,firstDates(met.filter(w=>w.scope==='week').map(w=>({key:w.start,date:w.end}))));setUnits(12,firstDates(met.filter(w=>w.scope==='month').map(w=>({key:w.start,date:w.end}))))
  setUnits(15,firstDates(met.filter(w=>w.scope==='month'&&['strike','firstPitch','walk','target'].includes(w.metric)).map(w=>({key:w.start,date:w.end}))));setUnits(16,balanced.map(b=>b.end))
  weighted(27,practices.map(p=>({date:p.date,n:totals([p]).firstPositive})));weighted(28,practices.map(p=>({date:p.date,n:totals([p]).strikeouts})));weighted(32,targets.filter(t=>t.eligible).map(t=>({date:t.date,n:t.hits})))
  setUnits(39,bestDates);setUnits(40,goals.filter(g=>g.data.resumedFrom && g.data.metric!=='pitches').flatMap(g=>{const w=result.windows.filter(w=>w.goalId===g.id).sort((a,b)=>a.start.localeCompare(b.start))[0];return w?.met?[w.end]:[]}))
  for(const [i,metric] of ['strike','firstPitch','walk','target','practice','habit','reflection'].entries())setUnits(41+i,met.filter(w=>w.metric===metric).map(w=>w.end))
  setUnits(48,combo.map(key=>met.find(w=>`${w.scope}:${w.start}`===key)!.end))
  Object.keys(drillTypes).forEach((type,i)=>setUnits(49+i,unique(drills.filter(d=>d.data.type===type).map(d=>d.data.date))))
  ;['warmup','cooldown','readiness','rest','adaptation'].forEach((a,i)=>setUnits(57+i,unique(actionRecords(a).map(r=>r.data.date))))
  setUnits(62,firstDates(offseason.map(r=>({key:seasonAt(r.data.date)?.id??r.data.date.slice(0,4),date:r.data.date}))))
  ;['gear','routine','focus','reflection','learning','nextStep','visualization','reset','feedbackAsked','feedbackApplied','encouragement','setup','cleanup','sharedLearning','commitment'].forEach((a,i)=>setUnits(63+i,unique(actionRecords(a).map(r=>r.data.date))))
  setUnits(78,firstDates(contributions.map(r=>({key:r.data.challengeId,date:r.data.date}))));setUnits(79,firstDates(scrapbooks.map(r=>({key:r.data.seasonId,date:seasons.find(s=>s.id===r.data.seasonId)!.data.end}))))
  const ordinary=result.awards.filter(a=>!isMeta(catalog.find(d=>d.id===a.definitionId)!.family))
  for(const a of ordinary){const def=catalog.find(d=>d.id===a.definitionId)!;if(def.scope==='career'){const date=units.get(def.family)?.[def.threshold-1];if(date){a.achievedDate=date;a.seasonId=seasonAt(date)?.id}}}
  career(7,unique(ordinary.map(a=>catalog.find(d=>d.id===a.definitionId)!.category)).length,ordinary.map(a=>a.id))
  career(8,unique(ordinary.map(a=>a.definitionId)).length,ordinary.map(a=>a.id))
  const collected=new Map<string,Set<number>>()
  const categoryById=new Map(catalog.map(d=>[d.id,d.category]))
  for(const a of ordinary){
    const matching=new Set(a.seasonId?[a.seasonId]:[])
    for(const sid of matching){const set=collected.get(sid)??new Set<number>();set.add(categoryById.get(a.definitionId)!);collected.set(sid,set)}
  }
  for(const s of seasons)emit(80,collected.get(s.id)?.size??0,s.id,ordinary.map(a=>a.id),true,s.id)
  return result
}

/** Preserve first-earned timestamps and identity across corrections and reinstatement. */
export function reconcileAwards(previous: AchievementAward[], next: AchievementAward[], now: string): AchievementAward[] {
  const map=new Map(previous.map(a=>[a.id,a]))
  for(const a of next) map.set(a.id,{...a,earnedAt:map.get(a.id)?.earnedAt??a.earnedAt})
  const ids=new Set(next.map(a=>a.id))
  return [...map.values()].map(a=>ids.has(a.id)?a:{...a,status:'withdrawn',explanation:`Evidence changed; recalculated ${now.slice(0,10)}.`})
}
