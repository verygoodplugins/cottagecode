import test from 'node:test';
import assert from 'node:assert/strict';
import {feedEnvelope,normalizeCottage,isCottageVisible,feedStatusNote,mergeActivity,activityAddress,elapsedMs} from '../src/feed-client.mjs';
test('bare and wrapped feeds are compatible but missing agents is invalid',()=>{
  assert.deepEqual(feedEnvelope([]).agents,[]);assert.equal(feedEnvelope({agents:[],source:'custom'}).source,'custom');
  assert.throws(()=>feedEnvelope({source:'oops'}));
});
test('missing timestamps never become the current time',()=>{
  const a=normalizeCottage({id:'a'},0,{town:x=>x||'Town',model:x=>x||'?',occupancy:()=> 'live'});
  assert.equal(a.startedAt,null);assert.equal(a.originalAsk,'');assert.equal(a.taskId,null);
});
test('known task notifications show a summary and never their transport fields',()=>{
  const a=normalizeCottage({id:'a',task:'<task-notification><task-id>private</task-id><summary>Refresh release notes</summary><event>private event payload</event></task-notification>',originalAsk:'<task-notification><summary>Refresh release notes</summary></task-notification>'},0,{town:x=>x||'Town',model:x=>x||'?',occupancy:()=> 'live'});
  assert.equal(a.task,'Refresh release notes');
  assert.equal(a.originalAsk,'Refresh release notes');
});
test('activity merges append and paged history without duplicates',()=>{
  const a={id:'a',timestamp:10,text:'one'},b={id:'b',timestamp:20,text:'two'};
  assert.deepEqual(mergeActivity([b],[a,b]),[a,b]);
  assert.equal(activityAddress({activityUrl:'/agents/a/activity'},'http://localhost:8787/agents').pathname,'/agents/a/activity');
  assert.equal(activityAddress({activityUrl:'javascript:alert(1)'},'http://localhost'),null);
});
test('undated activity keeps its source position across appends and earlier pages',()=>{
  const a={id:'a',timestamp:10,text:'read'},b={id:'b',timestamp:null,text:'tool'},c={id:'c',timestamp:20,text:'result'};
  assert.deepEqual(mergeActivity([a,b],[c]).map(e=>e.id),['a','b','c']);
  assert.deepEqual(mergeActivity([a,b],[c,{id:'d',timestamp:null,text:'summary'}]).map(e=>e.id),['a','b','c','d']);
});
test('source staleness is preserved even for a successful HTTP response',()=>{
  const data=feedEnvelope({agents:[],source:'claude',stale:true,errors:['scan failed']});
  assert.equal(data.stale,true);assert.deepEqual(data.errors,['scan failed']);
});
test('completed duration stays fixed and unknown boundaries stay unavailable',()=>{
  const start=1700000000000;
  assert.equal(elapsedMs({taskStartedAt:start,status:'done',endedAt:start+1000},start+9000),1000);
  assert.equal(elapsedMs({taskStartedAt:start,status:'done'},start+9000),null);
  assert.equal(elapsedMs({startedAt:start,status:'working'},start+9000),null);
});
test('terminal attention keeps its known elapsed duration after normalizing',()=>{
  const start=1700000000000;
  const cottage=normalizeCottage({taskStartedAt:start,status:'blocked',terminal:true,endedAt:start+1000},0,{town:x=>x||'Town',model:x=>x||'?',occupancy:()=> 'live'});
  assert.equal(cottage.terminal,true);
  assert.equal(elapsedMs(cottage,start+9000),1000);
});
test('Hub history stays settled even when it retains an unresolved PR link',()=>{
  const now=1700000000000;
  const options={town:x=>x||'Town',model:x=>x||'?',occupancy:()=> 'live',now};
  const pr={url:'https://github.com/example/repo/pull/42',state:'unknown'};
  const history=normalizeCottage({id:'history',inventoryScope:'history',occupancy:'live',pr},0,options);
  assert.equal(history.occupancy,'settled');
  assert.equal(history.pr.url,pr.url);
  assert.equal(isCottageVisible(history,{now}),false);
  assert.equal(isCottageVisible(history,{showSettled:true,now}),true);
  assert.equal(isCottageVisible(history,{interiorId:'history',now}),true);
  assert.equal(isCottageVisible(history,{interiorId:'another-cottage',now}),false);
});
test('Hub dashboard occupancy remains authoritative while standalone PRs stay visible',()=>{
  const now=1700000000000;
  const options={town:x=>x||'Town',model:x=>x||'?',occupancy:()=> 'settled',now};
  const pr={url:'https://github.com/example/repo/pull/42',state:'open',checkedAt:now};
  const dashboard=normalizeCottage({id:'recent',inventoryScope:'dashboard',occupancy:'recent',pr},0,options);
  const standalone=normalizeCottage({id:'standalone',occupancy:'settled',pr},1,options);
  assert.equal(dashboard.occupancy,'recent');
  assert.equal(isCottageVisible(dashboard,{now}),true);
  const undated=normalizeCottage({id:'undated',inventoryScope:'dashboard',status:'offline'},2,options);
  assert.equal(undated.occupancy,'recent');assert.equal(isCottageVisible(undated,{now}),true);
  assert.equal(standalone.occupancy,'live');
  assert.equal(isCottageVisible(standalone,{now}),true);
});
test('feed note separates live and recent cottages from historical inventory',()=>{
  const agents=[
    ...Array.from({length:19},(_,i)=>({id:`dashboard-${i}`,inventoryScope:'dashboard',occupancy:i%2?'live':'recent'})),
    ...Array.from({length:521},(_,i)=>({id:`history-${i}`,inventoryScope:'history',occupancy:'settled',pr:{url:'https://github.com/example/repo/pull/42'}})),
  ];
  assert.equal(feedStatusNote(agents,{source:'hub'}),'AutoHub · 19 live + recent · 521 settled');
  assert.equal(feedStatusNote(agents,{source:'hub+claude',stale:true}),'Stale snapshot · AutoHub + Claude sessions · 19 live + recent · 521 settled');
  assert.equal(feedStatusNote([],{source:'claude'}),'Claude sessions · 0 live + recent · 0 settled');
  assert.equal(feedStatusNote([]),'Custom feed · 0 live + recent · 0 settled');
});

test('recorded execution duration excludes delivery wait and supports zero',()=>{
  const start=1700000000000;
  const merged={taskStartedAt:start,status:'done',endedAt:start+169*60000,durationMs:63*60000};
  assert.equal(elapsedMs(merged),63*60000);
  assert.equal(elapsedMs({...merged,durationMs:0}),0);
  assert.equal(elapsedMs({durationMs:500}),500,'recorded duration does not need a start date');
  for(const durationMs of [null,undefined,-1,Infinity,NaN,'1000'])assert.equal(elapsedMs({...merged,durationMs}),169*60000);
});
