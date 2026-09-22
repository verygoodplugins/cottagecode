import test from 'node:test';
import assert from 'node:assert/strict';
import {activityJournalPresentation,activityCacheFor,applyActivityPage,returnToLatestActivity,activityPagingButtons,isPracticeDemo,button,handoffAction,appendInlineHandoffs,isApprenticeArrivalActive,apprenticeArrivalPosition,apprenticeResidentPosition,apprenticeResidentTarget,prSnapshotHtml} from '../src/observatory.mjs';

const pending = { id: 'practice-question', prompt: 'Which scope should I use?' };

test('practice replies require the built-in demo state, not a feed source label', () => {
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, true), true);
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, false), false);
  assert.equal(isPracticeDemo({ source: 'hub', inputRequest: pending }, true), false);
  assert.equal(isPracticeDemo({ source: 'demo' }, true), false);
});

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

test('PR snapshot shows GitHub labels, CI state, freshness, and the GitHub link',()=>{
  const html=prSnapshotHtml({number:42,url:'https://github.com/example/cottage/pull/42',title:'Refresh the sidebar',state:'open',source:'github',checkedAt:Date.parse('2026-09-14T12:00:00Z'),headSha:'abcdef123456',labels:['feature','babysit:waiting-ci'],statusCheckRollup:[{name:'smoke',status:'COMPLETED',conclusion:'SUCCESS',detailsUrl:'https://github.com/example/cottage/actions/runs/42'}]});
  assert.match(html,/View on GitHub/);
  assert.match(html,/feature/);
  assert.match(html,/babysit:waiting-ci/);
  assert.match(html,/Passing · 1 check/);
  assert.match(html,/github/);
  assert.match(html,/abcdef123456/);
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

test('an apprentice arrival stays active only during its visible walk',()=>{
  const arrivals=[{id:'pip',start:100},{id:'moss',start:90}];
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',100),true);
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',107.99),true);
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',108),false);
  assert.equal(isApprenticeArrivalActive(arrivals,'moss',100),false);
  assert.equal(isApprenticeArrivalActive(arrivals,'unknown',101),false);
});


test('an arriving apprentice uses its visible walking position and never a stale family hitbox',()=>{
  const arrivals=[{id:'pip',parent:'bolt',start:100}];
  const plots=[{x:100,y:200,agent:{id:'bolt'},kids:[{x:160,y:220,agent:{id:'pip'}}]}];
  const familyPosition={id:'pip',x:168,y:240};
  assert.deepEqual(apprenticeArrivalPosition(arrivals,'pip',plots,103),{id:'pip',x:147.5,y:256});
  assert.deepEqual(apprenticeResidentPosition(arrivals,'pip',plots,103,familyPosition),{id:'pip',x:147.5,y:256},'talk and click follow the visible walk');
  assert.deepEqual(apprenticeResidentPosition(arrivals,'pip',plots,108,familyPosition),familyPosition,'family interaction resumes after the arrival');
  assert.equal(apprenticeResidentPosition(arrivals,'pip',[],103,familyPosition),null,'an active arrival with no visible position cannot expose a stale hitbox');
});

test('a visible arriving apprentice remains a talk target after its bedtime frame tucks them in',()=>{
  const arrival={id:'pip',x:147.5,y:256};
  const tucked={id:'pip',x:168,y:240,hidden:true};
  assert.deepEqual(apprenticeResidentTarget(tucked,arrival,true),arrival,'the arrival walk owns the interaction target');
  assert.equal(apprenticeResidentTarget(tucked,null,true),null,'an active but unpaintable arrival never exposes the stale tucked position');
  assert.equal(apprenticeResidentTarget(tucked,null,false),null,'a settled child remains indoors after arrival');
  assert.deepEqual(apprenticeResidentTarget({...tucked,hidden:false},null,false),{id:'pip',x:168,y:240});
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

test('older journal pages remain visible within the bounded browser window',()=>{
  const records=Array.from({length:2000},(_,index)=>({id:'history-'+(index+1),kind:'progress',text:'Event '+(index+1),timestamp:Date.parse('2026-09-22T00:00:00Z')+index}));
  const cache={events:records.slice(-1500),cursor:'history-2000',hasMore:true};
  applyActivityPage(cache,{events:records.slice(0,500),hasMore:false,source:'hub'}, {older:true});
  assert.equal(cache.events.length,1500);
  assert.equal(cache.events[0].id,'history-1');assert.equal(cache.events.at(-1).id,'history-1500');
  assert.equal(cache.cursor,'history-2000','live polling keeps its own cursor');
});

test('historical browsing keeps a recent window and returns to live entries without gaps',()=>{
  const records=Array.from({length:2500},(_,index)=>({id:'history-'+(index+1),kind:'progress',text:'Event '+(index+1),timestamp:Date.parse('2026-09-22T00:00:00Z')+index}));
  const cache={events:records.slice(-1500),cursor:'history-2500',hasMore:true};
  applyActivityPage(cache,{events:records.slice(500,1000),hasMore:true,source:'hub'},{older:true});
  applyActivityPage(cache,{events:records.slice(0,500),hasMore:false,source:'hub'},{older:true});
  const historical=cache.events.map(event=>event.id);
  const live={id:'history-2501',kind:'progress',text:'New live event',timestamp:records.at(-1).timestamp+1};
  applyActivityPage(cache,{events:[live],cursor:live.id,hasMore:false,source:'hub'});
  assert.deepEqual(cache.events.map(event=>event.id),historical,'forward polling does not move the historical window');
  returnToLatestActivity(cache);
  assert.equal(cache.events.length,1500);
  assert.deepEqual(cache.events.map(event=>event.id),[...records.slice(-1499),live].map(event=>event.id));
  assert.equal(cache.cursor,live.id);
  assert.equal(cache.hasMore,true,'the recent window can page into history again');
  assert.equal(cache.browsingHistory,false);
});

test('latest journal action survives a live source cursor reset while browsing history',()=>{
  const row=id=>({id,kind:'progress',text:id,timestamp:Date.parse('2026-09-22T00:00:00Z')});
  const cache={events:[row('recent')],cursor:'recent',hasMore:true};
  assert.doesNotMatch(activityPagingButtons(cache),/data-action="latest"/);
  applyActivityPage(cache,{events:[row('old')],hasMore:false},{older:true});
  assert.match(activityPagingButtons(cache),/data-action="latest"\s*>Latest entries/);
  applyActivityPage(cache,{events:[row('new-source')],cursor:'new-source',hasMore:true,cursorReset:true});
  assert.equal(cache.events[0].id,'old');
  returnToLatestActivity(cache);
  assert.deepEqual(cache.events.map(event=>event.id),['new-source']);
  assert.equal(cache.cursor,'new-source');assert.equal(cache.hasMore,true);
  assert.doesNotMatch(activityPagingButtons(cache),/data-action="latest"/);
});
