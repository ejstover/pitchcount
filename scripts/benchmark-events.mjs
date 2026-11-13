// Local validation/transport microbenchmark, not concurrent capacity evidence.
import {PGlite} from '@electric-sql/pglite'
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {preparePracticeTransfer,practiceUploadRequest} from '../src/practice-transfer.ts'
const db=new PGlite()
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role supabase_auth_admin;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;`)
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'))
 const results=[]
 for(const size of [100,1000,5000]) {
  const pid=randomUUID(),sid=randomUUID(),timestamp=new Date().toISOString(),initial=randomUUID()
  let appearance=initial
  const events=Array.from({length:size},(_,i)=>{const next=randomUUID(),row={id:randomUUID(),sessionId:sid,pitcherId:pid,appearanceId:appearance,nextAppearanceId:next,sequence:i+1,timestamp,kind:'pitch',pitchType:'inPlay',voidedAt:null};appearance=next;return row})
  const session={id:sid,name:'Validation benchmark',notes:'',teamId:null,recorderId:randomUUID(),deviceId:randomUUID(),revision:2,startedAt:timestamp,updatedAt:timestamp,endedAt:null,status:'active',initialPitcherId:pid,selectedPitcherId:pid,initialAppearanceId:initial,pitcherIds:[pid],nextSequence:size+1}
  const times={}
  for(const [label,fn] of [['reference','pw_validate_practice_reference'],['indexed','validate_practice']]) {
   const samples=[]
   for(let i=0;i<4;i++) {const started=performance.now();await db.query(`select public.${fn}($1::jsonb,$2::jsonb)`,[JSON.stringify(session),JSON.stringify(events)]);if(i)samples.push(performance.now()-started)}
   samples.sort((a,b)=>a-b);times[label]=samples[1]
  }
  const op={id:randomUUID(),sessionId:sid,expectedRevision:1,session,events}
  const encoded=practiceUploadRequest(preparePracticeTransfer(op,{session:{...session,revision:1,nextSequence:size},events:events.slice(0,-1)}))
  results.push({events:size,referenceMedianMs:times.reference,indexedMedianMs:times.indexed,fullUploadBytes:Buffer.byteLength(JSON.stringify({operation:op})),deltaUploadBytes:Buffer.byteLength(JSON.stringify(encoded.input))})
 }
 const output={results,note:'Single-connection PGlite; includes parameter JSON parsing. Does not measure WAL, production CPU, network throughput or concurrent capacity.'}
 await mkdir('.test-artifacts',{recursive:true});await writeFile('.test-artifacts/event-benchmark.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output))
}catch(error){console.error(error.message);process.exitCode=1}finally{await db.close()}
