import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedTrades,tradePanelHTML,tradeStoryForSite,toolEvidence} from '../src/trade-panel.mjs';
const trades={miners:[{taskId:'a',town:'OakTown'},{taskId:'b',town:'PineTown'}],roads:[{fromId:'a',toId:'b',fromTown:'OakTown',toTown:'PineTown'}],gardens:[{town:'OakTown',arrivals:9},{town:'PineTown',arrivals:2}],stories:[{id:'m1',role:'miner',taskId:'a',town:'OakTown',title:'Read source',reason:'Recorded read tool',at:'2026-11-05T00:00:00Z'},{id:'g1',role:'gardener',town:'PineTown',title:'Two arrivals',reason:'First observed residents'}],coverage:{missingToolTasks:3}};
const tasks=[{id:'a',raw:{town:'OakTown'}},{id:'b',raw:{town:'PineTown'}}];
test('counts and stories obey town scope while cross-town explicit roads have both endpoints',()=>{
  const scoped=scopedTrades(trades,'OakTown');assert.equal(scoped.miners.length,1);assert.equal(scoped.roads.length,1);assert.equal(scoped.stories.length,1);
  const html=tradePanelHTML({trades,tasks,townFilter:'OakTown'});
  assert.match(html,/1 miners · 1 road crews · 9 arrivals/);assert.doesNotMatch(html,/Two arrivals|PineTown/);assert.match(html,/0 recent .*0 older\/stale · 1 unreported across 1 cottages/);
});
test('all source strings and attributes are escaped, supported exact task gets inspect',()=>{
  const evil='<img src=x onerror=alert(1)>';
  const html=tradePanelHTML({trades:{stories:[{id:evil,role:'miner',taskId:'a',town:evil,title:evil,reason:evil,at:evil}]},tasks,selectedId:evil});
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/data-cc-inspect="a"/);
  const missing=tradePanelHTML({trades:{stories:[{id:'s',taskId:'unsupported',title:'Evidence'}]},tasks,selectedId:'s'});
  assert.doesNotMatch(missing,/data-cc-inspect/);
});
test('expired or out-of-scope selection never leaves a misleading evidence card',()=>{
  assert.doesNotMatch(tradePanelHTML({trades,tasks,selectedId:'expired'}),/cc-trade-story/);
  assert.doesNotMatch(tradePanelHTML({trades,tasks,townFilter:'PineTown',selectedId:'m1'}),/Recorded read tool/);
});
test('demo rehearsal is exclusive to illustrative views; stale and unknown remain explicit',()=>{
  const html=tradePanelHTML({stale:true});assert.match(html,/Source stale/);assert.match(html,/Unreported does not mean idle/);assert.doesNotMatch(html,/data-cc-rehearse-growth/);
  const demo=tradePanelHTML({illustrative:true});assert.match(demo,/Illustrative town/);assert.match(demo,/data-cc-rehearse-growth/);
});
test('sprite inspection resolves only current matching role, town and recorded identity',()=>{
  const site={role:'miner',taskId:'a',town:'OakTown'};assert.equal(tradeStoryForSite(site,trades).id,'m1');
  assert.equal(tradeStoryForSite({...site,taskId:'missing'},trades),null);
  assert.equal(tradeStoryForSite(site,trades,'PineTown'),null);
  assert.equal(tradeStoryForSite(site,{stories:[]}),null);
  assert.equal(tradeStoryForSite({...site,role:'unknown'},trades),null);
});
test('named tool activity objects count as available only with known state and valid recorded time',()=>{
  const tools=[{name:'read_file',state:'succeeded',at:'2026-01-01T00:00:00Z'},{name:'read',state:'failed',at:Date.now()-1000},{name:'read',state:'unknown',at:Date.now()-1000},{name:'read',state:'started',at:'invalid'},{name:'read',state:'started',at:Date.now()+60000}];
  const local=tools.map((tool,i)=>({id:String(i),raw:{town:'OakTown',toolActivity:tool}}));
  assert.match(tradePanelHTML({tasks:local,townFilter:'OakTown'}),/1 recent .*1 older\/stale · 3 unreported across 5 cottages/);
});
test('source-side roads resolve current explicit story and inspect only a supported in-town endpoint',()=>{
  const story={id:'road:link',role:'road',town:'PineTown',fromTown:'OakTown',toTown:'PineTown',fromId:'a',toId:'b',taskId:'b',title:'New explicit link',reason:'Recorded parent'};
  const t={...trades,stories:[story]};
  assert.equal(scopedTrades(t,'OakTown').stories[0],story);
  assert.equal(tradeStoryForSite({role:'road',town:'OakTown',taskId:'a',evidence:{id:'link'}},t,'OakTown'),story);
  const html=tradePanelHTML({trades:t,tasks,townFilter:'OakTown',selectedId:story.id});assert.match(html,/Recorded parent/);assert.match(html,/data-cc-inspect="a"/);assert.doesNotMatch(html,/data-cc-inspect="b"/);
  assert.doesNotMatch(tradePanelHTML({trades:t,tasks:tasks.slice(1),townFilter:'OakTown',selectedId:story.id}),/data-cc-inspect/);
});
test('explicit expired evidence never falls back to another story for the same task',()=>{
  const current={id:'road:new',role:'road',town:'OakTown',fromTown:'OakTown',toTown:'OakTown',taskId:'a',fromId:'a',toId:'b',title:'New road',reason:'Recorded now'};
  const value={stories:[current]};
  const site={role:'road',town:'OakTown',taskId:'a',evidence:{id:'old'}};
  assert.equal(tradeStoryForSite(site,value,'OakTown'),null);
  assert.equal(tradeStoryForSite({...site,evidence:{id:'new'}},value,'OakTown'),current);
  assert.equal(tradeStoryForSite({...site,evidence:undefined},value,'OakTown'),current);
});
test('garden story follows exact town when its first arrival has departed',()=>{
  const story={id:'garden:OakTown',role:'gardener',town:'OakTown',taskId:'departed',title:'A growing garden'};
  const t={stories:[story]};assert.equal(tradeStoryForSite({role:'gardener',town:'OakTown',taskId:'a'},t,'OakTown'),story);
  assert.equal(tradeStoryForSite({role:'gardener',town:'PineTown',taskId:'a'},t),null);
  assert.doesNotMatch(tradePanelHTML({trades:t,tasks,selectedId:story.id}),/data-cc-inspect/);
});

test('tool coverage distinguishes recent, historical, stale and unreported facts within scope',()=>{
  const now=Date.parse('2026-11-06T12:00:00Z');
  const task=(id,tool,extra={})=>({id,status:'working',raw:{town:'OakTown',toolActivity:tool},...extra});
  const call={name:'Bash',state:'succeeded',at:now-1000};
  const local=[task('recent',call),task('old',{...call,at:now-120000}),task('stale',{...call,stale:true}),
    task('source',call,{sourceStale:true}),task('missing',null),task('future',{...call,at:now+1}),task('invalid',{...call,state:'unknown'}),
    task('other',null,{raw:{town:'PineTown'}})];
  const coverage=toolEvidence(local,{townFilter:'OakTown',now});
  assert.deepEqual({recent:coverage.recent,older:coverage.older,unreported:coverage.unreported,total:coverage.total},{recent:1,older:3,unreported:3,total:7});
  assert.equal(coverage.working.length,7);assert.equal(toolEvidence(local,{townFilter:'OakTown',now,stale:true}).recent,0);
});

test('working tool rows expose exact safe facts and inspect IDs, never arguments or outputs',()=>{
  const now=Date.parse('2026-11-06T12:00:00Z'),tool={name:'Bash',state:'succeeded',at:now-420000,arguments:'secret arguments',output:'secret output'};
  const local=[{id:'active',status:'working',raw:{town:'OakTown',name:'<em>agent</em>',toolActivity:tool}},
    {id:'missing',status:'working',raw:{town:'OakTown'}},
    {id:'done',status:'done',raw:{town:'OakTown',toolActivity:tool}}];
  const html=tradePanelHTML({tasks:local,now});
  assert.match(html,/Bash · succeeded · 7m 0s ago · older\/stale/);assert.match(html,/tool unreported/);
  assert.match(html,/data-cc-inspect="active"/);assert.match(html,/data-cc-inspect="missing"/);assert.doesNotMatch(html,/data-cc-inspect="done"/);
  assert.match(html,/&lt;em&gt;agent&lt;\/em&gt;/);assert.doesNotMatch(html,/<em>|secret arguments|secret output/);
});

test('workshops scope their counts and exact evidence to the recorded cottage',()=>{
  const story={id:'workshop:a',role:'workshop',taskId:'a',town:'OakTown',title:'Recent tool use',reason:'Bash succeeded; command contents are not inferred.'};
  const value={workshops:[{taskId:'a',town:'OakTown'},{taskId:'b',town:'PineTown'}],stories:[story]};
  assert.equal(scopedTrades(value,'OakTown').workshops.length,1);
  assert.equal(tradeStoryForSite({role:'workshop',taskId:'a',town:'OakTown'},value,'OakTown'),story);
  assert.equal(tradeStoryForSite({role:'workshop',taskId:'missing',town:'OakTown'},value),null);
  assert.equal(tradeStoryForSite({role:'workshop',taskId:'a',town:'PineTown'},value),null);
  const html=tradePanelHTML({trades:value,tasks,townFilter:'OakTown',selectedId:story.id});
  assert.match(html,/0 miners · 1 workshops · 0 road crews/);assert.match(html,/Workshop · Recent tool use/);
  assert.match(html,/command contents are not inferred/);assert.match(html,/data-cc-inspect="a"/);assert.doesNotMatch(html,/PineTown|data-cc-inspect="b"/);
  assert.doesNotMatch(tradePanelHTML({trades}),/0 workshops/);
});
