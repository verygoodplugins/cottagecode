import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistory,replayFrame} from '../src/history.mjs';
test('history records observed transitions once and preserves prior-visit baseline',()=>{
  const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
  let time=100;const history=createHistory({storage,key:'feed',now:()=>time});
  const a={id:'a',name:'Bolt',status:'working',pr:{state:'none'},taskId:'run1'};
  history.observe([a]);assert.equal(history.events()[0].kind,'observed');
  time=200;history.observe([{...a,status:'done'}]);history.observe([{...a,status:'done'}]);
  assert.equal(history.events().filter(e=>e.kind==='status').length,1);
  time=300;const next=createHistory({storage,key:'feed',now:()=>time});
  assert.equal(next.baseline,200);
  assert.equal(replayFrame(history.events(),1).states.get('a').status,'done');
});
test('artifact URLs are safe and history works without storage',()=>{
  const h=createHistory();
  h.record({id:'a',timestamp:1,url:'javascript:alert(1)'});
  assert.equal(h.events()[0].url,'');
  assert.equal(h.record({id:'a',timestamp:1}),false);
});

test('late source events use their local observation time in the scrapbook',()=>{
  let time=1_000;const h=createHistory({now:()=>time});
  time=2_000;
  assert.equal(h.recordObservation({id:'late-handoff',timestamp:100,kind:'handoff',text:'Arrived late'}),true);
  const event=h.events()[0];
  assert.equal(event.timestamp,2_000);
  assert.equal(event.sourceTimestamp,100);
  assert.deepEqual(h.sinceVisit().map(e=>e.id),['late-handoff']);
});

const start=Date.parse('2026-09-14T12:00:00Z');
const pr={number:7,url:'https://github.com/example/repo/pull/7',state:'open',source:'github',
  headSha:'head-a',checkedAt:start,labels:['babysit:active']};
const parent={id:'parent',name:'Bolt',town:'HubTown',taskId:'parent-task',status:'working',pr};
const child={...parent,id:'child',name:'Bolt-1',parent:'parent',taskId:'child-task'};
function storageFixture(){
  const store=new Map();
  return {store,storage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};
}

test('one shared PR emits one transition and replay updates its parent and children',()=>{
  let time=start;const h=createHistory({now:()=>time});
  h.observe([child,parent]);time+=1000;
  const ready={...pr,labels:['babysit:ready'],checkedAt:time};
  const changes=h.observe([{...child,pr:ready},{...parent,pr:ready}]);
  const milestones=changes.filter(e=>e.kind==='pr');
  assert.equal(milestones.length,1);
  assert.equal(milestones[0].text,'PR · ready');
  assert.equal(milestones[0].agentId,'parent');
  assert.deepEqual(milestones[0].agentIds,['child','parent']);
  assert.equal(h.observe([{...parent,pr:ready},{...child,pr:ready}]).length,0);
  const frame=replayFrame(h.events(),h.events().length-1);
  assert.equal(frame.states.get('parent').pr,'ready');
  assert.equal(frame.states.get('child').pr,'ready');
});

test('shared PRs use fresh consistent evidence and never record conflicting readiness',()=>{
  let time=start;const h=createHistory({now:()=>time});h.observe([parent,child]);time+=1000;
  const ready={...pr,labels:['babysit:ready'],checkedAt:time};
  const blocked={...pr,labels:['babysit:blocked'],checkedAt:time};
  const conflict=h.observe([{...parent,pr:ready},{...child,pr:blocked}]);
  assert.deepEqual(conflict.filter(e=>e.kind==='pr').map(e=>e.text),['PR · unknown']);
  time+=1000;
  const current={...ready,checkedAt:time};
  const resolved=h.observe([{...parent,pr:current},{...child,pr:blocked}]);
  assert.deepEqual(resolved.filter(e=>e.kind==='pr').map(e=>e.text),['PR · ready']);
});

test('a revisit compares persisted task and PR states despite initial:true',()=>{
  const {storage}=storageFixture();let time=start;
  const first=createHistory({storage,key:'return',now:()=>time});first.observe([parent,child]);
  time+=60_000;
  const revisit=createHistory({storage,key:'return',now:()=>time});
  const merged={...pr,state:'merged',checkedAt:time};
  const changes=revisit.observe([{...parent,status:'done',pr:merged},{...child,status:'done',pr:merged}],{initial:true});
  assert.equal(revisit.baseline,start);
  assert.equal(changes.filter(e=>e.kind==='status'&&e.text==='Task done').length,2);
  assert.equal(changes.filter(e=>e.kind==='pr'&&e.text==='PR · merged').length,1);
  assert.ok(revisit.sinceVisit().some(e=>e.text==='PR · merged'));
  assert.ok(changes.every(e=>e.timestamp===time)); // observed on return, not invented earlier times
  assert.equal(revisit.observe([{...parent,status:'done',pr:merged},{...child,status:'done',pr:merged}]).length,0);
});

test('first observations and legacy journals do not fabricate completion or PR transitions',()=>{
  let time=start;const {storage,store}=storageFixture();
  const ready={...pr,labels:['babysit:ready']};
  const first=createHistory({storage,key:'first',now:()=>time});
  const changes=first.observe([{...parent,status:'done',pr:ready}],{initial:true});
  assert.deepEqual(changes.map(e=>e.kind),['observed']);
  assert.equal(first.sinceVisit().length,0);
  store.set('cottagecode:journal:v1:legacy',JSON.stringify({events:[
    {id:'old',agentId:parent.id,taskId:parent.taskId,kind:'observed',text:'First observed · working',timestamp:start-1000},
  ],lastVisit:start-1000}));
  const legacy=createHistory({storage,key:'legacy',now:()=>time});
  assert.equal(legacy.observe([{...parent,status:'done',pr:ready}],{initial:true}).length,0);
  time+=1000;
  const arrival=legacy.observe([{...parent,status:'done',pr:ready},{...child,status:'done',pr:ready}]);
  assert.ok(!arrival.some(e=>e.kind==='pr'||e.kind==='status'));
});

test('task identity changes reset task comparisons without replaying the old task result',()=>{
  let time=start;const h=createHistory({now:()=>time});
  h.observe([{...parent,status:'done',result:'Old completed task',pr:{state:'none'}}]);time+=1000;
  const next={...parent,taskId:'new-task',status:'working',result:'',pr:{state:'none'}};
  const changed=h.observe([next]);
  assert.deepEqual(changed.map(e=>e.kind),['task']);
  time+=1000;
  const opened=h.observe([{...next,pr}]);
  assert.deepEqual(opened.filter(e=>e.kind==='pr').map(e=>e.text),['PR · active']);
});

test('the canonical PR baseline survives a change in which cottage reports it',()=>{
  let time=start;const h=createHistory({now:()=>time});h.observe([parent]);time+=1000;
  h.observe([]);time+=1000;
  const changed=h.observe([{...child,pr:{...pr,state:'merged',checkedAt:time}}]);
  assert.equal(changed.filter(e=>e.kind==='pr'&&e.text==='PR · merged').length,1);
});

test('bounded journals retain state comparisons and do not reannounce evicted artifacts',()=>{
  let time=start;const {storage,store}=storageFixture();
  const h=createHistory({storage,key:'bounded',now:()=>time});
  const a={...parent,artifacts:[{url:'https://example.com/build',title:'Build'}]};h.observe([a]);
  for(let i=0;i<1602;i++)h.record({id:'extra-'+i,timestamp:++time,kind:'test'});
  assert.equal(h.events().length,1600);
  const before=h.events().map(e=>e.id);
  const afterTrim=createHistory({storage,key:'bounded',now:()=>time});afterTrim.observe([a],{initial:true});
  assert.deepEqual(afterTrim.events().map(e=>e.id),before);
  time++;
  assert.ok(afterTrim.observe([{...a,status:'done'}]).some(e=>e.text==='Task done'));
  const saved=JSON.parse(store.get('cottagecode:journal:v1:bounded'));
  assert.equal(saved.events.length,1600);
  assert.equal(saved.states.parent.status,'done');
});

test('large and malformed saved snapshots are bounded and recover safely',()=>{
  const {storage,store}=storageFixture();
  const states=Object.fromEntries(Array.from({length:1605},(_,i)=>['a'+i,{status:'working',stage:'none',taskId:'task',observedAt:start+i}]));
  const prStates=Object.fromEntries(Array.from({length:1605},(_,i)=>['pr:'+i,{stage:'open',observedAt:start+i}]));
  store.set('cottagecode:journal:v1:large',JSON.stringify({events:[null,{id:'bad',timestamp:'bad'},{id:'safe',timestamp:start,url:'javascript:alert(1)'}],states,prStates,lastVisit:start}));
  const h=createHistory({storage,key:'large',now:()=>start+2000});h.observe([]);
  const saved=JSON.parse(store.get('cottagecode:journal:v1:large'));
  assert.equal(saved.events.length,1);assert.equal(saved.events[0].url,'');
  assert.equal(Object.keys(saved.states).length,1600);assert.equal(Object.keys(saved.prStates).length,1600);
  assert.equal(saved.states.a0,undefined);assert.ok(saved.states.a1604);
  assert.equal(h.record({id:'invalid-time',timestamp:NaN}),false);
  h.clear();
  const cleared=JSON.parse(store.get('cottagecode:journal:v1:large'));
  assert.deepEqual(cleared.states,{});assert.deepEqual(cleared.prStates,{});
  store.set('cottagecode:journal:v1:broken',JSON.stringify({events:[],states:[],prStates:{bad:null},lastVisit:'bad'}));
  assert.doesNotThrow(()=>createHistory({storage,key:'broken'}).observe([parent]));
});
