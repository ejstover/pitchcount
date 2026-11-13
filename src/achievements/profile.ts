import {defaultProfile,type AchievementRecord,type PlayerProfile} from './types.ts'

export function playerProfile(records:AchievementRecord[]):PlayerProfile{
  return records.filter(r=>r.kind==='profile').sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)).at(-1)?.data as PlayerProfile??defaultProfile()
}
