#!/usr/bin/env node
/** Real Chrome: opt-in audio, contextual beds, lighting and private PNG export. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createFeedServer} from '../src/feed.mjs';

const run=promisify(execFile),page='cottagecode-ambience-smoke';
const explicit=process.argv.indexOf('--url'),remote=explicit>=0?process.argv[explicit+1]:null;
const now=Date.now(),agents=['HubTown','AppTown','MemTown','VaultTown'].map((town,i)=>({
  id:'ambience-'+i,taskId:'ambience-task-'+i,name:['Hazel','Pip','Moss','Tock'][i],town,status:'working',
  task:'Synthetic browser check',originalAsk:'This request must never appear on a scenic postcard.',
  taskStartedAt:now-300000,sessionStartedAt:now-600000,updatedAt:now,
  pr:{state:'none',source:'browser-fixture',checkedAt:now},
  events:[{id:'recorded-result',kind:'result',timestamp:now-1000,text:'Verified a peaceful walk through the village.',url:'https://example.com/recorded-artifact'}],
}));
const feed={snapshot:()=>({agents,source:'browser-fixture',checkedAt:Date.now()})};
const server=remote?null:createFeedServer(feed).listen(0,'127.0.0.1');
if(server)await new Promise(resolve=>server.once('listening',resolve));
const url=remote||'http://127.0.0.1:'+server.address().port;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function browser(operation,args=[]){
  const {stdout}=await run('browser-hand',[operation,'--page-name',page,...args],{timeout:30000,maxBuffer:2e6});
  const result=JSON.parse(stdout);assert.equal(result.success,true,JSON.stringify(result));return result;
}
const evaluate=async code=>(await browser('evaluate',['--code',code])).result;
const click=selector=>browser('click',['--selector',selector]);
const fill=(selector,value)=>browser('fill',['--fields',JSON.stringify({[selector]:value})]);
const state=()=>evaluate('window.cottageObservatory.state');
async function until(code,message,timeout=12000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(code))return;await delay(250);}throw new Error(message);
}
function pass(text){process.stdout.write('PASS '+text+'\n');}
async function visit(town,expected){
  if((await state()).mode==='room')await click('[data-action="leave"]');
  const id=await evaluate('window.cottageState().agents.find(a=>a.town==='+JSON.stringify(town)+'&&!a.parent)?.id');assert.ok(id,town);
  if(!await evaluate('document.querySelector(".cottage-directory").open'))await click('.cottage-directory summary');
  await click('[data-cottage='+JSON.stringify(id)+']');
  await click('[data-action="enter"]');
  await until('window.cottageObservatory.state.town==='+JSON.stringify(town),'Interior did not select '+town);
  await until('window.cottageObservatory.state.music.track?.id==='+JSON.stringify(expected),'Music did not follow '+town);
  assert.equal((await state()).music.error,'');
}
try{
  await browser('open',['--url',url]);
  await until('!!window.cottageObservatory?.state.selected','Village did not load');
  await browser('snapshot');
  assert.equal((await state()).music.enabled,false);
  assert.equal(await evaluate('performance.getEntriesByType("resource").filter(e=>/\\.mp3(?:$|\\?)/.test(e.name)).length'),0);
  assert.equal((await state()).timeMode,'auto');
  pass('fresh page is silent and requests no audio');
  await click('#village-settings summary');await fill('#village-time','Day');
  await click('#music-toggle');
  await until('window.cottageObservatory.state.music.audible','Opt-in did not start native audio');
  assert.equal((await state()).music.track.id,'day');
  assert.equal((await state()).sound,false,'Music must not enable sound effects');
  pass('explicit play starts the daytime bed independently of sound effects');
  await visit('AppTown','app-town');
  const seed=(await state()).roomSeed;
  assert.ok(Math.abs((await state()).music.effectiveVolume-.104)<.0001);
  await click('[data-action="talk"]');
  await until('window.cottageObservatory.state.music.effectiveVolume<.03','Conversation did not hush the music');
  await click('[data-action="tab:request"]');
  await until('window.cottageObservatory.state.music.effectiveVolume>.10','Music stayed hushed after talking');
  pass('AppTown gets its own bed; interiors and conversations reduce volume');
  await visit('MemTown','mem-town');await visit('VaultTown','vault-town');
  await fill('#village-time','Dusk');
  await until('window.cottageObservatory.state.music.track?.id==="dusk"','Dusk did not replace the regional bed');
  assert.equal((await state()).phase,'dusk');
  await fill('#village-time','Night');
  await until('window.cottageObservatory.state.music.track?.id==="night"','Night bed did not load');
  pass('MemTown, VaultTown, dusk and night transitions play without errors');
  await evaluate('window.__ambienceNativeDate=window.Date;window.__ambienceHour=12;window.Date=class extends window.__ambienceNativeDate{getHours(){return window.__ambienceHour}getMinutes(){return 0}getSeconds(){return 0}}');
  await fill('#village-time','Follow my clock');
  await until('window.cottageObservatory.state.music.track?.id==="vault-town"','Noon clock fixture did not select daytime music');
  await evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))');
  assert.equal((await state()).music.playing,false);
  const resumed=await evaluate('(()=>{window.__ambienceHour=23;Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));return window.cottageObservatory.state.music;})()');
  assert.ok(resumed.pendingTrackId==='night'||resumed.track?.id==='night',JSON.stringify(resumed));
  await until('window.cottageObservatory.state.music.track?.id==="night"','Return after sunset did not select night immediately');
  await evaluate('window.Date=window.__ambienceNativeDate;delete window.__ambienceNativeDate;delete window.__ambienceHour;delete document.hidden');
  await fill('#village-time','Night');
  pass('returning after a clock boundary selects the new phase before resuming');
  // Exercise page-cache lifecycle without navigating away from the fixture.
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}))');
  assert.equal((await state()).music.status,'paused');
  assert.equal((await state()).music.playing,false);
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');
  await until('window.cottageObservatory.state.music.audible','Cached page restore did not resume opted-in music');
  pass('cached-page lifecycle releases media and restores the opted-in controller');
  await browser('snapshot');await click('[data-action="postcard"]');
  await until('document.getElementById("postcard-preview").naturalWidth===1200','Postcard PNG did not render');
  assert.equal((await state()).postcardOpen,true);
  assert.equal(await evaluate('document.getElementById("postcard-preview").naturalHeight'),840);
  assert.equal(await evaluate('document.getElementById("postcard-milestone").value'),'');
  assert.match(await evaluate('document.getElementById("postcard-save").download'),/^cottagecode-vaulttown-.*\.png$/);
  assert.match(await evaluate('document.getElementById("postcard-save").href'),/^blob:/);
  assert.equal(await evaluate('(()=>{const image=document.getElementById("postcard-preview"),canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);return ctx.getImageData(0,0,1,1).data[3]})()'),255);
  const scenicURL=await evaluate('document.getElementById("postcard-preview").src');
  const milestone=await evaluate('document.getElementById("postcard-milestone").options[1]?.text');
  if(milestone){
    await fill('#postcard-milestone',milestone);
    await until('document.getElementById("postcard-preview").naturalWidth===1200&&document.getElementById("postcard-preview").src!=='+JSON.stringify(scenicURL),'Explicit milestone did not redraw postcard');
    assert.match(await evaluate('document.getElementById("postcard-status").textContent'),/note you chose/);
  }
  await delay(1300); // Exercise focus return after the inspector refreshes.
  await click('#postcard-close');
  assert.equal((await state()).postcardOpen,false);
  assert.equal(await evaluate('document.activeElement.dataset.action'),'postcard');
  assert.equal(await evaluate('document.getElementById("postcard-preview").hasAttribute("src")'),false);
  pass('opaque PNG preview, explicit milestone, download link and restored keyboard focus');
  await fill('#village-time','Day');await visit('AppTown','app-town');assert.equal((await state()).roomSeed,seed);
  // A directory selection is inspection, not a change in Jack’s location.
  await click('[data-action="leave"]');
  const hub=await evaluate('window.cottageState().agents.find(a=>a.town==="HubTown"&&!a.parent).id');
  await click('[data-cottage='+JSON.stringify(hub)+']');
  assert.equal((await state()).town,'AppTown');
  await click('#music-toggle');
  await until('!window.cottageObservatory.state.music.playing','Stop did not release native media');
  pass('revisits preserve rooms; inspecting another town does not move the music; stop silences playback');
  if(!remote){
    const mobile=await evaluate(`(async()=>{
      const frame=document.createElement('iframe');frame.style='position:fixed;inset:0;width:390px;height:844px;z-index:99999;border:0';frame.src=location.href;document.body.append(frame);
      await new Promise(resolve=>frame.onload=resolve);const doc=frame.contentDocument,win=frame.contentWindow;
      const end=Date.now()+5000;while(!win.cottageObservatory?.state.selected&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
      doc.querySelector('#village-settings').open=true;doc.querySelector('[data-action="postcard"]').click();
      while(!doc.getElementById('postcard-preview').naturalWidth&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
      const dialog=doc.getElementById('postcard-dialog'),r=dialog.getBoundingClientRect();
      const result={width:win.innerWidth,scrollWidth:doc.documentElement.scrollWidth,dialogWidth:r.width,dialogLeft:r.left,dialogRight:r.right,dialogScroll:dialog.scrollWidth,dialogClient:dialog.clientWidth,png:doc.getElementById('postcard-preview').naturalWidth,music:win.cottageObservatory.state.music.enabled};
      frame.remove();return result;
    })()`);
    assert.equal(mobile.width,390);assert.ok(mobile.scrollWidth<=390,JSON.stringify(mobile));
    assert.ok(mobile.dialogLeft>=0&&mobile.dialogRight<=390,JSON.stringify(mobile));
    assert.equal(mobile.dialogScroll,mobile.dialogClient);assert.equal(mobile.png,1200);assert.equal(mobile.music,false);
    pass('390px controls and postcard dialog fit without overflow or autoplay');
  }
  await browser('goto',['--url',url]);await until('!!window.cottageObservatory?.state.selected','Reload failed');
  assert.equal((await state()).music.enabled,false);
  assert.equal(await evaluate('performance.getEntriesByType("resource").filter(e=>/\\.mp3(?:$|\\?)/.test(e.name)).length'),0);
  pass('reload never resumes music or preloads the soundtrack');
  if(!remote){
    // Force the ignored-volume branch with real media and real Web Audio. The
    // browser itself stays unchanged; only this isolated output gets the shim.
    await evaluate(`(async()=>{
      const {createMusicOutput}=await import('/modules/music-output.mjs'),{createMusic}=await import('/modules/music.mjs');
      const gains=[],media=[],contexts=[],NativeAudio=window.Audio,NativeContext=window.AudioContext;
      const output=createMusicOutput({Audio:function(){const a=new NativeAudio();Object.defineProperty(a,'volume',{get:()=>1,set:()=>{}});media.push(a);return a;},AudioContext:class extends NativeContext{constructor(){super();contexts.push(this)}createGain(){const gain=super.createGain();gains.push(gain);return gain;}}});
      const music=createMusic({tracks:[{id:'quiet-proof',phase:'day',url:new URL('/modules/audio/day.mp3',location.href).href}],audioFactory:output.create,visibilitySource:null,fadeMs:200});
      const button=document.createElement('button');button.id='quiet-output-proof';button.textContent='Test quiet music output';button.onclick=()=>music.enable(!music.enabled);document.body.append(button);
      window.__quietOutputProof={music,output,gains,media,contexts,button};
    })()`);
    await browser('snapshot');await click('#quiet-output-proof');
    await until('window.__quietOutputProof.music.state.audible','Gain fallback did not play real media');
    await evaluate('window.__quietOutputProof.music.setScene({indoors:true,talking:true})');
    await until('Math.abs(window.__quietOutputProof.gains[0].gain.value-.026)<.001','Real output gain did not hush for conversation');
    assert.deepEqual(await evaluate('(()=>{const q=window.__quietOutputProof;return {contexts:q.contexts.length,media:q.media.length,native:q.media[0].volume,state:q.contexts[0].state}})()'),{contexts:1,media:1,native:1,state:'running'});
    await click('#quiet-output-proof');await until('!window.__quietOutputProof.music.state.playing','Gain fallback did not stop');
    const closed=await evaluate('(async()=>{const q=window.__quietOutputProof;q.music.dispose();await q.output.dispose();q.button.remove();return q.contexts[0].state})()');
    assert.equal(closed,'closed');
    await evaluate('delete window.__quietOutputProof');
    pass('real Web Audio keeps ignored native volume quiet, ducks to 2.6%, and closes cleanly');
  }
}finally{
  try{await evaluate('(async()=>{const q=window.__quietOutputProof;if(q){q.music.dispose();await q.output.dispose();q.button.remove();delete window.__quietOutputProof;}})()');}catch{}
  try{await evaluate('if(window.__ambienceNativeDate){window.Date=window.__ambienceNativeDate;delete window.__ambienceNativeDate;delete window.__ambienceHour;delete document.hidden;}');}catch{}
  try{if(await evaluate('window.cottageObservatory?.state.music.enabled'))await click('#music-toggle');}catch{}
  if(server)await new Promise(resolve=>server.close(resolve));
}
