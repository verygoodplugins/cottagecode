import test from 'node:test';
import assert from 'node:assert/strict';
import {parentPaths} from '../src/parent-paths.mjs';
import {createTownLayout} from '../src/town-layout.mjs';

const agent = (id,extra={}) => ({id,town:'HubTown',...extra});
const samples = points => points.flatMap((b,i) => {
  if(!i)return [b];
  const a=points[i-1],length=Math.abs(b.x-a.x)+Math.abs(b.y-a.y);
  assert.ok(a.x===b.x || a.y===b.y,'Every footpath turn must be orthogonal');
  return Array.from({length},(_,n)=>({x:a.x+Math.sign(b.x-a.x)*(n+1),y:a.y+Math.sign(b.y-a.y)*(n+1)}));
});
const inside = (p,r) => p.x>r.x && p.x<r.x+r.w && p.y>r.y && p.y<r.y+r.h;
const rendered = world => world.plots.map(p=>({...p,kids:[]}));

test('shed footpaths reach both doors and skirt the branch sign and workbench',()=>{
  const parent=agent('parent'),child=agent('child',{parent:'parent'});
  const world=createTownLayout().update([parent,child]),plots=rendered(world),plot=plots[0];
  plot.kids=[{agent:child,x:plot.x+1,y:plot.y+115}];
  const [path]=parentPaths(plots,world),points=samples(path.points);
  assert.equal(path.kind,'yard');
  assert.deepEqual(path.points[0],{x:plot.x+27,y:plot.y+64});
  assert.deepEqual(path.points.at(-1),{x:plot.x+12,y:plot.y+130});
  const furniture=[{x:plot.x+4,y:plot.y+79,w:46,h:10},{x:plot.x+30,y:plot.y+95,w:24,h:12}];
  for(const point of points)assert.equal(furniture.some(box=>inside(point,box)),false,'Family path crosses yard furniture');
  assert.ok(points.some(p=>p.x<plot.x),'The path wraps around the yard');
});

test('only explicit links between rendered endpoints produce paths',()=>{
  const world=createTownLayout().update([agent('a',{branch:'same'}),agent('b',{branch:'same'})]);
  const plots=rendered(world);
  assert.deepEqual(parentPaths(plots,world),[]);
  plots[1].agent.parent='unknown';
  assert.deepEqual(parentPaths(plots,world),[]);
  plots[1].agent.parent='a';
  assert.equal(parentPaths(plots,world).length,1);
  assert.deepEqual(parentPaths(plots.slice(1),world),[]);
  plots[1].agent.parent='b';
  assert.deepEqual(parentPaths(plots,world),[]);
});

test('overflow children follow row lanes and district streets without crossing cottages',()=>{
  const layout=createTownLayout({columns:2,rows:1,maxWidth:1000});
  const residents=[agent('parent'),...Array.from({length:7},(_,i)=>agent('child-'+i,{parent:'parent'}))];
  const world=layout.update(residents),plots=rendered(world),paths=parentPaths(plots,world);
  assert.equal(paths.length,4,'Only the four rendered overflow cottages have endpoints');
  assert.ok(paths.some(p=>p.points.length>4),'At least one child uses a district street');
  for(const path of paths){
    const from=plots.find(p=>p.agent.id===path.parent.id),to=plots.find(p=>p.agent.id===path.child.id);
    assert.deepEqual(path.points[0],{x:from.x+27,y:from.y+64});
    assert.deepEqual(path.points.at(-1),{x:to.x+27,y:to.y+64});
    for(const point of samples(path.points)){
      assert.equal(plots.some(p=>inside(point,{x:p.x,y:p.y,w:54,h:63})),false,'A family route crosses a cottage');
      if(!world.blocks.some(b=>inside(point,b)))assert.ok(world.roads.some(r=>point.x>=r.x && point.x<=r.x+r.w && point.y>=r.y && point.y<=r.y+r.h),'A route outside a district must follow a real street');
    }
  }
});

test('a roommate can parent a shed without inventing a link to the host',()=>{
  const host=agent('host'),mate=agent('mate'),child=agent('child',{parent:'mate'});
  const world=createTownLayout().update([host]);
  const plots=rendered(world),plot=plots[0];
  plot.agent={...host,roommates:[mate]};plot.kids=[{agent:child,x:plot.x+19,y:plot.y+115}];
  const [path]=parentPaths(plots,world);
  assert.equal(path.parent.id,'mate');assert.equal(path.parentHost,'host');
  assert.equal(path.child.id,'child');assert.equal(path.kind,'yard');
});

test('shed-to-shed paths stay orthogonal when their door heights differ',()=>{
  const world=createTownLayout().update([agent('host')]),plots=rendered(world),plot=plots[0];
  plot.kids=[{agent:agent('parent'),x:plot.x+1,y:plot.y+115},
    {agent:agent('child',{parent:'parent'}),x:plot.x+19,y:plot.y+105}];
  const [path]=parentPaths(plots,world);
  samples(path.points);
  assert.deepEqual(path.points[0],{x:plot.x+12,y:plot.y+130});
  assert.deepEqual(path.points.at(-1),{x:plot.x+30,y:plot.y+120});
});

test('late arrivals do not move existing family routes and missing streets fail closed',()=>{
  const layout=createTownLayout({columns:2,rows:1,maxWidth:1000});
  const residents=[agent('parent'),...Array.from({length:6},(_,i)=>agent('child-'+i,{parent:'parent'}))];
  const first=layout.update(residents),before=parentPaths(rendered(first),first);
  const next=layout.update([...residents,agent('new',{town:'NewTown'})]);
  assert.deepEqual(parentPaths(rendered(next),next),before);
  const disconnected=parentPaths(rendered(first),{...first,roads:[]});
  for(const path of disconnected){
    const from=first.plots.find(p=>p.agent.id===path.parent.id),to=first.plots.find(p=>p.agent.id===path.child.id);
    assert.equal(from.blockId,to.blockId,'Disconnected districts must not gain a straight-line shortcut');
  }
});
