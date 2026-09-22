import test from 'node:test';
import assert from 'node:assert/strict';
import {createTownLayout,townWidthBudget,townActivity,overviewBounds,districtRoute} from '../src/town-layout.mjs';

const fleet = () => ['HubTown','AppTown','MemTown','VaultTown','FusionTown'].flatMap((town,i) =>
  Array.from({length:i===0?7:i===3?2:1},(_,n)=>({id:town+'-'+n,town,status:i===2?'blocked':'working'})));
const positions = world => Object.fromEntries(world.plots.map(p=>[p.agent.id,[p.x,p.y,p.blockId]]));
const intersects = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;

test('compact towns use extra width without resizing cottages or reserving eight lots everywhere', () => {
  const narrow=createTownLayout({maxWidth:768}).update(fleet());
  const wide=createTownLayout({maxWidth:1500}).update(fleet());
  assert.ok(wide.height<narrow.height);
  assert.ok(wide.width>768);assert.ok(wide.width<=1500);
  assert.ok(wide.blocks.filter(b=>b.y===30).length>2);
  const small=wide.blocks.find(b=>b.key==='AppTown'),large=wide.blocks.find(b=>b.key==='HubTown');
  assert.equal(small.capacity,2);assert.ok(small.w*small.h<large.w*large.h);
  const row=wide.plots.filter(p=>p.agent.town==='HubTown'&&p.y===wide.plots[0].y).sort((a,b)=>a.x-b.x);
  assert.equal(row[1].x-row[0].x,80);
});

test('packing and branch groups are deterministic; updates never move existing plots', () => {
  const agents=fleet().map((a,i)=>({...a,branch:i%2?'feat/search':'fix/cache'}));
  const layout=createTownLayout({maxWidth:1280}),first=layout.update(agents);
  assert.deepEqual(positions(createTownLayout({maxWidth:1280}).update([...agents].reverse())),positions(first));
  const changed=[...agents].reverse().map(a=>({...a,status:'offline',branch:'renamed'}));
  const next=layout.update([...changed,...Array.from({length:40},(_,i)=>({id:'new-'+i,town:i%2?'HubTown':'NewTown',status:'working'}))]);
  for(const [id,position] of Object.entries(positions(first)))assert.deepEqual(positions(next)[id],position);
  for(const a of next.blocks)for(const b of next.blocks)if(a!==b)assert.equal(intersects({...a,w:a.w+48,h:a.h+48},b),false);
  assert.equal(new Set(next.plots.map(p=>p.x+','+p.y)).size,next.plots.length);
});

test('known default and exact branch labels group neighbors without inventing ancestry', () => {
  const agents=[
    {id:'unknown',town:'HubTown'},
    {id:'feature-b',town:'HubTown',branch:'feat/auth'},
    {id:'main',town:'HubTown',branch:'trunk',defaultBranch:'trunk'},
    {id:'feature-a',town:'HubTown',branch:'feat/auth'},
  ];
  const world=createTownLayout().update(agents);
  const ordered=[...world.plots].sort((a,b)=>a.y-b.y||a.x-b.x).map(p=>p.agent.id);
  assert.deepEqual(ordered,['main','feature-a','feature-b','unknown']);
  assert.equal(world.blocks.some(b=>'parentBranch' in b),false);
});

test('the noticeboard square remains reachable when the original busy town empties', () => {
  const layout=createTownLayout({maxWidth:1500}),first=layout.update(fleet());
  const after=layout.update(fleet().filter(a=>a.town==='AppTown'),{trimEmptyBlocks:true});
  assert.deepEqual(after.square,first.square);
  assert.ok(after.square.y+50<after.height+112,'Square and its benches must fit inside the world');
  assert.deepEqual(positions(after)['AppTown-0'],positions(first)['AppTown-0']);
});

test('width budget uses the normal cottage scale and reserves the desktop panel', () => {
  assert.equal(townWidthBudget({windowWidth:2077,standardWidth:1084}),1214);
  assert.equal(townWidthBudget({windowWidth:390,standardWidth:340}),827);
  assert.equal(townWidthBudget({windowWidth:8000,standardWidth:800}),1920);
});

test('town activity counts people once, including roommates and children', () => {
  const mate={id:'mate',town:'HubTown',status:'working'};
  const list=[{id:'host',town:'HubTown',status:'idle',roommates:[mate]},mate,
    {id:'kid',parent:'host',town:'HubTown',status:'blocked'},
    {id:'other',town:'AppTown',status:'working'}];
  assert.deepEqual(townActivity(list).get('HubTown'),{working:1,blocked:1,total:3,active:2});
});

test('Overview includes active households and shed yards, excluding quiet distant plots', () => {
  const plots=[{x:50,y:50,agent:{status:'idle',roommates:[{status:'working'}]}},
    {x:200,y:250,agent:{status:'done'},kids:[{agent:{status:'blocked'}}]},
    {x:1800,y:2400,agent:{status:'offline'}}];
  assert.deepEqual(overviewBounds(plots),{x:34,y:22,w:238,h:370});
  assert.deepEqual(overviewBounds(plots.slice(2)),{x:1784,y:2372,w:88,h:170});
  assert.equal(overviewBounds([]),null);
});

test('every district has connected streets and explicit routes avoid all cottage districts', () => {
  for(const maxWidth of [500,768,1100,1500]) {
    const world=createTownLayout({maxWidth}).update(fleet());
    for(const road of world.roads)for(const block of world.blocks)assert.equal(intersects(road,block),false,'Street crosses a district');
    for(const block of world.blocks) {
      const route=districtRoute(world,world.blocks[0],block);
      assert.ok(route.length,'District is unreachable');
      for(let i=1;i<route.length;i++) {
        const a=route[i-1],b=route[i];
        assert.ok(a.x===b.x||a.y===b.y);
        for(let f=0;f<=1;f+=.1) {
          const point={x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,w:.01,h:.01};
          assert.ok(world.roads.some(r=>point.x>=r.x&&point.x<=r.x+r.w&&point.y>=r.y&&point.y<=r.y+r.h));
          assert.equal(world.blocks.some(d=>intersects(point,d)),false);
        }
      }
    }
  }
});
