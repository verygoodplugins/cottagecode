import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat } from '../src/heartbeat.mjs';
const event = (extra={}) => ({id:'e1',kind:'pr',text:'PR · merged',prKey:'github.com/acme/app#42',agentId:'a',town:'AppTown',...extra});
function context() { const calls=[]; return {calls,save(){},restore(){},fillRect(...v){calls.push([this.fillStyle,...v]);},fillText(...v){calls.push(['label',...v]);}}; }
const scene={districts:[{key:'AppTown',x:0,y:0,w:200,h:160}],plots:[{x:40,y:40,agent:{id:'a',town:'AppTown'}}],tasks:[{id:'a',status:'working',raw:{town:'AppTown'}}]};
test('only canonical explicit outcomes launch a shipment, shared observations count once',()=>{
 const h=createHeartbeat(); h.observe([event(),event({id:'e2',agentId:'b'}),event({text:'PR · ready',prKey:'github.com/acme/app#43'})],{now:0,sourceKey:'a'});
 assert.equal(h.state.shipments.length,1); assert.equal(h.state.shipments[0].outcome,'merged');
 h.observe([event({text:'PR · closed'})],{now:1,sourceKey:'a'}); assert.equal(h.state.shipments.length,1);
});
test('closed cart is empty; merged parcel and short PR label are drawn on front lane',()=>{
 const merged=createHeartbeat(),closed=createHeartbeat(); merged.observe([event()],{now:0});closed.observe([event({text:'PR · closed'})],{now:0});
 const a=context(),b=context();merged.drawLife(a,{...scene,time:1});closed.drawLife(b,{...scene,time:1});
 assert.ok(a.calls.some(c=>c[0]==='label'&&c[1]==='#42'));assert.equal(a.calls.length,b.calls.length+2);
});
test('missing PR identity never invents a delivery, URL identity deduplicates canonical key',()=>{
 const h=createHeartbeat();h.observe([event({prKey:'',id:'unknown'}),event({url:'https://github.com/acme/app/pull/42',prKey:''}),event()],{now:1});assert.equal(h.state.shipments.length,1);
});
test('source reset clears shipments and deduplication',()=>{
 const h=createHeartbeat();h.observe([event()],{now:0,sourceKey:'one'});h.observe([],{now:1,sourceKey:'two'});assert.equal(h.state.seenCount,0);assert.equal(h.state.shipments.length,0);
 h.observe([event()],{now:2,sourceKey:'two'});assert.equal(h.state.shipments.length,1);h.observe([],{now:3,sourceKey:'two',sourceChanged:true});assert.equal(h.state.seenCount,0);
});
test('bounded lifetime and memory',()=>{
 const h=createHeartbeat();h.observe(Array.from({length:400},(_,i)=>event({prKey:`github.com/acme/app#${i+1}`})),{now:0});assert.equal(h.state.seenCount,256);assert.equal(h.state.shipments.length,16);
 h.drawLife(context(),{time:21});assert.equal(h.state.shipments.length,0);
});
test('stale and reduced motion are static; idle town rests; scope excludes other towns',()=>{
 for(const flag of ['stale','reduce']) {const h=createHeartbeat();h.observe([event()],{now:0});const a=context(),b=context();h.drawGround(a,{...scene,time:1,[flag]:true});h.drawLife(a,{...scene,time:1,[flag]:true});h.drawGround(b,{...scene,time:9,[flag]:true});h.drawLife(b,{...scene,time:9,[flag]:true});assert.deepEqual(a.calls,b.calls);}
 const h=createHeartbeat(),a=context(),b=context();const idle={...scene,tasks:[{...scene.tasks[0],status:'idle'}]};h.drawLife(a,{...idle,time:1});h.drawLife(b,{...idle,time:4});assert.deepEqual(a.calls,b.calls);
 const scoped=context();h.drawLife(scoped,{...scene,townFilter:'OtherTown'});h.drawGround(scoped,{...scene,townFilter:'OtherTown'});assert.deepEqual(scoped.calls,[]);
});
test('closed carts return along the lane opposite merged deliveries',()=>{
 for(const outcome of ['merged','closed']) {
  const h=createHeartbeat();h.observe([event({text:`PR · ${outcome}`})],{now:0});
  const a=context(),b=context();h.drawLife(a,{...scene,time:1});h.drawLife(b,{...scene,time:10});
  const x1=a.calls.find(c=>c[0]==='label')[2],x2=b.calls.find(c=>c[0]==='label')[2];
  assert.ok(outcome==='merged'?x2>x1:x2<x1);
 }
});
test('individual stale tasks do not animate ground or district workers',()=>{
 const h=createHeartbeat(),stale={...scene,tasks:[{...scene.tasks[0],sourceStale:true}]};
 const a=context(),b=context();h.drawGround(a,{...stale,time:1});assert.deepEqual(a.calls,[]);
 h.drawLife(a,{...stale,time:1});h.drawLife(b,{...stale,time:10});assert.deepEqual(a.calls,b.calls);
});
test('a disappeared or filtered household never reassigns its cart to a town neighbour',()=>{
 const h=createHeartbeat();h.observe([event()],{now:0});
 const unrelated={...scene.plots[0],agent:{id:'other',town:'AppTown'}};
 for(const plots of [[unrelated],[]]) {
  const ctx=context();h.drawLife(ctx,{...scene,plots,time:1});
  assert.ok(!ctx.calls.some(c=>c[0]==='label'),'no PR label at unrelated household');
  assert.ok(!ctx.calls.some(c=>c[0]==='#c6a77a'),'no parcel at unrelated household');
 }
 assert.equal(h.state.shipments.length,1,'cart remains bounded in memory in case actual plot returns');
});
test('explicit reset immediately clears same-source shipments and accepts subsequent IDs',()=>{
 const h=createHeartbeat();h.observe([event()],{sourceKey:'same',now:0});h.reset();
 assert.equal(h.state.shipments.length,0);assert.equal(h.state.seenCount,0);
 // A synchronous empty observatory callback may still name the previous source.
 h.observe([],{sourceKey:'same',now:1});
 const ctx=context();h.drawLife(ctx,{...scene,time:1});assert.ok(!ctx.calls.some(c=>c[0]==='label'));
 h.observe([event()],{sourceKey:'same',now:2});assert.equal(h.state.shipments.length,1);
});
