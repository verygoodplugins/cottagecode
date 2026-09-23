import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubInventoryReader,toInventoryCottage} from '../src/hub-inventory.mjs';
import {createFeed} from '../src/feed.mjs';
import {elapsedMs,normalizeCottage} from '../src/feed-client.mjs';
import {prCi,normalizePr} from '../src/pr.mjs';
const now=Date.parse('2026-09-22T06:00:00Z');
const task=(id,extra={})=>({id,recordKind:'logical_task',task:'Short task',originalRequest:'Full request',status:'running',updatedAt:new Date(now).toISOString(),projectPath:'/projects/autohub',worktreePath:'/projects/autohub/.worktrees/fix',branch:'fix/cursor',source:'codex_app_server',provider:'openai',backend:'codex',sessionId:'session',currentActivity:'Testing pagination',controlTargetId:null,capabilities:{canInspect:true,canRespond:false,canSteer:false},...extra});
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

test('dashboard keeps refreshing while expensive historical pages are cached',async()=>{
  let clock=now;const scopes=[];
  const reader=createHubInventoryReader({baseUrl:'http://hub.test',now:()=>clock,ttl:0,fetchFn:async url=>{
    const u=new URL(url),scope=u.searchParams.get('scope');scopes.push(scope);
    assert.equal(u.searchParams.get('limit'),'500');
    return {ok:true,json:async()=>({tasks:[task(scope==='history'?'old':'current')],has_more:false})};
  }});
  await reader.read();clock+=5000;await reader.read();
  assert.deepEqual(scopes,['history','dashboard','dashboard']);
  clock+=60000;await reader.read();
  assert.deepEqual(scopes,['history','dashboard','dashboard','history','dashboard']);
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
