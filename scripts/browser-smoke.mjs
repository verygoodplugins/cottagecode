#!/usr/bin/env node
/** Optional real-Chrome integration check. Requires the browser-hand CLI/extension. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createFeedServer} from '../src/feed.mjs';
import {pageActivity} from '../src/activity.mjs';

const run=promisify(execFile),page='cottagecode-browser-smoke';
const stamp=Date.now(),pr={number:123,url:'https://github.com/example/observatory/pull/123',state:'open',labels:['babysit:ready'],headSha:'head-one',source:'browser-fixture',checkedAt:stamp};
let agents=[
  {id:'host',taskId:'task-one',name:'Hazel',town:'HubTown',status:'working',task:'Verify the observatory',originalAsk:'Keep the original request pinned while progress arrives.',taskStartedAt:stamp-130000,sessionStartedAt:stamp-600000,updatedAt:stamp,activityUrl:'/agents/host/activity',pr},
  {id:'neighbor',taskId:'task-neighbor',name:'Fern',town:'AppTown',status:'done',task:'Shared PR companion',pr:{...pr},endedAt:stamp-60000},
];
let events=Array.from({length:130},(_,i)=>({id:'event-'+i,timestamp:stamp-130000+i*1000,kind:i%3?'progress':'tool',text:'Recorded observation '+i+' with enough detail to make this journal scroll.'}));
let handoffs=[],stale=false,fail=false;
const feed={snapshot:()=>{if(fail)throw new Error('Simulated source outage');return {source:'browser-fixture',agents,stale,relationships:[{from:'HubTown',to:'AppTown',label:'Explicit test contract'}],handoffs};},getActivity:async(id,options)=>pageActivity(events,{...options,source:'browser-fixture'})};
const app=createFeedServer(feed),html=await readFile(new URL('../src/town.html',import.meta.url),'utf8');
// Emulate the browser preference before scene modules load, without changing macOS settings.
const preference='<script>const nativeMedia=window.matchMedia.bind(window);window.matchMedia=q=>q.includes("prefers-reduced-motion")?Object.assign(new EventTarget(),{matches:true,media:q}):nativeMedia(q);</script>';
const server=createServer((req,res)=>{if(req.url==='/reduced-motion'){res.setHeader('content-type','text/html');res.end(html.replace('<head>','<head>'+preference));}else app.emit('request',req,res);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function browser(operation,args=[]){
  const {stdout}=await run('browser-hand',[operation,'--page-name',page,...args],{timeout:30000,maxBuffer:2e6});
  const result=JSON.parse(stdout);assert.equal(result.success,true,JSON.stringify(result));return result;
}
const evaluate=async code=>(await browser('evaluate',['--code',code])).result;
const click=selector=>browser('click',['--selector',selector]);
async function until(code,message,timeout=7000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(code))return;await delay(250);}throw new Error(message);
}
const state=()=>evaluate('window.cottageObservatory.state');
async function key(key,ms=60){
  return evaluate(`(async()=>{const c=document.getElementById(window.cottageObservatory.mode==='room'?'room-canvas':'town');c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));await new Promise(r=>setTimeout(r,${ms}));window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(key)},bubbles:true}));return window.cottageObservatory.state;})()`);
}
function pass(label){process.stdout.write('PASS '+label+'\n');}
try{
  await browser('open',['--url',url]);
  await until('window.cottageObservatory?.state.selected===\'host\'','Town did not load');
  await browser('snapshot');
  assert.equal(await evaluate('document.querySelector(\'[data-pr="ready"] span\').textContent'),'1');
  pass('shared PR counted once, finished companion retained');
  await click('[data-action="enter"]');
  await until('window.cottageObservatory.state.mode===\'room\'','Direct entry failed');
  const first=await state();
  await key('ArrowLeft',350);
  assert.notDeepEqual((await state()).roomPlayer,first.roomPlayer);
  await click('[data-action="tab:request"]');
  assert.match(await evaluate('document.querySelector(\'.request-paper\').textContent'),/original request pinned/);
  await click('[data-action="tab:journal"]');
  await until('document.querySelectorAll(\'.journal-event\').length===100','Journal did not load');
  await evaluate('document.querySelector(\'.journal\').focus();document.querySelector(\'.journal\').scrollTop=150');
  events.push({id:'event-new',timestamp:Date.now(),kind:'result',text:'New result while inspecting earlier work.',url:'https://example.com/result'});
  await until('document.querySelectorAll(\'.journal-event\').length===101','Journal did not stream');
  assert.ok(Math.abs(await evaluate('document.querySelector(\'.journal\').scrollTop')-150)<2);
  assert.equal(await evaluate('document.activeElement.classList.contains(\'journal\')'),true);
  await click('[data-action="older"]');
  await until('document.querySelectorAll(\'.journal-event\').length===131','Older entries did not load');
  pass('walk indoors, inspect request, stream and paginate journal without scroll jumps');
  await click('[data-action="tab:review"]');
  assert.match(await evaluate('document.querySelector(\'.pr-summary\').textContent'),/Ready to merge/);
  assert.match(await evaluate('document.querySelector(\'.pr-summary a\').href'),/pull\/123$/);
  await key('Escape');assert.equal((await state()).mode,'town');
  await key('e');assert.equal((await state()).mode,'room');
  assert.equal((await state()).roomSeed,first.roomSeed);
  const plotBefore=await evaluate('window.cottageState().plots.find(p=>p.id===\'host\')');
  agents.push({...agents[0],id:'apprentice',name:'Pip',parent:'host',taskId:'apprentice-one'});
  handoffs=[{id:'handoff-one',from:'HubTown',to:'AppTown',agentId:'host',timestamp:Date.now(),text:'Recorded contract handed to Fern.'}];
  await until('window.cottageObservatory.state.apprentices===1&&window.cottageObservatory.state.couriers===1','Arrival or courier did not appear');
  const plotAfter=await evaluate('window.cottageState().plots.find(p=>p.id===\'host\')');
  assert.equal(plotAfter.x,plotBefore.x);assert.equal(plotAfter.y,plotBefore.y);assert.equal((await state()).roomSeed,first.roomSeed);
  pass('keyboard exit/reentry, stable room and plot, apprentice arrival and recorded courier');
  stale=true;
  await until('window.cottageObservatory.state.feedStale&&!document.querySelector(\'[data-pr="ready"]\')','Stale feed still advertised readiness');
  stale=false;await until('!!document.querySelector(\'[data-pr="ready"]\')','Fresh feed did not recover readiness');
  fail=true;
  await until('window.cottageObservatory.state.feedStale&&window.cottageState().agents.length===3&&!document.querySelector(\'[data-pr="ready"]\')','Failed connection did not retain a safe snapshot');
  fail=false;await until('!window.cottageObservatory.state.feedStale&&!!document.querySelector(\'[data-pr="ready"]\')','Failed connection did not recover');
  agents[0]={...agents[0],taskId:'task-two',originalAsk:'An entirely new request.',taskStartedAt:Date.now()};
  events=[{id:'new-task-request',timestamp:Date.now(),kind:'request',text:'An entirely new request.'}];
  await until(`window.cottageObservatory.state.roomSeed!==${JSON.stringify(first.roomSeed)}&&window.cottageObservatory.state.activity.events.length===1`,'New task did not reset room and journal');
  pass('stale readiness suppressed, reconnect recovers, new task gets new room and journal');
  await key('Escape');
  await click('[data-action="follow"]');assert.equal((await state()).followId,'host');
  await key('ArrowRight',150);assert.equal((await state()).followId,null);
  await click('#sound-toggle');assert.equal((await state()).sound,true);
  await click('#sound-toggle');assert.equal((await state()).sound,false);
  await click('#noticeboard');assert.match(await evaluate('document.getElementById(\'panel\').textContent'),/recorded|Recorded/);
  await click('#scrapbook');await click('[data-action="replay"]');
  const replay=(await state()).replayIndex;
  await until('window.cottageObservatory.state.replayIndex>'+replay,'Replay did not advance');
  await key('Escape');
  pass('follow bench, keyboard departure, opt-in sound, noticeboard and recorded replay');
  // Navigate by key events through the actual collision system to the pond.
  await click('[data-action="enter"]');await key('Escape');
  const duckResult=await evaluate(`(async()=>{
    const s=window.cottageState(),start=s.scene.player,duck=s.fauna.find(f=>f.kind==='duck'),step=4;
    const inside=(p,r,pad=0)=>p.x>=r.x-pad&&p.x<=r.x+r.w+pad&&p.y>=r.y-pad&&p.y<=r.y+r.h+pad;
    const solids=[...s.solids,...s.plots.flatMap(p=>[{x:p.x+5,y:p.y+27,w:44,h:37},...(p.kids||[]).map(k=>({x:k.x,y:k.y+4,w:16,h:13}))])];
    const free=p=>p.x>8&&p.y>20&&p.x<s.width-8&&p.y<s.height-8&&!solids.some(r=>inside(p,r,6));
    const queue=[{x:start.x,y:start.y}],parents=new Map([['0,0',null]]),points=new Map([['0,0',queue[0]]]);let goal=null;
    for(let i=0;i<queue.length;i++){const p=queue[i],k=Math.round((p.x-start.x)/step)+','+Math.round((p.y-start.y)/step);
      if(Math.hypot(p.x-duck.x,p.y-duck.y)<17){goal=k;break;}
      for(const [dx,dy] of [[step,0],[-step,0],[0,step],[0,-step]]){const n={x:p.x+dx,y:p.y+dy},nk=Math.round((n.x-start.x)/step)+','+Math.round((n.y-start.y)/step);if(!parents.has(nk)&&free(n)){parents.set(nk,k);points.set(nk,n);queue.push(n);}}
    }
    if(!goal)throw Error('No reachable duck approach');
    const path=[];for(let k=goal;k!==null;k=parents.get(k))path.unshift(points.get(k));
    const turns=path.filter((p,i)=>i===path.length-1||(i>0&&((path[i-1].x===p.x)!==(p.x===path[i+1]?.x))));
    const canvas=document.getElementById('town');canvas.focus();window.cottageWalkTrace=[];
    for(const target of turns){const from=window.cottageObservatory.player,key=Math.abs(target.x-from.x)>Math.abs(target.y-from.y)?(target.x>from.x?'ArrowRight':'ArrowLeft'):(target.y>from.y?'ArrowDown':'ArrowUp');
      const axis=key==='ArrowLeft'||key==='ArrowRight'?'x':'y',sign=target[axis]>from[axis]?1:-1;
      canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));const end=performance.now()+6000;
      await new Promise(resolve=>{const check=()=>{const p=window.cottageObservatory.player;if(sign*(target[axis]-p[axis])<1.5||performance.now()>end)resolve();else requestAnimationFrame(check);};check();});
      window.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true}));
      window.cottageWalkTrace.push({target,key,position:{...window.cottageObservatory.player}});
      if(['fleeing','swimming'].includes(window.cottageState().fauna.find(f=>f.kind==='duck').mode))break;
    }
    const followEnd=performance.now()+5000;
    while(performance.now()<followEnd){
      const current=window.cottageState(),d=current.fauna.find(f=>f.kind==='duck'),p=current.scene.player;
      if(['fleeing','swimming'].includes(d.mode))break;
      const pressed=[];
      if(Math.abs(d.x-p.x)>8)pressed.push(d.x>p.x?'ArrowRight':'ArrowLeft');
      if(Math.abs(d.y-p.y)>8)pressed.push(d.y>p.y?'ArrowDown':'ArrowUp');
      pressed.forEach(key=>canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})));
      await new Promise(r=>setTimeout(r,80));
      pressed.forEach(key=>window.dispatchEvent(new KeyboardEvent('keyup',{key,bubbles:true})));
    }
    return {player:window.cottageObservatory.player,duck:window.cottageState().fauna.find(f=>f.kind==='duck'),trace:window.cottageWalkTrace};
  })()`);
  assert.ok(['fleeing','swimming'].includes(duckResult.duck.mode),JSON.stringify(duckResult));
  await until('window.cottageState().fauna.find(f=>f.kind===\'duck\').mode===\'swimming\'','Duck did not reach water',9000);
  pass('walk to pond, startle duck, duck splashes into water');
  const mobile=await evaluate(`(async()=>{const f=document.createElement('iframe');f.style='position:fixed;inset:0;width:390px;height:844px;z-index:99999;border:0';f.src=location.href;document.body.append(f);await new Promise(r=>f.onload=r);await new Promise(r=>setTimeout(r,1700));const d=f.contentDocument,w=f.contentWindow;return {width:w.innerWidth,scrollWidth:d.documentElement.scrollWidth,canvas:d.getElementById('town').getBoundingClientRect().width,buttons:d.querySelectorAll('button').length};})()`);
  assert.equal(mobile.width,390);assert.ok(mobile.scrollWidth<=390,JSON.stringify(mobile));assert.ok(mobile.buttons>10);
  await evaluate('document.querySelector(\'iframe\').remove()');
  pass('390px responsive viewport has no horizontal page overflow');
  await click('[data-action="enter"]');
  await browser('fill',['--fields',JSON.stringify({'Cottage status endpoint':url+'/agents?reconnected=1'})]);
  await click('#connect');
  await until('window.cottageObservatory.state.mode===\'town\'','Feed switch did not leave old room');
  const reset=await state();assert.equal(reset.returnTo,null);assert.ok(reset.player.y<await evaluate('window.cottageState().height'));
  pass('switching feeds indoors resets Jack into the new world');
  await browser('goto',['--url',url+'/reduced-motion']);
  await until('window.cottageObservatory?.state.reduce===true','Reduced-motion preference was not applied');
  await click('[data-action="enter"]');await key('ArrowLeft',200);await key('Escape');
  await click('#scrapbook');await click('[data-action="replay"]');
  const reducedReplay=(await state()).replayIndex;
  await until('window.cottageObservatory.state.replayIndex>'+reducedReplay,'Reduced motion incorrectly disabled replay');
  await key('Escape');
  pass('emulated reduced-motion preference preserves walking and recorded replay');
  await browser('screenshot');
  process.stdout.write('Browser journey passed. Fixture: '+url+'\n');
}finally{server.close();}
