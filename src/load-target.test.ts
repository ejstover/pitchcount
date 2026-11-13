import {expect,it} from 'vitest'
import {loadTarget} from '../scripts/load-target'
const production='https://production.example/'
it('blocks protected production hosts including alternate ports before any request',()=>{
 for(const url of [production,'https://production.example:8443/','https://PRODUCTION.EXAMPLE/','https://production.example./'])expect(()=>loadTarget(url,[production])).toThrow(/protected production/)
 expect(loadTarget('https://staging.example/',[production]).hostname).toBe('staging.example')
})
it('requires independent production protection for remote runs and rejects malformed protection',()=>{
 expect(()=>loadTarget('https://staging.example/',[])).toThrow(/Declare the protected/)
 expect(()=>loadTarget('https://staging.example/',['not-a-url'])).toThrow(/production API URL is invalid/)
 expect(loadTarget('http://127.0.0.1:12345/',[]).port).toBe('12345')
})
it('rejects credentials, insecure remote endpoints and unexpected URL routing without reflecting inputs',()=>{
 for(const url of ['postgres://user:private@localhost/db','https://user:private@staging.example/','http://staging.example/','https://staging.example/?key=private','https://staging.example/#private','https://staging.example/other']){
  try{loadTarget(url,[production]);throw new Error('accepted')}catch(error){expect((error as Error).message).not.toContain('private');expect((error as Error).message).not.toBe('accepted')}
 }
})
