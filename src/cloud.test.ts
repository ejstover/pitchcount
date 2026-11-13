import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseGateway } from './cloud'
import { emptySnapshot } from './shared'
import type { Session } from './domain'
import type { Upload } from './shared'
import type {AchievementAward} from './achievements/types'

const session = (id: string) => ({id,revision:1,archived:false} as Session)
function fixture() {
  const rpc=vi.fn(),invoke=vi.fn()
  const client={rpc,functions:{invoke},auth:{getSession:async()=>({data:{session:{user:{id:'coach'}}}})}} as unknown as SupabaseClient
  const gateway=new SupabaseGateway(client)
  const page=(items:unknown[],next:string|null=null,epoch='1',snapshot=emptySnapshot())=>({data:{epoch,snapshot,items,next},error:null})
  return {rpc,invoke,gateway,page}
}
describe('bounded workspace downloads',()=>{
  it('reuses verified award values with fresh status, isolates caller mutations and rejects cross-epoch hits',async()=>{
    const {rpc,gateway,page}=fixture(),version='1'.repeat(64),changed='2'.repeat(64)
    const award={id:'award',pitcherId:'p',evidence:['source']} as AchievementAward
    rpc.mockResolvedValueOnce(page([]));await gateway.workspace()
    rpc.mockResolvedValueOnce({data:{epoch:'1',items:[],next:null,awardsVersion:version,awardsUnchanged:false,snapshot:{...emptySnapshot(),achievementAwards:[award]}},error:null})
    const first=await gateway.workspace();first.achievementAwards![0].evidence.push('caller edit')
    rpc.mockImplementationOnce(async(_name,input)=>{
      expect(input.p_awards).toBe(version)
      return {data:{epoch:'1',items:[],next:null,awardsVersion:version,awardsUnchanged:true,snapshot:{...emptySnapshot(),achievementAwards:[],achievementEvaluation:{revision:2,processedRevision:1,nextEvaluateAt:'2099-01-01'}}},error:null}
    })
    const hit=await gateway.workspace();expect(hit.achievementAwards![0].evidence).toEqual(['source']);expect(hit.achievementEvaluation?.revision).toBe(2)
    rpc.mockResolvedValueOnce({data:{epoch:'2',items:[],next:null,awardsVersion:version,awardsUnchanged:true,snapshot:{...emptySnapshot(),achievementAwards:[]}},error:null})
    await expect(gateway.workspace()).rejects.toThrow('another sync')
    rpc.mockResolvedValueOnce({data:{epoch:'2',items:[],next:null,awardsVersion:changed,awardsUnchanged:false,snapshot:{...emptySnapshot(),achievementAwards:[]}},error:null})
    expect((await gateway.workspace()).achievementAwards).toEqual([])
  })
  it('does not publish an award cache from a partially downloaded workspace',async()=>{
    const {rpc,gateway,page}=fixture(),version='1'.repeat(64)
    rpc.mockResolvedValueOnce(page([]));await gateway.workspace()
    rpc.mockResolvedValueOnce({data:{epoch:'1',items:[{id:'a',version:'1',session:session('a'),events:[]}],next:'a',awardsVersion:version,snapshot:{...emptySnapshot(),achievementAwards:[]}},error:null})
    rpc.mockResolvedValueOnce({data:null,error:{message:'Connection lost',code:'network'}})
    await expect(gateway.workspace()).rejects.toThrow('Connection lost')
    rpc.mockImplementationOnce(async(_name,input)=>{expect(input.p_awards).toBeNull();return {data:{epoch:'1',items:[],next:null,awardsVersion:version,awardsUnchanged:true,snapshot:{...emptySnapshot(),achievementAwards:[]}},error:null}})
    await expect(gateway.workspace()).rejects.toThrow('another sync')
  })
  it('keeps source current while respecting an award calculation window and confirms when due',async()=>{
    const {rpc,invoke,gateway,page}=fixture(),snapshot=emptySnapshot()
    snapshot.coaches=[{id:'coach',name:'Player',email:'player@test.com',role:'player',active:true,pitcherId:'p'}]
    snapshot.achievementEvaluation={revision:2,processedRevision:1,nextEvaluateAt:'2099-01-01T00:00:00Z'}
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]}],null,'1',snapshot))
    expect((await gateway.workspace()).sessions).toHaveLength(1);expect(invoke).not.toHaveBeenCalled()
    const due={...snapshot,achievementEvaluation:{revision:2,processedRevision:1,nextEvaluateAt:'2020-01-01T00:00:00Z'}}
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1'}],null,'1',due));invoke.mockResolvedValueOnce({data:{evaluated:1},error:null})
    rpc.mockResolvedValueOnce(page([],null,'1',{...due,achievementEvaluation:{revision:2,processedRevision:2,nextEvaluateAt:'2099-01-01T00:00:00Z'}}))
    expect((await gateway.workspace()).achievementEvaluation?.processedRevision).toBe(2);expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('retains the complete cache only with a matching server proof and fresh metadata',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]},{id:'b',version:'1',session:session('b'),events:[]}]))
    await gateway.workspace()
    rpc.mockImplementationOnce(async(name,input)=>{
      expect(name).toBe('get_workspace_update');expect(input.p_manifest).toMatch(/^[a-f0-9]{64}$/)
      return {data:{epoch:'1',manifest:input.p_manifest,unchanged:true,snapshot:{...emptySnapshot(),deletions:[{kind:'pitcher',id:'removed'}]},items:[],next:null},error:null}
    })
    const result=await gateway.workspace();expect(result.sessions.map(s=>s.id)).toEqual(['a','b']);expect(result.deletions).toEqual([{kind:'pitcher',id:'removed'}])
    rpc.mockImplementationOnce(async(_name,input)=>({data:{epoch:'2',manifest:input.p_manifest,unchanged:true,snapshot:emptySnapshot(),items:[],next:null},error:null}))
    await expect(gateway.workspace()).rejects.toThrow('incomplete')
    rpc.mockImplementationOnce(async(_name,input)=>({data:{epoch:'1',manifest:input.p_manifest,unchanged:true,snapshot:emptySnapshot(),items:[],next:null},error:null}))
    expect((await gateway.workspace()).sessions).toHaveLength(2)
  })
  it('keeps exact-version pagination available without Web Crypto',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]}]))
    await gateway.workspace()
    vi.stubGlobal('crypto',undefined)
    try {
      rpc.mockResolvedValueOnce(page([{id:'a',version:'1'}]));expect((await gateway.workspace()).sessions).toHaveLength(1)
      expect(rpc.mock.calls[1][0]).toBe('get_workspace_page')
    }finally{vi.unstubAllGlobals()}
  })
  it.each([false,true])('reuses acknowledged source bodies with server-checked versions (player %s)',async player=>{
    const {rpc,gateway,page}=fixture(),snapshot=emptySnapshot()
    snapshot.coaches=[{id:'coach',name:'Recorder',email:'recorder@test.com',role:player?'player':'coach',active:true,...(player?{pitcherId:'p'}:{})}]
    rpc.mockResolvedValueOnce(page([],null,'1',snapshot));await gateway.workspace()
    const op={id:'operation',sessionId:'a',expectedRevision:0,session:{...session('a'),teamId:null,pitcherIds:['p'],recorderId:'coach'},events:[]} as Upload
    rpc.mockResolvedValueOnce({data:1,error:null});await gateway.upload(op)
    const version=`1:false:true:${player?'p':''}`
    rpc.mockResolvedValueOnce(page([{id:'a',version}],null,'1',snapshot))
    const data=await gateway.workspace();expect(rpc.mock.calls[2][1].p_known).toEqual({a:version})
    expect(data.sessions).toEqual([op.session]);expect(data.achievementSessions).toEqual(player?[op.session]:[])
    // An old receipt does not override a newer canonical revision.
    rpc.mockResolvedValueOnce({data:1,error:null});await gateway.upload(op)
    rpc.mockResolvedValueOnce(page([{id:'a',version:`2:false:true:${player?'p':''}`,session:{...op.session,revision:2},events:[],...(player?{achievement:{session:{...op.session,revision:2},events:[]}}:{})}],null,'1',snapshot))
    expect((await gateway.workspace()).sessions[0].revision).toBe(2)
    rpc.mockResolvedValueOnce({data:1,error:null});await gateway.upload(op)
    rpc.mockResolvedValueOnce(page([],null,'2',snapshot))
    expect((await gateway.workspace()).sessions).toEqual([])
  })
  it('reuses exact versions and drops history omitted from the authorized manifest',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]},{id:'b',version:'1',session:session('b'),events:[]}]))
    expect((await gateway.workspace()).sessions).toHaveLength(2)
    rpc.mockResolvedValueOnce(page([{id:'b',version:'1'}]))
    expect((await gateway.workspace()).sessions.map(s=>s.id)).toEqual(['b'])
    expect(rpc.mock.calls[1][1].p_known).toEqual({a:'1',b:'1'})
  })
  it('does not commit a partial cache when a later page fails',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]}]))
    await gateway.workspace()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'2',session:{...session('a'),revision:2},events:[]}],'a'))
    rpc.mockResolvedValueOnce({data:null,error:{message:'Connection lost',code:'network'}})
    await expect(gateway.workspace()).rejects.toThrow('Connection lost')
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1'}]))
    expect((await gateway.workspace()).sessions[0].revision).toBe(1)
  })
  it('restarts the whole download when a roster change invalidates its epoch',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]}],'a'))
    rpc.mockResolvedValueOnce({data:null,error:{message:'Workspace changed; retry sync',code:'40001'}})
    rpc.mockResolvedValueOnce(page([{id:'b',version:'1',session:session('b'),events:[]}],null,'2'))
    expect((await gateway.workspace()).sessions.map(s=>s.id)).toEqual(['b'])
    expect(rpc.mock.calls[2][1].p_after).toBeNull()
  })
  it('rejects missing cache bodies and nonadvancing cursors',async()=>{
    const {rpc,gateway,page}=fixture()
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1'}]))
    await expect(gateway.workspace()).rejects.toThrow('could not be downloaded')
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',session:session('a'),events:[]}],'a'))
    rpc.mockResolvedValueOnce(page([],'a'))
    await expect(gateway.workspace()).rejects.toThrow('incomplete')
  })
  it('keeps player projections separate and does not evaluate clean awards on every poll',async()=>{
    const {rpc,invoke,gateway,page}=fixture(), snapshot=emptySnapshot()
    snapshot.coaches=[{id:'coach',name:'Player',email:'player@test.com',role:'player',active:true,pitcherId:'p'}]
    snapshot.achievementEvaluation={revision:2,processedRevision:2,nextEvaluateAt:'2099-01-01T00:00:00Z'}
    const projection={session:session('a'),events:[]}
    rpc.mockResolvedValueOnce(page([{id:'a',version:'1',achievement:projection}],null,'1',snapshot))
    const data=await gateway.workspace()
    expect(data.sessions).toEqual([]);expect(data.achievementSessions).toEqual([projection.session]);expect(invoke).not.toHaveBeenCalled()
  })
})
