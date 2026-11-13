// Small HTTP transport checks; synthetic keys and loopback servers only.
import assert from 'node:assert/strict'
import {createServer as httpServer,request as httpRequest} from 'node:http'
import {writeFile} from 'node:fs/promises'
import {createServer} from 'vite'
import {verifyAccountRequest,accountBodyLimit} from '../src/account-proxy.ts'
const secret='b'.repeat(64),app='https://count.twelvefs.com',received=[],results=[]
let front
const upstream=httpServer(async(req,res)=>{
 const chunks=[];for await(const part of req)chunks.push(part)
 const peer=await verifyAccountRequest([secret],app,new Headers(req.headers),Buffer.concat(chunks))
 received.push({peer,url:req.url,headers:req.headers})
 res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'synthetic=must-not-escape','x-pitchwork-proof':'synthetic-must-not-escape'})
 res.end(JSON.stringify({accepted:!!peer}))
})
const names=['APP_URL','VITE_SUPABASE_URL','VITE_SUPABASE_PUBLISHABLE_KEY','ACCOUNT_PROXY_SECRET'],before=names.map(name=>process.env[name])
async function check(name,run){await run();results.push({name,passed:true})}
try{
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
 Object.assign(process.env,{APP_URL:app,VITE_SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_gateway',ACCOUNT_PROXY_SECRET:secret})
 front=await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:5294,strictPort:true}});await front.listen()
 const base='http://127.0.0.1:5294',body=JSON.stringify({action:'recover_password',email:'synthetic@example.invalid'})
 const send=(extra={},payload=body)=>fetch(base+'/api/accounts',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...extra},body:payload})
 await check('HTTP gateway signs the socket address and strips caller credentials',async()=>{
  for(const fake of ['198.51.100.1','203.0.113.2']){
   const response=await send({'CF-Connecting-IP':fake,'X-Forwarded-For':fake,'x-pitchwork-peer':fake,Authorization:'Bearer synthetic',Cookie:'synthetic=1'})
   assert.equal(response.status,200);assert.equal((await response.json()).accepted,true)
   assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('x-pitchwork-proof'),null)
   assert.equal(response.headers.get('Cache-Control'),'no-store')
  }
  assert.equal(received.length,2)
  for(const request of received){assert.equal(request.peer,'127.0.0.1');assert.equal(request.url,'/functions/v1/accounts');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers.cookie,undefined);assert.equal(request.headers['cf-connecting-ip'],undefined)}
 })
 await check('Foreign origins and private actions stop before the upstream',async()=>{
  assert.equal((await send({Origin:'https://foreign.example'})).status,403)
  const status=await new Promise((resolve,reject)=>{
   const request=httpRequest(base+'/api/accounts',{method:'POST',headers:{Host:'foreign.example',Origin:base,'Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))})
   request.on('error',reject);request.end(body)
  });assert.equal(status,403)
  assert.equal((await send({},JSON.stringify({action:'profile'}))).status,400)
  assert.equal((await fetch(base+'/api/accounts')).status,405)
  assert.equal(received.length,2)
 })
 await check('Oversized fixed and streamed bodies return 413 without reaching the upstream',async()=>{
  assert.equal((await send({},'x'.repeat(accountBodyLimit+1))).status,413)
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(accountBodyLimit+1)));controller.close()}})
  const response=await fetch(base+'/api/accounts',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:stream,duplex:'half'})
  assert.equal(response.status,413);assert.equal(received.length,2)
 })
 await writeFile('.test-artifacts/account-gateway-http.json',JSON.stringify({completedAt:new Date().toISOString(),passed:true,results,note:'Synthetic loopback transport checks; not a capacity measurement.'},null,2))
 for(const result of results)console.log(`${result.name}: passed`)
}finally{
 if(front)await front.close()
 upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))
 names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index]})
}
