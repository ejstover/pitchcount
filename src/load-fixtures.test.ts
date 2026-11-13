import {expect,it} from 'vitest'
import {loadFixtures,partitionLoad,fixtureFingerprint} from '../scripts/load-fixtures'
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function user(n:number){const coachId=uid(n);return {coachId,pitcherId:uid(n+100),accessToken:`e30.${Buffer.from(JSON.stringify({sub:coachId,role:'authenticated',exp:10000})).toString('base64url')}.synthetic`,password:'must not propagate'}}
it('keeps every user exactly once and balances 1000 writers across four 1250-user processes',()=>{
 const groups=partitionLoad(Array.from({length:5000},(_,n)=>n),4,0.2)
 expect(groups.map(group=>[group.users.length,group.writers])).toEqual([[1250,250],[1250,250],[1250,250],[1250,250]])
 expect(new Set(groups.flatMap(group=>group.users)).size).toBe(5000)
 expect(partitionLoad([0,1,2],2,0.2).map(group=>group.writers)).toEqual([1,0])
})
it('rejects duplicate identities across partitions and strips passwords from workload copies',()=>{
 const users=loadFixtures([user(1),user(2)],2,30,0)
 expect(users[0]).not.toHaveProperty('password')
 expect(fixtureFingerprint(users)).not.toBe(fixtureFingerprint([...users].reverse()))
 expect(()=>loadFixtures([user(1),user(1)],2,30,0)).toThrow(/distinct/)
 expect(()=>loadFixtures([user(1),{...user(2),pitcherId:uid(101)}],2,30,0)).toThrow(/distinct/)
})
it('rejects malformed scope assertions and administrative/expired workload tokens before traffic',()=>{
 expect(()=>loadFixtures([{...user(1),expectedTeamIds:'invalid'}],1,30,0)).toThrow(/UUID arrays/)
 const changed=(role:string,exp:number)=>({...user(1),accessToken:`e30.${Buffer.from(JSON.stringify({sub:uid(1),role,exp})).toString('base64url')}.synthetic`})
 expect(()=>loadFixtures([changed('service_role',10000)],1,30,0)).toThrow(/administrative/)
 expect(()=>loadFixtures([changed('authenticated',1)],1,30,0)).toThrow(/remain valid/)
})
