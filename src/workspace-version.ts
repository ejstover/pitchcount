// Only a digest of the complete ID/version set can skip a manifest download.
// Include the server's access epoch and retain the paged path without Web Crypto.
export async function workspaceManifestHash(epoch:string,versions:Iterable<readonly [string,string]>):Promise<string|null> {
  if(!globalThis.crypto?.subtle)return null
  const entries=[...versions].sort(([a],[b])=>a<b?-1:a>b?1:0)
  const input=epoch+'\n'+entries.map(([id,version])=>id+':'+version).join('\n')
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')
}
