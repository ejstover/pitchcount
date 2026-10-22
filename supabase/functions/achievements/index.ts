import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { evaluateAchievements, reconcileAwards } from '../../../src/achievements/engine.ts'
import { validateAchievementRecord } from '../../../src/achievements/validation.ts'
import type { AchievementAward } from '../../../src/achievements/types.ts'
import type { Snapshot } from '../../../src/shared.ts'

const url=Deno.env.get('SUPABASE_URL')!, keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')??'{}')
const service=createClient(url,keys.default??Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}})
const origins=(Deno.env.get('ALLOWED_ORIGINS')??'https://count.twelvefs.com').split(',').map(s=>s.trim())
Deno.serve(async req=>{
  const origin=req.headers.get('origin')??'',headers={'Access-Control-Allow-Origin':origins.includes(origin)?origin:origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'}
  const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers})
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(req.method!=='POST' || origin && !origins.includes(origin))return reply({error:'Request not allowed'},403)
  try {
    const schedulerKey=Deno.env.get('ACHIEVEMENT_WORKER_SECRET')
    const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??''
    const scheduled=!!schedulerKey && token===schedulerKey
    let pid:string|undefined
    if(!scheduled){
      const {data,error}=await service.auth.getUser(token)
      if(error || !data.user)return reply({error:'Sign in again'},401)
      const {data:account}=await service.from('coaches').select('active,role').eq('id',data.user.id).single()
      if(!account?.active)return reply({error:'Account unavailable'},403)
      if(account.role!=='player')return reply({evaluated:0})
      const {data:link}=await service.from('player_accounts').select('pitcher_id').eq('account_id',data.user.id).single()
      if(!link)return reply({error:'Player link required'},403)
      pid=link.pitcher_id
    }
    let query=service.from('achievement_jobs').select('pitcher_id,revision').limit(scheduled?100:1)
    if(pid)query=query.eq('pitcher_id',pid)
    else query=query.lte('next_evaluate_at',new Date().toISOString()).order('next_evaluate_at').order('requested_at')
    const {data:jobs,error}=await query
    if(error)throw error
    let evaluated=0
    for(const job of jobs??[]) {
      try {
        const {data:input,error}=await service.rpc('achievement_input',{p:job.pitcher_id})
        if(error)throw error
        const source=input as Snapshot
        for(const record of source.achievementRecords??[])validateAchievementRecord(record)
        const {data:previous,error:readError}=await service.from('achievement_awards').select('data').eq('pitcher_id',job.pitcher_id)
        if(readError)throw readError
        const result=evaluateAchievements(source,job.pitcher_id)
        const awards=reconcileAwards((previous??[]).map(r=>r.data as AchievementAward),result.awards,new Date().toISOString())
        const {data:committed,error:commitError}=await service.rpc('achievement_commit',{p:job.pitcher_id,expected:job.revision,awards})
        if(commitError)throw commitError
        if(committed)evaluated++
      } catch {
        // Logs/diagnostics contain identifiers, never reflection content or credentials.
        await service.from('achievement_jobs').update({last_error:'Evaluation failed; inspect rule and source validation',next_evaluate_at:new Date(Date.now()+15*60_000).toISOString()}).eq('pitcher_id',job.pitcher_id)
        if(pid)return reply({error:'Awards could not be confirmed. Your activity is saved; retry sync.'},503)
      }
    }
    return reply({evaluated})
  }catch{return reply({error:'Award evaluation unavailable; retry sync.'},503)}
})
