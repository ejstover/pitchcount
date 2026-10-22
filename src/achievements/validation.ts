import { checkInActions, drillTypes, goalLabels, type RecordDraft, type AchievementRecord } from './types.ts'
import { pitchLocations } from '../domain.ts'
const day = (v: unknown): v is string => typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v
const text = (v: unknown,n=1000) => typeof v==='string' && v.length<=n
export function validateAchievementRecord(value: unknown): asserts value is RecordDraft {
  if (!value || typeof value!=='object') throw new Error('Invalid activity')
  const r=value as AchievementRecord, d=r.data
  if(!d || typeof d!=='object' || JSON.stringify(d).length>5000) throw new Error('Invalid activity details')
  let valid=false
  switch(r.kind) {
    case 'profile':valid=['baseball','softball'].includes(r.data.sport) && ['8–10','11–13','14–18'].includes(r.data.ageBand) && Array.isArray(r.data.pins) && r.data.pins.length<=3 && r.data.pins.every(id=>/^\d{3}$/.test(id)) && typeof r.data.sound==='boolean';if(valid){try{new Intl.DateTimeFormat('en',{timeZone:r.data.timezone}).format()}catch{valid=false}}break
    case 'season':valid=text(r.data.name,80) && !!r.data.name.trim() && day(r.data.start) && day(r.data.end) && r.data.start<=r.data.end;break
    case 'goal':valid=Object.hasOwn(goalLabels,r.data.metric) && ['week','month','season'].includes(r.data.scope) && Number.isFinite(r.data.target) && r.data.target>0 && (['strike','firstPitch','walk','target'].includes(r.data.metric)?r.data.target<=100:Number.isSafeInteger(r.data.target)) && day(r.data.effectiveFrom) && (!r.data.pausedAt || day(r.data.pausedAt)) && (r.data.metric!=='habit' || Object.hasOwn(checkInActions,r.data.habit??''));break
    case 'plan':valid=day(r.data.date) && ['practice','rest','offseason'].includes(r.data.activity) && (r.data.complete===undefined || typeof r.data.complete==='boolean') && (r.data.adapted===undefined || typeof r.data.adapted==='boolean');break
    case 'checkin':valid=day(r.data.date) && Object.hasOwn(checkInActions,r.data.action) && (r.data.note===undefined || text(r.data.note));break
    case 'drill':valid=day(r.data.date) && Object.hasOwn(drillTypes,r.data.type) && typeof r.data.complete==='boolean' && (r.data.startSequence===undefined || Number.isSafeInteger(r.data.startSequence) && r.data.startSequence>=1) && (r.data.endSequence===undefined || Number.isSafeInteger(r.data.endSequence) && r.data.endSequence>=(r.data.startSequence??1));break
    case 'participation':valid=day(r.data.date) && text(r.data.challengeId,100) && !!r.data.challengeId && typeof r.data.complete==='boolean';break
    case 'scrapbook':valid=text(r.data.seasonId,100) && typeof r.data.goalReviewed==='boolean' && text(r.data.learning) && /^\d{3}$/.test(r.data.favorite);break
  }
  if(!valid) throw new Error('Complete the activity using valid dates and values.')
}
export function validateTarget(value: unknown) { if(value!==undefined && !pitchLocations.includes(value as typeof pitchLocations[number])) throw new Error('Invalid intended target') }
