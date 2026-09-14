import test from 'node:test';
import assert from 'node:assert/strict';
import {createTownLayout,movePoint,normalizeRelationships,advanceDuck} from '../src/world.mjs';
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
