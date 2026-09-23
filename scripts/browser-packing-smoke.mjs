#!/usr/bin/env node
/** Compact districts, Overview and stable arrivals in real Chrome; fixture data only. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFeedServer} from '../src/feed.mjs';

const run=promisify(execFile),page='cottagecode-packing-smoke',now=Date.now();
const cottage=(id,town,status,extra={})=>({id,taskId:id,name:id,town,status,occupancy:'live',inventoryScope:'dashboard',
  task:'Verify compact town placement',updatedAt:now,taskStartedAt:now-60000,...extra});
let agents=[
  ...Array.from({length:7},(_,i)=>cottage('host-'+i,'HubTown',['idle','working','blocked','working','done','done','offline'][i],
    {branch:i===0?'main':i===1||i===3?'feat/auth':i===2?'fix/cache':'',defaultBranch:'main',worktreePath:'/fixture/hub/'+i})),
  cottage('roommate','HubTown','working',{worktreePath:'/fixture/hub/0',branch:'main'}),
  cottage('child-a','HubTown','blocked',{parent:'host-0'}),cottage('child-b','HubTown','working',{parent:'host-0'}),
  cottage('app-a','AppTown','working',{branch:'feat/mobile'}),cottage('app-b','AppTown','working',{branch:'feat/mobile'}),
  cottage('mem','MemTown','blocked'),cottage('fusion','FusionTown','offline'),
  cottage('vault-a','VaultTown','done'),cottage('vault-b','VaultTown','offline'),
];
const server=createFeedServer({snapshot:()=>({source:'packing-fixture',agents,relationships:[{from:'HubTown',to:'MemTown'}]})});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
async function browser(operation,args=[]){
  const {stdout}=await run('browser-hand',[operation,'--page-name',page,...args],{timeout:35000,maxBuffer:2e6});
  const result=JSON.parse(stdout);assert.equal(result.success,true,JSON.stringify(result));return result;
}
const evaluate=async code=>(await browser('evaluate',['--code',code])).result;
const click=selector=>browser('click',['--selector',selector]);
async function until(code,message){
  const end=Date.now()+10000;
  while(Date.now()<end){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,150));}
  throw new Error(message);
}
const pass=message=>process.stdout.write('PASS '+message+'\n');
const positions=()=>evaluate('window.cottageState().plots.map(p=>[p.id,p.x,p.y]).sort()');

try{
  await browser('open',['--url',url]);
  await until('window.cottageState?.().agents.length===16','Fixture failed to load');
  await browser('snapshot');
  const initial=await positions();
  assert.deepEqual(await evaluate('window.cottageState().townCounts.HubTown'),{working:4,blocked:2,total:10,active:6});
  assert.equal(await evaluate('window.cottageState().plots.length'),13);
  const scale=await evaluate('window.cottageState().viewport.scale');
  await click('#fullscreen-toggle');
  assert.equal(await evaluate('window.cottageState().viewport.scale'),scale);
  await click('#map-overview');
  assert.equal(await evaluate('document.getElementById("overview-status").textContent.includes("outside")'),false);
  assert.deepEqual(await positions(),initial);
  await evaluate('window.cottageObservatory.focusCottage("host-0")');
  await click('[data-action="follow"]');await click('#map-overview');
  assert.equal(await evaluate('window.cottageState().scene.followId'),null);
  await click('[data-action="enter"]');
  assert.equal(await evaluate('document.getElementById("map-zoom").hidden'),true);
  await click('#leave-cottage');await click('#map-overview');
  pass('Overview frames active households, stops following, and leaves room controls intact');

  const before=await evaluate('({zoom:window.cottageState().viewport.zoom,center:window.cottageState().viewport.center})');
  agents=agents.map(a=>a.id==='host-3'?{...a,status:'blocked',branch:'renamed'}:a).reverse();
  await until('window.cottageState().agents.find(a=>a.id==="host-3").branch==="renamed"','Feed update did not arrive');
  assert.deepEqual(await positions(),initial);
  assert.deepEqual(await evaluate('({zoom:window.cottageState().viewport.zoom,center:window.cottageState().viewport.center})'),before);
  agents.push(...Array.from({length:8},(_,i)=>cottage('new-'+i,i<3?'HubTown':'NewTown','working')));
  await until('window.cottageState().agents.length===24','Arrivals did not appear');
  const arrived=await positions();
  for(const p of initial)assert.deepEqual(arrived.find(q=>q[0]===p[0]),p);
  pass('reordered feeds, status and branch changes, spare plots and annexes preserve existing locations');

  for(const [width,height] of [[2077,1100],[900,450],[390,844]]){
    const result=await evaluate(`(async()=>{
      const frame=document.createElement('iframe');frame.style='position:fixed;inset:0;width:${width}px;height:${height}px;z-index:9999;border:0';
      frame.src=location.href;document.body.append(frame);await new Promise(r=>frame.onload=r);
      const w=frame.contentWindow,d=w.document,tick=()=>new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));
      for(let i=0;i<120&&!w.cottageState?.().plots.length;i++)await new Promise(r=>setTimeout(r,50));
      const positions=()=>JSON.stringify(w.cottageState().plots.map(p=>[p.id,p.x,p.y]).sort()),before=positions(),scale=w.cottageState().viewport.scale;
      d.getElementById('fullscreen-toggle').click();await tick();
      const sameScale=scale===w.cottageState().viewport.scale;
      d.getElementById('map-overview').click();await tick();
      const s=w.cottageState(),panel=d.getElementById('details-shell').getBoundingClientRect();
      const count=s.districts.filter(t=>t.y===30).length;
      const result={width:s.width,topTowns:count,sameScale,samePositions:before===positions(),zoom:s.viewport.zoom,
        overflow:d.documentElement.scrollWidth>w.innerWidth,toolbarFits:d.getElementById('map-zoom').getBoundingClientRect().right<=w.innerWidth,
        panelVisible:panel.bottom<=w.innerHeight&&panel.right<=w.innerWidth,status:d.getElementById('overview-status').textContent};
      d.getElementById('details-close').click();await tick();result.samePositions&&=before===positions();
      d.getElementById('fullscreen-toggle').click();await tick();result.samePositions&&=before===positions();
      frame.remove();return result;
    })()`);
    assert.equal(result.sameScale,true);assert.equal(result.samePositions,true);
    assert.equal(result.overflow,false);assert.equal(result.toolbarFits,true);assert.equal(result.panelVisible,true);
    assert.ok([50,75,100].includes(result.zoom));
    if(width>2000){assert.ok(result.width>768);assert.ok(result.topTowns>2);}
  }
  pass('wide, short and 390px layouts keep scale, positions and reachable controls');
}finally{
  await browser('goto',['--url','about:blank']).catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
}
