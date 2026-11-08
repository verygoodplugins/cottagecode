import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSnapshot, fleetView } from '../src/command-model.mjs';
import { feedEnvelope, staleFeedPr } from '../src/feed-client.mjs';

const now=Date.parse('2026-11-04T12:00:00Z');
test('command snapshot keeps exact public evidence and the map identity and PR authority',()=>{
 const normalized={id:'one',town:'HubTown',role:'HubTown',model:'gpt',status:'idle',terminal:false,occupancy:'live',originalAsk:'Readable request',pr:{authority:'hub',stage:'blocked',reason:'Canonical blocker'}};
 const raw={id:'one',town:'hub',model:'gpt-6.1-codex',status:'failed',taskStartedAt:now-60000,harness:'Codex',originalAsk:{text:'Readable request'},pr:{stage:'ready'}};
 const joined=commandSnapshot([normalized],{agents:[raw],relationships:[{from:'task:one',to:'task:two',kind:'parent'}]},{stale:true});
 assert.equal(joined.agents[0].model,'gpt-6.1-codex');assert.equal(joined.agents[0].status,'failed');
 assert.equal(joined.agents[0].town,'HubTown');assert.equal(joined.agents[0].terminal,undefined);
 assert.equal(joined.agents[0].originalAsk,'Readable request');assert.equal(joined.agents[0].pr.stage,'blocked');assert.equal(joined.stale,true);
 assert.equal(joined.relationships.length,1);assert.equal(raw.pr.stage,'ready');
});
test('command snapshot does not substitute evidence from another identity',()=>{
 const joined=commandSnapshot([{id:'new',town:'MemTown',task:'New work'}],{agents:[{id:'old',inputRequest:{id:'private-question'},model:'Old model'}]});
 assert.equal(joined.agents.length,1);assert.equal(joined.agents[0].inputRequest,undefined);assert.equal(joined.agents[0].model,undefined);
});
test('explicit settled toggle includes history without duplicating PR counts',()=>{
 const pr={url:'https://github.com/example/project/pull/1',number:1,authority:'hub',state:'open',reviewState:'ready',headSha:'abc',reviewedHeadSha:'abc',checkedAt:now};
 const agents=[{id:'a',task:'Current',inventoryScope:'dashboard',status:'idle',pr},{id:'b',task:'History',inventoryScope:'history',status:'done',pr}];
 assert.equal(fleetView({agents},{now}).tasks.length,1);
 const all=fleetView({agents},{now,includeSettled:true});assert.equal(all.tasks.length,2);assert.equal(all.counts.ready,1);
});
test('feed envelope preserves source verification timestamps independently',()=>{
 const value=feedEnvelope({agents:[],checkedAt:now-10000,timestamp:now,source:'hub'});
 assert.equal(value.checkedAt,now-10000);assert.equal(value.timestamp,now);
});

test('local demo replies are counted only in an explicitly built-in demo context',()=>{
 const snapshot={agents:[{id:'demo-1',source:'demo',status:'blocked',inputRequest:{id:'q1',prompt:'Choose a scope'}}]};
 assert.equal(fleetView(snapshot,{now}).counts.answerable,0);
 assert.equal(fleetView(snapshot,{now,builtInDemo:true}).counts.answerable,1);
});

test('missing source model and status never inherit renderer defaults',()=>{
 const snapshot=commandSnapshot([{id:'a',model:'sonnet',status:'idle'}],{agents:[{id:'a'}]});
 const view=fleetView(snapshot,{now,includeSettled:true}).tasks[0];
 assert.equal(view.model,'Unknown');assert.equal(view.status,'unknown');
});
test('outages preserve Hub verification and blocker reasons but stale standalone observations',()=>{
 const hub={authority:'hub',checkedAt:now,stale:false,reason:'Security review required'};
 assert.equal(staleFeedPr(hub,'Connection interrupted'),hub);
 const standalone=staleFeedPr({...hub,authority:'github'},'Connection interrupted');
 assert.equal(standalone.stale,true);assert.equal(standalone.reason,'Connection interrupted');
});
test('shared Hub PR observations reconcile CI, attention and project counts before town scoping',()=>{
 const common={url:'https://github.com/example/project/pull/42',state:'open',headSha:'abc',reviewedHeadSha:'abc',checkedAt:now};
 const agents=[{id:'hub',town:'HubTown',status:'working',pr:{...common,authority:'hub',reviewState:'ready',checks:[{name:'unit',status:'completed',conclusion:'success'}]}},
 {id:'other',town:'OtherTown',status:'working',pr:{...common,reviewState:'blocked',checks:[{name:'unit',status:'completed',conclusion:'failure'}]}}];
 const joined=commandSnapshot(agents,{agents});
 assert.equal(joined.agents[1].pr.authority,'hub');assert.equal(joined.agents[1].pr.reviewState,'ready');
 const fleet=fleetView({agents},{now});
 assert.equal(fleet.counts.attention,0);assert.equal(fleet.projects.find(p=>p.name==='OtherTown').attention,0);
 for(const task of fleet.tasks){assert.equal(task.prStage,'ready');assert.equal(task.ci.state,'passing');assert.equal(task.attention,false);}
 const scoped=fleetView({agents:fleet.tasks.filter(t=>t.town==='OtherTown').map(t=>({...t.raw,pr:t.pr}))},{now});
 assert.equal(scoped.tasks[0].pr.authority,'hub');assert.equal(scoped.counts.ready,1);assert.equal(scoped.tasks[0].ci.state,'passing');
 const blocked=fleetView({agents:agents.map(a=>({...a,pr:{...a.pr,reviewState:a.id==='hub'?'blocked':'ready'}}))},{now});
 assert.equal(blocked.counts.attention,2);assert.equal(blocked.tasks[1].prStage,'blocked');
});

test('conflicting terminal PR observations remain unknown through joins and town scoping in either order',()=>{
 for(const state of ['closed','merged'])for(const reverse of [false,true]){
  const common={url:'https://github.com/example/project/pull/42',authority:'hub',checkedAt:now};
  const agents=[{id:'a',town:'HubTown',status:'working',pr:{...common,state}},{id:'b',town:'OtherTown',status:'working',pr:{...common,state:'open'}}];
  if(reverse)agents.reverse();
  const joined=commandSnapshot(agents,{agents}),fleet=fleetView(joined,{now});
  assert.ok(fleet.tasks.every(t=>t.prStage==='unknown'));
  const scoped=fleetView({agents:fleet.tasks.slice(0,1).map(t=>({...t.raw,pr:t.pr}))},{now});
  assert.equal(scoped.tasks[0].prStage,'unknown');
 }
});
