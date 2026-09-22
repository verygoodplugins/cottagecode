import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubInventoryReader,toInventoryCottage} from '../src/hub-inventory.mjs';
import {createFeed} from '../src/feed.mjs';
const now=Date.parse('2026-09-22T06:00:00Z');
const task=(id,extra={})=>({id,recordKind:'logical_task',task:'Short task',originalRequest:'Full request',status:'running',updatedAt:new Date(now).toISOString(),projectPath:'/projects/autohub',worktreePath:'/projects/autohub/.worktrees/fix',branch:'fix/cursor',source:'codex_app_server',provider:'openai',backend:'codex',sessionId:'session',currentActivity:'Testing pagination',controlTargetId:null,capabilities:{canInspect:true,canRespond:false,canSteer:false},...extra});
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
