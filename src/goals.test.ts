import { describe, expect, it } from 'vitest'
import { applicableGoals, canEditGoal, goalComparison, goalWarnings, validGoal, type Goal, type GoalDraft } from './goals'
import { emptySnapshot } from './shared'
import { metrics, type Coach, type Appearance } from './domain'

const personal: GoalDraft = { scope: 'personal', teamId: null, pitcherId: 'p', metric: 'strikePct', direction: 'min', target: 60 }
const goal = (overrides: Partial<Goal> = {}): Goal => ({ ...personal, id: 'g', revision: 1, updatedAt: '2026-10-21T12:00:00Z', updatedBy: null, ...overrides })
function fixture() {
  return { ...emptySnapshot(), teams: ['a','b'].map(id => ({ id, name: id === 'a' ? 'Falcons' : 'Owls', createdAt: '', updatedAt: '' })),
    pitchers: [{ id: 'p', name: 'Jordan', jersey: '', archived: false, ownerId: 'coach', createdAt: '', updatedAt: '' }],
    teamPitchers: ['a','b'].map(teamId => ({ teamId, pitcherId: 'p', active: true })), teamCoaches: [{teamId:'a',coachId:'coach'}],
    goals: [goal({ id: 'a', scope: 'team', teamId: 'a', pitcherId: null, target: 65 }), goal({ id: 'b', scope: 'coach', teamId: 'b', target: 70 })] }
}
describe('ongoing goals', () => {
  it('compares minimums and maximums, equality, unavailable data and percentage points', () => {
    expect(goalComparison(personal, 63)).toEqual({met:true,text:'3 percentage points above goal'})
    expect(goalComparison(personal, 55).met).toBe(false)
    expect(goalComparison(personal, 60).text).toBe('At goal')
    expect(goalComparison(personal, null).met).toBeNull()
    expect(goalComparison({...personal,metric:'walkPct',direction:'max',target:10}, 8)).toEqual({met:true,text:'2 percentage points below goal'})
    expect(goalComparison({...personal,metric:'pitchesPerBatter',direction:'max',target:4}, 4.25).met).toBe(false)
    expect(goalComparison(personal, 59.999).text).toContain('<0.1')
  })
  it('warns against every active team and its coach target, including after updates', () => {
    const data = fixture()
    expect(goalWarnings(personal, data)).toHaveLength(2)
    expect(goalWarnings(personal, data).join(' ')).toContain('Owls coach target ≥70%')
    data.goals[1].target = 55
    expect(goalWarnings(personal, data)).toHaveLength(1)
    data.teamPitchers[0].active = false
    expect(goalWarnings(personal, data)).toEqual([])
    data.teamPitchers[0].active = true
    data.teams[0] = {...data.teams[0], archived:true} as typeof data.teams[0]
    expect(goalWarnings(personal, data)).toEqual([])
  })
  it('ignores staff counts, detects opposing directions and treats walk ceilings correctly', () => {
    const data = fixture()
    data.goals = [goal({scope:'team',teamId:'a',pitcherId:null,metric:'total',target:1000}), goal({scope:'coach',teamId:'b',metric:'total',target:100,direction:'max'})]
    expect(goalWarnings({...personal,metric:'total',target:50}, data)).toEqual(['Owls coach target ≤100: different target direction.'])
    data.goals = [goal({scope:'team',teamId:'a',pitcherId:null,metric:'walkPct',target:10,direction:'max'})]
    expect(goalWarnings({...personal,metric:'walkPct',direction:'max',target:15}, data)).toHaveLength(1)
    expect(goalWarnings({...personal,metric:'walkPct',direction:'max',target:8}, data)).toEqual([])
  })
  it('selects distinct personal, team and coach targets without treating staff totals as individual targets', () => {
    const data = fixture(); data.goals.push(goal())
    expect(applicableGoals(data,'strikePct','','p')).toHaveLength(3)
    expect(applicableGoals(data,'strikePct','a','p')).toHaveLength(2)
    expect(applicableGoals(data,'strikePct','a','')).toHaveLength(1)
    expect(applicableGoals(data,'strikePct','','')).toEqual([])
    data.goals.push(goal({scope:'team',teamId:'a',pitcherId:null,metric:'total'}))
    expect(applicableGoals(data,'total','a','p')).toEqual([])
  })
  it('validates goal ranges, count precision, scope and fixed rate direction', () => {
    expect(validGoal(personal)).toBe(true)
    for (const target of [-1, 101, Infinity, NaN]) expect(validGoal({...personal,target})).toBe(false)
    expect(validGoal({...personal,direction:'max'})).toBe(false)
    expect(validGoal({...personal,teamId:'a'})).toBe(false)
    expect(validGoal({...personal,metric:'total',target:2.5})).toBe(false)
    expect(validGoal({...personal,metric:'pitchesPerBatter',direction:'max',target:3.5})).toBe(true)
  })
  it('restricts client editing to linked players and assigned active coaches', () => {
    const data = fixture(), coach: Coach = {id:'coach',name:'Coach',email:'a@b.c',role:'coach',active:true}
    const player: Coach = {...coach,id:'player',role:'player',pitcherId:'p'}
    expect(canEditGoal(personal,player,data)).toBe(true)
    expect(canEditGoal(personal,coach,data)).toBe(false)
    expect(canEditGoal({...personal,pitcherId:'other'},player,data)).toBe(false)
    expect(canEditGoal(data.goals[0],coach,data)).toBe(true)
    expect(canEditGoal(data.goals[1],coach,data)).toBe(false)
    expect(canEditGoal(data.goals[0],player,data)).toBe(false)
    expect(canEditGoal(personal,{...player,active:false},data)).toBe(false)
    expect(canEditGoal(data.goals[0],{...coach,role:'viewer'},data)).toBe(false)
  })
  it('compares staff rates calculated from totals rather than an average of pitcher percentages', () => {
    const appearances = [{ pitches: Array(9).fill('called').concat('ball'), outcome:'manual' },{pitches:['ball'],outcome:'manual'}] as Appearance[]
    const staff = metrics(appearances)
    expect(staff.strikePct).toBeCloseTo(900/11)
    expect(goalComparison({...personal,target:80},staff.strikePct).met).toBe(true)
  })
})
