import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubInventoryReader,toInventoryCottage} from '../src/hub-inventory.mjs';
import {createFeed} from '../src/feed.mjs';
import {elapsedMs,normalizeCottage} from '../src/feed-client.mjs';
import {prCi,normalizePr} from '../src/pr.mjs';
const now=Date.parse('2026-09-22T06:00:00Z');
const task=(id,extra={})=>({id,recordKind:'logical_task',task:'Short task',originalRequest:'Full request',status:'running',updatedAt:new Date(now).toISOString(),projectPath:'/projects/autohub',worktreePath:'/projects/autohub/.worktrees/fix',branch:'fix/cursor',source:'codex_app_server',provider:'openai',backend:'codex',sessionId:'session',currentActivity:'Testing pagination',controlTargetId:null,capabilities:{canInspect:true,canRespond:false,canSteer:false},...extra});

function streamingFixture(t){
  const records=new Map([['root',task('root',{version:1})],['other-root',task('other-root',{version:1})]]);
  const dashboard=new Set(['root','other-root']),requests=[];
  let emit,starts=0,stops=0,changes=0,detailHook=null;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,streamCoalesceMs:1,
    streamFactory:options=>{emit=options.onChange;return {start(){starts++;},stop(){stops++;}};},
    fetchFn:async url=>{
      const u=new URL(url),scope=u.searchParams.get('scope');requests.push(u.pathname+u.search);
      if(u.pathname.endsWith('/snapshot'))return {ok:true,json:async()=>({tasks:[],coverage:{complete:true}})};
      if(u.pathname==='/v1/tasks')return {ok:true,json:async()=>({tasks:[...records.values()].filter(row=>!row.archived&&(scope!=='dashboard'||dashboard.has(row.id))).map(row=>structuredClone(row)),has_more:false})};
      const id=decodeURIComponent(u.pathname.slice('/v1/tasks/'.length));
      if(detailHook){const result=await detailHook(id);if(result)return result;}
      const row=records.get(id);
      return row?{ok:true,json:async()=>structuredClone(row)}:{ok:false,status:404};
    }});
  reader.start(()=>{changes++;});t.after(()=>reader.stop());
  return {reader,records,dashboard,requests,emit:hint=>emit(hint),get changes(){return changes;},get starts(){return starts;},get stops(){return stops;},
    setDetailHook(value){detailHook=value;},
    historyReads:()=>requests.filter(value=>value.includes('scope=history')).length,
    child:(id='child',extra={})=>task(id,{recordKind:'external_session',parentId:'root',source:'codex_rollout',sessionId:`session-${id}`,isStale:false,version:1,...extra})};
}

test('shared task hints hydrate new children, parent changes, completions and archives without waiting for history TTL',async t=>{
  const f=streamingFixture(t);await f.reader.read();
  f.records.set('child',f.child());f.emit({type:'task',taskId:'child',parentTaskId:'root'});
  let value=await f.reader.read(),child=value.agents.find(a=>a.id==='child');
  assert.equal(child.status,'working');assert.equal(child.occupancy,'live');assert.equal(child.inventoryScope,'family');assert.equal(child.parent,'root');
  f.records.set('child',f.child('child',{parentId:'other-root',version:2}));
  f.emit({type:'task',taskId:'child'});value=await f.reader.read();
  assert.equal(value.agents.find(a=>a.id==='child').parent,'other-root','same updatedAt does not hide a newer parent version');
  f.records.set('child',f.child('child',{parentId:'other-root',status:'completed',version:3}));
  f.emit({type:'task',taskId:'child'});value=await f.reader.read();
  child=value.agents.find(a=>a.id==='child');assert.equal(child.status,'done');assert.equal(child.inventoryScope,'history');assert.equal(child.occupancy,'settled');
  f.records.set('child',f.child('child',{archived:true,version:4}));f.emit({type:'task',taskId:'child'});
  assert.equal((await f.reader.read()).agents.some(a=>a.id==='child'),false);
  assert.equal(f.historyReads(),1,'targeted changes never repage warm history');
});

test('new explicit ancestry is hydrated while missing, unlinked and deleted parents remain conservative',async t=>{
  const f=streamingFixture(t);await f.reader.read();
  f.records.set('middle',f.child('middle'));
  f.records.set('child',f.child('child',{parentId:'middle'}));f.emit({type:'task',taskId:'child'});
  const value=await f.reader.read();assert.deepEqual(value.agents.filter(a=>a.inventoryScope==='family').map(a=>a.id).sort(),['child','middle']);
  f.records.set('child',f.child('child',{parentId:null,version:2}));f.emit({type:'task',taskId:'child'});
  assert.equal((await f.reader.read()).agents.find(a=>a.id==='child').inventoryScope,'history');
  f.records.set('child',f.child('child',{parentId:'missing',version:3}));f.emit({type:'task',taskId:'child'});
  assert.equal((await f.reader.read()).agents.find(a=>a.id==='child').inventoryScope,'history');
  f.records.delete('child');f.emit({type:'task',taskId:'child'});
  assert.equal((await f.reader.read()).agents.some(a=>a.id==='child'),false);
});

test('a lifecycle notification during hydration reruns before resolving shared readers',async t=>{
  const f=streamingFixture(t);f.records.set('child',f.child());await f.reader.read();
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});let calls=0;
  f.setDetailHook(async id=>{
    if(id!=='child'||++calls!==1)return null;
    const old=structuredClone(f.records.get(id));entered();await gate;return {ok:true,json:async()=>old};
  });
  f.emit({type:'task',taskId:'child'});const reading=f.reader.read();await started;
  f.records.set('child',f.child('child',{status:'completed',version:2}));f.emit({type:'task',taskId:'child'});
  const joined=f.reader.read();release();
  assert.equal((await reading).agents.find(a=>a.id==='child').status,'done');
  assert.equal((await joined).agents.find(a=>a.id==='child').status,'done');assert.equal(calls,2);
  assert.equal(f.historyReads(),1);
});

test('sustained canonical changes publish a coherent pass without waiting for global quiescence',async t=>{
  let emit,changing=false,version=1,dashboardReads=0,wakeups=0,enteredThird,releaseThird;
  const thirdStarted=new Promise(resolve=>{enteredThird=resolve;});
  const thirdGate=new Promise(resolve=>{releaseThird=resolve;});
  const child=()=>task('child',{recordKind:'external_session',parentId:'root',isStale:false,version,
    status:version%2?'running':'completed'});
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,streamCoalesceMs:1,
    streamFactory:options=>{emit=options.onChange;return {start(){},stop(){}};},
    fetchFn:async url=>{
      const u=new URL(url);
      if(u.pathname.endsWith('/snapshot'))return {ok:false};
      if(u.pathname.endsWith('/child')){const row=child();return {ok:true,json:async()=>row};}
      const scope=u.searchParams.get('scope');
      if(scope==='dashboard'&&changing){
        dashboardReads++;
        if(dashboardReads===3){enteredThird();await thirdGate;}
        if(changing){version++;emit({type:'task',taskId:'child'});}
      }
      return {ok:true,json:async()=>({tasks:scope==='history'?[task('root'),child()]:[task('root')],has_more:false})};
    }});
  reader.start(()=>{wakeups++;});t.after(()=>reader.stop());await reader.read();
  changing=true;emit({type:'task',taskId:'child'});
  const reading=reader.read();
  const result=await Promise.race([reading.then(value=>({published:true,value})),thirdStarted.then(()=>({published:false}))]);
  changing=false;releaseThird();await reading;
  assert.equal(result.published,true,'two successful passes must be published while a newer task change remains pending');
  assert.equal(dashboardReads,2);
  const published=result.value.agents.find(a=>a.id==='child');
  assert.equal(published.version,2);assert.equal(published.status,'done');
  assert.equal(version,3,'a newer canonical change still exists at publication');
  const caughtUp=(await reader.read()).agents.find(a=>a.id==='child');
  assert.equal(caughtUp.version,3);assert.equal(caughtUp.status,'working');
  await new Promise(resolve=>setTimeout(resolve,5));assert.ok(wakeups>0,'pending changes retain a subsequent scan wakeup');
});

test('failed targeted hydration retains dirty identities for recovery instead of accepting an old cached row',async t=>{
  const f=streamingFixture(t);await f.reader.read();f.records.set('child',f.child());f.emit({type:'task',taskId:'child'});
  f.setDetailHook(async()=>{throw new Error('private upstream error');});
  await assert.rejects(f.reader.read(),/^Error: Hub inventory temporarily unavailable$/);
  f.setDetailHook(null);
  assert.equal((await f.reader.read()).agents.find(a=>a.id==='child').status,'working');
});

test('telemetry invalidations refresh enrichment without historical paging or lifecycle inference',async t=>{
  const f=streamingFixture(t);f.records.set('child',f.child('child',{status:'completed'}));await f.reader.read();
  const before=f.requests.length;for(let i=0;i<100;i++)f.emit({type:'telemetry',taskId:'child'});
  const next=await f.reader.read();assert.equal(next.agents.find(a=>a.id==='child').status,'done');
  assert.equal(f.historyReads(),1);assert.equal(f.requests.slice(before).some(path=>path==='/v1/tasks/child'),false);
  assert.equal(f.requests.filter(path=>path.includes('/snapshot')).length,2);
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.changes,1,'bursts produce one scan wakeup');
});

test('reconnect or reset invalidates full history and start/stop own a single subscription',async t=>{
  const f=streamingFixture(t);await f.reader.read();f.reader.start(()=>{});assert.equal(f.starts,1);
  f.records.set('quiet-new-child',f.child('quiet-new-child'));f.emit({type:'resync'});
  assert.equal((await f.reader.read()).agents.find(a=>a.id==='quiet-new-child').status,'working');assert.equal(f.historyReads(),2);
  f.records.delete('quiet-new-child');f.emit({type:'resync'});
  assert.equal((await f.reader.read()).agents.some(a=>a.id==='quiet-new-child'),false);assert.equal(f.historyReads(),3);
  f.reader.stop();f.reader.stop();assert.equal(f.stops,1);
});

test('Codex rollout turn boundaries never become task or persistent session starts',()=>{
  const start=now-60000,sessionStart=now-3600000;
  const record=task('turn',{recordKind:'external_session',source:'codex_rollout',startedAt:new Date(start).toISOString()});
  const observed=toInventoryCottage(record,now);
  assert.equal(observed.turnStartedAt,start);assert.equal(observed.taskStartedAt,null);assert.equal(observed.sessionStartedAt,null);
  const knownSession=toInventoryCottage({...record,context:{sessionStartedAt:new Date(sessionStart).toISOString()}},now);
  assert.equal(knownSession.sessionStartedAt,sessionStart);assert.equal(knownSession.turnStartedAt,start);
  const contextSource=toInventoryCottage({...record,source:undefined,context:{source:'codex_rollout',lifecycle:{sessionStartedAt:new Date(sessionStart).toISOString()}}},now);
  assert.equal(contextSource.turnStartedAt,start);assert.equal(contextSource.sessionStartedAt,sessionStart);
  const missing=toInventoryCottage({...record,startedAt:null,queuedAt:new Date(start).toISOString()},now);
  assert.equal(missing.turnStartedAt,null);assert.equal(missing.sessionStartedAt,null,'queue time is not a turn or session boundary');
  const other=toInventoryCottage({...record,source:'codex_app_server'},now);
  assert.equal(other.sessionStartedAt,start);assert.equal(other.turnStartedAt,null,'other adapters retain their existing clock semantics');
});
test('inventory preserves known legacy counters and absent measurements stay unavailable',()=>{
 const absent=toInventoryCottage(task('missing'),now);
 assert.equal(absent.tokens,null);assert.equal(absent.cost,null);
 const zero=toInventoryCottage(task('zero',{inputTokens:0,totalCost:0}),now);
 assert.equal(zero.tokens,0);assert.equal(zero.cost,0);
 const known=toInventoryCottage(task('known',{inputTokens:100,outputTokens:20,cacheReadTokens:50,totalCost:0.12}),now);
 assert.equal(known.tokens,170);assert.equal(known.cost,0.12);
 const observed=toInventoryCottage(task('observed',{recordKind:'external_session',source:'codex_rollout',inputTokens:0,outputTokens:0,totalCost:0}),now);
 assert.equal(observed.tokens,null);assert.equal(observed.cost,null);
 const prior=toInventoryCottage(task('prior',{recordKind:'external_session',source:'codex_rollout',inputTokens:100,totalCost:0.2}),now);
 assert.equal(prior.tokens,100);assert.equal(prior.cost,0.2);
});
test('execution harness uses explicit backend evidence, never provider or model inference',()=>{
  assert.equal(toInventoryCottage(task('codex'),now).harness,'codex');
  assert.equal(toInventoryCottage(task('claude',{backend:'claude-code'}),now).harness,'claude-code');
  assert.equal(toInventoryCottage(task('explicit',{harness:'custom-runner'}),now).harness,'custom-runner');
  assert.equal(toInventoryCottage(task('missing',{backend:null,model:'gpt',provider:'openai'}),now).harness,null);
});
test('canonical model hints preserve known providers without inventing a model family',()=>{
  assert.equal(toInventoryCottage(task('codex'),now).model,'gpt');
  assert.equal(toInventoryCottage(task('backend',{provider:null}),now).model,'gpt');
  assert.equal(toInventoryCottage(task('explicit',{model:'claude-opus-4'}),now).model,'opus');
  assert.equal(toInventoryCottage(task('route',{context:{agentKernel:{route:{model:'claude-haiku-4'}}}}),now).model,'haiku');
  assert.equal(toInventoryCottage(task('anthropic',{provider:'anthropic',backend:'claude-code'}),now).model,'anthropic');
  assert.equal(toInventoryCottage(task('unknown',{provider:null,backend:null}),now).model,'unknown');
});
test('inventory adapter follows all cursor pages and preserves canonical parent/control identities',async()=>{
  const calls=[];
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',token:'secret',now:()=>now,ttl:0,fetchFn:async(url,options)=>{
    if(new URL(url).pathname.endsWith('/snapshot'))return {ok:false};
    calls.push({url:String(url),options});
    return {ok:true,json:async()=>new URL(url).searchParams.get('cursor') ? {tasks:[task('child',{recordKind:'external_session',parentId:'canonical-parent'})],has_more:false,next_cursor:null} : {tasks:[task('canonical-parent')],has_more:true,next_cursor:'page-2'}};
  }});
  const value=await reader.read();
  assert.equal(calls.length,4);
  assert.deepEqual(calls.map(call=>new URL(call.url).searchParams.get('scope')),['history','history','dashboard','dashboard']);
  assert.equal(calls[0].options.headers.authorization,'Bearer secret');
  assert.equal(new URL(calls[0].url).pathname,'/v1/tasks');
  assert.deepEqual(value.agents.map(a=>a.id),['canonical-parent','child']);
  assert.equal(value.agents[1].parent,'canonical-parent');
  assert.equal(value.agents[1].conversationTarget.controlTargetId,null);
  assert.equal(value.agents[0].originalAsk,'Full request');
  assert.equal(value.agents[0].activity,'Testing pagination');
  assert.equal(value.agents[0].branch,'fix/cursor');
  assert.equal(JSON.stringify(value.agents).includes('secret'),false);
});

test('dashboard membership survives history PRs, old clocks, child records, and detail refresh',async()=>{
  const old=new Date(now-10*86400e3).toISOString();
  const link={kind:'pull_request',url:'https://github.com/acme/repo/pull/1'};
  const history=[task('recent',{status:'completed',completedAt:old,updatedAt:old}),
    task('old-pr',{status:'completed',updatedAt:old,resultLinks:[link]}),
    task('child',{recordKind:'external_session',parentId:'recent'}),
    task('waiting',{status:'awaiting_review',updatedAt:old})];
  let fail=false;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,ttl:0,fetchFn:async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/recent'))return {ok:true,json:async()=>history[0]};
    const dashboard=u.searchParams.get('scope')==='dashboard';
    if(dashboard && fail)throw new Error('private connection failure');
    return {ok:true,json:async()=>({tasks:dashboard?[history[0],history[3]]:history,has_more:false})};
  }});
  const feed=createFeed({hubInventory:reader,resolveRepos:async a=>a,enrich:async a=>a,now:()=>now});
  await feed.scan();
  const snapshot=feed.snapshot();
  assert.equal(snapshot.live,2);assert.equal(snapshot.settled,2);
  assert.deepEqual(snapshot.agents.filter(a=>a.occupancy!=='settled').map(a=>a.id).sort(),['recent','waiting']);
  assert.equal(snapshot.agents.find(a=>a.id==='child').parent,'recent');
  assert.equal(snapshot.agents.find(a=>a.id==='old-pr').pr.url,link.url);
  const detail=await reader.detail('recent');
  assert.equal(detail.inventoryScope,'dashboard');assert.equal(detail.occupancy,'recent');
  fail=true;await feed.scan();
  assert.equal(feed.snapshot().stale,true);
  assert.deepEqual(feed.snapshot().agents,snapshot.agents,'dashboard failure cannot publish a history-only snapshot');
});

test('canonical tasks can settle or disappear without old PRs resurrecting them',async()=>{
  let phase=0;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>now,ttl:0,historyTtl:0,fetchFn:async url=>{
    const dashboard=new URL(url).searchParams.get('scope')==='dashboard';
    return {ok:true,json:async()=>({tasks:phase===2 || dashboard && phase===1 ? [] : [task('retiring',{resultLinks:[{kind:'pull_request',url:'https://github.com/acme/repo/pull/1'}]})],has_more:false})};
  }});
  const feed=createFeed({hubInventory:reader,resolveRepos:async a=>a,enrich:async a=>a,now:()=>now});
  await feed.scan();assert.equal(feed.snapshot().live,1);
  phase=1;await feed.scan();assert.equal(feed.snapshot().live,0);assert.equal(feed.snapshot().settled,1);
  phase=2;await feed.scan();assert.equal(feed.snapshot().agents.length,0);
});

test('fresh active external children join their dashboard family without promoting unrelated history',async()=>{
  let clock=now,rootVisible=true,childDone=false;
  const child=(id,parentId,extra={})=>task(id,{recordKind:'external_session',parentId,isStale:false,...extra});
  const root=task('root'),cyclicRoot=task('cyclic-root',{parentId:'cyclic-child'});
  const rows=[root,child('child','root'),child('grandchild','child'),
    child('stale','root',{isStale:true}),child('unknown','root',{isStale:undefined}),
    child('done','root',{status:'completed'}),child('orphan','missing'),
    child('cycle-a','cycle-b'),child('cycle-b','cycle-a'),cyclicRoot,child('cyclic-child','cyclic-root'),
    task('logical',{parentId:'root',isStale:false})];
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>clock,ttl:0,fetchFn:async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/snapshot'))return {ok:false};
    if(u.pathname.endsWith('/child'))return {ok:true,json:async()=>child('child','root',{status:childDone?'completed':'running'})};
    return {ok:true,json:async()=>({tasks:u.searchParams.get('scope')==='dashboard'?(rootVisible?[root,cyclicRoot]:[]):rows,has_more:false})};
  }});
  const first=await reader.read();
  assert.deepEqual(first.agents.filter(a=>a.inventoryScope==='family').map(a=>a.id).sort(),['child','grandchild']);
  assert.equal(first.agents.find(a=>a.id==='child').occupancy,'live');
  assert.equal(first.agents.find(a=>a.id==='child').executionStatus,'running');
  assert.equal((await reader.detail('child')).inventoryScope,'family');
  childDone=true;
  assert.equal((await reader.detail('child')).inventoryScope,'history','terminal detail cannot inherit active family membership');
  rootVisible=false;clock+=5000;
  const next=await reader.read();
  assert.equal(next.agents.some(a=>a.inventoryScope==='family'),false,'cached history must not retain prior family promotion');
  assert.equal(next.agents.find(a=>a.id==='child').occupancy,'settled');
});

test('dashboard keeps refreshing while expensive historical pages are cached',async()=>{
  let clock=now;const scopes=[];
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>clock,ttl:0,fetchFn:async url=>{
    const u=new URL(url);if(u.pathname.endsWith('/snapshot'))return {ok:false};
    const scope=u.searchParams.get('scope');scopes.push(scope);
    assert.equal(u.searchParams.get('limit'),'500');
    return {ok:true,json:async()=>({tasks:[task(scope==='history'?'old':'current')],has_more:false})};
  }});
  await reader.read();clock+=5000;await reader.read();
  assert.deepEqual(scopes,['history','dashboard','dashboard']);
  clock+=60000;await reader.read();
  assert.deepEqual(scopes,['history','dashboard','dashboard','history','dashboard']);
});
test('a cached history pass crossing its TTL never renews the history pagination clock',async()=>{
  let clock=now,advanceDashboard=false,historyReads=0;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>clock,ttl:0,fetchFn:async url=>{
    const u=new URL(url);if(u.pathname.endsWith('/snapshot'))return {ok:false};
    const scope=u.searchParams.get('scope');
    if(scope==='history')historyReads++;
    if(scope==='dashboard'&&advanceDashboard)clock+=2;
    return {ok:true,json:async()=>({tasks:[task('root')],has_more:false})};
  }});
  await reader.read();assert.equal(historyReads,1);
  clock=now+59999;advanceDashboard=true;
  await reader.read();assert.equal(historyReads,1,'the pass began with valid cached history');
  clock=now+60002;await reader.read();
  assert.equal(historyReads,2,'crossing the TTL during dashboard hydration cannot extend old history');
});
test('configured hub mode never calls standalone scanner or SQLite reader',async()=>{
  let scans=0,reads=0;
  const inventory={configured:true,read:async()=>({ok:true,agents:[toInventoryCottage(task('canonical'),now)],keys:new Set(),links:new Map()})};
  const feed=createFeed({hubInventory:inventory,scanClaude:async()=>{scans++;throw new Error('scanner forbidden');},readHub:()=>{reads++;throw new Error('DB forbidden');},resolveRepos:async a=>a,enrich:async a=>a,now:()=>now});
  await feed.scan();assert.equal(scans,0);assert.equal(reads,0);assert.equal(feed.snapshot().agents[0].id,'canonical');assert.equal(feed.snapshot().source,'hub');
});

test('Hub inventory never consumes local repository or GitHub polling',async()=>{
  const agents=[{...toInventoryCottage(task('current'),now),inventoryScope:'dashboard'},
    {...toInventoryCottage(task('old',{resultLinks:[{kind:'pull_request',url:'https://github.com/acme/repo/pull/1'}]}),now),inventoryScope:'history'}];
  const calls=[];
  const feed=createFeed({hubInventory:{configured:true,read:async()=>({ok:true,agents})},
    resolveRepos:async a=>{calls.push(['repos',a.map(agent=>agent.id)]);return a;},
    enrich:async a=>{calls.push(['github',a.map(agent=>agent.id)]);return a;},now:()=>now});
  await feed.scan();
  assert.deepEqual(calls,[]);
  assert.equal(feed.snapshot().agents.length,2);
  assert.equal(feed.snapshot().agents.find(a=>a.id==='old').pr.url,'https://github.com/acme/repo/pull/1');
});
test('failed continuation retains the previous complete feed without exposing token/errors',async()=>{
  let fail=false;
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',token:'private-token',ttl:0,fetchFn:async()=>{
    if(fail)throw new Error('private-token connection failed');
    return {ok:true,json:async()=>({tasks:[task('stable')],has_more:false})};
  }});
  await reader.read();fail=true;
  await assert.rejects(reader.read(),/Hub inventory temporarily unavailable/);
});

test('Hub mode retains last complete snapshot during failure and reads canonical detail/timeline',async()=>{
  let failed=false;const details=[],timelines=[];
  const inventory={configured:true,read:async()=>{if(failed)throw new Error('private failure');return {ok:true,agents:[toInventoryCottage(task('canonical'),now)],keys:new Set(),links:new Map()};},detail:async id=>{details.push(id);return toInventoryCottage(task(id,{currentActivity:'Updated activity'}),now);}};
  const feed=createFeed({hubInventory:inventory,resolveRepos:async a=>a,enrich:async a=>a,now:()=>now,timeline:{configured:true,read:async id=>{timelines.push(id);return {events:[],source:'hub:claude-transcript'};}}});
  await feed.scan();await feed.getActivity('canonical');
  assert.deepEqual(details,['canonical']);assert.deepEqual(timelines,['canonical']);
  failed=true;await feed.scan();
  assert.equal(feed.snapshot().stale,true);
  assert.equal(feed.snapshot().agents[0].id,'canonical');
  assert.equal(JSON.stringify(feed.snapshot()).includes('private failure'),false);
});

test('canonical result links populate the existing artifact shelves contract',()=>{
  const cottage=toInventoryCottage(task('outputs',{resultLinks:[
    {kind:'result',url:'https://example.com/report',label:'Verification report'},
    {kind:'result',url:'https://example.com/build'},
    {kind:'pull_request',url:'https://github.com/acme/repo/pull/1'},
    {kind:'result',url:'javascript:alert(1)'},
  ]}),now);
  assert.deepEqual(cottage.artifacts,[
    {url:'https://example.com/report',title:'Verification report'},
    {url:'https://example.com/build',title:'Result'},
    {url:'https://github.com/acme/repo/pull/1',title:'Pull request'},
  ]);
});

test('activity detail refresh preserves the enriched feed and returns the current question',async()=>{
  const raw=toInventoryCottage(task('canonical'),now);
  const question={id:'new-question',kind:'question',prompt:'Choose scope',detail:'',questions:[]};
  const inventory={configured:true,read:async()=>({ok:true,agents:[raw],keys:new Set(),links:new Map()}),detail:async()=>({...raw,activity:'Waiting for input',inputRequest:question,repo:'',pr:{state:'unknown'}})};
  const feed=createFeed({hubInventory:inventory,resolveRepos:async agents=>agents.map(agent=>({...agent,repo:'acme/repo'})),enrich:async agents=>agents.map(agent=>({...agent,pr:{state:'ready',url:'https://github.com/acme/repo/pull/1',checkedAt:now}})),timeline:{configured:true,read:async()=>({events:[],source:'hub:claude-transcript'})},now:()=>now});
  await feed.scan();
  const before=structuredClone(feed.snapshot());
  const activity=await feed.getActivity('canonical');
  assert.deepEqual(feed.snapshot(),before,'activity polling does not replace enriched inventory state');
  assert.equal(activity.inputRequest.id,'new-question');
});

test('detail failure keeps cached journal pages and marks the input evidence stale',async()=>{
  const {pageActivity}=await import('../src/activity.mjs');
  const {applyActivityPage}=await import('../src/observatory.mjs');
  let failed=false,reads=0;
  const raw={...toInventoryCottage(task('canonical'),now),inputRequest:{id:'q',kind:'question',prompt:'Proceed?',questions:[]}};
  const events=[{id:'event-1',kind:'progress',text:'Retained progress',timestamp:now}];
  const inventory={configured:true,read:async()=>({ok:true,agents:[raw],keys:new Set(),links:new Map()}),detail:async()=>{if(failed)throw new Error('detail unavailable');return raw;}};
  const feed=createFeed({hubInventory:inventory,resolveRepos:async a=>a,enrich:async a=>a,timeline:{configured:true,read:async(id,options)=>{reads++;return pageActivity(events,options);}},now:()=>now});
  await feed.scan();
  const cache={events:[],cursor:null};applyActivityPage(cache,await feed.getActivity('canonical'));
  failed=true;
  const next=await feed.getActivity('canonical',{after:'event-1'});
  assert.equal(next.stale,true);assert.equal(next.inputRequest.stale,true);
  assert.equal(next.cursor,'event-1');assert.notEqual(next.cursorReset,true);
  applyActivityPage(cache,next);
  assert.deepEqual(cache.events,events);assert.equal(reads,2);
});

test('canonical freshness keeps healthy running tasks live despite an older task update',()=>{
  const old=new Date(now-3600e3).toISOString();
  for(const fields of [{freshness:{lastSeenAt:new Date(now).toISOString(),isStale:false}},{isStale:false}]){
    const fresh=toInventoryCottage(task('healthy',{updatedAt:old,...fields}),now);
    assert.equal(fresh.status,'working');assert.equal(fresh.occupancy,'live');
    assert.equal(fresh.updatedAt,Date.parse(old),'retain the actual task update timestamp');
  }
  const stale=toInventoryCottage(task('stale',{freshness:{isStale:true}}),now);
  assert.equal(stale.status,'offline');
  const unknown=toInventoryCottage(task('unknown',{updatedAt:old}),now);
  assert.equal(unknown.status,'offline','legacy heuristic remains when canonical freshness is absent');
  const question=toInventoryCottage(task('question',{updatedAt:old,freshness:{isStale:false},attentionType:'question',attentionMessage:'Proceed?'}),now);
  assert.equal(question.status,'blocked','freshness never hides a pending question');
});

test('canonical requests honor the public original request limit and truncation flag',()=>{
  const text='x'.repeat(32769);
  const truncated=toInventoryCottage(task('large',{originalRequest:text}),now);
  assert.equal(truncated.originalAsk.length,32768);
  assert.equal(truncated.originalAsk,text.slice(0,32768));
  assert.equal(truncated.originalAskTruncated,true);
  const exact=toInventoryCottage(task('exact',{originalRequest:text.slice(1)}),now);
  assert.equal(exact.originalAskTruncated,false);
  const absent=toInventoryCottage(task('missing',{originalRequest:null,task:text}),now);
  assert.equal(absent.originalAsk,'');assert.equal(absent.originalAskTruncated,false);
});

test('canonical result links reject credentials and malformed URLs before public projection',()=>{
  const cottage=toInventoryCottage(task('links',{resultLinks:[
    {kind:'result',url:'https://user:secret@example.com/report'},
    {kind:'pull_request',url:'https://secret@github.com/acme/repo/pull/1'},
    {kind:'result',url:'https://'},
    {kind:'result',url:'javascript:alert(1)'},
    {kind:'result',url:'https://example.com/report',label:'Report'},
  ]}),now);
  assert.deepEqual(cottage.resultLinks,[{kind:'result',url:'https://example.com/report'}]);
  assert.deepEqual(cottage.artifacts,[{url:'https://example.com/report',title:'Report'}]);
  assert.doesNotMatch(JSON.stringify(cottage),/secret/);
});


test('canonical lifecycle supersedes old development receipts and keeps delivery states stopped',()=>{
  const url='https://github.com/verygoodplugins/autohub/pull/1757';
  const row=task('1757',{status:'completed',displayResult:'Merged #1757',resultSummary:'Did not open a PR',
    pr:{number:1757,url,state:'merged',headSha:'abc',checks:{status:'passing',total:1,entries:[{name:'CI',status:'SUCCESS',conclusion:'SUCCESS'}]},labels:['babysit:ready'],source:'github',checkedAt:new Date(now).toISOString()},
    finalization:{status:'merged'},cleanup:{status:'deferred',reason:'Live process'},version:4,
    context:{pr:{state:'open',url},finalization:{status:'blocked'}}});
  const cottage=toInventoryCottage(row,now);
  assert.equal(cottage.pr.state,'merged');assert.equal(cottage.result,'Merged #1757');
  assert.equal(prCi(cottage.pr).state,'passing');assert.equal(prCi(cottage.pr).total,1);
  assert.equal(cottage.finalization.status,'merged');assert.equal(cottage.cleanup.reason,'Live process');
  assert.equal(cottage.executionStatus,'completed');assert.equal(cottage.version,4);
  assert.equal(toInventoryCottage({...row,status:'ready_for_merge'},now).status,'idle');
  assert.equal(toInventoryCottage({...row,status:'blocked'},now).status,'blocked');
  assert.equal(toInventoryCottage({...row,status:'failed'},now).status,'offline');
});


test('Hub delivery authority wins over raw labels and preserves stale verified readiness',()=>{
 const pr={number:1757,url:'https://github.com/verygoodplugins/autohub/pull/1757',state:'open',headSha:'new',labels:['babysit:ready'],source:'github',checkedAt:new Date(now).toISOString()};
 const blocked=toInventoryCottage(task('head-changed',{status:'blocked',pr,finalization:{status:'blocked',blocker:'Head changed; review required'}}),now);
 assert.equal(blocked.pr.stage,'blocked');assert.equal(blocked.pr.reviewState,'blocked');
 assert.deepEqual(blocked.pr.labels,['babysit:ready'],'raw evidence remains visible');
 assert.equal(blocked.pr.reason,'Head changed; review required');
 const stale=toInventoryCottage(task('ready',{status:'ready_for_merge',pr:{...pr,stale:true,checkedAt:new Date(now-3600000).toISOString()},finalization:{status:'ready'}}),now);
 assert.equal(stale.pr.stage,'ready');assert.equal(stale.pr.stale,true);
 assert.equal(stale.status,'idle');
 const renormalized=normalizePr(stale.pr,now);
 assert.equal(renormalized.stage,'ready','browser normalization preserves Hub authority');
});

test('merged Hub tasks preserve execution duration through browser normalization',()=>{
 const cottage=toInventoryCottage(task('merged',{status:'completed',startedAt:new Date(now-169*60000).toISOString(),completedAt:new Date(now).toISOString(),durationMs:63*60000}),now);
 const browser=normalizeCottage(cottage,0,{town:x=>x,model:x=>x,occupancy:()=> 'recent',now});
 assert.equal(elapsedMs(browser),63*60000);
});

test('canonical Hub freshness remains authoritative after local PR cache TTL',()=>{
 const pr={number:1757,url:'https://github.com/verygoodplugins/autohub/pull/1757',state:'merged',stale:false,source:'github',checkedAt:new Date(now-86400000).toISOString()};
 const cottage=toInventoryCottage(task('merged',{status:'completed',pr}),now);
 assert.equal(cottage.pr.stale,false);
 assert.equal(normalizePr(cottage.pr,now+86400000).stale,false,'browser must not invent a stale merged observation');
 assert.equal(normalizePr({...cottage.pr,stale:true},now).stale,true,'Hub outage evidence remains visible');
 assert.equal(normalizePr(pr,now).stale,true,'standalone observations retain their TTL');
});
