import test from 'node:test';
import assert from 'node:assert/strict';
import {durationLabel,taskView,fleetView} from '../experiments/command-center/model.mjs';
import {createScenario} from '../experiments/command-center/scenario.mjs';
import {createReplyClient,isTerminalForMessage} from '../experiments/command-center/replies.mjs';
import {inputRequestVersion} from '../src/input-request.mjs';
const now=Date.parse('2026-11-04T12:00:00Z');
const endpoint='http://127.0.0.1:8790/agents';
const task=(extra={})=>({id:'cottage-1',taskId:'task-1',task:'Review fleet inventory',town:'HubTown',status:'working',source:'hub',updatedAt:now,...extra});
const pr=(extra={})=>({url:'https://example.invalid/fiction/hub/pull/901',state:'open',reviewState:'ready',headSha:'abc',reviewedHeadSha:'abc',checkedAt:now,...extra});
const question=(extra={})=>task({status:'blocked',inputRequest:{id:'question-1',kind:'question',prompt:'Keep historical records?',options:['Yes','No']},conversation:{available:true,mode:'respond',checkedAt:now,messageUrl:'/agents/cottage-1/messages'},...extra});
const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('compact durations preserve unavailable rather than inventing a clock',()=>{
  assert.equal(durationLabel(null),'Unavailable');assert.equal(durationLabel(NaN),'Unavailable');assert.equal(durationLabel(-1),'Unavailable');
  assert.equal(durationLabel(0),'0s');assert.equal(durationLabel(90061_000),'1d 1h');assert.equal(durationLabel(125_000),'2m 5s');
});
test('task and session clocks stay separate when task start is missing',()=>{
  const view=taskView(task({sessionStartedAt:now-3600_000}),{now});
  assert.equal(view.taskAgeMs,null);assert.equal(view.sessionAgeMs,3600_000);assert.equal(view.harness,'Unknown');
});
test('terminal clocks freeze at end time or remain unavailable without one',()=>{
  const base=task({status:'done',taskStartedAt:now-600_000,sessionStartedAt:now-900_000,endedAt:now-300_000});
  assert.equal(taskView(base,{now}).taskAgeMs,300_000);assert.equal(taskView(base,{now:now+1e6}).sessionAgeMs,600_000);
  assert.equal(taskView({...base,endedAt:null},{now}).taskAgeMs,null);
  assert.equal(taskView({...base,durationMs:12000},{now}).taskAgeMs,300_000);
  assert.equal(taskView({...base,endedAt:null,durationMs:12000},{now}).taskAgeMs,null);
});
test('observation alone never becomes progress or quiet; explicit old progress is a heuristic',()=>{
  const observed=taskView(task({updatedAt:now-7200_000}),{now});assert.equal(observed.observedAgeMs,7200_000);assert.equal(observed.progressAgeMs,null);assert.equal(observed.quiet,false);
  assert.equal(taskView(task({lastProgressAt:now-1200_000}),{now}).quiet,true);
  assert.equal(taskView(task({telemetry:{progressAt:now-60_000}}),{now}).quiet,false);
  assert.equal(taskView(task({status:'blocked',lastProgressAt:now-1200_000}),{now}).quiet,false);
});
test('Hub readiness remains authoritative through stale observation; standalone readiness does not',()=>{
  assert.equal(taskView(task({pr:pr({authority:'hub',checkedAt:now-1e8})}),{now,stale:true}).prStage,'ready');
  assert.notEqual(taskView(task({pr:pr()}),{now,stale:true}).prStage,'ready');
  assert.notEqual(taskView(task({pr:pr({checkedAt:now-1e8})}),{now}).prStage,'ready');
});
test('shared PR counts deduplicate and equal-time contradictory evidence is unknown',()=>{
  const snapshot={agents:[task({pr:pr()}),task({id:'cottage-2',pr:pr()}),task({id:'old',inventoryScope:'history'})]};
  const fleet=fleetView(snapshot,{now});assert.equal(fleet.counts.tasks,2);assert.equal(fleet.counts.settled,1);assert.equal(fleet.counts.ready,1);assert.equal(fleet.prs[0].taskIds.length,2);
  const conflict=fleetView({agents:[task({pr:pr()}),task({id:'cottage-2',pr:pr({reviewState:'blocked'})})]},{now});assert.equal(conflict.counts.ready,0);assert.equal(conflict.prs[0].stage,'unknown');
});
test('canonical Hub PR observation outranks conflicting standalone labels',()=>{
  const fleet=fleetView({agents:[task({pr:pr({authority:'hub',checkedAt:now-5000})}),task({id:'cottage-2',pr:pr({reviewState:'blocked'})})]},{now});
  assert.equal(fleet.prs[0].stage,'ready');
});
test('graph uses explicit safe issues, parents, PRs and typed relationships only',()=>{
  const fleet=fleetView({agents:[task({id:'parent'}),task({parent:'parent',issues:[{url:'https://example.invalid/fiction/hub/issues/801',title:'Fictional inventory'},{url:'javascript:alert(1)'}],pr:pr(),task:'Mentions #999 and https://example.invalid/no/guess/pull/1'})],relationships:[{from:'task:parent',to:'task:cottage-1',kind:'depends-on'},{from:'task:missing',to:'task:cottage-1',kind:'depends-on'}]},{now});
  assert.equal(fleet.tasks[1].issues.length,1);assert.ok(fleet.edges.some(edge=>edge.from==='task:parent'&&edge.to==='task:cottage-1'&&edge.kind==='parent'));
  assert.ok(fleet.edges.some(edge=>edge.from.startsWith('issue:https:')&&edge.to==='task:cottage-1'));
  assert.ok(fleet.edges.some(edge=>edge.to.startsWith('pr:')));assert.ok(!JSON.stringify(fleet.edges).includes('999'));assert.ok(!JSON.stringify(fleet.edges).includes('missing'));
});
test('activity remains public text; events reject thinking; unknown harness stays unknown',()=>{
  const view=taskView(task({model:'opus',dispatchedBy:'codex',activity:'Reading canonical task state',events:[{id:'1',kind:'progress',text:'Verified one route',timestamp:now},{id:'2',kind:'thinking',text:'Private'}],issues:[{url:'file:///etc/passwd'}]}),{now});
  assert.equal(view.harness,'Unknown');assert.equal(view.activity,'Reading canonical task state');assert.equal(view.events.length,1);assert.equal(view.issues.length,0);
});
test('scenario is marked illustrative and contains all required evidence cases',()=>{
  const snapshot=createScenario(now),fleet=fleetView(snapshot,{now,endpoint});assert.equal(snapshot.illustrative,true);assert.equal(fleet.tasks.length,12);
  assert.equal(fleet.projects.length,5);assert.equal(fleet.tasks.filter(t=>t.input).length,2);assert.equal(fleet.counts.answerable,1);assert.ok(fleet.counts.quiet);assert.ok(fleet.counts.ready);assert.ok(fleet.counts.blockedPr);assert.ok(fleet.prs.some(p=>p.taskIds.length>1));
  assert.ok(fleet.tasks.some(t=>t.status==='done'));assert.ok(fleet.tasks.some(t=>t.prStage==='unknown'));assert.ok(fleet.tasks.every(t=>t.raw.illustrative));
});

test('reply preflight refuses stale feeds and a changed question revision without a POST',async()=>{
  for(const snapshot of [{agents:[question()],stale:true},{agents:[question({inputRequest:{id:'question-1',prompt:'Delete history?'}})]},{agents:[question({taskId:'replacement'})]}]){
    let posts=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,options)=>{if(options?.method==='POST')posts++;return json(snapshot);}});
    const result=await client.send(question(),'Yes');assert.equal(result.phase,'error');assert.equal(posts,0);
  }
});
test('reply sends one matching input version and durably records receipt before transport',async()=>{
  const storage=memory();let posts=0;let client;
  const fetchImpl=async(url,options)=>{
    if(options?.method!=='POST')return json({agents:[question()]});posts++;
    assert.equal(client.state('task-1').phase,'sending');
    const recreated=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal(recreated.state('task-1').phase,'uncertain');
    const payload=JSON.parse(options.body);assert.equal(payload.inputRequestVersion,inputRequestVersion(question().inputRequest));assert.equal(payload.inputRequestId,'question-1');assert.equal(payload.taskId,'task-1');assert.ok(payload.requestId);
    return json({ok:true,delivery:'accepted',requestId:payload.requestId});
  };
  client=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal((await client.send(question(),'Yes')).phase,'sent');assert.equal(posts,1);
  assert.equal((await client.send(question(),'Yes')).phase,'sent');assert.equal(posts,1);
});
test('ambiguous delivery remains locked across client recreation without automatic retry',async()=>{
  const storage=memory();let posts=0;const fetchImpl=async(_,options)=>{if(options?.method==='POST'){posts++;throw new Error('Connection dropped');}return json({agents:[question()]});};
  const first=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal((await first.send(question(),'Yes')).phase,'uncertain');
  const second=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal(second.state('task-1').phase,'uncertain');assert.equal((await second.send(question(),'Yes')).phase,'uncertain');assert.equal(posts,1);
});
test('known not-sent rejection is recoverable but malformed or unconfirmed replies lock',async()=>{
  for(const [reply,status,phase] of [[{ok:false,delivery:'not_sent',error:'Question changed'},409,'error'],[{ok:false,delivery:'unconfirmed'},409,'uncertain'],[{ok:true,delivery:'accepted'},200,'uncertain']]){
    const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,opts)=>opts?.method==='POST'?json(reply,status):json({agents:[question()]})});assert.equal((await client.send(question(),'Yes')).phase,phase);
  }
});
test('storage failure prevents send, and unavailable or changed routes never POST',async()=>{
  let posts=0;const failingStorage={getItem:()=>null,setItem:()=>{throw new Error('Quota');}};
  const client=createReplyClient({endpoint,storage:failingStorage,now:()=>now,fetchImpl:async(_,options)=>{if(options?.method==='POST')posts++;return json({agents:[question()]});}});
  assert.equal((await client.send(question(),'Yes')).phase,'error');assert.equal(posts,0);
  for(const conversation of [{available:false,reason:'Source only'},{available:true,mode:'respond',checkedAt:now,messageUrl:'https://evil.invalid/messages'},{available:true,mode:'redirect',checkedAt:now,messageUrl:'/agents/cottage-1/messages'}]){
    const next=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,opts)=>{if(opts?.method==='POST')posts++;return json({agents:[question({conversation})]});}});assert.equal((await next.send(question(),'Yes')).phase,'error');assert.equal(posts,0);
  }
});
test('two synchronous sends perform only one POST',async()=>{
  let posts=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,opts)=>{if(opts?.method==='POST'){posts++;return json({ok:false,delivery:'unconfirmed'},409);}return json({agents:[question()]});}});
  await Promise.all([client.send(question(),'Yes'),client.send(question(),'Yes')]);assert.equal(posts,1);
});
test('explicit recent occupancy is preserved and malformed optional link collections are ignored',()=>{
  const fleet=fleetView({agents:[task({status:'offline',occupancy:'recent',resultLinks:{kind:'issue'}})]},{now});assert.equal(fleet.tasks.length,1);assert.equal(fleet.tasks[0].issues.length,0);
});
test('a second client reservation that appears during preflight blocks this client POST',async()=>{
  const storage=memory();let posts=0;let second;
  const fetchImpl=async(_,opts)=>{if(opts?.method==='POST'){posts++;throw new Error('Ambiguous stub');}return json({agents:[question()]});};
  second=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});
  const first=createReplyClient({endpoint,storage,now:()=>now,fetchImpl:async(_,opts)=>{if(opts?.method==='POST'){posts++;throw new Error('Must not send twice');}await second.send(question(),'Yes');return json({agents:[question()]});}});
  assert.equal((await first.send(question(),'Yes')).phase,'uncertain');assert.equal(posts,1);
});
test('illustrative replies never enter a live transport',async()=>{
  let requests=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async()=>{requests++;throw new Error('Must stay local');}});
  assert.equal((await client.send(question({illustrative:true}),'Yes')).phase,'error');assert.equal(requests,0);
});
test('terminal or ended tasks cannot send even when a source supplied an available flag',async()=>{
  let requests=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async()=>{requests++;return json({agents:[question({status:'done'})]});}});
  assert.equal((await client.send(question({status:'done'}),'Yes')).phase,'error');assert.equal(requests,0);
});
test('fresh terminal and end flags independently prevent a POST despite unchanged working status',async()=>{
  const shown=task({conversation:{available:true,mode:'redirect',checkedAt:now,messageUrl:'/agents/cottage-1/messages'}});
  for(const changed of [{terminal:true},{endedAt:now}]){
    let posts=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,opts)=>{if(opts?.method==='POST'){posts++;return json({ok:false,delivery:'unconfirmed'},409);}return json({agents:[{...shown,...changed}]});}});
    assert.equal((await client.send(shown,'Please check the fixtures.')).phase,'error');assert.equal(posts,0);
  }
});
test('confirmed free-form redirects permit distinct explicit sends with fresh request IDs across reload',async()=>{
  const shown=task({conversation:{available:true,mode:'redirect',checkedAt:now,messageUrl:'/agents/cottage-1/messages'}}),storage=memory(),payloads=[];
  const fetchImpl=async(_,opts)=>{if(opts?.method!=='POST')return json({agents:[shown]});const payload=JSON.parse(opts.body);payloads.push(payload);return json({ok:true,delivery:'submitted',requestId:payload.requestId});};
  const first=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});
  assert.equal((await first.send(shown,'Check the Node fixtures first.')).phase,'sent');
  assert.equal((await first.send(shown,'Also inspect the browser route.')).phase,'sent');
  const recreated=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});
  assert.equal((await recreated.send(shown,'Include the evidence in your report.')).phase,'sent');
  assert.equal(payloads.length,3);assert.equal(new Set(payloads.map(payload=>payload.requestId)).size,3);assert.deepEqual(payloads.map(payload=>payload.message),['Check the Node fixtures first.','Also inspect the browser route.','Include the evidence in your report.']);
});
test('uncertain free-form redirects still lock distinct amendments across reload',async()=>{
  const shown=task({conversation:{available:true,mode:'redirect',checkedAt:now,messageUrl:'/agents/cottage-1/messages'}}),storage=memory();let posts=0;
  const fetchImpl=async(_,opts)=>{if(opts?.method==='POST'){posts++;throw new Error('Stub connection dropped');}return json({agents:[shown]});};
  const first=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal((await first.send(shown,'Check the fixtures.')).phase,'uncertain');
  const recreated=createReplyClient({endpoint,storage,now:()=>now,fetchImpl});assert.equal((await recreated.send(shown,'Check the browser too.')).phase,'uncertain');assert.equal(posts,1);
});
test('explicit current terminal false overrides a historical end timestamp for responding',async()=>{
  const shown=question({terminal:false,endedAt:now-3600_000,executionStatus:'needs_input',conversationTarget:{taskStatus:'needs_input'}});
  let posts=0;
  const client=createReplyClient({endpoint,storage:memory(),now:()=>now,fetchImpl:async(_,opts)=>{
    if(opts?.method!=='POST')return json({agents:[shown]});
    posts++;const payload=JSON.parse(opts.body);return json({ok:true,delivery:'accepted',requestId:payload.requestId});
  }});
  assert.equal((await client.send(shown,'Keep 30 days.')).phase,'sent');assert.equal(posts,1);
});

test('shared terminal guard honors current flags without reviving terminal statuses',()=>{
  assert.equal(isTerminalForMessage({status:'blocked',terminal:false,endedAt:now-3600_000}),false);
  assert.equal(isTerminalForMessage({status:'working',terminal:true}),true);
  assert.equal(isTerminalForMessage({status:'working',endedAt:now}),true);
  assert.equal(isTerminalForMessage({status:'done',terminal:false}),true);
});

test('task wall age includes review and input waits rather than recorded execution duration',()=>{
  for(const [status,executionStatus] of [['working','running'],['idle','ready_for_merge'],['blocked','needs_input']]){
    const view=taskView(task({status,executionStatus,terminal:false,taskStartedAt:now-7200_000,durationMs:600_000}),{now});
    assert.equal(view.taskAgeMs,7200_000);assert.equal(view.recordedExecutionMs,600_000);
  }
});
test('current nonterminal task age ignores a prior attempt end and requires explicit task start',()=>{
  const current=task({terminal:false,taskStartedAt:now-7200_000,sessionStartedAt:now-10800_000,endedAt:now-3600_000,durationMs:600_000});
  const view=taskView(current,{now});assert.equal(view.taskAgeMs,7200_000);assert.equal(view.sessionAgeMs,10800_000);
  assert.equal(taskView({...current,taskStartedAt:null},{now}).taskAgeMs,null);
  assert.equal(taskView({...current,taskStartedAt:now+60_000},{now}).taskAgeMs,null);
});
