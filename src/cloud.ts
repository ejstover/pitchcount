import type { SupabaseClient } from '@supabase/supabase-js'
import { CloudError, type Gateway, type Snapshot, type Upload } from './shared'
import { createId } from './id'
import type { Session, SessionEvent } from './domain'
import { acceptedPracticeChunk,preparePracticeTransfer,practiceUploadRequest,type PracticeBase } from './practice-transfer'
import {workspaceManifestHash} from './workspace-version'
import {achievementEvaluationDue} from './achievements/scheduling'
import {readAwardCache,type AwardCache} from './achievements/cache'

interface PracticeChunk {
  id: string
  version: string
  session?: Session
  events?: SessionEvent[]
  achievement?: { session: Session; events: SessionEvent[] } | null
}
interface WorkspacePage {
  epoch: string
  snapshot?: Omit<Snapshot, 'appearances'>
  items: PracticeChunk[]
  next: string | null
  unchanged?: boolean
  manifest?: string
  awardsVersion?:string
  awardsUnchanged?:boolean
}

export function getDeviceId(): string {
  const key = 'pitchwork-device-id'
  let value = localStorage.getItem(key)
  if (!value) { value = createId(); localStorage.setItem(key, value) }
  return value
}
export class SupabaseGateway implements Gateway {
  private practices = new Map<string, PracticeChunk>()
  private epoch:string|null=null
  private awards:AwardCache|null=null
  private uploaded = new Map<string, PracticeBase>()
  private playerPitcherId:string|null=null
  private team: string | null = null
  private inspection: string | null = null
  setWorkspaceTeam(team: string | null) { this.team = team; this.inspection = null }
  setInspectedPractice(id:string) { this.inspection = id }
  constructor(private client: SupabaseClient) {}
  private async rpc<T>(name: string, input?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(name, input)
    if (error) throw new CloudError(error.message, error.code)
    return data as T
  }
  async workspace() {
    // A structural change during pagination invalidates the whole download.
    // Keep the previous cache until every page succeeds; partial manifests must
    // never remove offline history or revive records after access revocation.
    for (let attempt = 0; ; attempt++) {
      try { return await this.pagedWorkspace() }
      catch (error) {
        if (error instanceof CloudError && error.code === '40001' && attempt < 2) continue
        throw error
      }
    }
  }
  private async pagedWorkspace() {
    const received = new Map<string, PracticeChunk>()
    const cached=new Map(this.practices)
    for(const [id,base] of this.uploaded)cached.set(id,acceptedPracticeChunk(base,this.playerPitcherId))
    const cachedIds = [...cached.keys()].sort()
    const manifest=this.epoch===null?null:await workspaceManifestHash(this.epoch,[...cached].map(([id,chunk])=>[id,chunk.version] as const))
    let after: string | null = null, epoch: string | undefined, data: Omit<Snapshot, 'appearances'> | undefined
    let awards=this.awards
    const metadata=(page:WorkspacePage)=>{
      const result=readAwardCache(page,awards);awards=result.cache;return result.snapshot
    }
    let cachedIndex = 0
    do {
      while (cachedIndex < cachedIds.length && after !== null && cachedIds[cachedIndex] <= after) cachedIndex++
      const known = Object.fromEntries(cachedIds.slice(cachedIndex, cachedIndex + 100).map(id => [id, cached.get(id)!.version]))
      const page: WorkspacePage = after===null && manifest!==null
        ? await this.rpc('get_workspace_update',{p_manifest:manifest,p_epoch:this.epoch,p_known:known,p_team:this.team,p_awards:awards?.version??null})
        : await this.rpc('get_workspace_page', { p_after: after, p_known: known, p_limit: 50, p_epoch: epoch ?? null, p_team: this.team })
      if (!page || !Array.isArray(page.items) || typeof page.epoch !== 'string' || (epoch && page.epoch !== epoch) || (page.next !== null && (typeof page.next !== 'string' || (after !== null && page.next <= after)))) {
        throw new CloudError('The workspace download was incomplete. Retry sync.')
      }
      if (after === null) data = metadata(page)
      epoch = page.epoch
      if(page.unchanged) {
        if(after!==null||manifest===null||page.manifest!==manifest||page.epoch!==this.epoch||page.next!==null||page.items.length!==0)throw new CloudError('The workspace download was incomplete. Retry sync.')
        for(const [id,chunk]of cached)received.set(id,chunk)
      }
      for (const item of page.items) {
        // Absence of a body is a cache hit only for this exact server version.
        const old = cached.get(item.id)
        const chunk = !item.session && !('achievement' in item) && old?.version === item.version ? old : item
        if (!chunk.session && !('achievement' in chunk)) throw new CloudError('A practice could not be downloaded. Retry sync.')
        received.set(item.id, chunk)
      }
      after = page.next
    } while (after !== null)
    if (!data) throw new CloudError('The workspace download was incomplete. Retry sync.')
    const userId=(await this.client.auth.getSession()).data.session?.user.id
    const evaluation = data.achievementEvaluation
    const needsEvaluation = achievementEvaluationDue(evaluation)
    if (needsEvaluation && data.coaches.some(c => c.role === 'player' && c.id === userId)) {
      const {data:result,error} = await this.client.functions.invoke('achievements', {body:{}})
      if(error) data.achievementConfirmationError='Activity is saved. Awards need confirmation; retry sync.'
      else if (result?.evaluated) {
        const currentManifest=epoch?await workspaceManifestHash(epoch,[...received].map(([id,chunk])=>[id,chunk.version] as const)):null
        const refreshed = currentManifest
          ?await this.rpc<WorkspacePage>('get_workspace_update',{p_manifest:currentManifest,p_epoch:epoch,p_known:{},p_team:this.team,p_awards:awards?.version??null})
          :await this.rpc<WorkspacePage>('get_workspace_page', {p_limit: 1, p_epoch: epoch, p_team:this.team})
        if(refreshed.epoch!==epoch)throw new CloudError('Workspace changed; retry sync','40001')
        const confirmed=metadata(refreshed)
        if (!confirmed) throw new CloudError('Award confirmation needs another sync.')
        data = confirmed
      }
    }
    data.sessions = []; data.events = []; data.achievementSessions = []; data.achievementEvents = []
    for (const chunk of received.values()) {
      if (chunk.session) { data.sessions.push(chunk.session); data.events.push(...chunk.events ?? []) }
      if (chunk.achievement) { data.achievementSessions.push(chunk.achievement.session); data.achievementEvents.push(...chunk.achievement.events) }
    }
    if(this.inspection) {
      const inspected=await this.rpc<Pick<Snapshot,'sessions'|'events'|'pitchers'|'teams'>|null>('inspect_practice',{p_id:this.inspection})
      if(!inspected)this.inspection=null
      else {
        const merge=<T extends {id:string}>(a:T[],b:T[])=>[...new Map([...a,...b].map(row=>[row.id,row])).values()]
        data.sessions=merge(data.sessions,inspected.sessions);data.events=merge(data.events,inspected.events)
        data.pitchers=merge(data.pitchers,inspected.pitchers);data.teams=merge(data.teams,inspected.teams)
      }
    }
    this.practices = received
    this.epoch=epoch??null
    this.awards=awards
    const profile=data.coaches.find(c=>c.id===userId)
    this.playerPitcherId=profile?.role==='player'?profile.pitcherId??null:null
    this.uploaded.clear()
    return data
  }
  manage(action: string, input: Record<string, unknown>) { return this.rpc('manage', { action, input }) }
  prepareUpload(operation:Upload) {
    const cached=this.practices.get(operation.sessionId)
    const base=this.uploaded.get(operation.sessionId)??(cached?.session?{session:cached.session,events:cached.events??[]}:undefined)
    return preparePracticeTransfer(operation,base)
  }
  async upload(operation: Upload) {
    const request=practiceUploadRequest(operation)
    const revision=await this.rpc<number>(request.name,request.input)
    this.uploaded.set(operation.sessionId,{session:{...operation.session,revision},events:operation.events})
    return revision
  }
}
