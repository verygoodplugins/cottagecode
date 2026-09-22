import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubInventoryReader,toInventoryCottage} from '../src/hub-inventory.mjs';
import {createFeed} from '../src/feed.mjs';
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
  assert.equal(calls.length,2);
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
test('configured hub mode never calls standalone scanner or SQLite reader',async()=>{
  let scans=0,reads=0;
  const inventory={configured:true,read:async()=>({ok:true,agents:[toInventoryCottage(task('canonical'),now)],keys:new Set(),links:new Map()})};
  const feed=createFeed({hubInventory:inventory,scanClaude:async()=>{scans++;throw new Error('scanner forbidden');},readHub:()=>{reads++;throw new Error('DB forbidden');},resolveRepos:async a=>a,enrich:async a=>a,now:()=>now});
  await feed.scan();assert.equal(scans,0);assert.equal(reads,0);assert.equal(feed.snapshot().agents[0].id,'canonical');assert.equal(feed.snapshot().source,'hub');
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
