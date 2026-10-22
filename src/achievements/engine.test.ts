import { describe, expect, it } from 'vitest'
import { catalog, families } from './catalog'
import { evaluateAchievements, reconcileAwards } from './engine'
import { awardArtManifest } from './art'
import { shareCardContent } from './share'
import { calendarWindow, dateAt } from './calendar'
import { checkInActions, drillTypes, type AchievementRecord, type RecordPayload } from './types'
import { emptySnapshot } from '../shared'
import type { Session, SessionEvent, PitchType } from '../domain'
function evidenceFixture() {
  const data=emptySnapshot();data.achievementRecords=[]
  const add=(payload:RecordPayload,date='2019-01-01')=>{const r={...payload,id:crypto.randomUUID(),pitcherId:'player',revision:1,createdAt:date+'T00:00:00Z',updatedAt:date+'T00:00:00Z'} as AchievementRecord;data.achievementRecords!.push(r);return r}
  add({kind:'profile',data:{sport:'softball',ageBand:'14–18',timezone:'UTC',pins:[],sound:false}})
  let practiceNumber=0, priorPracticeGoal=add({kind:'goal',data:{metric:'practice',scope:'month',target:1,effectiveFrom:'2019-01-01',pausedAt:'2019-12-31'}}).id
  for(let year=2020;year<2030;year++) {
    const season=add({kind:'season',data:{name:String(year),start:`${year}-01-01`,end:`${year}-12-31`}})
    for(const metric of ['strike','firstPitch','walk','target','habit','reflection'] as const)add({kind:'goal',data:{metric,scope:'month',target:metric==='walk'?10:metric==='habit'||metric==='reflection'?1:40,habit:'warmup',effectiveFrom:`${year}-01-01`}})
    add({kind:'goal',data:{metric:'strike',scope:'month',target:50,effectiveFrom:`${year}-02-01`}})
    priorPracticeGoal=add({kind:'goal',data:{metric:'practice',scope:'month',target:1,effectiveFrom:`${year}-01-01`,pausedAt:`${year}-12-31`,resumedFrom:priorPracticeGoal}}).id
    add({kind:'goal',data:{metric:'practice',scope:'week',target:1,effectiveFrom:`${year}-01-01`}})
    add({kind:'plan',data:{date:`${year}-12-30`,activity:'offseason',complete:true}})
    for(let month=1;month<=12;month++)for(const day of [5,20]) {
      const date=`${year}-${String(month).padStart(2,'0')}-${day===5?'05':'20'}`,sid=crypto.randomUUID(),initial=crypto.randomUUID()
      let current=initial,sequence=1
      const session:Session={id:sid,name:'Evidence fixture',notes:'Never exported on a card',teamId:null,recorderId:'recorder',deviceId:'device',revision:1,startedAt:date+'T12:00:00Z',updatedAt:date+'T13:00:00Z',endedAt:date+'T13:00:00Z',status:'ended',initialPitcherId:'player',selectedPitcherId:'player',initialAppearanceId:initial,pitcherIds:['player'],nextSequence:0}
      const drill=add({kind:'drill',data:{date,type:'target',sessionId:sid,startSequence:1,endSequence:10,complete:true}})
      const append=(type:PitchType,ends=false)=>{const next=crypto.randomUUID();data.events.push({id:crypto.randomUUID(),sessionId:sid,pitcherId:'player',appearanceId:current,nextAppearanceId:next,sequence:sequence++,timestamp:date+'T12:00:00Z',kind:'pitch',pitchType:type,pitchLocation:practiceNumber<3&&sequence<=10?'upOut':'upIn',...(sequence<=11?{drillId:drill.id,intendedTarget:'upIn' as const}:{}),voidedAt:null});if(ends)current=next}
      for(let batter=0;batter<10;batter++){append('called');append('called');append('called',true)}
      const walks=practiceNumber<3?20:Math.max(0,22-practiceNumber)
      for(let b=0;b<20;b++)if(b<walks){append('ball');append('ball');append('ball');append('ball',true)}else append('inPlay',true)
      data.events.push({id:crypto.randomUUID(),sessionId:sid,pitcherId:'player',appearanceId:current,nextAppearanceId:crypto.randomUUID(),sequence:sequence++,timestamp:date+'T13:00:00Z',kind:'end',voidedAt:null});session.nextSequence=sequence;data.sessions.push(session);practiceNumber++
      add({kind:'plan',data:{date,activity:'practice'}})
      const rest=new Date(date+'T12:00:00Z');rest.setUTCDate(rest.getUTCDate()+1);const restDate=rest.toISOString().slice(0,10)
      add({kind:'plan',data:{date:restDate,activity:'rest'}})
      add({kind:'plan',data:{date,activity:'practice',adapted:true}})
      for(const action of Object.keys(checkInActions))add({kind:'checkin',data:{date:action==='rest'?restDate:date,action}})
      for(const type of Object.keys(drillTypes).filter(t=>t!=='target'))add({kind:'drill',data:{date,type,complete:true}})
      add({kind:'participation',data:{date,challengeId:sid,complete:true}})
    }
    add({kind:'scrapbook',data:{seasonId:season.id,goalReviewed:true,learning:'My focus helped',favorite:'081'}})
  }
  return data
}
describe('complete achievement catalog and evaluation',()=>{
 it('defines exactly 400 stable, distinct designs across 80 five-tier families',()=>{
  expect(families).toHaveLength(80);expect(catalog).toHaveLength(400);expect(new Set(catalog.map(d=>d.id)).size).toBe(400)
  expect(Object.keys(awardArtManifest)).toHaveLength(400);expect(new Set(catalog.map(d=>awardArtManifest[d.artwork]())).size).toBe(400)
  const artworkIds=catalog.flatMap(d=>[...awardArtManifest[d.artwork]().matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]))
  expect(new Set(artworkIds).size).toBe(artworkIds.length)
  expect(catalog[0].title).toBe('First Practice');expect(catalog[44].threshold).toBe(25);expect(catalog[49].threshold).toBe(100)
 })
 it('requires real evidence for every definition, and can qualify all 400 from their supported inputs',()=>{
  expect(evaluateAchievements(emptySnapshot(),'player',new Date('2030-01-02')).awards).toEqual([])
  const result=evaluateAchievements(evidenceFixture(),'player',new Date('2030-01-02T12:00:00Z'))
  const ids=new Set(result.awards.map(a=>a.definitionId))
  expect(catalog.filter(d=>!ids.has(d.id)).map(d=>`${d.id} ${d.title}`)).toEqual([])
 },30000)
 it('uses local Sunday calendars across DST and year boundaries',()=>{
  expect(dateAt('2026-03-08T04:30:00Z','America/New_York')).toBe('2026-03-07')
  expect(calendarWindow('2027-01-01','week')).toEqual({start:'2026-12-27',end:'2027-01-02'})
  expect(calendarWindow('2028-02-15','month').end).toBe('2028-02-29')
 })
 it('deduplicates provenance, excludes recovered unproven history, and withdraws without changing award identity',()=>{
  const data=evidenceFixture();data.sessions=data.sessions.slice(0,1);data.achievementRecords=[]
  const original=evaluateAchievements(data,'player',new Date('2030-01-02'))
  data.sessions.push({...data.sessions[0],id:'copy',originSessionId:data.sessions[0].id,recovered:true})
  expect(evaluateAchievements(data,'player',new Date('2030-01-02')).awards.map(a=>a.id)).toEqual(original.awards.map(a=>a.id))
  data.sessions[0].recovered=true;data.sessions.pop();expect(evaluateAchievements(data,'player',new Date('2030-01-02')).awards).toEqual([])
  const withdrawn=reconcileAwards(original.awards,[],'2030-02-01T00:00:00Z');expect(withdrawn.every(a=>a.status==='withdrawn')).toBe(true)
  expect(reconcileAwards(withdrawn,original.awards,'2030-03-01T00:00:00Z')[0].earnedAt).toBe(original.awards[0].earnedAt)
 })
 it('does not award quality from incomplete samples, open windows, undone pitches or missing intended regions',()=>{
  const data=evidenceFixture();data.sessions=data.sessions.slice(-1);data.achievementRecords=[]
  data.events=data.events.filter(e=>e.sessionId===data.sessions[0].id);data.events.filter(e=>e.kind==='pitch').slice(1).forEach(e=>e.voidedAt='2030-01-01T00:00:00Z')
  const ids=evaluateAchievements(data,'player',new Date('2030-01-02')).awards.map(a=>a.definitionId)
  expect(ids).toContain('001');expect(ids).not.toContain('081');expect(ids).not.toContain('151')
 })
 it('exports only generic definition content for every design',()=>{
  for(const def of catalog){const content=shareCardContent(def);expect(Object.keys(content).sort()).toEqual(['brand','requirement','tier','title']);expect(JSON.stringify(content)).not.toMatch(/username|2026|@/i)}
 })
 it('holds period quality until closure, counts duplicate logs once, and cannot infer target accuracy',()=>{
  const data=evidenceFixture();data.sessions=data.sessions.slice(-1);data.events=data.events.filter(e=>e.sessionId===data.sessions[0].id)
  data.achievementRecords=data.achievementRecords!.filter(r=>r.kind==='profile'||r.kind==='checkin'&&r.data.action==='warmup'||r.kind==='drill'&&r.data.sessionId===data.sessions[0].id)
  const day=data.sessions[0].startedAt.slice(0,10)
  let ids=evaluateAchievements(data,'player',new Date(day+'T23:00:00Z')).awards.map(a=>a.definitionId)
  expect(ids).toContain('085');expect(ids).not.toContain('090');expect(ids).not.toContain('095')
  data.events.forEach(e=>delete e.intendedTarget)
  ids=evaluateAchievements(data,'player',new Date('2030-01-02')).awards.map(a=>a.definitionId)
  expect(ids).not.toContain('151')
  const r=data.achievementRecords!.find(r=>r.kind==='checkin'&&r.data.action==='warmup')!
  data.achievementRecords=Array.from({length:50},()=>({...r,id:crypto.randomUUID()}))
  ids=evaluateAchievements(data,'player',new Date('2030-01-02')).awards.map(a=>a.definitionId)
  expect(ids).toContain('281');expect(ids).not.toContain('282')
 })
})
