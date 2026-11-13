import {expect,it} from 'vitest'
import {aggregateLoad,type ShardReport,type AggregateExpectation} from '../scripts/load-aggregate'
import {loadBounds,mergeHistograms,histogramMetrics} from '../scripts/load-report'
const runId='00000000-0000-4000-8000-000000000001',targetOrigin='https://staging.example'
function row(index:number):ShardReport{
 const histogram=()=>({requests:100,errors:0,buckets:loadBounds.map((_,i)=>i===1?100:0)})
 const histograms={profile:histogram(),workspace:histogram(),completeWorkspace:histogram()}
 return {schemaVersion:2,runId,shardIndex:index,sourceFingerprint:'a'.repeat(64),targetOrigin,fixtureFingerprint:String(index).repeat(64),virtualUsers:1,writeFraction:0,expectedWriters:0,readiedUsers:1,peakActiveUsers:1,fullPeakSeconds:29,minimumPeakSeconds:15,generatorEventLoopP99Ms:25,maximumGeneratorEventLoopP99Ms:50,workloadRequests:200,workloadFailures:0,securityFailures:0,integrityFailures:0,cleanupFailures:0,verifiedWriters:0,clientErrors:0,metrics:histogramMetrics(histograms),requests:200,failures:0,bytes:1000,pendingEvaluations:0,finalPracticesVerified:0,awardCacheHits:0,practiceManifestHits:0,cleanupSkippedAfterFailure:0,histograms,serverTimingHistograms:{},cohort:{startedAt:1000,deadlineAt:31000,readyAt:2000,stoppedAt:31000},generatorCpuSeconds:{user:0.1,system:0.05},passed:true,externalStop:false}
}
function settings():AggregateExpectation{return {runId,targetOrigin,writeFraction:0,durationSeconds:30,minimumPeakSeconds:15,maximumGeneratorEventLoopP99Ms:50,shards:[0,1].map(index=>({virtualUsers:1,expectedWriters:0,fixtureFingerprint:String(index).repeat(64)}))}}
it('merges histogram counts before computing percentiles rather than averaging process percentiles',()=>{
 const fast={requests:99,errors:0,buckets:loadBounds.map((_,i)=>i===0?99:0)},slow={requests:1,errors:0,buckets:loadBounds.map((_,i)=>i===13?1:0)}
 const metrics=histogramMetrics(mergeHistograms([{profile:fast},{profile:slow}]))
 expect(metrics.profile.p95UpperBoundMs).toBe(50);expect(metrics.profile.requests).toBe(100)
 expect(()=>mergeHistograms([{profile:{...fast,requests:100}}])).toThrow(/histogram/)
})
it('requires a common full-population window and never sums disjoint process peaks',()=>{
 const first=row(0),second=row(1)
 expect(aggregateLoad([first,second],settings()).passed).toBe(true)
 second.cohort={startedAt:41000,readyAt:42000,stoppedAt:71000,deadlineAt:71000}
 const result=aggregateLoad([first,second],settings());expect(result.fullPeakSeconds).toBe(0);expect(result.passed).toBe(false);expect(result.peakActiveUsers).toBe(0)
})
it('rejects missing, duplicate, wrong-revision or wrong-fixture reports',()=>{
 expect(()=>aggregateLoad([row(0)],settings())).toThrow(/Missing/)
 expect(()=>aggregateLoad([row(0),row(0)],settings())).toThrow(/duplicate/)
 expect(()=>aggregateLoad([row(0),{...row(1),sourceFingerprint:'b'.repeat(64)}],settings())).toThrow(/different source/)
 expect(()=>aggregateLoad([row(0),{...row(1),fixtureFingerprint:'c'.repeat(64)}],settings())).toThrow(/assigned fixtures/)
})
it('keeps the worst driver and rejects inconsistent error counters or outcomes',()=>{
 const slow={...row(1),generatorEventLoopP99Ms:70,passed:false}
 const result=aggregateLoad([row(0),slow],settings());expect(result.passed).toBe(false);expect(result.generatorEventLoopP99Ms).toBe(70)
 expect(()=>aggregateLoad([row(0),{...row(1),workloadFailures:1,passed:false}],settings())).toThrow(/counters/)
 expect(()=>aggregateLoad([row(0),{...row(1),passed:false}],settings())).toThrow(/outcome/)
})
