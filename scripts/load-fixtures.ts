import {createHash} from 'node:crypto'
export interface LoadFixture{coachId:string;pitcherId:string;accessToken:string;[key:string]:unknown}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function loadFixtures(input:unknown,count:number,seconds:number,now=Date.now()):LoadFixture[]{
 if(!Number.isInteger(count)||count<1||count>10000||!Array.isArray(input)||input.length<count)throw new Error('Provide one distinct identity per virtual user.')
 const users=input.slice(0,count).map((value:unknown)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid workload fixture.')
  const user=value as Record<string,unknown>
  if(typeof user.coachId!=='string'||!uuid.test(user.coachId)||typeof user.pitcherId!=='string'||!uuid.test(user.pitcherId)||typeof user.accessToken!=='string')throw new Error('Fixtures need valid coach/pitcher UUIDs and user tokens.')
  const normalized:LoadFixture={coachId:user.coachId.toLowerCase(),pitcherId:user.pitcherId.toLowerCase(),accessToken:user.accessToken}
  for(const key of ['expectedTeamIds','expectedPitcherIds','expectedCoachIds'])if(user[key]!==undefined){
   if(!Array.isArray(user[key])||!(user[key] as unknown[]).every(id=>typeof id==='string'&&uuid.test(id)))throw new Error('Expected scope identities must be UUID arrays.')
   normalized[key]=(user[key] as string[]).map(id=>id.toLowerCase())
  }
  if(user.forbiddenCoachId!==undefined){if(typeof user.forbiddenCoachId!=='string'||!uuid.test(user.forbiddenCoachId)||user.forbiddenCoachId.toLowerCase()===normalized.coachId)throw new Error('The isolation probe needs an unrelated coach UUID.');normalized.forbiddenCoachId=user.forbiddenCoachId.toLowerCase()}
  let claims:{role?:unknown;sub?:unknown;exp?:unknown}
  try{claims=JSON.parse(Buffer.from(user.accessToken.split('.')[1],'base64url').toString())}catch{throw new Error('Each fixture needs a normal signed-in user JWT.')}
  if(claims?.role!=='authenticated'||typeof claims.sub!=='string'||claims.sub.toLowerCase()!==normalized.coachId)throw new Error('Never use administrative tokens as workload identities.')
  if(typeof claims.exp!=='number'||!Number.isFinite(claims.exp)||claims.exp*1000<now+(seconds+60)*1000)throw new Error('User tokens must remain valid for the complete run and cleanup.')
  return normalized
 })
 if(new Set(users.map(user=>user.coachId)).size!==count||new Set(users.map(user=>user.pitcherId)).size!==count)throw new Error('Workload identities and independent pitchers must be distinct.')
 return users
}
export function fixtureFingerprint(users:LoadFixture[]):string{return createHash('sha256').update(JSON.stringify(users.map(user=>[user.coachId,user.pitcherId]))).digest('hex')}
/** Round-robin keeps writer CPU distributed while preserving exact global count. */
export function partitionLoad<T>(users:T[],count:number,writeFraction:number){
 if(!Number.isInteger(count)||count<1||count>16||count>users.length||!Number.isFinite(writeFraction)||writeFraction<0||writeFraction>1)throw new Error('Invalid workload partition configuration.')
 const writers=Math.ceil(users.length*writeFraction),groups=Array.from({length:count},()=>({users:[] as T[],writers:0}))
 users.forEach((user,index)=>{const group=groups[index%count];group.users.push(user);if(index<writers)group.writers++})
 return groups
}
