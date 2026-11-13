import {describe,expect,it} from 'vitest'
import type {Session,SessionEvent} from './domain'
import type {Upload} from './shared'
import {preparePracticeTransfer,practiceUploadRequest} from './practice-transfer'

const session={id:'practice',revision:4} as Session
const event=(sequence:number)=>({id:`event-${sequence}`,sessionId:'practice',sequence,pitcherId:'pitcher',appearanceId:`appearance-${sequence}`,nextAppearanceId:`appearance-${sequence+1}`,timestamp:'2026-11-11T12:00:00Z',kind:'pitch',pitchType:'inPlay',voidedAt:null} as SessionEvent)
const operation=(events:SessionEvent[]):Upload=>({id:'operation',sessionId:'practice',expectedRevision:4,session:{...session,revision:5},events})
describe('durable practice transfer encoding',()=>{
 it('sends one new event instead of a thousand-event prefix',()=>{
  const events=Array.from({length:1000},(_,i)=>event(i+1)),op=operation(events)
  const prepared=preparePracticeTransfer(op,{session,events:events.slice(0,-1)})
  const request=practiceUploadRequest(prepared),delta=request.input.delta as any
  expect(request.name).toBe('upload_practice_delta');expect(delta.baseEventCount).toBe(999)
  expect(delta.appendEvents).toEqual([events[999]]);expect(delta.voidedEvents).toEqual([])
  expect(JSON.stringify(request.input).length).toBeLessThan(JSON.stringify(op).length*0.01)
 })
 it('encodes only undo changes and accepts equivalent JSON key ordering',()=>{
  const old=[event(1),event(2)],reordered={voidedAt:'2026-11-11T13:00:00Z',...Object.fromEntries(Object.entries(old[0]).filter(([k])=>k!=='voidedAt').reverse())} as SessionEvent
  const prepared=preparePracticeTransfer(operation([reordered,old[1]]),{session,events:old})
  const delta=practiceUploadRequest(prepared).input.delta as any
  expect(delta.appendEvents).toEqual([]);expect(delta.voidedEvents).toEqual([{sequence:1,voidedAt:'2026-11-11T13:00:00Z'}])
 })
 it('keeps the full protocol for immutable edits, unvoiding and uncertain old uploads',()=>{
  const old=[event(1)],base={session,events:old}
  expect(preparePracticeTransfer(operation([{...old[0],pitchType:'ball'}]),base).transfer?.kind).toBe('full')
  expect(preparePracticeTransfer(operation(old),{session,events:[{...old[0],voidedAt:'2026-11-11T13:00:00Z'}]}).transfer?.kind).toBe('full')
  expect(preparePracticeTransfer({...operation(old),inFlight:true},base).transfer?.kind).toBe('full')
 })
 it('preserves a persisted protocol on retry even without its original cache',()=>{
  const op=operation([event(1),event(2)]),prepared=preparePracticeTransfer(op,{session,events:[event(1)]})
  prepared.inFlight=true
  const reopened=JSON.parse(JSON.stringify(prepared)) as Upload
  expect(preparePracticeTransfer(reopened)).toBe(reopened)
  expect(practiceUploadRequest(reopened)).toEqual(practiceUploadRequest(prepared))
 })
 it('does not add transport metadata to legacy receipt payloads',()=>{
  const original={...operation([event(1)]),inFlight:true}
  const prepared=preparePracticeTransfer(original)
  expect(practiceUploadRequest(prepared)).toEqual({name:'upload_practice',input:{operation:original}})
 })
})
