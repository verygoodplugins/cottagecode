import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubEventStream} from '../src/hub-event-stream.mjs';

const waitFor=async predicate=>{
  const until=Date.now()+2000;
  while(!predicate()){
    if(Date.now()>until)throw new Error('Timed out waiting for stream');
    await new Promise(resolve=>setTimeout(resolve,2));
  }
};
const envelope=(kind,taskId='child',extra={})=>({schemaVersion:1,kind,taskId,parentTaskId:'root',...extra});
const frame=(id,value,event='agent_event')=>`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
function connection(){
  let controller,cancelled=false;
  const body=new ReadableStream({start(value){controller=value;},cancel(){cancelled=true;}});
  return {response:{ok:true,headers:new Headers({'content-type':'text/event-stream; charset=utf-8'}),body},
    send(text){controller.enqueue(new TextEncoder().encode(text));},close(){controller.close();},get cancelled(){return cancelled;}};
}

test('stream sends server-only credentials and emits bounded identity hints from split SSE frames',async t=>{
  const socket=connection(),seen=[],requests=[];
  const stream=createHubEventStream({url:new URL('http://hub.test/v1/agent-events/stream'),token:'private-token',
    fetchFn:async(url,options)=>{requests.push({url,options});return socket.response;},onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();stream.start();await waitFor(()=>seen.length===1);
  const value=frame('1',envelope('task_updated','child',{payload:{version:3,thinking:'private thought',arguments:'private arguments'}})).replaceAll('\n','\r\n');
  socket.send(value.slice(0,15));socket.send(value.slice(15));
  socket.send(frame('2',envelope('tool'))+frame('3',envelope('usage',null)));
  await waitFor(()=>seen.length===3);
  assert.deepEqual(seen,[{type:'resync'},{type:'task',taskId:'child',parentTaskId:'root'},{type:'telemetry',taskId:'child',parentTaskId:'root'}]);
  assert.equal(requests.length,1);assert.equal(requests[0].options.headers.authorization,'Bearer private-token');
  assert.equal(requests[0].options.redirect,'error');assert.equal(JSON.stringify(seen).includes('private'),false);
  stream.stop();await waitFor(()=>socket.cancelled);assert.equal(requests[0].options.signal.aborted,true);
});

test('heartbeats advance the reconnect cursor and each connection resyncs canonical inventory',async t=>{
  const sockets=[connection(),connection()],requests=[],seen=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',retryMs:5,
    fetchFn:async(url,options)=>{requests.push(options);return sockets[requests.length-1].response;},onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>seen.length===1);
  sockets[0].send(frame('12',{cursor:'12'},'heartbeat'));sockets[0].close();
  await waitFor(()=>requests.length===2);
  assert.equal(requests[1].headers['last-event-id'],'12');
  assert.deepEqual(seen,[{type:'resync'},{type:'resync'}]);
});

test('reset and telemetry gaps force resync without exporting diagnostic text',async t=>{
  const sockets=[connection(),connection()],requests=[],seen=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',retryMs:5,
    fetchFn:async(url,options)=>{requests.push(options);return sockets[requests.length-1].response;},onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>seen.length===1);
  sockets[0].send(frame('7',envelope('diagnostic',null,{payload:{code:'telemetry_gap',message:'private'}})));
  sockets[0].send(frame('10',{reason:'cursor_pruned'},'reset'));sockets[0].close();
  await waitFor(()=>requests.length===2);
  assert.equal(requests[1].headers['last-event-id'],'10');
  assert.deepEqual(seen,Array.from({length:4},()=>({type:'resync'})));
});

test('malformed frames cannot advance the replay cursor and oversized frames are bounded',async t=>{
  const sockets=[connection(),connection(),connection()],requests=[],seen=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',retryMs:2,maxFrameBytes:256,
    fetchFn:async(url,options)=>{requests.push(options);return sockets[requests.length-1].response;},onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>seen.length===1);
  sockets[0].send(frame('5',{cursor:'5'},'heartbeat')+'id: 6\nevent: agent_event\ndata: broken\n\n');
  await waitFor(()=>requests.length===2);
  assert.equal(requests[1].headers['last-event-id'],'5');
  sockets[1].send('data: '+'x'.repeat(257));await waitFor(()=>requests.length===3);
  assert.equal(requests[2].headers['last-event-id'],'5');
  assert.equal(seen.every(hint=>hint.type==='resync'),true);
});

test('global inventory hints resync canonical IDs outside the telemetry vocabulary',async t=>{
  const socket=connection(),seen=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',
    fetchFn:async()=>socket.response,onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>seen.length===1);
  socket.send(frame('1',envelope('task_updated',null,{parentTaskId:null,payload:{version:null,resync:true,private:'not exported'}})));
  socket.send(frame('2',envelope('usage',null,{parentTaskId:null,payload:{resync:true}})));
  await waitFor(()=>seen.length===2);
  assert.deepEqual(seen,[{type:'resync'},{type:'resync'}]);
});

test('many complete frames in one transport chunk are processed without an aggregate-size rejection',async t=>{
  const socket=connection(),seen=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',maxFrameBytes:256,
    fetchFn:async()=>socket.response,onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>seen.length===1);
  socket.send(Array.from({length:100},(_,index)=>frame(String(index+1),envelope('tool'))).join(''));
  await waitFor(()=>seen.length===101);
  assert.equal(seen.slice(1).every(hint=>hint.type==='telemetry'),true);
});

test('stop fences a late handshake and cancels retry timers',async()=>{
  const socket=connection(),seen=[];let release,requests=0;
  const waiting=new Promise(resolve=>{release=resolve;});
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',retryMs:2,
    fetchFn:async()=>{requests++;await waiting;return socket.response;},onChange:hint=>seen.push(hint)});
  stream.start();stream.stop();release();await waitFor(()=>socket.cancelled);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(requests,1);assert.deepEqual(seen,[]);
});

test('a silent connected stream times out and reconnects instead of freezing inventory recovery',async t=>{
  const sockets=[connection(),connection()],seen=[],requests=[];
  const stream=createHubEventStream({url:'http://hub.test/v1/agent-events/stream',idleTimeoutMs:15,retryMs:2,
    fetchFn:async(url,options)=>{requests.push(options);return sockets[requests.length-1].response;},onChange:hint=>seen.push(hint)});
  t.after(()=>stream.stop());stream.start();await waitFor(()=>requests.length===2);
  assert.equal(requests[0].signal.aborted,true);assert.equal(sockets[0].cancelled,true);
  assert.deepEqual(seen,[{type:'resync'},{type:'resync'}]);
});
