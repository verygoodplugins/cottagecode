import test from 'node:test';
import assert from 'node:assert/strict';
import {createTownLayout,movePoint,normalizeRelationships,normalizedHandoffs,advanceDuck} from '../src/world.mjs';
import {layoutCottages} from '../src/feed-client.mjs';
import {plotAgentsForLayout} from '../src/roommates.mjs';

test('Hub history does not reserve empty districts or become the live roommate host',()=>{
  const history=Array.from({length:500},(_,i)=>({id:'a-old-'+i,town:'HubTown',inventoryScope:'history',occupancy:'settled',worktreePath:i===0?'/project/shared':'/old/'+i}));
  const active={id:'z-current',town:'HubTown',inventoryScope:'dashboard',occupancy:'live',worktreePath:'/project/shared'};
  const all=[...history,active],layout=createTownLayout(),options={trimEmptyBlocks:true};
  const current=()=>layout.update(plotAgentsForLayout(layoutCottages(all)),options);
  const first=current();
  assert.equal(first.plots.length,1);assert.equal(first.blocks.length,1);
  assert.equal(first.plots[0].agent.id,active.id);assert.deepEqual(first.plots[0].agent.roommates,[]);
  const expanded=layout.fork().update(plotAgentsForLayout(layoutCottages(all,{showSettled:true})),options);
  assert.ok(expanded.height>first.height);
  const restored=current();
  assert.equal(restored.height,first.height);assert.equal(restored.blocks.length,1);
  assert.equal(restored.plots[0].x,first.plots[0].x);assert.equal(restored.plots[0].y,first.plots[0].y);
  const historical=expanded.plots.find(p=>p.agent.id==='a-old-10');
  const again=layout.fork().update(plotAgentsForLayout(layoutCottages(all,{showSettled:true})),options);
  assert.deepEqual(again.plots.find(p=>p.agent.id==='a-old-10'),historical,'history locations survive toggling');
  all.push({...active,id:'new-arrival',worktreePath:'/project/new'});
  const arrived=current();
  assert.equal(arrived.height,first.height,'history never pushes new live work into distant annexes');
  assert.equal(arrived.blocks.length,1);assert.equal(arrived.plots.length,2);
});
test('plots remain fixed through reorder, departure, overflow and new towns',()=>{
  const layout=createTownLayout({columns:2,rows:1});
  const a={id:'a',town:'HubTown'},b={id:'b',town:'AppTown'};
  const old=layout.update([a,b]);
  const next=layout.update([b,...Array.from({length:20},(_,i)=>({id:'c'+i,town:'HubTown'})),a]);
  for(const p of old.plots){const q=next.plots.find(x=>x.agent.id===p.agent.id);assert.equal(p.x,q.x);assert.equal(p.y,q.y);}
  assert.equal(new Set(next.plots.map(p=>p.x+','+p.y)).size,next.plots.length);
  assert.deepEqual(layout.update([a]).plots[0],old.plots[0]);
});
test('movement cannot tunnel through furniture',()=>{
  const p=movePoint({x:0,y:4},100,0,(x)=>x<20||x>25);
  assert.ok(p.x<20);
});
test('only explicit valid project relationships are accepted',()=>{
  assert.deepEqual(normalizeRelationships([],['HubTown','AppTown']),[]);
  assert.equal(normalizeRelationships([{from:'HubTown',to:'AppTown'},{from:'AppTown',to:'HubTown'},{from:'Other',to:'HubTown'}],['HubTown','AppTown']).length,1);
});
test('custom feed town stems share cottage aliases for paths and handoffs',()=>{
  const towns=['HubTown','AppTown','MemTown','VaultTown'];
  assert.deepEqual(normalizeRelationships([
    {from:'autohub',to:'autoapp',label:'App route'},
    {from:'AppTown',to:'Hub',label:'duplicate route'},
    {from:'unknown',to:'hub'},
  ],towns),[{id:'AppTown|HubTown',from:'HubTown',to:'AppTown',label:'App route'}]);
  assert.deepEqual(normalizedHandoffs([{id:'h1',from:'mem',to:'autovault',timestamp:10,text:'Archive'}]),[
    {id:'h1',from:'MemTown',to:'VaultTown',timestamp:10,text:'Archive'},
  ]);
});
test('duck flees toward water, splashes, swims, and returns',()=>{
  const duck={x:15,y:55,mode:'wandering'},pond={x:0,y:0,w:60,h:30};
  assert.equal(advanceDuck(duck,{x:16,y:55},pond,.02,0),'quack');
  const events=[];
  for(let i=1;i<1500;i++){const e=advanceDuck(duck,{x:200,y:200},pond,.02,i*.02);if(e)events.push(e);}
  assert.ok(events.includes('splash'));assert.equal(duck.mode,'wandering');
});
test('shed slots survive reordered arrivals and overflow gets collision-free plots',()=>{
  const layout=createTownLayout(),parent={id:'p',town:'HubTown'};
  const kids=Array.from({length:9},(_,i)=>({id:'k'+i,parent:'p',town:'HubTown'}));
  const before=layout.update([parent,...kids.slice(0,2)]);
  const after=layout.update([parent,...kids.slice(2),...kids.slice(0,2)]);
  assert.equal(after.shedSlots.k0,before.shedSlots.k0);assert.equal(after.shedSlots.k1,before.shedSlots.k1);
  assert.equal(after.plots.length,7);
  assert.equal(new Set(after.plots.map(p=>p.x+','+p.y)).size,7);
});
