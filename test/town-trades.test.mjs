import test from 'node:test';
import assert from 'node:assert/strict';
import {createTownTrades,TOOL_WINDOW_MS,ROAD_WINDOW_MS,GROWTH_WINDOW_MS} from '../src/town-trades.mjs';
const now=Date.parse('2026-11-05T12:00:00Z');
const task=(id,extra={})=>({id,town:'MemTown',status:'working',raw:{name:id,taskId:`task-${id}`},...extra});
const read=(id,extra={})=>task(id,{raw:{name:id,toolActivity:{name:'mcp__memory__recall_memory',state:'succeeded',at:now,...extra}}});
test('miners require explicit fresh allowlisted tools and canonical working state',()=>{
  const model=createTownTrades(),tasks=[read('a'),read('b',{name:'Bash'}),read('c',{at:now-TOOL_WINDOW_MS}),read('d',{at:now+1}),read('e',{state:'failed'}),read('f',{stale:true}),{...read('g'),quiet:true},{...read('h'),sourceStale:true},{...read('i'),status:'done'},task('j',{activity:'Read all the source files'})];
  const output=model.snapshot({tasks,now});assert.deepEqual(output.miners.map(m=>m.taskId),['a']);assert.equal(output.coverage.missingToolTasks,2);
  assert.equal(model.snapshot({tasks,now,stale:true}).miners.length,0);
});
test('tool evidence expires independently of inventory refresh',()=>{
  const model=createTownTrades();assert.equal(model.snapshot({tasks:[read('a')],now}).miners.length,1);
  assert.equal(model.snapshot({tasks:[read('a')],now:now+TOOL_WINDOW_MS}).miners.length,0);
});
test('canonical WebSearch and WebFetch tool names mine without classifying shell calls',()=>{
  const model=createTownTrades(),tasks=['WebSearch','WebFetch','mcp__browser__WebSearch','Bash','shell','exec_command'].map((name,i)=>read(String(i),{name}));
  assert.deepEqual(model.snapshot({tasks,now}).miners.map(m=>m.toolName),['WebSearch','WebFetch','mcp__browser__WebSearch']);
});
test('recent non-reading tools create truthful workshops while read tools stay miners',()=>{
  const model=createTownTrades(),tasks=[read('read',{name:'Read'}),read('bash',{name:'Bash'}),read('shell',{name:'shell',state:'started'}),read('tool',{name:'mcp__agent__wrap_up'})];
  tasks[1].raw.toolActivity.arguments={command:'private command'};
  tasks[1].activity='Running tests and writing source files';
  const output=model.snapshot({tasks,now});
  assert.deepEqual(output.miners.map(m=>m.taskId),['read']);
  assert.deepEqual(output.workshops.map(w=>w.taskId),['bash','shell','tool']);
  const story=output.stories.find(s=>s.id==='workshop:bash');
  assert.equal(story.role,'workshop');assert.equal(story.taskId,'bash');assert.equal(story.at,now);
  assert.match(story.reason,/Bash succeeded/);assert.match(story.reason,/Tool use was observed/);
  assert.match(story.reason,/does not assert that the tool is still running/);
  assert.doesNotMatch(JSON.stringify(output),/private command|Running tests|writing source files|arguments/);
});
test('workshops require fresh successful tool facts and working nonquiet tasks',()=>{
  const model=createTownTrades();
  const tasks=[read('okay',{name:'Bash'}),read('expired',{name:'Bash',at:now-TOOL_WINDOW_MS}),read('future',{name:'shell',at:now+1}),read('failed',{name:'Bash',state:'failed'}),read('cancelled',{name:'shell',state:'cancelled'}),read('stale',{name:'Bash',stale:true}),read('missing',{name:' '}),{...read('quiet',{name:'Bash'}),quiet:true},{...read('source',{name:'shell'}),sourceStale:true},{...read('done',{name:'Bash'}),status:'done'},task('prose',{activity:'Bash running'})];
  assert.deepEqual(model.snapshot({tasks,now}).workshops.map(w=>w.taskId),['okay']);
  assert.deepEqual(model.snapshot({tasks,now,stale:true}).workshops,[]);
  assert.deepEqual(model.snapshot({tasks:[tasks[0]],now:now+TOOL_WINDOW_MS}).workshops,[]);
});
test('baseline, view filtering, repeated snapshots and reappearances do not invent growth',()=>{
  const model=createTownTrades(),a=task('a'),b=task('b');
  model.observeSnapshot({tasks:[a]},{sourceKey:'one',now});assert.equal(model.snapshot({tasks:[a],now}).gardens[0].arrivals,0);
  model.snapshot({tasks:[],now});model.observeSnapshot({tasks:[a,b]},{sourceKey:'one',now:now+1});
  model.observeSnapshot({tasks:[a]},{sourceKey:'one',now:now+2});model.observeSnapshot({tasks:[a,b]},{sourceKey:'one',now:now+3});
  assert.equal(model.snapshot({tasks:[a,b],now:now+3}).gardens[0].arrivals,1);
  assert.equal(model.snapshot({tasks:[a,b],now:now+GROWTH_WINDOW_MS+1}).gardens[0].arrivals,0);
});
test('three new residents make a growth spurt, historical membership does not',()=>{
  const model=createTownTrades(),tasks=[task('a')];model.observeSnapshot({tasks},{sourceKey:'one',now});
  tasks.push(task('b'),task('c'),task('d'),task('historic',{raw:{inventoryScope:'history'}}));
  model.observeSnapshot({tasks},{sourceKey:'one',now:now+1});
  const garden=model.snapshot({tasks,now:now+1}).gardens[0];assert.equal(garden.growth,'spurt');assert.equal(garden.arrivals,3);assert.deepEqual(garden.taskIds,['b','c','d']);
});
test('dashboard membership keeps trades and growth aligned with canonical inventory',()=>{
  const model=createTownTrades(),base=task('baseline');
  model.observeSnapshot({tasks:[base]},{sourceKey:'one',now});
  const dashboard=task('dashboard',{status:'offline',raw:{inventoryScope:'dashboard',occupancy:'settled'}});
  const history=task('history',{raw:{inventoryScope:'history',occupancy:'live'}});
  const standalone=task('standalone',{raw:{occupancy:'settled'}});
  const tasks=[base,dashboard,history,standalone];
  model.observeSnapshot({tasks},{sourceKey:'one',now:now+1});
  const snapshot=model.snapshot({tasks,now:now+1});
  assert.equal(snapshot.gardens[0].arrivals,1);
  assert.deepEqual(snapshot.gardens[0].taskIds,['dashboard']);
  assert.equal(snapshot.gardens[0].activeCount,1,'finished dashboard residents do not act working');
  assert.equal(snapshot.coverage.missingToolTasks,2,'dashboard and standalone visible baseline count; history and settled standalone do not');
});
test('only newly observed explicit links create roads; handoffs need recent clocks',()=>{
  const model=createTownTrades(),a=task('a'),b=task('b',{parent:'task-a'}),c=task('c');
  model.observeSnapshot({tasks:[a,b,c]},{sourceKey:'one',now});
  assert.equal(model.snapshot({tasks:[a,b,c],now}).roads.length,0);
  const relationships=[{id:'r',from:'task:a',to:'task:c',kind:'depends-on'},{id:'bad',from:'missing',to:'c'}];
  const handoffs=[{id:'old',from:'a',to:'b',at:now-ROAD_WINDOW_MS},{id:'future',from:'a',to:'b',at:now+999},{id:'new',from:'a',to:'b',at:now}];
  model.observeSnapshot({tasks:[a,b,c],relationships,handoffs},{sourceKey:'one',now:now+1});
  assert.deepEqual(model.snapshot({tasks:[a,b,c],now:now+1}).roads.map(r=>r.id),['relationship:r','handoff:new']);
  assert.equal(model.snapshot({tasks:[a,b,c],now:now+ROAD_WINDOW_MS+1}).roads.length,0);
});
test('stale snapshots cannot create arrivals and source change resets immediately',()=>{
  const model=createTownTrades(),a=task('a'),b=task('b');model.observeSnapshot({tasks:[a]},{sourceKey:'one',now});
  model.observeSnapshot({tasks:[a,b]},{sourceKey:'one',now:now+1,stale:true});assert.equal(model.snapshot({tasks:[a,b],now:now+1}).gardens[0].arrivals,0);
  model.observeSnapshot({tasks:[a,b]},{sourceKey:'one',now:now+2});assert.equal(model.snapshot({tasks:[a,b],now:now+2}).gardens[0].arrivals,1);
  model.observeSnapshot({tasks:[a,b]},{sourceKey:'two',now:now+3,stale:true});assert.equal(model.snapshot({tasks:[a,b],now:now+3}).gardens[0].arrivals,0);
  model.observeSnapshot({tasks:[a,b]},{sourceKey:'two',now:now+4});assert.equal(model.snapshot({tasks:[a,b],now:now+4}).gardens[0].arrivals,0);
  model.reset();assert.deepEqual(model.snapshot({tasks:[],now:now+5}).stories,[]);
});

test('documented town-stem aliases preserve explicit links without assigning a cottage',()=>{
  const model=createTownTrades(),tasks=[task('a'),task('b',{town:'HubTown'})];
  model.observeSnapshot({tasks},{sourceKey:'one',now});
  model.observeSnapshot({tasks,relationships:[{id:'known',from:'Mem',to:'Hub'},{id:'unknown',from:'Missing',to:'Hub'}]},{sourceKey:'one',now:now+1});
  const roads=model.snapshot({tasks,now:now+1}).roads;
  assert.equal(roads.length,1);assert.equal(roads[0].fromTown,'MemTown');assert.equal(roads[0].toTown,'HubTown');assert.equal(roads[0].toId,null);
});

test('an unresolved parent or task-prefixed endpoint never becomes a town',()=>{
  const model=createTownTrades(),tasks=[task('a'),task('b',{town:'TaskMemTown'})];
  model.observeSnapshot({tasks},{sourceKey:'one',now});
  tasks.push(task('child',{parent:'Mem'}));
  model.observeSnapshot({tasks,relationships:[{from:'task:Mem',to:'a',kind:'depends-on'}]},{sourceKey:'one',now:now+1});
  assert.deepEqual(model.snapshot({tasks,now:now+1}).roads,[]);
});
