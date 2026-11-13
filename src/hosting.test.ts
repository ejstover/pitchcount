import {describe,expect,it} from 'vitest'
import {hostingHeaders} from '../build-hosting'

function headers(url?:string) {
  const plugin=hostingHeaders()
  let emitted:{fileName:string;source:string}|undefined
  Reflect.apply(plugin.configResolved as Function,{},[{env:{VITE_SUPABASE_URL:url}}])
  Reflect.apply(plugin.generateBundle as Function,{emitFile:(asset:typeof emitted)=>{if(asset?.fileName==='_headers')emitted=asset}},[])
  expect(emitted?.fileName).toBe('_headers')
  return emitted!.source
}
describe('CDN header artifact',()=>{
  it('sends only the account API through Functions so static requests bypass the runtime',()=>{
    const plugin=hostingHeaders(),files:Record<string,string>={}
    Reflect.apply(plugin.generateBundle as Function,{emitFile:(asset:{fileName:string;source:string})=>{files[asset.fileName]=asset.source}},[])
    expect(JSON.parse(files['_routes.json'])).toEqual({version:1,include:['/api/accounts'],exclude:[]})
  })
  it('permits only the configured connection origin and disallows embedded content and inline scripts',()=>{
    const result=headers('https://project.supabase.co/path')
    expect(result).toContain("connect-src 'self' https://project.supabase.co wss://project.supabase.co;")
    expect(result).toContain("script-src 'self';")
    expect(result).toContain("frame-ancestors 'none'")
    expect(result).toContain("object-src 'none'")
    expect(result).not.toContain('*.supabase.co')
    expect(result).toContain('Referrer-Policy: no-referrer')
  })
  it.each([undefined,'invalid','javascript:alert(1)','http://public.example.com'])('fails closed for an invalid or insecure public origin: %s',url=>{
    expect(headers(url)).toContain("connect-src 'self';")
  })
  it('keeps immutable asset rules separate from the app shell and service worker',()=>{
    const result=headers('https://project.supabase.co')
    expect(result).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable')
    expect(result).toContain('/index.html\n  Cache-Control: no-cache')
    expect(result).toContain('/sw.js\n  Cache-Control: no-cache')
  })
})
