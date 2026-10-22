import type { AchievementDefinition, AwardScope } from './types.ts'
export const categories = ['Foundations', 'Calendar', 'Pitching quality', 'Control & location', 'Personal growth', 'My goals', 'Practice labs', 'Preparation & recovery', 'Mindset & learning', 'Teamwork & seasons']
type Family = [name: string, thresholds: number[], requirement: string, scope?: AwardScope]
const count = [1, 5, 10, 25, 50], years = [1, 2, 3, 5, 10], windows = [1, 3, 6, 12, 24]
const strikes = [40, 50, 60, 70, 80], first = [30, 40, 50, 60, 70], walks = [30, 25, 20, 15, 10], gain = [2, 4, 6, 8, 10]
export const families: Family[] = [
  ['Practice Path', count, 'Complete {n} practices'], ['Pitch Journey', [25,100,250,500,1000], 'Record {n} practice pitches'],
  ['Weekly Regular', [1,4,12,26,52], 'Practice in {n} different weeks'], ['Monthly Regular', [1,3,6,12,24], 'Practice in {n} different months'],
  ['Season Traveler', years, 'Practice in {n} seasons'], ['Yearbook', years, 'Practice in {n} calendar years'],
  ['Trophy Explorer', [2,4,6,8,10], 'Earn awards in {n} categories'], ['The Collector', [5,15,30,60,100], 'Earn {n} distinct achievements'],
  ['Weekly Pitchmark', [5,10,15,20,25], 'Record {n} pitches this week', 'week'], ['Monthly Pitchmark', [20,40,60,80,100], 'Record {n} pitches this month', 'month'],
  ['Goal Weeks', windows, 'Meet a goal in {n} different weeks'], ['Goal Months', [1,2,3,6,12], 'Meet a goal in {n} different months'],
  ['Weekly Game Plan', [20,40,60,80,100], 'Complete {n}% of planned practices', 'week'], ['Monthly Game Plan', [20,40,60,80,100], 'Complete {n}% of planned practices', 'month'],
  ['Quality Months', [1,2,3,6,12], 'Meet a percentage goal in {n} different months'], ['Balanced Weeks', windows, 'Complete a drill, reflection and planned rest in {n} weeks'],
  ['Session Strikecraft', strikes, 'Finish at {n}% strikes or higher', 'practice'], ['Weekly Strikecraft', strikes, 'Finish at {n}% strikes or higher', 'week'],
  ['Monthly Strikecraft', strikes, 'Finish at {n}% strikes or higher', 'month'], ['Season Strikecraft', strikes, 'Finish at {n}% strikes or higher', 'season'],
  ['First Move: Practice', first, 'Finish at {n}% first-pitch strikes or higher', 'practice'], ['First Move: Week', first, 'Finish at {n}% first-pitch strikes or higher', 'week'],
  ['First Move: Month', first, 'Finish at {n}% first-pitch strikes or higher', 'month'], ['First Move: Season', first, 'Finish at {n}% first-pitch strikes or higher', 'season'],
  ['Walk Control: Practice', walks, 'Finish at or below {n}% completed-batter walks', 'practice'], ['Walk Control: Month', walks, 'Finish at or below {n}% completed-batter walks', 'month'],
  ['First-Pitch Bank', [10,25,50,100,250], 'Record {n} first-pitch strikes'], ['Strikeout Trail', count, 'Record {n} practice strikeouts'],
  ['Strike Sequence', [3,4,5,6,8], 'Record {n} consecutive positive strike outcomes', 'practice'], ['Fast Starts', [2,3,4,5,6], 'Start {n} consecutive batters with strikes', 'practice'],
  ['Target Finder', [20,30,40,50,60], 'Match the intended region on {n}% of a target drill', 'drill'], ['Target Trail', [10,25,50,100,250], 'Record {n} intended-region matches'],
  ['Strike Climber', gain, 'Improve strikes by {n} percentage points', 'season'], ['First-Pitch Climber', gain, 'Improve first-pitch strikes by {n} points', 'season'],
  ['Walk Turnaround', gain, 'Reduce completed-batter walks by {n} points', 'season'], ['Target Climber', gain, 'Improve target matches by {n} points', 'season'],
  ['Steady Floor', [1,2,3,4,5], 'Finish {n} eligible practices in a row two points above baseline', 'season'], ['Level Up', gain, 'Raise your original strike goal by {n} points and meet it', 'season'],
  ['Personal-Best Parade', [1,3,5,10,20], 'Set {n} qualifying personal strike records'], ['Back on My Plan', years, 'Resume and complete the next goal window {n} times'],
  ['My Strike Goal', windows, 'Meet your strike goal in {n} windows'], ['My First-Pitch Goal', windows, 'Meet your first-pitch goal in {n} windows'],
  ['My Control Goal', windows, 'Meet your completed-batter walk goal in {n} windows'], ['My Target Goal', windows, 'Meet your target goal in {n} windows'],
  ['My Practice Goal', windows, 'Meet your practice goal in {n} windows'], ['My Habit Goal', windows, 'Meet your habit goal in {n} windows'],
  ['My Reflection Goal', windows, 'Meet your reflection goal in {n} windows'], ['Goal Combo', windows, 'Meet two different goal types in one window {n} times'],
  ['Target Lab', count, 'Complete {n} intended-target drills'], ['First-Pitch Lab', count, 'Complete {n} first-pitch focus drills'],
  ['Count Lab', count, 'Complete {n} count-scenario rehearsals'], ['Balance Lab', count, 'Complete {n} balance-focus drills'],
  ['Finish Lab', count, 'Complete {n} finish-position drills'], ['Ready Position Lab', count, 'Complete {n} fielding-ready drills'],
  ['Left-Side Lab', count, 'Complete {n} left-side target drills'], ['Right-Side Lab', count, 'Complete {n} right-side target drills'],
  ['Warm-Up Ready', count, 'Log your warm-up on {n} days'], ['Cooldown Complete', count, 'Log your cooldown on {n} days'],
  ['Ready Check', count, 'Complete a readiness check on {n} days'], ['Rest Is Training', count, 'Follow planned rest on {n} days'],
  ['Plan Adapter', count, 'Log an adapted practice plan on {n} days'], ['Off-Season Builder', years, 'Complete {n} nonthrowing off-season plans'],
  ['Gear Ready', count, 'Check your equipment on {n} days'], ['Routine Ready', count, 'Review your plan and focus on {n} days'],
  ['Focus Finder', count, 'Choose a focus on {n} days'], ['Practice Journal', count, 'Reflect on practice on {n} days'],
  ['Learning Light', count, 'Record a learning on {n} days'], ['Next Step', count, 'Identify an adjustment on {n} days'],
  ['Picture It', count, 'Log mental rehearsal on {n} days'], ['Reset Button', count, 'Use your reset routine on {n} days'],
  ['Ask and Learn', count, 'Ask for feedback on {n} days'], ['Put It to Work', count, 'Apply feedback on {n} days'],
  ['Dugout Boost', count, 'Encourage a teammate on {n} days'], ['Setup Crew', count, 'Help set up on {n} days'],
  ['Cleanup Crew', count, 'Help clean up on {n} days'], ['Pass It On', count, 'Share a learning on {n} days'],
  ['Team Promise', count, 'Meet a team commitment on {n} days'], ['Team Quest', [1,3,5,10,20], 'Complete your contribution to {n} team challenges'],
  ['Season Scrapbook', years, 'Complete {n} season scrapbooks'], ['Complete Player Collection', [2,4,6,8,10], 'Earn awards in {n} categories this season', 'season'],
]
export const catalog: AchievementDefinition[] = families.flatMap(([name, thresholds, text, scope = 'career'], i) => thresholds.map((threshold, t) => {
  const id = String(i * 5 + t + 1).padStart(3, '0')
  let requirement=text.replace('{n}',threshold.toLocaleString('en-US'))
  if(threshold===1)requirement=requirement.replace(/\b(practices|pitches|weeks|months|seasons|years|categories|achievements|strikeouts|matches|windows|drills|days|plans|times|scrapbooks|challenges)\b/g,word=>word==='categories'?'category':word.slice(0,-1))
  return { id, family: i + 1, name, title: id === '001' ? 'First Practice' : `${name} · ${threshold}${text.includes('{n}%') ? '%' : ''}`,
    category: Math.floor(i / 8), tier: t + 1, threshold, requirement, scope,
    evidence: i >= 48 && i !== 79 ? 'self-reported' : [6,7,10,11,12,13,14,15,37,39,40,41,42,43,44,45,46,47,79].includes(i) ? 'mixed' : 'recorded',
    artwork: `patch-${String(i+1).padStart(2,'0')}-${t+1}`, ruleVersion: 1 }
}))
export const isMeta = (family: number) => [7,8,80].includes(family)
