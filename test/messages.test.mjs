import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createHubMessenger,acceptsMessageOrigin} from '../src/messages.mjs';
import {createFeedServer} from '../src/feed.mjs';

const now=Date.now();
const agent={id:'cottage-1',taskId:'task-1',source:'hub',conversationTarget:{taskId:'task-1',taskStatus:'running',recordKind:'logical_task',transport:'tmux',supportsRedirection:true}};
const message={taskId:'task-1',message:'Please explain the tradeoffs before changing the API.',requestId:'message-1234'};
const task={id:'task-1',status:'running',recordKind:'logical_task',context:{lifecycle:{execution:{sessionMode:'tmux',supportsRedirection:true}}}};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function fixture({current=task,reply={ok:true,taskId:'task-1'},status=200,throws=false,...options}={}){
  const calls=[];
  const messenger=createHubMessenger({baseUrl:'http://hub.test/v1',token:'fixture-token',now:()=>now,ledgerPath:null,
    fetchImpl:async(url,init)=>{calls.push({url:String(url),...init});if(init.method==='POST'){if(throws)throw new Error('Socket closed after write');return response(reply,status);}return response(current);},...options});
  return {messenger,calls};
}
test('only supported logical task transports advertise messages; terminal, unknown, and stale tasks do not',()=>{
  const {messenger}=fixture();
  assert.equal(messenger.capability(agent).mode,'redirect');
  assert.equal(messenger.capability({...agent,conversationTarget:{...agent.conversationTarget,taskStatus:'needs_input',transport:'direct'}}).mode,'respond');
  for(const overrides of [{recordKind:'external_session'},{recordKind:'unknown'},{taskStatus:'completed'},{taskStatus:'queued'},{taskStatus:'failed'},{transport:'direct'},{transport:'unknown'},{supportsRedirection:false},{taskId:'other'}])
    assert.equal(messenger.capability({...agent,conversationTarget:{...agent.conversationTarget,...overrides}}).available,false,JSON.stringify(overrides));
  assert.equal(messenger.capability(agent,{stale:true}).available,false);
  assert.equal(messenger.capability(agent,{checkedAt:now-121000}).available,false);
  assert.equal(createHubMessenger({baseUrl:''}).capability(agent).available,false);
});
test('explicit messages verify current task then submit exact text, with concurrent duplicate protection',async()=>{
  const {messenger,calls}=fixture();
  const [one,two]=await Promise.all([messenger.send(agent,message),messenger.send(agent,message)]);
  assert.equal(one.body.delivery,'submitted');assert.deepEqual(two,one);assert.equal(calls.length,2);
  assert.equal(calls[0].url,'http://hub.test/v1/tasks/task-1');
  assert.equal(calls[1].url,'http://hub.test/v1/tasks/task-1/redirect');
  assert.deepEqual(JSON.parse(calls[1].body),{instruction:message.message});
  assert.equal(calls[1].headers.authorization,'Bearer fixture-token');assert.equal(calls[1].redirect,'error');
  assert.equal(JSON.stringify(one).includes('fixture-token'),false);
  assert.equal((await messenger.send(agent,{...message,message:'A different ask'})).status,409);assert.equal(calls.length,2);
});
test('waiting input uses respond and never invokes resume or dispatch',async()=>{
  const waiting={...agent,conversationTarget:{...agent.conversationTarget,taskStatus:'awaiting_input'}};
  const {messenger,calls}=fixture({current:{...task,status:'awaiting_input',canRespond:true},reply:{id:'task-1',status:'running'},status:202});
  assert.equal((await messenger.send(waiting,message)).body.delivery,'accepted');
  assert.equal(calls[1].url,'http://hub.test/v1/tasks/task-1/respond');
  assert.deepEqual(JSON.parse(calls[1].body),{response:message.message});
});
test('fresh validation rejects changed task states and direct sessions before any write',async()=>{
  for(const current of [{...task,status:'completed'},{...task,id:'other'},{...task,isStale:true},{...task,archived:true},{...task,recordKind:'external_session'},{...task,context:{lifecycle:{execution:{sessionMode:'direct'}}}}]){
    const {messenger,calls}=fixture({current});
    assert.equal((await messenger.send(agent,message)).body.delivery,'not_sent');
    assert.equal(calls.filter(call=>call.method==='POST').length,0);
  }
  const {messenger,calls}=fixture();
  for(const invalid of [{...message,taskId:'wrong'},{...message,message:''},{...message,message:'x'.repeat(8001)},{...message,requestId:'../'}])assert.notEqual((await messenger.send(agent,invalid)).status,200);
  assert.equal(calls.length,0);
});
test('uncertain deliveries and successful receipts survive restart without replaying a message',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cottage-messages-')),ledgerPath=join(directory,'receipts.jsonl');
  try{
    const first=fixture({throws:true,ledgerPath});
    assert.equal((await first.messenger.send(agent,message)).body.delivery,'unconfirmed');
    const second=fixture({ledgerPath});
    assert.equal((await second.messenger.send(agent,message)).body.delivery,'unconfirmed');assert.equal(second.calls.length,0);
    const next={...message,requestId:'another-message'};
    assert.equal((await second.messenger.send(agent,next)).body.delivery,'submitted');
    const third=fixture({ledgerPath});assert.equal((await third.messenger.send(agent,next)).body.delivery,'submitted');assert.equal(third.calls.length,0);
    const stored=await readFile(ledgerPath,'utf8');assert.equal(stored.includes(message.message),false);assert.equal(stored.includes('fixture-token'),false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('upstream rejection is distinct from uncertainty and omits private error context',async()=>{
  const {messenger}=fixture({status:403,reply:{error:'owner_approval_required',task:{private:'do-not-return'}}});
  const sent=await messenger.send(agent,message);assert.equal(sent.status,403);assert.equal(sent.body.delivery,'not_sent');assert.match(sent.body.error,/owner/);assert.equal(JSON.stringify(sent).includes('do-not-return'),false);
  assert.equal((await fixture({status:500}).messenger.send(agent,message)).body.delivery,'unconfirmed');
  for(const error of ['cancellation_in_progress','already_answered']){
    const waiting={...agent,conversationTarget:{...agent.conversationTarget,taskStatus:'awaiting_input'}};
    const {messenger,calls}=fixture({current:{...task,status:'awaiting_input'},status:409,reply:{error}});
    assert.equal((await messenger.send(waiting,message)).body.delivery,'unconfirmed');
    assert.equal((await messenger.send(waiting,message)).body.delivery,'unconfirmed');assert.equal(calls.length,2,'an ambiguous conflict must not repeat the write');
  }
});
test('message origin guard rejects cross-origin, absent Origin, and rebinding hostnames',()=>{
  const headers={host:'127.0.0.1:8787',origin:'http://127.0.0.1:8787','content-type':'application/json','x-cottagecode-request':'user-message'};
  const socket={remoteAddress:'127.0.0.1'};
  assert.equal(acceptsMessageOrigin({headers,socket}),true);
  for(const remoteAddress of ['::1','::ffff:127.0.0.1'])assert.equal(acceptsMessageOrigin({headers,socket:{remoteAddress}}),true);
  for(const remoteAddress of ['192.168.1.5','::ffff:192.168.1.5','',undefined])assert.equal(acceptsMessageOrigin({headers,socket:{remoteAddress}}),false);
  for(const extra of [{origin:'https://example.com'},{origin:undefined},{host:'evil.example:8787',origin:'http://evil.example:8787'},{'content-type':'text/plain'},{'x-cottagecode-request':undefined}])assert.equal(acceptsMessageOrigin({headers:{...headers,...extra},socket}),false);
});
test('HTTP message chunks preserve Unicode split across multibyte boundaries',async()=>{
  let received;
  const server=createFeedServer({snapshot:()=>({agents:[agent]}),getActivity:async()=>null},{messages:{capability:()=>({available:false}),send:async(a,payload)=>{received=payload;return {status:200,body:{ok:true,delivery:'submitted'}};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  try{
    const payload={...message,message:'Hello 🦆 — Grüß dich!'},bytes=Buffer.from(JSON.stringify(payload)),cut=bytes.indexOf(Buffer.from('🦆'))+2;
    await new Promise((resolve,reject)=>{
      const req=httpRequest(origin+'/agents/cottage-1/messages',{method:'POST',headers:{origin,'content-type':'application/json','x-cottagecode-request':'user-message'}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(new Error('HTTP '+res.statusCode)));});
      req.on('error',reject);req.write(bytes.subarray(0,cut));setTimeout(()=>req.end(bytes.subarray(cut)),10);
    });
    assert.equal(received.message,payload.message);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('HTTP server exposes capability and accepts only explicit same-origin message posts',async()=>{
  const {messenger,calls}=fixture(),feed={snapshot:()=>({agents:[agent],checkedAt:now,stale:false}),getActivity:async()=>null};
  const server=createFeedServer(feed,{messages:messenger});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const post=(body,headers={})=>fetch(base+'/agents/cottage-1/messages',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  try{
    assert.equal((await (await fetch(base+'/agents')).json()).agents[0].conversation.available,true);
    assert.equal((await post(message)).status,403);
    assert.equal((await post(message,{origin:'https://other.example','x-cottagecode-request':'user-message'})).status,403);
    assert.equal(calls.length,0);
    const sent=await post(message,{origin:base,'x-cottagecode-request':'user-message'});assert.equal(sent.status,200);assert.equal((await sent.json()).delivery,'submitted');
    assert.equal((await fetch(base+'/agents',{method:'POST'})).status,405);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
