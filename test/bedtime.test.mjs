import test from 'node:test';
import assert from 'node:assert/strict';
import {createBedtimeRoutine,isBedtime,roomRest,paintBed,routineForAgent,statusBubbleAnchor,villageLifeLabel,visibleBedtimeKids} from '../src/bedtime.mjs';
import {isApprenticeArrivalActive} from '../src/observatory.mjs';
import {createInterior,isWalkable} from '../src/interiors.mjs';

const plots=Array.from({length:8},(_,i)=>({x:80+i*80,y:100,agent:{id:'home-'+i,taskId:'task-one',status:i===0?'working':i===1?'blocked':'idle'},
  kids:i===0?[{x:81,y:215,agent:{id:'child',parent:'home-0',status:'working'}}]:[]}));
const night={hour:23},day={hour:12};

test('bedtime follows the evening clock including midnight, not invalid input',()=>{
  for(const hour of [0,4.99,18.5,19,23])assert.equal(isBedtime({hour}),true);
  for(const hour of [5,12,18.49,null,undefined,NaN,'night'])assert.equal(isBedtime({hour}),false);
});

test('village-life copy follows the clock when no families are rendered',()=>{
  assert.equal(villageLifeLabel(night,[]),'The village is tucked in · 0 cottages working late');
  assert.equal(villageLifeLabel(day,[]),'Daytime · Children and chickens in the gardens');
  assert.equal(villageLifeLabel(night,[{evening:true,settled:false}]),'Families are heading home · Chickens to their coops');
});

test('families gather once, then children and hens get indoors without changing task state',()=>{
  const copy=structuredClone(plots),routine=createBedtimeRoutine();
  const first=routine.update(copy,night,{time:100});
  assert.ok([...first.values()].every(r=>r.mode==='gathering'&&!r.settled));
  assert.ok([...first.values()].some(r=>r.hens.some(h=>!h.hidden)));
  const halfway=routine.update(copy,night,{time:106}).get('home-0');
  assert.notDeepEqual(halfway.parent,first.get('home-0').parent);
  assert.equal(halfway.kids[0].hidden,false);
  const settled=routine.update(copy,night,{time:115});
  assert.equal(settled.get('home-0').mode,'working-late');
  assert.equal(settled.get('home-1').mode,'asleep');
  assert.ok([...settled.values()].every(r=>r.settled&&r.hens.every(h=>h.hidden)&&r.kids.every(k=>k.hidden)));
  assert.deepEqual(copy,plots);
});

test('feed order, text, and status changes preserve the routine and stable flock',()=>{
  const routine=createBedtimeRoutine();routine.update(plots,night,{time:10});
  const a=routine.update(plots,night,{time:30});
  const refreshed=plots.toReversed().map(p=>({...p,agent:{...p.agent,lastLine:'new progress',updatedAt:Date.now(),status:'working'}}));
  const b=routine.update(refreshed,night,{time:30});
  for(const [id,frame] of a){
    assert.deepEqual(b.get(id).parent,frame.parent);
    assert.deepEqual(b.get(id).hens,frame.hens);
    assert.equal(b.get(id).settled,true);
    assert.equal(b.get(id).mode,'working-late');
  }
});

test('hidden settled cottages retain their homecoming state until the task leaves the feed',()=>{
  const routine=createBedtimeRoutine();
  routine.update(plots,night,{time:0,reduce:true,present:plots.map(plot=>plot.agent)});
  routine.update([],night,{time:4,present:plots.map(plot=>plot.agent)});
  const returned=routine.update(plots,night,{time:5,present:plots.map(plot=>plot.agent)});
  assert.ok([...returned.values()].every(frame=>frame.settled),'hiding a cottage must not discard its tucked-in family');

  routine.update([],night,{time:6,present:[]});
  const replacement=routine.update(plots,night,{time:7,present:plots.map(plot=>plot.agent)});
  assert.equal(replacement.get('home-0').settled,false,'a real task removal gets a fresh arrival when it returns');
});

test('blocked and done bubbles retain their moving or tucked-in anchors for a post-palette repaint',()=>{
  const plot={x:80,y:100},actor={x:93.2,y:134.6,indoors:false};
  assert.deepEqual(statusBubbleAnchor({agent:{status:'blocked'},plot,routine:{settled:false},actor,time:1,reduce:true}),{x:102,y:120,status:'blocked'});
  assert.deepEqual(statusBubbleAnchor({agent:{status:'done'},plot,routine:{settled:true},actor,time:1}),{x:127,y:122,status:'done'});
  assert.equal(statusBubbleAnchor({agent:{status:'idle'},plot,routine:{settled:false},actor}),null);
  assert.equal(statusBubbleAnchor({agent:{status:'blocked'},plot,routine:{settled:false},actor:{...actor,indoors:true}}),null);
});

test('day wakes the village; another evening and explicit new tasks have fresh arrivals',()=>{
  const routine=createBedtimeRoutine();routine.update(plots,night,{time:0});
  const morning=routine.update(plots,{hour:7},{time:100});
  assert.ok([...morning.values()].every(r=>r.mode==='day'&&!r.parent&&r.hens.every(h=>!h.hidden)));
  const dusk=routine.update(plots,{hour:19},{time:110});
  assert.ok([...dusk.values()].every(r=>r.mode==='gathering'));
  const before=routine.update(plots,night,{time:130});
  assert.ok([...before.values()].every(r=>r.settled),'dusk to night does not repeat homecoming');
  const changed=structuredClone(plots);changed[0].agent.taskId='task-two';
  const after=routine.update(changed,night,{time:140});
  assert.equal(after.get('home-0').settled,false);
  assert.equal(after.get('home-1').settled,true);
});

test('reduced motion immediately tucks families in and keeps scenery reproducible',()=>{
  const one=createBedtimeRoutine(),two=createBedtimeRoutine();
  const a=one.update(plots,night,{time:0,reduce:true});
  assert.deepEqual(a,two.update(plots.toReversed(),night,{time:900,reduce:true}));
  assert.ok([...a.values()].every(r=>r.settled));
  const calm=one.update(plots,day,{time:100,reduce:true});
  assert.deepEqual(calm,one.update(plots,day,{time:900,reduce:true}));
});

test('child sprites only represent recorded parent relationships',()=>{
  const frames=createBedtimeRoutine().update(plots,day);
  assert.deepEqual([...frames.values()].flatMap(r=>r.kids.map(k=>k.id)),['child']);
  assert.ok([...frames.values()].every(r=>r.hens.length<=2));
});

test('a newly arrived apprentice is not also drawn by the family routine',()=>{
  const routine=createBedtimeRoutine();
  const daytime=routine.update(plots,day,{time:100}).get('home-0');
  const gathering=routine.update(plots,night,{time:101}).get('home-0');
  const arrivals=[{id:'child',start:100}];
  const arriving=id=>isApprenticeArrivalActive(arrivals,id,101);
  assert.deepEqual(visibleBedtimeKids(daytime,arriving),[],'daytime shed position yields to the arrival walk');
  assert.deepEqual(visibleBedtimeKids(gathering,arriving),[],'evening family return yields to the arrival walk');
  assert.deepEqual(visibleBedtimeKids(gathering,id=>isApprenticeArrivalActive(arrivals,id,108)).map(kid=>kid.id),['child'],'the family routine resumes after the arrival walk');
});

test('disabling reduced motion does not bring a tucked family back outside',()=>{
  const routine=createBedtimeRoutine();routine.update(plots,night,{time:0});
  routine.update(plots,night,{time:1,reduce:true});
  assert.ok([...routine.update(plots,night,{time:2}).values()].every(r=>r.settled));
});

test('a settled family supplies bedtime state to its nonworking shed apprentice',()=>{
  const routine=createBedtimeRoutine();
  const frames=routine.update(plots,night,{time:0,reduce:true});
  const child={...plots[0].kids[0].agent,status:'idle'};
  const shared=routineForAgent(frames,child);
  assert.equal(shared,frames.get('home-0'));
  assert.ok(roomRest(createInterior(child),child,night,shared),'the tucked child uses its family arrival state');
  assert.equal(roomRest(createInterior(child),{...child,status:'working'},night,shared),null,'late child work stays awake');
  assert.equal(routineForAgent(frames,{id:'orphan',parent:'missing'}),null);
});

test('sleeping bed keeps room geometry stable and a reachable host in every layout',()=>{
  const layouts=new Set();
  for(let i=0;i<60;i++){
    const room=createInterior({id:'room-'+i,town:'MemTown'}),before=JSON.stringify(room);
    layouts.add(room.layout);
    const rest=roomRest(room,{status:'idle'},night,{settled:true});
    assert.ok(rest);assert.equal(rest.bed.id,'chair');
    let near=false;
    for(let y=room.floor.y;y<room.floor.y+room.floor.h;y+=2)for(let x=room.floor.x;x<room.floor.x+room.floor.w;x+=2)
      if(isWalkable(room,x,y)&&Math.hypot(x-rest.host.x,y-rest.host.y)<25)near=true;
    assert.ok(near,'host can be spoken to from a walking lane');
    assert.equal(roomRest(room,{status:'idle'},night,{settled:false}),null,'the indoor pose waits for this cottage to arrive home');
    assert.equal(roomRest(room,{status:'working'},night,{settled:true}),null);
    assert.equal(roomRest(room,{status:'blocked'},day),null);
    assert.equal(JSON.stringify(room),before);
  }
  assert.equal(layouts.size,4);
});

test('bed painter remains static under reduced motion and handles talking',()=>{
  const room=createInterior({id:'bed'}),rest=roomRest(room,{status:'idle'},night,{settled:true});
  const draw=(time,talking=false)=>{
    const calls=[],ctx={save(){},restore(){},fillRect(...rect){calls.push([...rect,this.fillStyle]);}};
    paintBed(ctx,room,rest,{time,reduce:true,talking});return calls;
  };
  assert.deepEqual(draw(0),draw(20));assert.notDeepEqual(draw(0),draw(0,true));
});
