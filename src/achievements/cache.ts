import type {AchievementAward} from './types.ts'

export interface AwardCache {version:string;epoch:string;items:AchievementAward[]}
interface AwardMetadata {achievementAwards?:AchievementAward[]}

// Cache hints never authorize a read. The server hashes the actual authorized
// values and access epoch. Keep cache updates local until the whole sync commits.
export function readAwardCache<T extends AwardMetadata>(page:{epoch:string;snapshot?:T;awardsVersion?:string;awardsUnchanged?:boolean},cache:AwardCache|null):{snapshot:T|undefined;cache:AwardCache|null} {
  const snapshot=page.snapshot
  if(!snapshot)return {snapshot,cache}
  if(page.awardsUnchanged){
    if(!cache||cache.version!==page.awardsVersion||cache.epoch!==page.epoch||(snapshot.achievementAwards??[]).length!==0)throw new Error('Award confirmation needs another sync.')
    snapshot.achievementAwards=structuredClone(cache.items)
  }else if(page.awardsVersion){
    if(!/^[a-f0-9]{64}$/.test(page.awardsVersion)||!Array.isArray(snapshot.achievementAwards))throw new Error('Award confirmation needs another sync.')
    cache={version:page.awardsVersion,epoch:page.epoch,items:structuredClone(snapshot.achievementAwards)}
  }else cache=null
  return {snapshot,cache}
}
