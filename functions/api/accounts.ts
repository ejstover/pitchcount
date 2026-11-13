import {accountIngressUnavailable,forwardAccountRequest,type AccountGatewayConfig} from '../../src/account-gateway.ts'
import {canonicalIp} from '../../src/account-proxy.ts'

/** Cloudflare Pages supplies cf metadata on real incoming requests. */
export async function onRequest({request,env}:{request:Request;env:AccountGatewayConfig}):Promise<Response>{
 const metadata=(request as Request&{cf?:unknown}).cf,peer=canonicalIp(request.headers.get('cf-connecting-ip'))
 // Pseudo IPv4 overwrite loses the IPv6 network used by rate buckets. Keep it
 // off; neither an alternate HTTP header nor a caller claim proves provenance.
 if(!metadata||typeof metadata!=='object'||!peer||(!peer.includes(':')&&Number(peer.split('.')[0])>=240))return accountIngressUnavailable()
 return forwardAccountRequest(request,env,peer)
}
