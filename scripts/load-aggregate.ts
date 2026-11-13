import {assessLoad,histogramMetrics,mergeHistograms,type LoadEvidence,type LoadHistogram} from './load-report.ts'
export interface ShardReport extends LoadEvidence{
 schemaVersion:number;runId:string;shardIndex:number;sourceFingerprint:string;targetOrigin:string;fixtureFingerprint:string
 expectedWriters:number;passed:boolean;externalStop:boolean
 requests:number;failures:number;bytes:number;pendingEvaluations:number;finalPracticesVerified:number
 awardCacheHits:number;practiceManifestHits:number;cleanupSkippedAfterFailure:number
 histograms:Record<string,LoadHistogram>;serverTimingHistograms:Record<string,LoadHistogram>
 cohort:{startedAt:number;deadlineAt:number;readyAt:number|null;stoppedAt:number|null}
 generatorCpuSeconds:{user:number;system:number}
}
export interface AggregateExpectation{
 runId:string;targetOrigin:string;writeFraction:number;durationSeconds:number;minimumPeakSeconds:number;maximumGeneratorEventLoopP99Ms:number
 shards:{virtualUsers:number;expectedWriters:number;fixtureFingerprint:string}[]
}
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}
const counters=['virtualUsers','expectedWriters','readiedUsers','peakActiveUsers','requests','failures','bytes','workloadRequests','workloadFailures','securityFailures','integrityFailures','cleanupFailures','verifiedWriters','clientErrors','pendingEvaluations','finalPracticesVerified','awardCacheHits','practiceManifestHits','cleanupSkippedAfterFailure'] as const
export function aggregateLoad(input:unknown[],expected:AggregateExpectation){
 check(input.length===expected.shards.length&&input.length>0,'Missing traffic-process report.')
 const reports=input as ShardReport[],seen=new Set<number>();let fingerprint:string|undefined
 for(const row of reports){
  check(row&&row.schemaVersion===2&&row.runId===expected.runId&&Number.isInteger(row.shardIndex)&&!seen.has(row.shardIndex),'Incompatible or duplicate traffic-process report.');seen.add(row.shardIndex)
  const part=expected.shards[row.shardIndex]
  check(part&&part.fixtureFingerprint===row.fixtureFingerprint&&part.virtualUsers===row.virtualUsers&&part.expectedWriters===row.expectedWriters,'Traffic-process population does not match its assigned fixtures.')
  check(row.writeFraction===row.expectedWriters/row.virtualUsers,'Traffic-process recording fraction differs from its actual writers.')
  check(row.targetOrigin===expected.targetOrigin&&/^[a-f0-9]{64}$/.test(row.sourceFingerprint),'Traffic target or source identity is invalid.')
  fingerprint??=row.sourceFingerprint;check(row.sourceFingerprint===fingerprint,'Traffic processes used different source revisions.')
  for(const key of counters)check(Number.isSafeInteger(row[key])&&row[key]>=0,'Invalid traffic-process counter.')
  check(row.readiedUsers<=row.virtualUsers&&row.peakActiveUsers<=row.virtualUsers&&row.verifiedWriters<=row.expectedWriters,'Invalid traffic-process population counter.')
  check(row.minimumPeakSeconds===expected.minimumPeakSeconds&&row.maximumGeneratorEventLoopP99Ms===expected.maximumGeneratorEventLoopP99Ms,'Traffic-process qualification limits differ.')
  check(Number.isFinite(row.generatorEventLoopP99Ms)&&row.generatorEventLoopP99Ms>=0,'Missing generator-delay measurement.')
  check(row.cohort&&Number.isFinite(row.cohort.startedAt)&&Number.isFinite(row.cohort.deadlineAt)&&row.cohort.deadlineAt>row.cohort.startedAt,'Invalid traffic-process time window.')
  check(Math.abs(row.cohort.deadlineAt-row.cohort.startedAt-expected.durationSeconds*1000)<1,'Traffic-process duration differs from the requested run.')
  for(const field of ['readyAt','stoppedAt'] as const)check(row.cohort[field]===null||Number.isFinite(row.cohort[field])&&row.cohort[field]!>=row.cohort.startedAt,'Invalid traffic-process cohort timestamp.')
  check(row.cohort.readyAt===null||row.cohort.stoppedAt!==null,'A ready cohort needs a measured stopping time.')
  check(typeof row.passed==='boolean'&&typeof row.externalStop==='boolean','Missing traffic-process outcome.')
  // A corrupt/mismatched report must not dilute errors in a larger population.
  const rows=mergeHistograms([row.histograms]),real=Object.entries(rows).filter(([kind])=>!kind.startsWith('completeWorkspace'))
  check(row.passed===(assessLoad({...row,metrics:histogramMetrics(rows)}).passed&&!row.externalStop),'Traffic-process outcome disagrees with its evidence.')
  check(real.reduce((n,[,r])=>n+r.requests,0)===row.requests&&real.reduce((n,[,r])=>n+(r.errors??0),0)===row.failures,'Traffic request counters disagree with histograms.')
  const workload=real.filter(([kind])=>kind!=='cleanup'&&kind!=='integrityRead')
  check(workload.reduce((n,[,r])=>n+r.requests,0)===row.workloadRequests&&workload.reduce((n,[,r])=>n+(r.errors??0),0)===row.workloadFailures,'Workload counters disagree with histograms.')
  check(row.generatorCpuSeconds&&['user','system'].every(key=>Number.isFinite(row.generatorCpuSeconds[key as 'user'|'system'])&&row.generatorCpuSeconds[key as 'user'|'system']>=0),'Invalid generator CPU measurement.')
 }
 const sum=(key:typeof counters[number])=>reports.reduce((n,row)=>n+row[key],0)
 const histograms=mergeHistograms(reports.map(row=>row.histograms)),serverTimingHistograms=mergeHistograms(reports.map(row=>row.serverTimingHistograms))
 const readyAt=reports.every(row=>row.cohort.readyAt!==null)?Math.max(...reports.map(row=>row.cohort.readyAt!)):null
 const stoppedAt=Math.min(...reports.map(row=>Math.min(row.cohort.deadlineAt,row.cohort.stoppedAt??row.cohort.deadlineAt)))
 const fullPeakSeconds=readyAt===null?0:Math.max(0,(stoppedAt-readyAt)/1000)
 const metrics=histogramMetrics(histograms),generatorEventLoopP99Ms=Math.max(...reports.map(row=>row.generatorEventLoopP99Ms))
 const totals=Object.fromEntries(counters.map(key=>[key,sum(key)])) as Record<typeof counters[number],number>
 // Summing process peaks would claim concurrency even for disjoint runs.
 totals.peakActiveUsers=fullPeakSeconds>0?totals.virtualUsers:0
 const assessment=assessLoad({...totals,writeFraction:expected.writeFraction,fullPeakSeconds,minimumPeakSeconds:expected.minimumPeakSeconds,maximumGeneratorEventLoopP99Ms:expected.maximumGeneratorEventLoopP99Ms,generatorEventLoopP99Ms,metrics})
 if(reports.some(row=>!row.passed||row.externalStop)){assessment.passed=false;assessment.reasons.push('At least one traffic process failed or was stopped.')}
 return {schemaVersion:2,completedAt:new Date().toISOString(),runId:expected.runId,targetOrigin:expected.targetOrigin,sourceFingerprint:fingerprint,processes:reports.length,...totals,writeFraction:expected.writeFraction,fullPeakSeconds,minimumPeakSeconds:expected.minimumPeakSeconds,maximumGeneratorEventLoopP99Ms:expected.maximumGeneratorEventLoopP99Ms,generatorEventLoopP99Ms,generatorCpuSeconds:{user:reports.reduce((n,row)=>n+row.generatorCpuSeconds.user,0),system:reports.reduce((n,row)=>n+row.generatorCpuSeconds.system,0)},cohort:{readyAt,stoppedAt},histograms,serverTimingHistograms,metrics,serverTimings:histogramMetrics(serverTimingHistograms),assessment,passed:assessment.passed,note:'Distinct identity partitions; histogram counts merged before percentile calculation. Peak hold is the intersection of all ready cohorts. Driver delay is the worst process, not an average. Server utilization, data size, worker recovery and interactive Auth remain separate acceptance evidence.'}
}
