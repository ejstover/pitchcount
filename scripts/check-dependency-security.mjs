import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
const reviewed='https://github.com/advisories/GHSA-gcqx-w48m-w2h4'
async function audit(extra=[]) {
 const args=['audit','--json',...extra]
 const npmCli=process.env.npm_execpath
 if(!npmCli)throw new Error('Run this check with npm run test:security.')
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[npmCli,...args],{windowsHide:true})
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.resume();child.on('error',reject);child.on('close',code=>resolve({code,stdout}))
 })
 let report;try{report=JSON.parse(result.stdout)}catch{throw new Error('The dependency audit did not return a valid report.')}
 if(!report.vulnerabilities||report.error)throw new Error('The dependency audit service is unavailable; security verification is incomplete.')
 return report
}
const production=await audit(['--omit=dev'])
if(Object.keys(production.vulnerabilities).length)throw new Error('Production dependencies have security advisories. Review and fix them before publishing.')
const full=await audit(),vulnerable=full.vulnerabilities
function advisories(name,seen=new Set()) {
 if(seen.has(name))return []
 const item=vulnerable[name];if(!item)throw new Error(`Unresolved advisory chain: ${name}`)
 const next=new Set([...seen,name])
 return item.via.flatMap(v=>typeof v==='string'?advisories(v,next):[v.url])
}
for(const name of Object.keys(vulnerable)) {
 const urls=advisories(name)
 if(vulnerable[name].severity!=='low'||!urls.length||urls.some(url=>url!==reviewed))throw new Error(`Unreviewed dependency advisory: ${name}`)
}
let reviewedBuildDependency=null
if(Object.keys(vulnerable).length) {
 // No upstream fix is published for deepmerge 4.3.1. Its sole consumer here
 // copies a literal defaults object; application/request/config input never
 // reaches the merge call. Pin that reviewed consumer, not just a CVE allowlist.
 if(Date.now()>=Date.parse('2027-02-11T00:00:00Z'))throw new Error('Re-review the build-only deepmerge advisory before publishing.')
 const consumer=JSON.parse(await readFile('node_modules/@rollup/plugin-node-resolve/package.json','utf8'))
 const merge=JSON.parse(await readFile('node_modules/deepmerge/package.json','utf8'))
 if(consumer.version!=='16.0.3'||merge.version!=='4.3.1')throw new Error('The reviewed deepmerge versions changed; recheck reachability.')
 const reviewedSources={
  'dist/es/index.js':'e3d3dd4cee934cc57e6a335005c2db4111b1333bbaddce39f08a7d505ee9ccea',
  'dist/cjs/index.js':'98eee3d5a03aac277c01f78be8af18fe19cae7cb0fe79e2b9817af44051a07b9',
 }
 for(const [file,hash] of Object.entries(reviewedSources)) {
  const source=await readFile(`node_modules/@rollup/plugin-node-resolve/${file}`,'utf8')
  if(createHash('sha256').update(source).digest('hex')!==hash||(source.match(/\bdeepMerge\s*\(/g)??[]).length!==1||!source.includes('const DEFAULTS = deepFreeze(deepMerge({}, defaults));'))throw new Error('The reviewed deepmerge consumer changed; recheck reachability.')
 }
 reviewedBuildDependency={advisory:reviewed,consumer:'@rollup/plugin-node-resolve@16.0.3',consumerSha256:reviewedSources,reason:'Both module formats only copy a source-code literal defaults object. No user/application/build-option input is merged.',reviewExpires:'2027-02-11'}
}
const result={checkedAt:new Date().toISOString(),productionAdvisories:0,fullDependencyCounts:full.metadata.vulnerabilities,reviewedBuildDependency}
await mkdir('.test-artifacts',{recursive:true});await writeFile('.test-artifacts/dependency-security.json',JSON.stringify(result,null,2))
console.log('Production dependency audit: no advisories. Build dependencies: available fixes applied; any remaining advisory is restricted to the pinned, reviewed constant-input consumer.')
