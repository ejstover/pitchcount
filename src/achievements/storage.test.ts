import { afterEach, describe, expect, it, vi } from 'vitest'
import { PitchDatabase, Repository } from '../storage'
import { CloudError, emptySnapshot, type Gateway } from '../shared'
import type { AchievementRecord } from './types'
let db:PitchDatabase
afterEach(async()=>{await db?.delete();vi.unstubAllGlobals()})
async function setup(gateway?:Gateway){vi.stubGlobal('navigator',{onLine:false});db=new PitchDatabase(`awards-${crypto.randomUUID()}`);await db.pitchers.put({id:'pitcher',name:'Player',jersey:'',ownerId:'adult',archived:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});await db.coaches.put({id:'account',name:'Player',email:'private@example.com',role:'player',active:true,pitcherId:'pitcher'});return new Repository(db,{coachId:'account',deviceId:'device'},gateway)}
describe('offline achievement storage and safe retries',()=>{
 it('survives close/reopen with ordered edits and no credential fields in backup',async()=>{
  const repo=await setup();await repo.saveAchievement({kind:'checkin',data:{date:'2026-10-20',action:'reflection',note:'Private learning'}})
  const entry=(await db.achievementRecords.toArray())[0];await repo.saveAchievement({kind:'checkin',data:{...entry.kind==='checkin'?entry.data:{date:'2026-10-20',action:'reflection'},note:'Corrected learning'}},entry)
  const name=db.name;db.close();db=new PitchDatabase(name)
  expect((await db.activityOutbox.orderBy('order').toArray()).map(o=>o.expectedRevision)).toEqual([0,1])
  expect((await db.achievementRecords.get(entry.id))?.data).toMatchObject({note:'Corrected learning'})
  const reopened=new Repository(db,{coachId:'account',deviceId:'device'});const backup=await reopened.exportBackup()
  expect(backup.achievementRecords).toHaveLength(1);expect(JSON.stringify(backup)).not.toContain('private@example.com')
 })
 it('uploads activity revisions in creation order, preserving unsynced records through refresh',async()=>{
  const remote=emptySnapshot(), revisions:number[]=[], records=new Map<string,AchievementRecord>()
  const gateway:Gateway={workspace:async()=>({...remote,achievementRecords:[...records.values()]}),upload:async()=>1,manage:async(_action,input)=>{const op=input as unknown as {record:AchievementRecord;expectedRevision:number};expect(op.expectedRevision).toBe(records.get(op.record.id)?.revision??0);revisions.push(op.expectedRevision);records.set(op.record.id,op.record);return {}}}
  const repo=await setup(gateway);await repo.saveAchievement({kind:'checkin',data:{date:'2026-10-20',action:'warmup'}});const entry=(await db.achievementRecords.toArray())[0]
  if(entry.kind!=='checkin')throw new Error('Wrong fixture')
  await repo.saveAchievement({kind:'checkin',data:{...entry.data,note:'Added offline'}},entry)
  vi.stubGlobal('navigator',{onLine:true});await repo.sync();expect(revisions).toEqual([0,1]);expect(await repo.activityPending()).toEqual([])
 })
 it('blocks dependent revisions on a conflict and preserves both for recovery',async()=>{
  let calls=0
  const gateway:Gateway={workspace:async()=>emptySnapshot(),upload:async()=>1,manage:async()=>{calls++;throw new CloudError('Activity changed','40001')}}
  const repo=await setup(gateway);await repo.saveAchievement({kind:'checkin',data:{date:'2026-10-20',action:'warmup'}});const entry=(await db.achievementRecords.toArray())[0]
  if(entry.kind!=='checkin')throw new Error('Wrong fixture')
  await repo.saveAchievement({kind:'checkin',data:{...entry.data,note:'Later edit'}},entry)
  vi.stubGlobal('navigator',{onLine:true});await repo.sync();await repo.sync();expect(calls).toBe(1)
  expect((await repo.exportRecovery()).activities).toHaveLength(2);expect(await repo.hasPending()).toBe(true)
 })
 it('exports private player projections as valid replayable history without modifying cached events',async()=>{
  const repo=await setup(),sid=crypto.randomUUID(),initial=crypto.randomUUID(),stamp='2026-10-20T12:00:00Z'
  await db.achievementSessions.put({id:sid,name:'Recorded practice',notes:'',startedAt:stamp,updatedAt:stamp,endedAt:stamp,status:'ended',initialPitcherId:'pitcher',selectedPitcherId:'pitcher',initialAppearanceId:initial,pitcherIds:['pitcher'],nextSequence:23,teamId:null,recorderId:'account',deviceId:'other-device',revision:1,recovered:true,originSessionId:'private-original',archived:false})
  await db.achievementEvents.bulkPut([5,6,20,21].map((sequence,i)=>({id:crypto.randomUUID(),sessionId:sid,pitcherId:'pitcher',appearanceId:i<2?initial:'missing-from-projection',nextAppearanceId:crypto.randomUUID(),sequence,timestamp:stamp,kind:i===1?'reset' as const:'pitch' as const,...(i!==1?{pitchType:'called' as const}:{}),voidedAt:i===3?stamp:null})))
  const backup=await repo.exportBackup()
  expect(backup.sessions[0].originSessionId).toBe('private-original');expect(backup.events.map(e=>e.sequence)).toEqual([1,2,3,4,5]);expect(backup.events.at(-1)?.kind).toBe('end')
  expect((await db.achievementEvents.toArray()).map(e=>e.sequence).sort((a,b)=>a-b)).toEqual([5,6,20,21])
 })
})
