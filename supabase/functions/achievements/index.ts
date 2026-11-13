import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { evaluateAchievements, reconcileAwards } from '../../../src/achievements/engine.ts'
import { validateAchievementRecord } from '../../../src/achievements/validation.ts'
import {needsCalendarEvaluation} from '../../../src/achievements/scheduling.ts'
import type { AchievementAward } from '../../../src/achievements/types.ts'
import type { Snapshot } from '../../../src/shared.ts'

const url=Deno.env.get('SUPABASE_URL')!, keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')??'{}')
const service=createClient(url,keys.default??Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}})
const origins=(Deno.env.get('ALLOWED_ORIGINS')??'https://count.twelvefs.com').split(',').map(s=>s.trim())
Deno.serve(async req=>{
  const timing=Deno.env.get('PITCHWORK_STAGE_TIMING')==='1',requestStarted=Date.now(),spans:Record<string,number>={}
  async function timed<T>(name:string,query:PromiseLike<T>):Promise<T>{const begin=Date.now();try{return await query}finally{if(timing)spans[name]=(spans[name]??0)+Date.now()-begin}}
  const origin=req.headers.get('origin')??'',headers={'Access-Control-Allow-Origin':origins.includes(origin)?origin:origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'}
  const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,...(timing?{'Server-Timing':Object.entries({...spans,total:Date.now()-requestStarted}).map(([name,duration])=>`${name};dur=${duration}`).join(', ')}:{})}})
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(req.method!=='POST' || origin && !origins.includes(origin))return reply({error:'Request not allowed'},403)
  try {
    const schedulerKey=Deno.env.get('ACHIEVEMENT_WORKER_SECRET')
    const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??''
    const scheduled=!!schedulerKey && token===schedulerKey
    let pid:string|undefined,prepared:any
    if(!scheduled){
      let verification
      try{verification=await timed('auth',service.auth.getUser(token))}catch{return reply({error:'Sign-in verification is temporarily unavailable; retry sync.',code:'auth_unavailable'},503)}
      const {data,error}=verification
      if(error && (!error.status || error.status>=500 || error.status===429))return reply({error:'Sign-in verification is temporarily unavailable; retry sync.',code:'auth_unavailable'},503)
      if(error || !data.user)return reply({error:'Sign in again'},401)
      const context=await timed('prepare',service.rpc('achievement_prepare',{p_actor:data.user.id}))
      if(context.error)throw context.error
      prepared=context.data
      if(prepared?.kind==='denied')return reply({error:'Account unavailable'},403)
      if(prepared?.kind==='notPlayer')return reply({evaluated:0})
      if(prepared?.kind==='missingLink')return reply({error:'Player link required'},403)
      if(prepared?.kind!=='ready')throw new Error('Player context unavailable')
      pid=prepared.pitcherId
    }
    const started=Date.now()
    let evaluated=0,attempted=0,synchronousMs=0
    function measureWork<T>(name:string,work:()=>T):T{
      const begin=performance.now()
      try{return work()}finally{
        const elapsed=performance.now()-begin;synchronousMs+=elapsed
        if(timing)spans[name]=(spans[name]??0)+elapsed
      }
    }
    // Claim one at a time so one long replay cannot leave a parallel wave over
    // the hosted CPU budget. Other invocations scale out through SKIP LOCKED.
    do {
      const {data:jobs,error}=scheduled?await timed('claim',service.rpc('achievement_claim',{p_player:null,p_limit:1})):{data:prepared.job?[prepared.job]:[],error:null}
      if(error)throw error
      if(!jobs?.length)break
      attempted+=jobs.length
      await Promise.all(jobs.map(async(job:{pitcher_id:string;revision:number;lease_token:string})=>{try {
        const {data:input,error}=scheduled?await timed('input',service.rpc('achievement_input',{p:job.pitcher_id})):{data:prepared.input,error:null}
        if(error)throw error
        const source=input as Snapshot
        measureWork('validation',()=>{for(const record of source.achievementRecords??[])validateAchievementRecord(record)})
        const {data:previous,error:readError}=scheduled?await timed('previous',service.from('achievement_awards').select('data').eq('pitcher_id',job.pitcher_id)):{data:(prepared.previous??[]).map((data:AchievementAward)=>({data})),error:null}
        if(readError)throw readError
        const {awards,calendarPending,evaluatedAt}=measureWork('rules',()=>{
          const now=new Date(),result=evaluateAchievements(source,job.pitcher_id,now)
          return {awards:reconcileAwards((previous??[]).map(r=>r.data as AchievementAward),result.awards,now.toISOString()),calendarPending:needsCalendarEvaluation(source,job.pitcher_id,now),evaluatedAt:now.toISOString()}
        })
        const {data:committed,error:commitError}=await timed('finish',service.rpc('achievement_finish_scheduled',{p:job.pitcher_id,expected:job.revision,token:job.lease_token,awards,p_calendar_pending:calendarPending,p_evaluated_at:evaluatedAt}))
        if(commitError)throw commitError
        if(committed)evaluated++
      } catch {
        // Logs/diagnostics contain identifiers, never reflection content or credentials.
        await service.rpc('achievement_fail',{p:job.pitcher_id,token:job.lease_token,expected:job.revision})
        if(pid)throw new Error('Evaluation failed')
      }}))
    }while(scheduled && attempted<100 && Date.now()-started<20_000 && synchronousMs<250)
    return reply({evaluated,attempted})
  }catch{return reply({error:'Award evaluation unavailable; retry sync.'},503)}
})
