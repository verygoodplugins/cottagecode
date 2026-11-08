import test from 'node:test';
import assert from 'node:assert/strict';
import {attachHubTelemetry} from '../src/hub-telemetry.mjs';
import {createHubInventoryReader} from '../src/hub-inventory.mjs';
import {normalizeCottage} from '../src/feed-client.mjs';
const now=Date.parse('2026-11-05T12:00:00Z');
const cottage={taskId:'task',sessionId:'session',status:'working',freshness:{isStale:false}};
const call={name:'read_file',at:new Date(now).toISOString(),callId:'call-1'};
const scope={scope:'a:one',current:true,tool:{current:call}};
const row={taskId:'task',currentAttempt:'a:one',attempts:[scope],observed:[]};
const snapshot={tasks:[row],coverage:{complete:true},secret:'private'};
test('only explicit safe fields survive; canonical data stays intact',()=>{
 const value=attachHubTelemetry(cottage,{...snapshot,tasks:[{...row,attempts:[{...scope,tool:{current:{...call,arguments:'secret',output:'secret'}}}]}]},now);
 assert.deepEqual(value.toolActivity,{name:'read_file',state:'started',at:now,callId:'call-1',source:'hub:agent-events',stale:false});
 assert.equal(value.status,'working');assert.equal(JSON.stringify(value).includes('secret'),false);
 assert.equal(JSON.stringify(value).includes('attempts'),false);
});
test('foreign, duplicate, conflicting and old attempt scopes cannot supply tools',()=>{
 for(const tasks of [[],[{...row,taskId:'foreign'}],[row,row],[{...row,currentAttempt:'a:new'}],[{...row,attempts:[scope,{...scope,scope:'a:old'}]}],[{...row,currentAttempt:null}]]){
  assert.equal(attachHubTelemetry(cottage,{tasks},now).toolActivity,null);
 }
});
test('observed scopes require exact known unambiguous session identity',()=>{
 const observed={scope:'s:session',sessionIds:['session'],tool:{current:call}};
 const sample={taskId:'task',currentAttempt:null,attempts:[],observed:[observed]};
 assert.equal(attachHubTelemetry(cottage,{tasks:[sample]},now).toolActivity.name,'read_file');
 for(const scopes of [[{...observed,sessionIds:['foreign']}],[observed,observed],[{...observed,sessionIds:['session','other']}],[{...observed,scope:'s:other'}]])assert.equal(attachHubTelemetry(cottage,{tasks:[{...sample,observed:scopes}]},now).toolActivity,null);
 assert.equal(attachHubTelemetry({...cottage,sessionId:null},{tasks:[sample]},now).toolActivity,null);
});
test('absent retained scopes are missing while conflicting identities remain ambiguous',()=>{
 const observed={scope:'s:session',sessionIds:['session'],tool:{current:call}};
 const absent=[{...row,attempts:[],observed:[observed]},
  {...row,currentAttempt:null,attempts:[],observed:[]},
  {...row,currentAttempt:null,attempts:[],observed:[{...observed,scope:'s:foreign',sessionIds:['foreign']}]}];
 for(const value of absent){
  const result=attachHubTelemetry(cottage,{tasks:[value]},now);
  assert.equal(result.toolActivity,null);
  assert.equal(result.toolCoverage.reason,'missing_scope');
 }
 const ambiguous=[{...row,attempts:[scope,scope]},
  {...row,attempts:[scope,{...scope,scope:'a:other'}]},
  {...row,currentAttempt:null,attempts:[],observed:[observed,observed]},
  {...row,currentAttempt:null,attempts:[],observed:[{...observed,sessionIds:['session','other']}]},
  {...row,currentAttempt:null,attempts:[],observed:[{...observed,scope:'s:other'}]}];
 for(const value of ambiguous){
  const result=attachHubTelemetry(cottage,{tasks:[value]},now);
  assert.equal(result.toolActivity,null);
  assert.equal(result.toolCoverage.reason,'ambiguous_scope');
 }
});
test('malformed names, times, states and call ids degrade only telemetry',()=>{
 for(const invalid of [{name:'cat secret args'},{name:'x'.repeat(121)},{at:'invalid'},{at:new Date(now+60000).toISOString()},{callId:'secret string'},{state:'completed'}]){
  const last={...call,state:'succeeded',...invalid};
  assert.equal(attachHubTelemetry(cottage,{tasks:[{...row,attempts:[{...scope,tool:{last}}]}]},now).toolActivity,null);
 }
 assert.equal(attachHubTelemetry(cottage,null,now).toolActivity,null);
 assert.equal(attachHubTelemetry(cottage,snapshot,now+121000).toolActivity.stale,true);
 for(const state of ['succeeded','failed','cancelled'])assert.equal(attachHubTelemetry(cottage,{tasks:[{...row,attempts:[{...scope,tool:{last:{...call,state}}}]}]},now).toolActivity.state,state);
});
test('one authenticated optional snapshot is TTL coalesced; failures and unresponsive fetches are bounded',async()=>{
 for(const failure of ['404','throw','hang','badjson']){
  let count=0;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',token:'private-token',now:()=>now,telemetryTimeoutMs:20,fetchFn:async(url,options)=>{
   if(new URL(url).pathname.endsWith('/snapshot')){
    count++;assert.equal(new URL(url).searchParams.get('limit'),'200');assert.equal(options.headers.authorization,'Bearer private-token');
    if(failure==='throw')throw Error('private');if(failure==='hang')return new Promise(()=>{});
    if(failure==='badjson')return {ok:true,json:async()=>{throw Error('private');}};
    return {ok:false};
   }
   return {ok:true,json:async()=>({tasks:[{id:'task',status:'running',sessionId:'session'}],has_more:false})};
  }});
  const start=Date.now();const [a,b]=await Promise.all([reader.read(),reader.read()]);
  assert.equal(a,b);assert.equal(a.agents.length,1);assert.equal(a.agents[0].toolActivity,null);assert.equal(count,1);await reader.read();assert.equal(count,1);assert.ok(Date.now()-start<1000);
 }
});
test('default telemetry budget accepts a cold snapshot without a real-time wait',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,fetchFn:async url=>{
  if(new URL(url).pathname.endsWith('/snapshot'))return new Promise(resolve=>setTimeout(()=>resolve({ok:true,json:async()=>snapshot}),1800));
  return {ok:true,json:async()=>({tasks:[{id:'task',status:'running',sessionId:'session'}],has_more:false})};
 }});
 const pending=reader.read();
 t.mock.timers.tick(1800);
 const result=await pending;
 assert.equal(result.agents[0].toolActivity?.name,'read_file');
});
test('fresh telemetry reaches cached historical session cottages on subsequent inventory refreshes',async()=>{
 let clock=now,historyReads=0,telemetryReads=0;
 const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>clock,ttl:0,fetchFn:async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/snapshot')){telemetryReads++;return {ok:true,json:async()=>({tasks:[{taskId:'historical',currentAttempt:null,attempts:[],observed:[{scope:'s:session',sessionIds:['session'],tool:{current:call}}]}]})};}
  if(u.searchParams.get('scope')==='history'){historyReads++;return {ok:true,json:async()=>({tasks:[{id:'historical',sessionId:'session',status:'completed'}],has_more:false})};}
  return {ok:true,json:async()=>({tasks:[],has_more:false})};
 }});
 assert.equal((await reader.read()).agents[0].toolActivity.name,'read_file');clock+=5000;
 assert.equal((await reader.read()).agents[0].toolActivity.name,'read_file');assert.equal(historyReads,1);assert.equal(telemetryReads,2);
});

const sessionUsage={tokens:{inputTokens:200,outputTokens:10,cacheReadTokens:120,cacheWriteTokens:null,totalTokens:210},
 incompleteFields:[],lowerBound:[],unavailable:['cost'],cost:{usd:null,sources:[],bySource:{},complete:false},arrivalOrdered:false,
 meters:[{producer:'codex_rollout',sessionId:'session',meter:'session',basis:'latest_state',inputTokens:200,totalTokens:210,private:'secret'}]};
const observedUsage={scope:'s:session',sessionIds:['session'],usage:sessionUsage,
 context:{usedTokens:100,windowTokens:200000,at:new Date(now-1000).toISOString(),usedRatio:0.0005},
 lastObservedAt:new Date(now).toISOString(),tool:{current:null,last:null}};
const usageRow={taskId:'task',currentAttempt:null,attempts:[],observed:[observedUsage]};
const usageSnapshot={tasks:[usageRow],coverage:{complete:true}};
test('observed cumulative session usage survives without tool facts and does not become run spend',()=>{
 const value=attachHubTelemetry({...cottage,tokens:999,cost:2},usageSnapshot,now);
 assert.equal(value.toolCoverage.reason,'missing_tool');
 assert.equal(value.usageCoverage.available,true);assert.equal(value.usageCoverage.reason,null);
 assert.equal(value.usage.scope,'session');assert.equal(value.usage.scopeId,'s:session');
 assert.equal(value.usage.tokens.totalTokens,210,'cached input is already included, not added a second time');
 assert.equal(value.usage.cost.usd,null);assert.equal(value.usage.measuredAt,null,'latest tool observation is not a usage timestamp');
 assert.equal(value.tokens,999);assert.equal(value.cost,2,'canonical known counters remain intact');
 assert.deepEqual(value.contextUsage,{source:'hub:agent-events',scope:'session',usedTokens:100,windowTokens:200000,at:now-1000,usedRatio:0.0005,stale:false});
 assert.equal(JSON.stringify(value).includes('secret'),false);assert.equal('meters' in value.usage,false);
});
test('usage and context use the same strict identity fence as tools',()=>{
 for(const tasks of [[],[usageRow,usageRow],[{...usageRow,taskId:'foreign'}],
  [{...usageRow,currentAttempt:'a:new'}],
  [{...usageRow,observed:[observedUsage,{...observedUsage}]}],
  [{...usageRow,observed:[{...observedUsage,sessionIds:['session','other']}]}],
  [{...usageRow,observed:[{...observedUsage,scope:'s:other'}]}]]){
  const value=attachHubTelemetry(cottage,{tasks},now);
  assert.equal(value.usage,null);assert.equal(value.contextUsage,null);
 }
});
test('managed ownership suppresses duplicate session usage including retained diagnostic meters',()=>{
 for(const row of [{...usageRow,ownedBy:'managed'},
  {...usageRow,observed:[{...observedUsage,usage:{...sessionUsage,supersededBy:'managed',superseded:sessionUsage}}]}]){
  const value=attachHubTelemetry(cottage,{tasks:[row]},now);
  assert.equal(value.usage,null);assert.equal(value.usageCoverage.reason,'superseded');assert.equal(value.contextUsage,null);
 }
});
test('unknown, partial, malformed, and explicitly zero measurements remain distinct',()=>{
 const partial=attachHubTelemetry(cottage,{...usageSnapshot,coverage:{complete:false}},now);
 assert.equal(partial.usageCoverage.reason,'partial');assert.equal(partial.usage.coverageComplete,false);
 assert.ok(partial.usage.incompleteFields.includes('totalTokens'));
 const usage={...sessionUsage,tokens:{inputTokens:0,outputTokens:-1,totalTokens:null,cacheReadTokens:'10',cacheWriteTokens:Infinity},
  cost:{usd:0,sources:['vendor'],complete:true}};
 const value=attachHubTelemetry(cottage,{...usageSnapshot,tasks:[{...usageRow,observed:[{...observedUsage,usage}]}]},now);
 assert.deepEqual(value.usage.tokens,{inputTokens:0,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,totalTokens:null});
 assert.equal(value.usage.cost.usd,0);assert.equal(value.usage.cost.complete,true);
 const stale=attachHubTelemetry(cottage,usageSnapshot,now+121000);
 assert.equal(stale.contextUsage.stale,true);assert.equal(stale.usage.measuredAt,null);
});
test('real observer shape reaches the browser without turning missing legacy measurements into zero',async()=>{
 const task={id:'task',sessionId:'session',recordKind:'external_session',source:'codex_rollout',backend:'codex',
  status:'running',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalCost:0};
 const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,fetchFn:async url=>({ok:true,json:async()=>
  new URL(url).pathname.endsWith('/snapshot')?usageSnapshot:{tasks:[task],has_more:false}})});
 const agent=(await reader.read()).agents[0];
 const value=normalizeCottage(agent,0,{town:x=>x,model:x=>x,occupancy:()=> 'live',now});
 assert.equal(value.tokens,null);assert.equal(value.cost,null);
 assert.equal(value.usage.tokens.totalTokens,210);assert.equal(value.usage.cost.usd,null);
 assert.equal(value.usage.scope,'session');assert.equal(value.contextUsage.usedTokens,100);
});
