import type { PitchLocation } from '../domain.ts'

export type AwardScope = 'career' | 'practice' | 'week' | 'month' | 'season' | 'drill'
export type GoalMetric = 'strike' | 'firstPitch' | 'walk' | 'target' | 'practice' | 'habit' | 'reflection' | 'pitches'
export type GoalScope = 'week' | 'month' | 'season'
export interface PlayerProfile { sport: 'baseball' | 'softball'; ageBand: '8–10' | '11–13' | '14–18'; timezone: string; pins: string[]; sound: boolean }
export interface AchievementSeason { name: string; start: string; end: string }
export interface PersonalGoal { metric: GoalMetric; scope: GoalScope; target: number; effectiveFrom: string; pausedAt?: string; resumedFrom?: string; seasonId?: string; habit?: string }
export interface GoalWindow { id: string; goalId: string; scope: GoalScope; start: string; end: string; target: number; actual: number | null; met: boolean; revision: number; metric: GoalMetric; timezone:string; ruleVersion:1 }
export interface PracticePlan { date: string; activity: 'practice' | 'rest' | 'offseason'; adapted?: boolean; complete?: boolean }
export interface ActivityCheckIn { date: string; action: string; note?: string; sessionId?: string }
export interface DrillRecord { date: string; type: string; sessionId?: string; startSequence?: number; endSequence?: number; complete: boolean }
export interface TeamChallenge { name: string; description: string; start: string; end: string; teamId: string }
export interface ChallengeParticipation { date: string; challengeId: string; complete: boolean }
export interface SeasonScrapbook { seasonId: string; goalReviewed: boolean; learning: string; favorite: string }
export type RecordPayload =
  | { kind: 'profile'; data: PlayerProfile }
  | { kind: 'season'; data: AchievementSeason }
  | { kind: 'goal'; data: PersonalGoal }
  | { kind: 'plan'; data: PracticePlan }
  | { kind: 'checkin'; data: ActivityCheckIn }
  | { kind: 'drill'; data: DrillRecord }
  | { kind: 'participation'; data: ChallengeParticipation }
  | { kind: 'scrapbook'; data: SeasonScrapbook }
export type AchievementRecord = RecordPayload & { id: string; pitcherId: string; revision: number; createdAt: string; updatedAt: string }
export type RecordDraft = RecordPayload & { id?: string }
export interface AchievementDefinition {
  id: string; family: number; name: string; title: string; category: number; tier: number; threshold: number
  requirement: string; scope: AwardScope; evidence: 'recorded' | 'self-reported' | 'mixed'; artwork: string; ruleVersion: 1
}
export interface AchievementAward {
  id: string; pitcherId: string; definitionId: string; period: string; seasonId?: string; earnedAt: string
  status: 'qualified' | 'withdrawn'; actual: number; evidence: string[]; goal?: GoalWindow; ruleVersion: 1; explanation?: string
  achievedDate?:string
}
export interface AchievementEvaluationJob { pitcherId: string; revision: number; requestedAt: string }
export interface AchievementProgress { definitionId: string; period: string; actual: number; eligible: boolean; remainingSample?: string }
export interface EvaluationResult { awards: AchievementAward[]; progress: AchievementProgress[]; windows: GoalWindow[] }
export const checkInActions = {
  warmup: 'Warm-up complete', cooldown: 'Cooldown complete', readiness: 'Readiness check', rest: 'Planned rest followed',
  adaptation: 'Adapted my plan', gear: 'Equipment ready', routine: 'Plan and focus checklist', focus: 'Chose a focus',
  reflection: 'Practice reflection', learning: 'Something I learned', nextStep: 'My next adjustment', visualization: 'Mental rehearsal',
  reset: 'Used my reset routine', feedbackAsked: 'Asked for feedback', feedbackApplied: 'Applied feedback',
  encouragement: 'Encouraged a teammate', setup: 'Helped set up', cleanup: 'Helped clean up', sharedLearning: 'Shared a learning', commitment: 'Met a team commitment',
} as const
export const drillTypes = { target: 'Intended target', firstPitch: 'First-pitch focus', count: 'Count scenario', balance: 'Balance focus', finish: 'Finish position', fielding: 'Fielding ready', left: 'Left-side target', right: 'Right-side target' } as const
export const goalLabels: Record<GoalMetric, string> = { strike: 'Strike percentage', firstPitch: 'First-pitch strike percentage', walk: 'Completed-batter walk rate', target: 'Target-match percentage', practice: 'Practices completed', habit: 'Habit days', reflection: 'Reflection days', pitches: 'Pitches recorded' }
export const defaultProfile = (): PlayerProfile => ({ sport: 'baseball', ageBand: '11–13', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, pins: [], sound: false })
export interface TargetMetadata { intendedTarget?: PitchLocation; drillId?: string }
