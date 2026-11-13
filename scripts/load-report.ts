export interface LoadMetric{requests:number;errors:number;p95UpperBoundMs:number|string|null}
export const loadBounds=[50,100,250,500,750,1000,1500,2000,2500,3000,3500,4000,5000,10000,Infinity]
export interface LoadHistogram{requests:number;errors?:number;buckets:number[]}
export function histogramPercentile(row:LoadHistogram,q:number):number|string|null{
 if(!row.requests)return null
 let count=0;for(let i=0;i<loadBounds.length;i++){count+=row.buckets[i];if(count>=row.requests*q)return Number.isFinite(loadBounds[i])?loadBounds[i]:'over 10000'}return null
}
export function mergeHistograms(groups:Record<string,LoadHistogram>[]){
 const merged=new Map<string,LoadHistogram>()
 for(const group of groups)for(const [name,row]of Object.entries(group)){
  if(!Number.isSafeInteger(row.requests)||row.requests<0||!Number.isSafeInteger(row.errors??0)||(row.errors??0)<0||(row.errors??0)>row.requests||!Array.isArray(row.buckets)||row.buckets.length!==loadBounds.length||row.buckets.some(n=>!Number.isSafeInteger(n)||n<0)||row.buckets.reduce((a,b)=>a+b,0)!==row.requests)throw new Error('Invalid workload histogram.')
  const result=merged.get(name)??{requests:0,errors:0,buckets:loadBounds.map(()=>0)}
  result.requests+=row.requests;result.errors=(result.errors??0)+(row.errors??0);row.buckets.forEach((count,index)=>{result.buckets[index]+=count});merged.set(name,result)
 }
 return Object.fromEntries(merged)
}
export function histogramMetrics(rows:Record<string,LoadHistogram>){return Object.fromEntries(Object.entries(rows).map(([name,row])=>[name,{requests:row.requests,errors:row.errors??0,p95UpperBoundMs:histogramPercentile(row,0.95),p99UpperBoundMs:histogramPercentile(row,0.99)}]))}
export interface LoadEvidence{
 virtualUsers:number;writeFraction:number;expectedWriters?:number;readiedUsers:number;peakActiveUsers:number
 fullPeakSeconds:number;minimumPeakSeconds:number;generatorEventLoopP99Ms:number;maximumGeneratorEventLoopP99Ms:number
 workloadRequests:number;workloadFailures:number;securityFailures:number;integrityFailures:number
 cleanupFailures:number;verifiedWriters:number;clientErrors:number;metrics:Record<string,LoadMetric>
}
/** Passing request timings alone do not establish the requested population. */
export function assessLoad(e:LoadEvidence){
 const reasons:string[]=[],writers=e.expectedWriters??Math.ceil(e.virtualUsers*e.writeFraction)
 const populationValid=e.readiedUsers===e.virtualUsers&&e.peakActiveUsers===e.virtualUsers
 const peakValid=Number.isFinite(e.fullPeakSeconds)&&e.fullPeakSeconds>=e.minimumPeakSeconds&&e.minimumPeakSeconds>0
 const generatorValid=Number.isFinite(e.generatorEventLoopP99Ms)&&e.generatorEventLoopP99Ms>=0&&e.generatorEventLoopP99Ms<=e.maximumGeneratorEventLoopP99Ms
 if(!populationValid)reasons.push('The complete user population did not become ready and active.')
 if(!peakValid)reasons.push('The complete user population did not sustain the required peak hold.')
 if(!generatorValid)reasons.push('Traffic-generator delay exceeded its headroom limit; capacity is unverified.')
 if(e.workloadRequests<=0||e.workloadFailures/Math.max(e.workloadRequests,1)>=0.001)reasons.push('Workload request errors exceeded the limit.')
 if(e.securityFailures||e.integrityFailures||e.cleanupFailures||e.clientErrors||e.verifiedWriters!==writers)reasons.push('Security, source integrity, cleanup or client checks failed.')
 for(const kind of ['workspace','completeWorkspace','profile',...(writers?['upload']:[])]){
  if((e.metrics[kind]?.requests??0)<(kind==='upload'?writers:e.virtualUsers))reasons.push(`Insufficient ${kind} samples for the requested population.`)
 }
 for(const kind of ['workspace','completeWorkspace','completeWorkspace:player','completeWorkspace:coach','profile','upload']){
  const row=e.metrics[kind];if(!row)continue
  if(typeof row.p95UpperBoundMs!=='number'||!Number.isFinite(row.p95UpperBoundMs)||row.p95UpperBoundMs<0||row.p95UpperBoundMs>(kind==='upload'?1500:1000))reasons.push(`${kind} latency exceeded the limit.`)
 }
 return {passed:reasons.length===0,populationValid,peakValid,generatorValid,reasons}
}
