import test from 'node:test';
import assert from 'node:assert/strict';
import {townPulses,townPulseLabel,activityVisit,bindSceneBalance,projectBounds} from '../src/command-workbench.mjs';
import {fleetView} from '../src/command-model.mjs';

test('project pulse deduplicates shared PRs and preserves stale and quiet evidence',()=>{
  const now=Date.parse('2026-11-05T00:00:00Z');
  const pr={url:'https://github.com/example/repo/pull/2',number:2,authority:'hub',state:'open',reviewState:'ready',checkedAt:now};
  const agents=[{id:'a',town:'MemTown',status:'working',lastProgressAt:now-20*60000,pr},{id:'b',town:'MemTown',status:'blocked',pr},{id:'c',town:'HubTown',status:'idle',isStale:true}];
  const pulses=townPulses(fleetView(agents,{now,includeSettled:true}).tasks);
  assert.deepEqual(pulses,[{name:'MemTown',total:2,working:1,attention:1,quiet:1,stale:false,ready:1},{name:'HubTown',total:1,working:0,attention:0,quiet:0,stale:true,ready:0}]);
});

test('balance drag and keyboard change update both layout shares and accessible output immediately',()=>{
  const listeners=new Map(),styles=new Map(),attrs=new Map(),changes=[];
  const input={value:'55',addEventListener:(kind,fn)=>listeners.set(kind,fn),removeEventListener:kind=>listeners.delete(kind),setAttribute:(key,value)=>attrs.set(key,value)};
  const output={textContent:''};
  const dispose=bindSceneBalance({input,output,root:{style:{setProperty:(key,value)=>styles.set(key,value)}},onResize:value=>changes.push(value)});
  for(const [value,expected] of [['30',30],['72',72],['200',75],['invalid',55]]){
    input.value=value;listeners.get('input')();
    assert.equal(styles.get('--cc-scene-share'),`${expected}fr`);
    assert.equal(styles.get('--cc-desk-share'),`${100-expected}fr`);
    assert.equal(output.textContent,`${expected}% town`);
    assert.equal(attrs.get('aria-valuetext'),`${expected}% town, ${100-expected}% workbench`);
  }
  input.value='63';listeners.get('change')();assert.equal(changes.at(-1),63);
  dispose();assert.equal(listeners.size,0);
});

test('project focus includes resting cottages and never mutates plot geometry',()=>{
  const plots=[{x:100,y:100,agent:{town:'MemTown',status:'working'}},{x:300,y:400,agent:{town:'MemTown',status:'idle'}},{x:900,y:100,agent:{town:'HubTown'}}];
  const before=JSON.stringify(plots);
  assert.deepEqual(projectBounds(plots,'MemTown'),{x:76,y:64,w:302,h:482});
  assert.equal(projectBounds(plots,'MissingTown'),null);
  assert.equal(JSON.stringify(plots),before);
});

test('project pulse retains ready PRs alongside attention counts',()=>{
  assert.equal(townPulseLabel({working:1,attention:25,ready:6}),'1 working · 25 check · 6 ready');
  assert.equal(townPulseLabel({stale:true,working:1,attention:25,ready:6}),'Last seen · 25 check · 6 ready');
  assert.equal(townPulseLabel({working:0,attention:0,ready:0}),'Resting');
});

test('Visit activity prefers fresh working then input then ready then exact selected cottage',()=>{
  const selected={id:'selected'},ready={id:'ready',prStage:'ready'},input={id:'input',input:{prompt:'Help?'}},
    stale={id:'stale',status:'working',sourceStale:true},quiet={id:'quiet',status:'working',quiet:true},working={id:'working',status:'working'};
  const tasks=[selected,ready,input,stale,quiet,working],before=structuredClone(tasks);
  assert.equal(activityVisit(tasks,'selected').task,working);
  assert.equal(activityVisit(tasks.slice(0,-1),'selected').task,input);
  assert.equal(activityVisit([selected,ready,stale,quiet],'selected').task,ready);
  assert.equal(activityVisit([selected,stale,quiet],'selected').task,selected);
  assert.equal(activityVisit([stale,quiet],'not-in-this-town'),null);
  assert.equal(activityVisit([]),null);assert.deepEqual(tasks,before);
});

test('Visit activity prefers the latest recent tool evidence and preserves input order on ties',()=>{
  const now=Date.parse('2026-11-06T12:00:00Z');
  const working=(id,toolActivity)=>({id,status:'working',raw:{toolActivity}});
  const unreported=working('unreported'),older=working('grep',{name:'Grep',state:'succeeded',at:now-30000}),
    latest=working('bash',{name:'Bash',state:'started',at:new Date(now-5000).toISOString()}),
    tied=working('shell',{name:'shell',state:'succeeded',at:now-5000});
  const tasks=[unreported,older,latest,tied],before=structuredClone(tasks);
  assert.equal(activityVisit(tasks,null,now).task,latest);
  assert.equal(activityVisit([unreported,tied,latest],null,now).task,tied);
  assert.deepEqual(tasks,before);
});

test('Visit activity never prefers untrusted tool evidence over the existing working fallback',()=>{
  const now=Date.parse('2026-11-06T12:00:00Z');
  const fallback={id:'first-working',status:'working'};
  const valid={name:'Bash',state:'succeeded',at:now-1000};
  const invalidTools=[
    {...valid,state:'failed'},{...valid,state:'cancelled'},{...valid,state:'unknown'},
    {...valid,at:now+1},{...valid,at:'invalid'},{...valid,at:null},{...valid,at:0},
    {...valid,at:now-120000},{...valid,at:now-120001},{...valid,stale:true},
    {...valid,name:''},{...valid,name:'  '},{...valid,name:42},
  ];
  for(const toolActivity of invalidTools){
    const candidate={id:'candidate',status:'working',raw:{toolActivity}};
    assert.equal(activityVisit([fallback,candidate],null,now).task,fallback,JSON.stringify(toolActivity));
  }
  for(const extra of [{sourceStale:true},{quiet:true},{status:'idle'},{status:'blocked'}]){
    const candidate={id:'candidate',status:'working',raw:{toolActivity:valid},...extra};
    assert.equal(activityVisit([fallback,candidate],null,now).task,fallback,JSON.stringify(extra));
  }
  for(const at of [now,now-119999]){
    const candidate={id:'candidate',status:'working',raw:{toolActivity:{...valid,at}}};
    assert.equal(activityVisit([fallback,candidate],null,now).task,candidate);
  }
});
