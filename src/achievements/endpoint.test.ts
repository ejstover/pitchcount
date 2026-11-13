import {describe,expect,it,vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {emptySnapshot} from '../shared'

function fixture() {
 let handler:(req:Request)=>Promise<Response>
 const jobs=[{pitcher_id:'player-pitcher',revision:3,lease_token:'lease'}]
 const rpc=vi.fn(async(name:string):Promise<any>=>({data:name==='achievement_prepare'?{kind:'ready',pitcherId:'player-pitcher',job:jobs.splice(0)[0]??null,input:emptySnapshot(),previous:[]}:name==='achievement_claim'?jobs.splice(0):name==='achievement_input'?emptySnapshot():name==='achievement_finish_scheduled'?true:null,error:null}))
 const service={rpc,auth:{getUser:vi.fn(async()=>({data:{user:{id:'player-account'}},error:null}))},from:vi.fn((name:string)=>{
  const query:any={select:()=>query,eq:()=>query}
  query.single=async()=>({data:name==='coaches'?{role:'player',active:true}:{pitcher_id:'player-pitcher'},error:null})
  query.then=(resolve:any,reject:any)=>Promise.resolve({data:[],error:null}).then(resolve,reject)
  return query
 })}
 const evaluate=vi.fn(()=>({awards:[]})),reconcile=vi.fn(()=>[]),validate=vi.fn(),calendar=vi.fn(()=>false)
 let spent=0
 const env:Record<string,string>={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only',ACHIEVEMENT_WORKER_SECRET:'worker-only'}
 const source=readFileSync('supabase/functions/achievements/index.ts','utf8').replace(/^import .*\r?\n/gm,'')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
 runInNewContext(js,{createClient:()=>service,evaluateAchievements:evaluate,reconcileAwards:reconcile,validateAchievementRecord:validate,needsCalendarEvaluation:calendar,performance:{now:()=>spent},Response,Date,Deno:{env:{get:(key:string)=>env[key]},serve:(fn:typeof handler)=>{handler=fn}}})
 return {rpc,evaluate,calendar,service,spend:(ms:number)=>{spent+=ms},call:(token='user-token')=>handler(new Request('https://example.supabase.co/functions/v1/achievements',{method:'POST',headers:{origin:'https://count.twelvefs.com',authorization:`Bearer ${token}`},body:JSON.stringify({pitcherId:'forged-player'})}))}
}
describe('leased achievement worker',()=>{
 it('fails closed on a backend context outage without treating it as suspension or running rules',async()=>{
  const e=fixture();e.rpc.mockResolvedValueOnce({data:null,error:{code:'PGRST003'}})
  expect((await e.call()).status).toBe(503);expect(e.evaluate).not.toHaveBeenCalled()
 })
 it.each(['denied','missingLink'])('rejects a current %s context without running rules',async kind=>{
  const e=fixture();e.rpc.mockResolvedValueOnce({data:{kind},error:null})
  expect((await e.call()).status).toBe(403);expect(e.evaluate).not.toHaveBeenCalled()
 })
 it('does not claim work when the identity service is temporarily unavailable',async()=>{
  const e=fixture();e.service.auth.getUser.mockResolvedValue({data:{user:null},error:{status:503,message:'Private internal sentinel'}} as any)
  const response=await e.call();expect(response.status).toBe(503);expect((await response.json()).code).toBe('auth_unavailable');expect(e.rpc).not.toHaveBeenCalled()
 })
 it('derives the player scope from authenticated linkage and commits with the claim token',async()=>{
  const e=fixture(),res=await e.call()
  expect(res.status).toBe(200);expect(await res.json()).toEqual({evaluated:1,attempted:1})
  expect(e.rpc).toHaveBeenCalledWith('achievement_prepare',{p_actor:'player-account'})
  expect(e.rpc).toHaveBeenCalledWith('achievement_finish_scheduled',{p:'player-pitcher',expected:3,token:'lease',awards:[],p_calendar_pending:false,p_evaluated_at:expect.any(String)})
  expect(e.calendar).toHaveBeenCalledWith(emptySnapshot(),'player-pitcher',expect.any(Date))
 })
 it('allows scheduled batches only for the dedicated worker secret',async()=>{
  const e=fixture();await e.call('worker-only')
  expect(e.service.auth.getUser).not.toHaveBeenCalled()
  expect(e.rpc).toHaveBeenCalledWith('achievement_claim',{p_player:null,p_limit:1})
 })
 it.each([false,true])('stops claiming after an expensive replay, including failure=%s',async fail=>{
  const e=fixture()
  e.rpc.mockImplementation(async(name:string)=>({data:name==='achievement_claim'?[{pitcher_id:'player-pitcher',revision:3,lease_token:'lease'}]:name==='achievement_input'?emptySnapshot():name==='achievement_finish_scheduled'?true:null,error:null}))
  e.evaluate.mockImplementation(()=>{e.spend(300);if(fail)throw new Error('Synthetic slow failure');return{awards:[]}})
  const response=await e.call('worker-only')
  expect(response.status).toBe(200);expect(await response.json()).toEqual({evaluated:fail?0:1,attempted:1})
  expect(e.rpc.mock.calls.filter(([name])=>name==='achievement_claim')).toHaveLength(1)
 })
 it('retains the 100-job cap for inexpensive scheduled work',async()=>{
  const e=fixture()
  e.rpc.mockImplementation(async(name:string)=>({data:name==='achievement_claim'?[{pitcher_id:'player-pitcher',revision:3,lease_token:'lease'}]:name==='achievement_input'?emptySnapshot():name==='achievement_finish_scheduled'?true:null,error:null}))
  expect(await (await e.call('worker-only')).json()).toEqual({evaluated:100,attempted:100})
 })
 it('releases only its own failed lease and hides source content in errors',async()=>{
  const e=fixture();e.evaluate.mockImplementation(()=>{throw new Error('Private reflection sentinel')})
  const res=await e.call();expect(res.status).toBe(503);expect(JSON.stringify(await res.json())).not.toContain('sentinel')
  expect(e.rpc).toHaveBeenCalledWith('achievement_fail',{p:'player-pitcher',token:'lease',expected:3})
 })
})
