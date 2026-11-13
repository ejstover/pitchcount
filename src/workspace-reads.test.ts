import {expect,it,vi} from 'vitest'
import {emptySnapshot} from './shared'
import {WorkspaceReads} from './workspace-reads'

function deferred(){let resolve!:(value:ReturnType<typeof emptySnapshot>)=>void;const promise=new Promise<ReturnType<typeof emptySnapshot>>(r=>{resolve=r});return{promise,resolve}}

it('shares overlapping UI reads but reads storage again after completion',async()=>{
 const value=emptySnapshot(),source={snapshot:vi.fn(async()=>value)},reads=new WorkspaceReads()
 const first=reads.read(source),second=reads.read(source)
 expect(second).toBe(first);expect(await first).toBe(value);expect(source.snapshot).toHaveBeenCalledTimes(1)
 await reads.read(source);expect(source.snapshot).toHaveBeenCalledTimes(2)
})
it('starts a new read after a change and prevents old completion from clearing the newer read',async()=>{
 const old=deferred(),fresh=deferred(),source={snapshot:vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)},reads=new WorkspaceReads()
 const first=reads.read(source);await Promise.resolve();reads.changed();const second=reads.read(source);await Promise.resolve()
 old.resolve(emptySnapshot());await first
 expect(reads.read(source)).toBe(second)
 const updated=emptySnapshot();updated.coaches=[{id:'new',email:'new@example.invalid',name:'Current',role:'coach',active:true}]
 fresh.resolve(updated);expect(await second).toBe(updated);expect(source.snapshot).toHaveBeenCalledTimes(2)
})
it('never shares one account repository read with another repository',async()=>{
 const pending=deferred(),reads=new WorkspaceReads(),a={snapshot:vi.fn(()=>pending.promise)},other=emptySnapshot(),b={snapshot:vi.fn(async()=>other)}
 const first=reads.read(a);expect(await reads.read(b)).toBe(other);expect(b.snapshot).toHaveBeenCalledTimes(1)
 pending.resolve(emptySnapshot());expect(await first).not.toBe(other)
})
it('does not retain a failed read and lets the caller retry storage',async()=>{
 const source={snapshot:vi.fn().mockRejectedValueOnce(new Error('Storage unavailable')).mockResolvedValueOnce(emptySnapshot())},reads=new WorkspaceReads()
 await expect(reads.read(source)).rejects.toThrow('Storage unavailable');await expect(reads.read(source)).resolves.toEqual(emptySnapshot())
 expect(source.snapshot).toHaveBeenCalledTimes(2)
})
