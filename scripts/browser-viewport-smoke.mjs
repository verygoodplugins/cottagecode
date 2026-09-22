#!/usr/bin/env node
/** Real Chrome regression journey for the camera and in-window fullscreen. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFeedServer} from '../src/feed.mjs';

const run = promisify(execFile), page = 'cottagecode-viewport-smoke', now = Date.now();
const events = Array.from({length:120}, (_, i) => ({id:'event-'+i, timestamp:now-120000+i*1000,
  kind:'progress', text:'Recorded viewport fixture activity '+i+' with a readable journal entry.'}));
const agents = Array.from({length:12}, (_, i) => ({id:'view-'+i, taskId:'task-'+i, name:'Resident '+i,
  town:'Village'+i+'Town', status:'working', task:'Verify map viewport '+i, originalAsk:'Keep this request available in fullscreen.',
  updatedAt:now, taskStartedAt:now-300000, sessionStartedAt:now-600000, events,
  todos:{source:'fixture',updatedAt:now,items:[{id:'viewport',text:'Check fullscreen details',status:'in_progress'}]},
  pr:{number:42,url:'https://github.com/example/fixture/pull/42',state:'open'},
  artifacts:[{url:'https://example.com/fixture',title:'Fixture artifact'}]}));
let sends = 0;
const server = createFeedServer({snapshot:()=>({source:'viewport-fixture',agents})}, {messages:{
  capability:()=>({available:true,mode:'redirect',source:'viewport-fixture'}),
  send:async()=>{sends++;return {status:200,body:{ok:true}};},
}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url = 'http://127.0.0.1:'+server.address().port;
async function browser(operation, args=[]) {
  const {stdout} = await run('browser-hand',[operation,'--page-name',page,...args],{timeout:35000,maxBuffer:2e6});
  const result = JSON.parse(stdout); assert.equal(result.success,true,JSON.stringify(result)); return result;
}
const evaluate = async code => (await browser('evaluate',['--code',code])).result;
const click = selector => browser('click',['--selector',selector]);
async function until(code, message) {
  const end = Date.now()+10000;
  while(Date.now()<end) { if(await evaluate(code))return; await new Promise(resolve=>setTimeout(resolve,150)); }
  throw new Error(message);
}
const state = () => evaluate('(()=>{const {viewport,display,scene}=window.cottageState();return {viewport,display,scene:{mode:scene.mode,selected:scene.selected,tab:scene.tab}};})()');
const pass = label => process.stdout.write('PASS '+label+'\n');
const near = (a,b,label,tolerance=1) => assert.ok(Math.abs(a-b)<tolerance,`${label}: ${a} != ${b}`);
const key = (key,extra={}) => evaluate(`(()=>{const c=document.getElementById('town');c.focus({preventScroll:true});c.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({key,bubbles:true,...extra})}));return window.cottageState().viewport;})()`);

try {
  await browser('open',['--url',url]);
  await until('window.cottageState?.().agents.length===12','Fixture failed to load');
  await browser('snapshot');
  // Start at the map's center: compact layouts can fit vertically in fullscreen,
  // where a former fixed scroll offset would legitimately clamp at the edge.
  await evaluate('window.originalPanel=document.getElementById("panel"); window.nativeCalls=[]; document.getElementById("map-shell").requestFullscreen=()=>{nativeCalls.push("request");return Promise.resolve();}; document.exitFullscreen=()=>{nativeCalls.push("exit");return Promise.resolve();}; window.originalWindow=[innerWidth,innerHeight]; const v=document.getElementById("map-viewport"); v.scrollTop=Math.max(0,(window.cottageState().viewport.geometry.mapHeight-v.clientHeight)/2);');
  const normal = await state();
  await click('#fullscreen-toggle');
  await until('window.cottageState().display.fullscreen','In-window fullscreen did not open');
  const full = await state();
  near(full.viewport.scale,normal.viewport.scale,'Fullscreen scale',1e-8);
  near(full.viewport.center.y,normal.viewport.center.y,'Fullscreen world center');
  assert.ok(full.viewport.geometry.height>normal.viewport.geometry.height);
  assert.equal(await evaluate('document.getElementById("map-viewport").getBoundingClientRect().bottom<=innerHeight'),true);
  assert.equal(await evaluate('document.getElementById("panel")===window.originalPanel'),true);
  assert.equal(await evaluate('[...document.getElementById("map-shell").parentElement.children].filter(e=>e.id!=="map-shell").every(e=>e.inert)'),true);
  assert.deepEqual(await evaluate('window.nativeCalls'),[],'Native fullscreen APIs must never be called');
  assert.equal(await evaluate('document.fullscreenElement===null && JSON.stringify([innerWidth,innerHeight])===JSON.stringify(window.originalWindow)'),true);
  pass('in-window fullscreen preserves scale, center and inspector without calling native APIs');

  for(const [tab,selector] of [['request','.request-paper'],['journal','.journal'],['todos','.todo-list'],['review','.pr-snapshot'],['artifacts','.artifact-list']]) {
    await click('[data-action="tab:'+tab+'"]');
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),true);
  }
  await click('[data-action="tab:journal"]');
  await evaluate('document.querySelector(".journal").scrollTop=180; document.getElementById("panel").scrollTop=50;');
  const reading = await evaluate('({journal:document.querySelector(".journal").scrollTop,panel:document.getElementById("panel").scrollTop})');
  await click('#fullscreen-toggle');
  await click('#fullscreen-toggle');
  const readingAfter = await evaluate('({journal:document.querySelector(".journal").scrollTop,panel:document.getElementById("panel").scrollTop})');
  near(readingAfter.journal,reading.journal,'Journal reading position');
  near(readingAfter.panel,reading.panel,'Inspector reading position');
  await click('[data-action="talk"]');
  await evaluate('(()=>{const input=document.getElementById("agent-message");input.value="Unsent fullscreen draft + - 0";input.dispatchEvent(new Event("input",{bubbles:true}));input.focus();input.setSelectionRange(7,17);input.dispatchEvent(new KeyboardEvent("keydown",{key:"+",bubbles:true}));})()');
  assert.equal((await state()).viewport.zoom,100);
  await click('#fullscreen-toggle'); await click('#fullscreen-toggle');
  assert.equal(await evaluate('document.getElementById("agent-message").value'),'Unsent fullscreen draft + - 0');
  assert.equal((await state()).scene.tab,'talk');
  assert.equal(sends,0);
  pass('all detail tabs, journal scroll, and an unsent draft survive fullscreen round trips');

  const beforeClose = (await state()).viewport;
  await click('#details-close');
  await evaluate('new Promise(resolve=>setTimeout(resolve,2200))');
  assert.equal(await evaluate('document.getElementById("details-shell").hidden'),true);
  near((await state()).viewport.scale,beforeClose.scale,'Closing details scale');
  await click('#noticeboard');
  assert.equal(await evaluate('document.getElementById("details-shell").hidden'),false);
  assert.equal((await state()).scene.mode,'board');
  await click('#details-close'); await click('#scrapbook');
  assert.equal((await state()).scene.mode,'scrapbook');
  assert.equal(await evaluate('document.getElementById("details-shell").hidden'),false);
  await evaluate('window.cottageObservatory.focusCottage("view-0")');
  await click('[data-action="postcard"]');
  await until('document.getElementById("postcard-dialog").open','Postcard did not open');
  assert.equal(await evaluate('document.getElementById("map-shell").contains(document.getElementById("postcard-dialog"))'),true);
  await evaluate('document.getElementById("postcard-dialog").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal((await state()).display.fullscreen,true,'Escape in a dialog must not also exit CSS fullscreen');
  await click('#postcard-close');
  pass('closed details stay closed on polls; explicit history and postcard actions remain available');

  await click('#details-close');
  for(const zoom of [125,150,200]) { await click('#zoom-in'); assert.equal((await state()).viewport.zoom,zoom); }
  assert.equal(await evaluate('document.getElementById("zoom-in").disabled'),true);
  const zoomed = await state();
  near(zoomed.viewport.scale,normal.viewport.scale*2,'200% scale',1e-8);
  await key('-', {ctrlKey:true}); assert.equal((await state()).viewport.zoom,200);
  await key('0'); assert.equal((await state()).viewport.zoom,100);
  await key('-'); await key('-');
  assert.equal((await state()).viewport.zoom,50);
  assert.equal(await evaluate('document.getElementById("zoom-out").disabled'),true);
  await key('='); assert.equal((await state()).viewport.zoom,75);
  await click('#zoom-reset');
  // Reset is an explicit zoom action; subsequent fullscreen toggles retain it.
  await click('#zoom-in'); await click('#fullscreen-toggle');
  assert.equal((await state()).viewport.zoom,125);
  await evaluate('document.getElementById("map-viewport").scrollTo({left:100,top:300,behavior:"instant"})');
  const pointer = await evaluate(`(()=>{const s=window.cottageState(),p=s.plots[0],c=document.getElementById('town'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('click',{clientX:r.left+(p.x+27)*r.width/c.width,clientY:r.top+(p.y+45)*r.height/c.height,bubbles:true}));return window.cottageState().scene.selected;})()`);
  assert.equal(pointer,'view-0');
  await click('[data-action="enter"]');
  await until('window.cottageState().scene.mode==="room"','Room did not open');
  assert.equal(await evaluate('document.getElementById("map-zoom").hidden'),true);
  await click('#fullscreen-toggle');
  assert.equal((await state()).scene.mode,'room');
  await click('#leave-cottage');
  assert.equal((await state()).viewport.zoom,125);
  assert.equal(await evaluate('document.getElementById("map-zoom").hidden'),false);
  pass('zoom limits, shortcuts, hit testing, and room visits preserve the Townmap camera');

  await click('#fullscreen-toggle');
  await evaluate('document.getElementById("map-shell").requestFullscreen=undefined;');
  await click('#fullscreen-toggle');
  assert.equal((await state()).display.fullscreen,true);
  await key('Escape');
  assert.equal((await state()).display.fullscreen,false);
  pass('in-window fullscreen and Escape work with no Fullscreen API');

  // Same-origin frames exercise CSS-pixel geometry without changing the user's browser window.
  for(const [width,height] of [[390,844],[900,450]]) {
    const result = await evaluate(`(async()=>{
      const frame=document.createElement('iframe');
      frame.style='position:fixed;inset:0;width:${width}px;height:${height}px;z-index:9999;border:0';
      frame.src=location.href;document.body.append(frame);await new Promise(r=>frame.onload=r);
      const w=frame.contentWindow,d=w.document,tick=()=>new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));
      for(let i=0;i<120&&!w.cottageState?.().viewport.scale;i++)await new Promise(r=>setTimeout(r,50));
      const initial=w.cottageState().viewport.scale;
      d.getElementById('map-shell').requestFullscreen=undefined;
      d.getElementById('fullscreen-toggle').click();await tick();
      const panel=d.getElementById('details-shell').getBoundingClientRect(),v=d.getElementById('map-viewport').getBoundingClientRect();
      const result={initial,scale:w.cottageState().viewport.scale,width:w.innerWidth,overflow:d.documentElement.scrollWidth>w.innerWidth,
        panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom,height:panel.height},
        viewportBottom:v.bottom,height:w.innerHeight,closeVisible:!!d.getElementById('details-close').getClientRects().length};
      const inspector=d.getElementById('panel');inspector.scrollTop=100;result.readingBefore=inspector.scrollTop;
      d.getElementById('fullscreen-toggle').click();await tick();
      d.getElementById('fullscreen-toggle').click();await tick();result.readingAfter=inspector.scrollTop;
      w.cottageObservatory.focusCottage('view-11');await tick();
      const plot=w.cottageState().plots.find(p=>p.id==='view-11'),c=d.getElementById('town'),r=c.getBoundingClientRect();
      result.target={x:r.left+plot.x*r.width/c.width,y:r.top+plot.y*r.height/c.height};
      const map=d.getElementById('map-viewport');map.scrollTop=Math.max(0,(w.cottageState().viewport.geometry.mapHeight-map.clientHeight)/2);await tick();
      const before=w.cottageState().viewport;frame.style.height='700px';await tick();
      const after=w.cottageState().viewport;
      result.resize={scaleBefore:before.scale,scaleAfter:after.scale,yBefore:before.center.y,yAfter:after.center.y};
      frame.remove();return result;
    })()`);
    near(result.scale,result.initial,'Responsive fullscreen scale',1e-8);
    assert.equal(result.overflow,false); assert.equal(result.closeVisible,true);
    assert.ok(result.panel.left>=0 && result.panel.right<=result.width);
    assert.ok(result.panel.top>=0 && result.panel.bottom<=result.height);
    assert.ok(result.viewportBottom<=result.height);
    if(width<600)assert.ok(result.panel.height<=height*.45+1);
    assert.ok(result.readingBefore>0,'Fixture must actually scroll the outer inspector');
    near(result.readingAfter,result.readingBefore,'Outer inspector reading position');
    if(width<600)assert.ok(result.target.y<result.panel.top,'Focused cottage must clear the bottom panel');
    else assert.ok(result.target.x<result.panel.left,'Focused cottage must clear the right panel');
    near(result.resize.scaleAfter,result.resize.scaleBefore,'Resize scale',1e-8);
    near(result.resize.yAfter,result.resize.yBefore,'Resize world center');
  }
  pass('390px bottom panel and short desktop fullscreen stay within the viewport');
  assert.deepEqual(await evaluate('window.nativeCalls'),[],'The whole journey must leave native fullscreen alone');
  assert.equal(sends,0,'No messages should be sent during viewport tests');
} finally {
  await browser('goto',['--url','about:blank']).catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
}
