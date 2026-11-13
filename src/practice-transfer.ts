import type { Session,SessionEvent } from './domain.ts'
import type { Upload } from './shared.ts'

export type PracticeTransfer = {kind:'full'} | {kind:'delta';baseEventCount:number;voidedEvents:{sequence:number;voidedAt:string}[]}
export type PracticeBase = {session:Session;events:SessionEvent[]}

/** Use only after a successful upload receipt. Versions remain server-checked
 * hints: a changed revision/archive/visibility/player identity causes a miss. */
export function acceptedPracticeChunk(base:PracticeBase,playerPitcherId:string|null=null) {
  const session={...base.session,archived:false}
  return {id:session.id,version:`${session.revision}:false:true:${playerPitcherId??''}`,session,events:base.events,
    ...(playerPitcherId && session.teamId===null && session.pitcherIds.includes(playerPitcherId)
      ? {achievement:{session,events:base.events}} : {})}
}

const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
  if(value && typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)??'null'
}

/** Prepare once, then persist this choice before any network request. */
export function preparePracticeTransfer(operation:Upload,base?:PracticeBase):Upload {
  if(operation.transfer)return operation
  // An earlier app may have sent an in-flight full snapshot already. Preserve
  // that protocol and payload so its existing receipt can acknowledge the retry.
  const full=()=>({...operation,transfer:{kind:'full'} as PracticeTransfer})
  if(operation.inFlight || !base || base.session.revision!==operation.expectedRevision || base.session.id!==operation.session.id || base.events.length>operation.events.length)return full()
  const old=[...base.events].sort((a,b)=>a.sequence-b.sequence)
  const current=[...operation.events].sort((a,b)=>a.sequence-b.sequence)
  // Legacy malformed ordering is repaired only after an explicit rejection.
  if(current.some((e,i)=>e!==operation.events[i]))return full()
  const voidedEvents:{sequence:number;voidedAt:string}[]=[]
  for(let i=0;i<old.length;i++) {
    const {voidedAt:before,...original}=old[i],{voidedAt:after,...next}=current[i]
    if(old[i].sequence!==i+1 || current[i].sequence!==i+1 || canonical(original)!==canonical(next) || before && before!==after)return full()
    if(before!==after) {
      if(typeof after!=='string')return full()
      voidedEvents.push({sequence:i+1,voidedAt:after})
    }
  }
  return {...operation,transfer:{kind:'delta',baseEventCount:old.length,voidedEvents}}
}

export function practiceUploadRequest(operation:Upload):{name:string;input:Record<string,unknown>} {
  const {transfer,...full}=operation
  if(transfer?.kind!=='delta')return {name:'upload_practice',input:{operation:full}}
  const {events,...metadata}=full
  return {name:'upload_practice_delta',input:{delta:{...metadata,baseEventCount:transfer.baseEventCount,appendEvents:events.slice(transfer.baseEventCount),voidedEvents:transfer.voidedEvents}}}
}
