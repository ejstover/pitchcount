import type { Snapshot } from './shared'

type Source={snapshot():Promise<Snapshot>}

/** UI reads only: callers treat the shared snapshot as immutable. Backups and
 * other mutable consumers keep using Repository.snapshot directly. */
export class WorkspaceReads {
  private version=0
  private pending?:{source:Source;version:number;promise:Promise<Snapshot>}
  changed(){this.version++}
  read(source:Source):Promise<Snapshot>{
    if(this.pending?.source===source&&this.pending.version===this.version)return this.pending.promise
    const entry={source,version:this.version,promise:source.snapshot()}
    entry.promise=entry.promise.finally(()=>{if(this.pending===entry)this.pending=undefined})
    this.pending=entry
    return entry.promise
  }
}
