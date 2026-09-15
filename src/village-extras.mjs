import {createMusic} from './music.mjs';
import {createMusicOutput} from './music-output.mjs';
import {MUSIC_TRACKS} from './music-tracks.mjs';
import {villageTime,locateVillageTown,paintTownAtmosphere,paintRoomAtmosphere,paintGramophone} from './atmosphere.mjs';
import {createPostcard} from './postcard.mjs';

/** Small domestic extras live outside the frequently refreshed task inspector. */
export function createVillageExtras({getPostcard,clearKeys}) {
  const $=id=>document.getElementById(id),output=createMusicOutput();
  const music=createMusic({tracks:MUSIC_TRACKS,audioFactory:output.create,visibilitySource:null});
  let timeMode='auto',light=villageTime(),scene={town:'HubTown',indoors:false,talking:false};
  let lastClock=-Infinity,lastUI='',postcard=null,postcardURL=null,postcardVersion=0;
  const dialog=$('postcard-dialog'),preview=$('postcard-preview'),milestones=$('postcard-milestone'),save=$('postcard-save');
  const text=(id,value)=>{const node=$(id);if(node.textContent!==value)node.textContent=value;};
  function renderMusic() {
    const state=music.state,signature=JSON.stringify([state,timeMode,light.phase,scene]);
    if(signature===lastUI)return;lastUI=signature;
    const toggle=$('music-toggle');
    toggle.setAttribute('aria-pressed',String(state.enabled));
    toggle.textContent=state.enabled?'♫ Music on':'♫ Music off';
    toggle.setAttribute('aria-label',state.enabled?'Stop village music':'Play village music');
    const place=light.label+' in '+scene.town;
    const playing=state.track?.title||'Winding up the gramophone…';
    const status=state.error||(!state.enabled?'The gramophone is quiet':state.status==='paused'?'Music paused while you’re away':playing);
    text('music-status',status+' · '+place+(state.enabled&&scene.talking?' · hushed for conversation':state.enabled&&scene.indoors?' · softly indoors':''));
    text('village-clock',light.label+(timeMode==='auto'?' · local time':' · preview'));
    text('music-volume-value',Math.round(music.volume*100)+'%');
    if(!state.playing&&(!state.enabled||state.hidden))void output.suspend().catch(()=>{});
  }
  function updateClock(time,force=false) {
    if(force||time-lastClock>=1){lastClock=time;light=villageTime(timeMode==='auto'?new Date():timeMode);}
  }
  function update(context,time) {
    updateClock(time);
    scene={town:locateVillageTown(context.player,context.world.districts,{interiorTown:context.interiorTown}),indoors:context.indoors,talking:context.talking};
    music.setScene({phase:light.phase,...scene});renderMusic();
  }
  function restoreVisibility() {
    // Refresh the clock while still paused, so a night-time return never starts
    // yesterday afternoon's track and waits for the normal scene debounce.
    updateClock(performance.now()/1000,true);
    music.setScene({phase:light.phase,...scene});music.setHidden(document.hidden);
    if(document.hidden)void output.suspend().catch(()=>{});
    renderMusic();
  }
  music.setHidden(document.hidden);
  document.addEventListener('visibilitychange',restoreVisibility);
  function toggleMusic() {
    // enable calls play synchronously in the click/key gesture; a second click
    // can stop an in-flight load without waiting for its promise.
    const pending=music.enable(!music.enabled);renderMusic();
    void pending.then(renderMusic);return pending;
  }
  $('music-toggle').onclick=toggleMusic;
  $('music-volume').oninput=e=>{music.volume=Number(e.target.value)/100;renderMusic();};
  $('village-time').onchange=e=>{
    timeMode=['morning','day','dusk','night'].includes(e.target.value)?e.target.value:'auto';
    updateClock(performance.now()/1000,true);music.setScene({phase:light.phase,...scene});renderMusic();
  };

  function releasePreview() {
    if(postcardURL)URL.revokeObjectURL(postcardURL);
    postcardURL=null;preview.removeAttribute('src');preview.hidden=true;save.hidden=true;save.removeAttribute('href');
  }
  async function renderPostcard() {
    if(!postcard||!dialog.open)return;
    const version=++postcardVersion;
    releasePreview();text('postcard-status','Drawing your postcard…');
    const milestone=milestones.value===''?null:postcard.milestones[Number(milestones.value)]||null;
    try {
      const result=await createPostcard({...postcard,milestone,timeState:postcard.light});
      if(version!==postcardVersion||!dialog.open)return;
      postcardURL=URL.createObjectURL(result.blob);
      preview.src=postcardURL;preview.alt='Postcard from '+result.model.town+' showing '+result.model.resident+'’s cottage';preview.hidden=false;
      save.href=postcardURL;save.download=result.filename;save.hidden=false;
      text('postcard-status',milestone?'Preview includes the recorded note you chose.':'Just the cottage and resident. No work details included.');
    }catch {if(version===postcardVersion)text('postcard-status','The postcard could not be drawn. Close this window and try again.');}
  }
  function openPostcard(id) {
    const context=getPostcard(id);if(!context)return;
    clearKeys();postcard={...context,light,now:Date.now()};
    milestones.replaceChildren(new Option('Scenic postcard · no work details',''));
    for(const [i,event] of postcard.milestones.entries()) {
      const when=event.timestamp?new Date(event.timestamp).toLocaleDateString([], {month:'short',day:'numeric'})+' · ':'';
      milestones.add(new Option(when+String(event.text).slice(0,110),String(i)));
    }
    milestones.value='';milestones.disabled=!postcard.milestones.length;
    text('postcard-title','A postcard from '+(context.agent.town||'the village'));
    dialog.showModal();void renderPostcard();
  }
  milestones.onchange=()=>void renderPostcard();
  $('postcard-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{
    postcardVersion++;postcard=null;releasePreview();
    // Feed refreshes can replace the original opener while the dialog is up.
    document.querySelector('[data-action="postcard"]')?.focus({preventScroll:true});
  });
  save.addEventListener('click',()=>text('postcard-status','Saving your PNG postcard…'));
  window.addEventListener('pagehide',event=>{
    // Back/forward cache restores this exact controller, without rerunning setup.
    if(event.persisted){music.setHidden(true);void output.suspend().catch(()=>{});}
    else{music.dispose();void output.dispose().catch(()=>{});}
    postcardVersion++;if(dialog.open)dialog.close();releasePreview();
  });
  window.addEventListener('pageshow',event=>{if(event.persisted)restoreVisibility();});
  renderMusic();
  return {
    update,toggleMusic,openPostcard,
    drawTown(ctx,world,time,reduce,beforePalette){updateClock(time);return paintTownAtmosphere(ctx,world,light,{time,reduce,signalsPaintedAfter:true,beforePalette});},
    drawRoom(ctx,room,time,reduce,agent){return paintRoomAtmosphere(ctx,room,light,{time,reduce,agent});},
    lightAt(time){updateClock(time);return light;},
    drawGramophone(ctx,point,time,reduce){if(point)paintGramophone(ctx,point.x-12,point.y-14,{time,reduce,playing:music.state.audible});},
    get state(){return {timeMode,phase:light.phase,town:scene.town,music:music.state,postcardOpen:dialog.open};},
  };
}
