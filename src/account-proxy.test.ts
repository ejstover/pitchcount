import {expect,it} from 'vitest'
import {accountProxyHeaders,canonicalIp,networkRateSubject,signAccountRequest,verifyAccountRequest} from './account-proxy'
const secret='a'.repeat(64),previous='b'.repeat(64),origin='https://count.twelvefs.com',now=1794517200000,body=new TextEncoder().encode('{"action":"request","name":"Player ⚾"}')
it('binds the actual body, origin and peer address, ignoring untrusted forwarding headers',async()=>{
 const headers=new Headers(await signAccountRequest(secret,origin,'203.0.113.7',body,now))
 headers.set('cf-connecting-ip','198.51.100.5');headers.set('x-real-ip','198.51.100.6');headers.set('x-forwarded-for','198.51.100.7')
 expect(await verifyAccountRequest([secret],origin,headers,body,now)).toBe('203.0.113.7')
 expect(await verifyAccountRequest([secret],origin,headers,new TextEncoder().encode('{}'),now)).toBeNull()
 expect(await verifyAccountRequest([secret],'https://other.example',headers,body,now)).toBeNull()
 headers.set(accountProxyHeaders.ip,'198.51.100.8');expect(await verifyAccountRequest([secret],origin,headers,body,now)).toBeNull()
})
it('rejects missing, altered, expired and excessively future proofs',async()=>{
 expect(await verifyAccountRequest([secret],origin,new Headers(),body,now)).toBeNull()
 const headers=new Headers(await signAccountRequest(secret,origin,'203.0.113.7',body,now))
 expect(await verifyAccountRequest([previous],origin,headers,body,now)).toBeNull()
 expect(await verifyAccountRequest([secret],origin,headers,body,now+60001)).toBeNull()
 expect(await verifyAccountRequest([secret],origin,headers,body,now-10001)).toBeNull()
 headers.set(accountProxyHeaders.signature,'0'.repeat(64));expect(await verifyAccountRequest([secret],origin,headers,body,now)).toBeNull()
})
it('allows a bounded previous key during rotation without accepting malformed configuration',async()=>{
 const headers=new Headers(await signAccountRequest(previous,origin,'203.0.113.7',body,now))
 expect(await verifyAccountRequest([secret,previous],origin,headers,body,now)).toBe('203.0.113.7')
 expect(await verifyAccountRequest([secret,previous,secret],origin,headers,body,now)).toBeNull()
 expect(await verifyAccountRequest(['weak'],origin,headers,body,now)).toBeNull()
})
it('canonicalizes mapped addresses and prevents IPv6 rotation within one network from resetting its bucket',()=>{
 expect(canonicalIp('::ffff:192.0.2.1')).toBe('192.0.2.1')
 expect(canonicalIp('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::1')
 expect(networkRateSubject('2001:db8:1:2::1')).toBe(networkRateSubject('2001:db8:1:2::99'))
 expect(networkRateSubject('2001:db8:1:3::1')).not.toBe(networkRateSubject('2001:db8:1:2::1'))
 for(const value of ['203.0.113.7, 1.2.3.4','203.0.113.999','001.2.3.4','::1%lo','::1\n','garbage'])expect(canonicalIp(value)).toBeNull()
})
