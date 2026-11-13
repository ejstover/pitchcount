import {expect,it} from 'vitest'
import {emptySnapshot,type Snapshot} from '../shared'
import type {Session} from '../domain'
import type {AchievementRecord} from './types'
import {needsCalendarEvaluation} from './scheduling'

const actor='player',now=new Date('2026-11-12T12:00:00Z')
function source(startedAt='2020-01-01T12:00:00Z',timezone='UTC'):Snapshot{
 const value=emptySnapshot()
 value.sessions=[{id:'practice',name:'Historical',notes:'',teamId:null,recorderId:'coach',deviceId:'device',revision:1,status:'ended',startedAt,endedAt:startedAt,updatedAt:startedAt,initialPitcherId:actor,selectedPitcherId:actor,initialAppearanceId:'appearance',pitcherIds:[actor],nextSequence:1} as Session]
 value.achievementRecords=[{id:'profile',pitcherId:actor,kind:'profile',revision:1,createdAt:'2020-01-01',updatedAt:'2020-01-01',data:{sport:'baseball',ageBand:'11–13',timezone,pins:[],sound:false}}]
 return value
}
function record(value:Snapshot,kind:string,data:unknown,pitcherId=actor){value.achievementRecords!.push({id:'record',pitcherId,kind,data,revision:1,createdAt:'2020-01-01',updatedAt:'2020-01-01'} as AchievementRecord)}

it('needs no timer for empty or fully closed history, but retains open and future practice periods',()=>{
 expect(needsCalendarEvaluation(emptySnapshot(),actor,now)).toBe(false)
 expect(needsCalendarEvaluation(source(),actor,now)).toBe(false)
 expect(needsCalendarEvaluation(source('2026-11-01T12:00:00Z'),actor,now)).toBe(true)
 expect(needsCalendarEvaluation(source('2027-01-01T12:00:00Z'),actor,now)).toBe(true)
})
it('keeps a week that crosses month end until the week also closes',()=>{
 const value=source('2026-04-30T12:00:00Z')
 expect(needsCalendarEvaluation(value,actor,new Date('2026-05-01T12:00:00Z'))).toBe(true)
 expect(needsCalendarEvaluation(value,actor,new Date('2026-05-03T12:00:00Z'))).toBe(false)
})
it('uses the player calendar around local midnight, rather than the UTC day',()=>{
 const value=source('2026-01-31T05:00:00Z','Pacific/Kiritimati')
 expect(needsCalendarEvaluation(value,actor,new Date('2026-01-31T09:59:00Z'))).toBe(true)
 expect(needsCalendarEvaluation(value,actor,new Date('2026-01-31T10:01:00Z'))).toBe(false)
 value.achievementRecords![0].data={sport:'baseball',ageBand:'11–13',timezone:'UTC',pins:[],sound:false}
 expect(needsCalendarEvaluation(value,actor,new Date('2026-01-31T10:01:00Z'))).toBe(true)
})
it('retains future activity and season checks until their calendar boundaries pass',()=>{
 const value=source();record(value,'checkin',{date:'2027-01-01',action:'warmup'})
 expect(needsCalendarEvaluation(value,actor,now)).toBe(true)
 value.achievementRecords!.pop();record(value,'season',{name:'Season',start:'2026-01-01',end:'2026-11-12'})
 expect(needsCalendarEvaluation(value,actor,now)).toBe(true)
 expect(needsCalendarEvaluation(value,actor,new Date('2026-11-13T12:00:00Z'))).toBe(false)
})
it('conservatively keeps daily evaluation for goals, including old paused goals',()=>{
 const value=source();record(value,'goal',{metric:'practice',scope:'week',target:1,effectiveFrom:'2020-01-01',pausedAt:'2021-01-01'})
 expect(needsCalendarEvaluation(value,actor,now)).toBe(true)
})
it('includes projected practice dates and only the evaluated player records',()=>{
 const value=source();record(value,'goal',{metric:'practice',scope:'week',target:1,effectiveFrom:'2020-01-01'},'foreign')
 expect(needsCalendarEvaluation(value,actor,now)).toBe(false)
 value.achievementSessions=[{...value.sessions[0],id:'projection',startedAt:'2027-01-01T12:00:00Z'}]
 expect(needsCalendarEvaluation(value,actor,now)).toBe(true)
})
it('rejects an invalid source date instead of declaring the source idle',()=>{
 expect(()=>needsCalendarEvaluation(source('invalid'),actor,now)).toThrow(RangeError)
})
