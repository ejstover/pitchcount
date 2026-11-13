import {expect,it} from 'vitest'
import {assessLoad,type LoadEvidence} from '../scripts/load-report'
const evidence=():LoadEvidence=>({virtualUsers:5000,writeFraction:0.2,readiedUsers:5000,peakActiveUsers:5000,fullPeakSeconds:1801,minimumPeakSeconds:1800,generatorEventLoopP99Ms:25,maximumGeneratorEventLoopP99Ms:50,workloadRequests:100000,workloadFailures:0,securityFailures:0,integrityFailures:0,cleanupFailures:0,verifiedWriters:1000,clientErrors:0,metrics:Object.fromEntries(['workspace','completeWorkspace','profile','upload'].map(kind=>[kind,{requests:10000,errors:0,p95UpperBoundMs:750}]))})
it('requires the full ready population, a sustained hold and sufficient driver headroom',()=>{
 expect(assessLoad(evidence()).passed).toBe(true)
 for(const change of [{readiedUsers:4999},{peakActiveUsers:4999},{fullPeakSeconds:1799},{generatorEventLoopP99Ms:51},{generatorEventLoopP99Ms:NaN}])expect(assessLoad({...evidence(),...change}).passed).toBe(false)
})
it('does not let cleanup success dilute workload errors or empty samples certify a run',()=>{
 expect(assessLoad({...evidence(),workloadRequests:1000,workloadFailures:1}).passed).toBe(false)
 expect(assessLoad({...evidence(),metrics:{}}).passed).toBe(false)
 expect(assessLoad({...evidence(),metrics:{...evidence().metrics,profile:{requests:4999,errors:0,p95UpperBoundMs:50}}}).passed).toBe(false)
})
it('requires every writer and every security/integrity check even when latency is low',()=>{
 for(const change of [{securityFailures:1},{integrityFailures:1},{cleanupFailures:1},{clientErrors:1},{verifiedWriters:999}])expect(assessLoad({...evidence(),...change}).passed).toBe(false)
 expect(assessLoad({...evidence(),metrics:{...evidence().metrics,upload:{requests:10000,errors:0,p95UpperBoundMs:'over 10000'}}}).passed).toBe(false)
})
