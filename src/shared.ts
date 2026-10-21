import type { Appearance, Coach, Invitation, Pitcher, Session, SessionEvent, Team, TeamCoach, TeamPitcher } from './domain'

export interface Snapshot {
  teams: Team[]; pitchers: Pitcher[]; coaches: Coach[]; teamPitchers: TeamPitcher[]; teamCoaches: TeamCoach[]
  invitations: Invitation[]; sessions: Session[]; appearances: Appearance[]; events: SessionEvent[]
  deletions?: { kind: RemovalKind; id: string }[]
}
export type RemovalKind = 'pitcher' | 'team' | 'session' | 'coach' | 'request'
export interface RemovalTarget { kind: RemovalKind; id: string; name: string; archived: boolean }
export interface RemovalPreview {
  name: string; canRemove: boolean; archiveBlockers: string[]; deleteBlockers: string[]
  practices: { id: string; name: string }[]; hiddenPractices: number
  assignments: number; invitations: number; ownedPitchers?: number
}
export interface RemovalInput { kind: RemovalKind; id: string; confirmation?: string; archived?: boolean }
export const emptySnapshot = (): Snapshot => ({ teams: [], pitchers: [], coaches: [], teamPitchers: [], teamCoaches: [], invitations: [], sessions: [], appearances: [], events: [] })
export interface Identity { coachId: string; deviceId: string }
export interface Upload { id: string; sessionId: string; expectedRevision: number; session: Session; events: SessionEvent[]; blocked?: string; inFlight?: boolean }
export interface SavePitcher { id?: string; name: string; jersey: string; teamIds: string[] }
export interface Gateway {
  workspace(): Promise<Omit<Snapshot, 'appearances'>>
  manage(action: string, input: Record<string, unknown>): Promise<unknown>
  upload(operation: Upload): Promise<number>
}
export class CloudError extends Error {
  constructor(message: string, public code = '') { super(message) }
}
export function teamHasPitcher(data: Pick<Snapshot, 'teamPitchers'>, teamId: string, pitcherId: string) {
  return data.teamPitchers.some(m => m.teamId === teamId && m.pitcherId === pitcherId && m.active)
}
