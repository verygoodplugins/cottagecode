import test from 'node:test';
import assert from 'node:assert/strict';
import {activityJournalPresentation,activityCacheFor,applyActivityPage,button,handoffAction,appendInlineHandoffs} from '../src/observatory.mjs';

test('history jump actions escape untrusted cottage identifiers in button markup',()=>{
  const html=button('jump:agent" onfocus="alert(1)','Open cottage');
  assert.match(html,/data-action="jump:agent&quot; onfocus=&quot;alert\(1\)"/);
  assert.doesNotMatch(html,/data-action="jump:agent" onfocus=/);
});

test('inline activity routes only complete handoffs to the append path',()=>{
  const appended=[];
  appendInlineHandoffs([
    {id:'progress',kind:'progress',text:'Building'},
    {id:'handoff',kind:'handoff',from:'HubTown',to:'AppTown',text:'Interface contract ready'},
    {id:'partial',kind:'handoff',from:'HubTown',text:'Missing destination'},
  ],event=>appended.push(event));
  assert.deepEqual(appended,[{id:'handoff',kind:'handoff',from:'HubTown',to:'AppTown',text:'Interface contract ready'}]);
});

test('handoff action only exposes an HTTPS handoff target',()=>{
  assert.match(handoffAction('https://github.com/owner/repo/pull/9'),/data-action="handoff"/);
  assert.equal(handoffAction('http://localhost:8787/handoff'),'');
  assert.equal(handoffAction('javascript:alert(1)'), '');
});


test('unavailable activity is retained and presented apart from an empty live journal',()=>{
  const cache={events:[],source:'none',cursor:null,hasMore:false,stale:false,error:'',unavailable:false};
  applyActivityPage(cache,{events:[],source:'hub timeline',unavailable:true});
  assert.equal(cache.unavailable,true);
  assert.deepEqual(activityJournalPresentation(cache),{
    state:'unavailable',text:'hub timeline · activity unavailable from this source',
  });

  applyActivityPage(cache,{events:[],source:'hub timeline',unavailable:false});
  assert.equal(cache.unavailable,false);
  assert.deepEqual(activityJournalPresentation(cache),{state:'live',text:'hub timeline · live activity'});
});

test('activity cache clears task artifacts when a session-only cottage advances to a new session',()=>{
  const first={taskId:null,sessionId:'session-one',activityUrl:'/agents/cottage/activity'};
  const cache=activityCacheFor(null,first);
  cache.events=[{id:'old',text:'Earlier task'}];
  cache.todos={items:[{id:'old-todo',text:'Earlier task checklist',status:'pending'}]};
  cache.cursor='old';

  assert.equal(activityCacheFor(cache,{...first,task:'Updated same task'}),cache,'a same-session refresh keeps journal state and scroll anchors');

  const next=activityCacheFor(cache,{...first,sessionId:'session-two'});
  assert.notEqual(next,cache);
  assert.deepEqual(next.events,[]);
  assert.equal(next.todos,undefined,'an omitted new-session todo snapshot cannot reuse the prior task checklist');
  assert.equal(next.cursor,null);
});
