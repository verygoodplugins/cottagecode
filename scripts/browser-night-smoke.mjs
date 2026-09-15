#!/usr/bin/env node
/** Real Chrome check of pixels, bedtime, and access to a sleeping host. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFeedServer} from '../src/feed.mjs';

const run=promisify(execFile),page='cottagecode-night-smoke',stamp=Date.now();
const pr={number:123,url:'https://github.com/example/cottage/pull/123',state:'open',labels:['babysit:ready'],headSha:'night-head',source:'browser-fixture',checkedAt:stamp};
let agents=[
  {id:'night-host',taskId:'night-task',name:'Night Owl',town:'HubTown',status:'working',pr},
  {id:'night-sleeper',taskId:'quiet-task',name:'Sleepy',town:'HubTown',status:'idle',originalAsk:'A recorded request remains accessible after bedtime.',pr:{state:'none',source:'browser-fixture',checkedAt:stamp}},
  {id:'night-done',taskId:'complete-task',name:'Finished Finch',town:'HubTown',status:'done',pr},
  {id:'night-kid',name:'Pip',parent:'night-host',town:'HubTown',status:'working',pr},
];
const server=createFeedServer({snapshot:()=>({agents,source:'browser-fixture',checkedAt:Date.now()})}).listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function browser(op,args=[]){
  const {stdout}=await run('browser-hand',[op,'--page-name',page,...args],{timeout:30000,maxBuffer:2e6});
  const result=JSON.parse(stdout);assert.equal(result.success,true,JSON.stringify(result));return result;
}
const evaluate=async code=>(await browser('evaluate',['--code',code])).result;
const click=selector=>browser('click',['--selector',selector]);
const fill=(selector,value)=>browser('fill',['--fields',JSON.stringify({[selector]:value})]);
const state=()=>evaluate('window.cottageState()');
async function until(code,message,timeout=18000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(code))return;await delay(250);}throw new Error(message);
}
function pass(label){process.stdout.write('PASS '+label+'\n');}
const samples=()=>evaluate(`(()=>{
  const c=document.getElementById('town'),ctx=c.getContext('2d'),s=window.cottageState();let total=[0,0,0],n=0;
  for(let y=16;y<c.height;y+=24)for(let x=16;x<c.width;x+=24){const d=ctx.getImageData(x,y,1,1).data;for(let i=0;i<3;i++)total[i]+=d[i];n++;}
  const p=s.plots.find(p=>p.id==='night-host'),q=s.plots.find(p=>p.id==='night-sleeper'),r=s.plots.find(p=>p.id==='night-done'),kid=p.kids.find(k=>k.agent.id==='night-kid');
  const pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3);
  return {mean:total.map(v=>v/n),working:pixel(p.x+13,p.y+43),sleeping:pixel(q.x+13,q.y+43),shed:pixel(kid.x+4,kid.y+11),done:pixel(r.x+47,r.y+22),pr:pixel(p.x-9,p.y+54)};
})()`);
try{
  await browser('open',['--url','http://127.0.0.1:'+server.address().port]);
  await until('!!window.cottageObservatory?.state.selected','Village did not load');
  await browser('snapshot');await click('#village-settings > summary');await fill('#village-time','Day');
  await until('window.cottageObservatory.state.phase==="day"','Day preview failed');
  const daylight=await samples(),original=(await state()).agents.map(a=>[a.id,a.status]);
  await fill('#village-time','Night');
  await until('window.cottageState().bedtime.some(r=>r.mode==="gathering")','Families did not gather');
  const moving=(await state()).bedtime.find(r=>r.id==='night-host');assert.equal(moving.kids[0].hidden,false);
  assert.equal((await state()).bedtime.find(r=>r.id==='night-sleeper').settled,false,'the selected host is still walking home');
  await evaluate("window.cottageObservatory.enter('night-sleeper')");
  await until('window.cottageObservatory.state.mode==="room"','Cottage did not open during homecoming');
  assert.equal((await state()).scene.resting,false,'a host remains outside until its own homecoming settles');
  await evaluate('window.cottageObservatory.leave()');
  await until('window.cottageObservatory.state.mode==="town"','Cottage did not close after the homecoming check');
  await until('window.cottageState().bedtime.every(r=>r.settled)','Families did not settle');
  const after=await state(),dark=await samples();
  assert.deepEqual(after.agents.map(a=>[a.id,a.status]),original);
  assert.ok(after.bedtime.every(r=>r.hens.every(h=>h.hidden)));
  const host=after.bedtime.find(r=>r.id==='night-host'),apprentice=host.kids.find(k=>k.id==='night-kid'),shed=after.plots.find(p=>p.id==='night-host').kids.find(k=>k.agent.id==='night-kid');
  assert.equal(apprentice.hidden,false,'a working apprentice remains available at their shed');
  assert.equal(apprentice.walking,false);
  assert.deepEqual({x:apprentice.x,y:apprentice.y},{x:shed.x+8,y:shed.y+20});
  const luminance=rgb=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  assert.ok(luminance(dark.mean)<luminance(daylight.mean)*.7,JSON.stringify({daylight,dark}));
  assert.ok(dark.mean[2]>dark.mean[1]&&dark.mean[1]>dark.mean[0]);
  assert.ok(dark.working[0]>dark.working[2]*1.5&&luminance(dark.working)>luminance(dark.sleeping)*2);
  assert.ok(dark.shed[0]>dark.shed[2]*1.5,'the awake apprentice keeps a warm shed light');
  assert.deepEqual(dark.done,[121,194,95],'completed residents retain a green status marker after settling');
  assert.deepEqual(dark.pr,daylight.pr,'PR readiness color must survive the palette');
  pass('actual night pixels are darker and blue, working windows warm, PR colors unchanged, families tucked in');
  agents=[...agents,{id:'night-arrival',taskId:'arrival-task',name:'New Neighbor',parent:'night-host',town:'HubTown',status:'idle',pr:{state:'none',source:'browser-fixture',checkedAt:Date.now()}}];
  await until("window.cottageObservatory.state.apprentices===1&&!!window.cottageObservatory.apprenticeArrival('night-arrival')",'New apprentice did not begin their arrival walk');
  const arrivalParcel=await evaluate(`(async()=>{await new Promise(requestAnimationFrame);const c=document.getElementById('town'),p=window.cottageObservatory.apprenticeArrival('night-arrival');return p?Array.from(c.getContext('2d').getImageData(Math.round(p.x+6),Math.round(p.y-6),1,1).data).slice(0,3):null;})()`);
  assert.ok(arrivalParcel[2]>arrivalParcel[0]+20,'new arrival parcel should use the blue night palette: '+arrivalParcel);
  pass('a newly arriving apprentice and parcel share the night palette');
  await click('[data-cottage="night-sleeper"]');await click('[data-action="enter"]');
  await until('window.cottageObservatory.state.resting','Host did not go to bed');
  const roomSeed=(await state()).scene.roomSeed;
  await evaluate(`(async()=>{
    const {createInterior,isWalkable}=await import('/modules/interiors.mjs'),s=window.cottageState(),room=createInterior(s.agents.find(a=>a.id===s.scene.interiorId));
    const start=s.scene.roomPlayer,host=s.scene.resident,step=4,queue=[{...start,key:'0,0'}],parents=new Map([['0,0',null]]);let goal=null;
    for(let i=0;i<queue.length;i++){
      const p=queue[i];if(Math.hypot(p.x-host.x,p.y-host.y)<24){goal=p.key;break;}
      const [gx,gy]=p.key.split(',').map(Number);
      for(const [dx,dy]of [[1,0],[-1,0],[0,-1],[0,1]]){const key=(gx+dx)+','+(gy+dy),n={x:start.x+(gx+dx)*step,y:start.y+(gy+dy)*step,key};if(parents.has(key)||n.y>154||!isWalkable(room,n.x,n.y))continue;parents.set(key,{key:p.key,point:n});queue.push(n);}
    }
    if(!goal)throw new Error('Bedside is unreachable');const path=[];while(parents.get(goal)){const e=parents.get(goal);path.unshift(e.point);goal=e.key;}
    const canvas=document.getElementById('room-canvas');canvas.focus();
    for(const target of path){const p=window.cottageObservatory.state.roomPlayer,horizontal=Math.abs(target.x-p.x)>Math.abs(target.y-p.y),axis=horizontal?'x':'y',sign=Math.sign(target[axis]-p[axis]);if(Math.abs(target[axis]-p[axis])<1)continue;
      const key=horizontal?(sign>0?'ArrowRight':'ArrowLeft'):(sign>0?'ArrowDown':'ArrowUp');canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
      try{const end=performance.now()+800;while(sign*(target[axis]-window.cottageObservatory.state.roomPlayer[axis])>0&&performance.now()<end)await new Promise(requestAnimationFrame);}finally{window.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true}));}
    }
    if(Math.hypot(window.cottageObservatory.state.roomPlayer.x-host.x,window.cottageObservatory.state.roomPlayer.y-host.y)>=30)throw new Error('Did not reach bedside');
    canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'e',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keyup',{key:'e',bubbles:true}));
  })()`);
  await until('window.cottageObservatory.state.tab==="talk"','E beside the bed did not open the conversation');
  await browser('snapshot');
  assert.match(await evaluate('document.querySelector("#panel").textContent'),/A word with Sleepy/);
  await click('[data-action="tab:request"]');assert.match(await evaluate('document.querySelector("#panel").textContent'),/recorded request remains accessible/);
  agents=agents.map(a=>a.id==='night-sleeper'?{...a,status:'working',updatedAt:Date.now()}:a);
  await until('!window.cottageObservatory.state.resting','Working agent did not return to workbench');
  assert.equal((await state()).scene.roomSeed,roomSeed);
  pass('walked to the bed, pressed E, read the request, and watched a real status update wake the host without moving furniture');
  await click('[data-action="leave"]');await fill('#village-time','Day');
  await until('window.cottageState().bedtime.every(r=>r.mode==="day")','Day did not wake families');
  assert.ok((await state()).bedtime.every(r=>r.kids.every(k=>!k.hidden)&&r.hens.every(h=>!h.hidden)));
  assert.equal((await state()).scene.music.enabled,false);
  pass('day restores families, music remains off');
}finally{server.close();}
