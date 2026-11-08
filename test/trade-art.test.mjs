import test from 'node:test';
import assert from 'node:assert/strict';
import {drawTradeLife,tradeSites} from '../src/trade-art.mjs';
const fixtures=()=>({
  plots:[{agent:{id:'a',town:'OakTown',roommates:[{id:'mate',town:'OakTown'}]},x:40,y:60,kids:[{agent:{id:'kid',town:'OakTown'},x:100,y:150}]},
    {agent:{id:'b',town:'PineTown'},x:340,y:60,kids:[]}],
  districts:[{key:'OakTown',x:0,y:0,w:240,h:240},{key:'PineTown',x:300,y:0,w:240,h:240}],
  roads:[{x:0,y:140,w:240,h:24},{x:240,y:0,w:48,h:300},{x:0,y:250,w:600,h:40}],
  trades:{miners:[{taskId:'a',town:'OakTown'},{taskId:'b',town:'PineTown'}],
    roads:[{id:'link',fromId:'a',toId:'b',fromTown:'OakTown',toTown:'PineTown'}],
    gardens:[{town:'OakTown',arrivals:4,growth:'spurt',taskIds:['a']},{town:'PineTown',arrivals:1,growth:'growing',taskIds:['b']}]}
});
function canvas(fail=false) {
  const calls=[], stack=[];
  const ctx={calls,fillStyle:'original',save(){stack.push(this.fillStyle);calls.push(['save']);},restore(){this.fillStyle=stack.pop();calls.push(['restore']);},
    beginPath(){calls.push(['begin']);},rect(...v){calls.push(['rect',...v]);},clip(){calls.push(['clip']);},
    fillRect(...v){if(fail)throw Error('paint failed');calls.push(['fill',this.fillStyle,...v]);}};
  Object.defineProperty(ctx,'depth',{get:()=>stack.length});return ctx;
}
test('every miner belongs to its exact visible household, including roommates and children',()=>{
  const f=fixtures();f.trades.miners=[{taskId:'missing',town:'OakTown'},{taskId:'b',town:'OakTown'},{taskId:'mate',town:'OakTown'},{taskId:'kid',town:'OakTown'}];
  const sites=tradeSites(f).filter(s=>s.role==='miner');
  assert.equal(sites.length,1,'one compact work yard per household');assert.equal(sites[0].taskId,'mate');
  assert.equal(sites[0].x,96);assert.equal(sites[0].y,101);
  f.trades.miners=[{taskId:'kid',town:'OakTown'}];assert.equal(tradeSites(f).find(s=>s.role==='miner').taskId,'kid');
  f.plots=[];assert.deepEqual(tradeSites(f),[]);
});
test('workshops use exact household yards and do not overlap a miner in the same household',()=>{
  const f=fixtures();f.trades.miners=[{taskId:'a',town:'OakTown'}];
  f.trades.workshops=[{taskId:'mate',town:'OakTown'},{taskId:'missing',town:'PineTown'},{taskId:'b',town:'PineTown'}];
  let sites=tradeSites(f).filter(s=>s.role==='workshop');
  assert.equal(sites.length,1);assert.equal(sites[0].taskId,'b');assert.equal(sites[0].town,'PineTown');
  assert.equal(sites[0].x,396);assert.equal(sites[0].y,101);
  f.townFilter='OakTown';assert.equal(tradeSites(f).filter(s=>s.role==='workshop').length,0);
  f.trades.miners=[];sites=tradeSites(f).filter(s=>s.role==='workshop');assert.equal(sites[0].taskId,'mate');
  f.plots=[];assert.deepEqual(tradeSites(f),[]);
});
test('last-column roommate activity uses its own left yard inside the district',()=>{
  const f={districts:[{key:'HubTown',id:'HubTown:0',x:114,y:30,w:330,h:356}],
    plots:[132,212,292,372].flatMap(x=>[96,232].map(y=>({x,y,agent:{id:`${x}-${y}`,town:'HubTown',roommates:x===372&&y===232?[{id:'live-roommate',town:'HubTown'}]:[]}})))};
  for(const [key,role] of [['miners','miner'],['workshops','workshop']]){
    const sites=tradeSites({...f,trades:{[key]:[{taskId:'live-roommate',town:'HubTown',toolName:role==='miner'?'Grep':'Bash'}]}});
    assert.equal(sites.length,1);const site=sites[0];
    assert.equal(site.role,role);assert.equal(site.taskId,'live-roommate');
    assert.deepEqual({x:site.x,y:site.y,w:site.w,h:site.h},{x:347,y:273,w:23,h:24});
    assert.ok(site.x>292+54&&site.x+site.w<372,'yard stays between adjacent cottage bodies');
    assert.ok(site.y+site.h<232+66,'yard remains above the doorway, front lane and branch sign');
    assert.ok(site.x>=114&&site.x+site.w<=444,'yard remains inside its recorded district');
  }
  const busy=tradeSites({...f,trades:{miners:[{taskId:'292-232',town:'HubTown'}],workshops:[{taskId:'live-roommate',town:'HubTown'}]}});
  assert.equal(busy.length,1,'do not overlap the neighbouring miner when both side yards are unavailable');
  assert.equal(busy[0].taskId,'292-232');
  assert.deepEqual(tradeSites({...f,trades:{workshops:[{taskId:'missing-roommate',town:'HubTown'}]}}),[]);
});
test('workshop paint moves only with fresh motion enabled and preserves canvas state',()=>{
  const f=fixtures();f.trades={workshops:[{taskId:'a',town:'OakTown',toolName:'Bash'}]};
  for(const flag of ['reduce','stale']){
    const a=canvas(),b=canvas();drawTradeLife(a,{...f,[flag]:true,time:0});drawTradeLife(b,{...f,[flag]:true,time:1});
    assert.deepEqual(a.calls,b.calls);assert.equal(a.depth,0);assert.equal(a.fillStyle,'original');
  }
  const a=canvas(),b=canvas();drawTradeLife(a,{...f,time:0});drawTradeLife(b,{...f,time:1});assert.notDeepEqual(a.calls,b.calls);
  const site=tradeSites(f)[0];assert.equal(site.role,'workshop');assert.equal(site.evidence.toolName,'Bash');
});
test('roads require recorded endpoints and stay inside an actual street',()=>{
  const f=fixtures();const site=tradeSites(f).find(s=>s.role==='road');
  assert.equal(site.taskId,'b');assert.equal(site.town,'PineTown');
  assert.ok(f.roads.some(r=>site.x>=r.x&&site.y>=r.y&&site.x+site.w<=r.x+r.w&&site.y+site.h<=r.y+r.h));
  f.trades.roads=[{fromId:'missing',toId:'also-missing',fromTown:'OakTown',toTown:'OakTown'}];
  assert.equal(tradeSites(f).filter(s=>s.role==='road').length,0);
  f.trades.roads=[{fromId:'a',fromTown:'OakTown'}];f.roads=[];
  assert.equal(tradeSites(f).filter(s=>s.role==='road').length,0);
});
test('town filtering applies to every trade and can use the visible recorded endpoint',()=>{
  const f={...fixtures(),townFilter:'OakTown'};
  const sites=tradeSites(f);assert.ok(sites.length>=3);assert.ok(sites.every(s=>s.town==='OakTown'));
  assert.equal(sites.find(s=>s.role==='road').taskId,'a');
  f.plots=f.plots.filter(p=>p.agent.id==='b');assert.deepEqual(tradeSites(f),[]);
});
test('gardens fit district margins and avoid houses and their signs',()=>{
  const f=fixtures();const sites=tradeSites(f).filter(s=>s.role==='gardener');assert.equal(sites.length,2);
  for(const s of sites) {assert.ok(s.x>=s.clip.x&&s.y>=s.clip.y&&s.x+s.w<=s.clip.x+s.clip.w&&s.y+s.h<=s.clip.y+s.clip.h);}
  f.districts=[{key:'OakTown',x:40,y:60,w:60,h:70}];assert.equal(tradeSites(f).filter(s=>s.role==='gardener').length,0);
});
test('reduced motion and stale scenes are completely still across clocks',()=>{
  for(const flag of ['reduce','stale']) {
    const a=canvas(),b=canvas();drawTradeLife(a,{...fixtures(),[flag]:true,time:0});drawTradeLife(b,{...fixtures(),[flag]:true,time:123.9});
    assert.deepEqual(a.calls,b.calls);
  }
  const a=canvas(),b=canvas();drawTradeLife(a,{...fixtures(),time:0});drawTradeLife(b,{...fixtures(),time:1});assert.notDeepEqual(a.calls,b.calls);
});
test('every site is clipped; canvas state and inputs survive drawing and paint failures',()=>{
  const f=fixtures(),before=structuredClone(f),ctx=canvas();drawTradeLife(ctx,f);
  assert.equal(ctx.depth,0);assert.equal(ctx.fillStyle,'original');assert.deepEqual(f,before);
  assert.equal(ctx.calls.filter(c=>c[0]==='clip').length,tradeSites(f).length*2);
  const broken=canvas(true);assert.throws(()=>drawTradeLife(broken,f),/paint failed/);assert.equal(broken.depth,0);assert.equal(broken.fillStyle,'original');
});
test('growth seedlings are bounded independently of reported arrivals',()=>{
  const f=fixtures();f.trades={gardens:[{town:'OakTown',arrivals:6,growth:'spurt'}]};
  const a=canvas();drawTradeLife(a,f);f.trades.gardens[0].arrivals=1000000;
  const b=canvas();drawTradeLife(b,f);assert.deepEqual(a.calls,b.calls);assert.equal(f.trades.gardens[0].arrivals,1000000);
});

test('town links use the exact visible recorded district and its adjacent streets',()=>{
  const f=fixtures();f.trades={roads:[{fromId:null,toId:null,fromTown:'OakTown',toTown:'PineTown'}]};
  let site=tradeSites(f)[0];assert.equal(site.town,'PineTown');assert.equal(site.taskId,null);
  f.townFilter='OakTown';site=tradeSites(f)[0];assert.equal(site.town,'OakTown');assert.equal(site.taskId,null);
  f.townFilter='';f.trades.roads=[{toTown:'MissingTown'}];assert.deepEqual(tradeSites(f),[]);
  f.trades.roads=[{toTown:'PineTown'}];f.plots=f.plots.filter(p=>p.agent.town==='OakTown');assert.deepEqual(tradeSites(f),[]);
  f.plots=fixtures().plots;f.roads=[{x:1000,y:1000,w:100,h:40}];assert.deepEqual(tradeSites(f),[]);
  f.trades.roads=[{toId:'b',toTown:'PineTown'}];assert.deepEqual(tradeSites(f),[]);
});

test('a cottage in the middle of a wide district still uses that district’s street',()=>{
  const site=tradeSites({plots:[{agent:{id:'middle',town:'OakTown'},x:212,y:96}],
    districts:[{key:'OakTown',x:114,y:50,w:330,h:336}],
    roads:[{x:66,y:0,w:48,h:434},{x:444,y:0,w:48,h:434}],
    trades:{roads:[{id:'parent',toId:'middle',toTown:'OakTown'}]}}).find(s=>s.role==='road');
  assert.ok(site);assert.equal(site.taskId,'middle');assert.ok(site.x>=66&&site.x+site.w<=114);
});
