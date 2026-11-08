/** Small, truthful summaries shared by the living town's controls. */
import {validTime} from './feed-client.mjs';
export function townPulses(tasks) {
  const towns=new Map();
  for(const task of tasks){
    const name=task.raw.town||task.raw.role||'WildTown';
    if(!towns.has(name))towns.set(name,{name,total:0,working:0,attention:0,quiet:0,stale:false,ready:new Set()});
    const town=towns.get(name);town.total++;town.working+=Number(task.status==='working');
    town.attention+=Number(task.attention);town.quiet+=Number(task.quiet);town.stale||=task.sourceStale;
    if(task.prStage==='ready'&&task.prKey)town.ready.add(task.prKey);
  }
  return [...towns.values()].map(town=>({...town,ready:town.ready.size}));
}
export function townPulseLabel(town) {
  return [town.stale?'Last seen':town.working?`${town.working} working`:'Resting',
    town.attention?`${town.attention} check`:'',town.ready?`${town.ready} ready`:''].filter(Boolean).join(' · ');
}
/** Pick within the already scoped fleet; locating never changes task state. */
export function activityVisit(tasks,selectedId=null,now=Date.now()) {
  const working=tasks.filter(task=>task.status==='working'&&!task.sourceStale&&!task.quiet);
  let recent=null,latestAt=-Infinity;
  for(const task of working){
    const tool=task.raw?.toolActivity,at=validTime(tool?.at);
    if(!tool||tool.stale||typeof tool.name!=='string'||!tool.name.trim()||!['started','succeeded'].includes(tool.state)||
      at===null||at>now||now-at>=120000)continue;
    if(at>latestAt){recent=task;latestAt=at;}
  }
  if(recent)return {task:recent,reason:'working cottage with recent tool activity'};
  if(working.length)return {task:working[0],reason:'working cottage'};
  const input=tasks.find(task=>task.input);
  if(input)return {task:input,reason:'cottage awaiting input'};
  const ready=tasks.find(task=>task.prStage==='ready');
  if(ready)return {task:ready,reason:'cottage with a ready PR'};
  const selected=tasks.find(task=>task.id===selectedId);
  return selected?{task:selected,reason:'selected cottage'}:null;
}
export function sceneShare(value) {
  const number=Number(value);
  return Number.isFinite(number)?Math.max(30,Math.min(75,Math.round(number))):55;
}
/** Keep the control outside generated/streaming markup so dragging never loses its node. */
export function bindSceneBalance({input,output,root,onResize=()=>{}}) {
  const apply=()=>{
    const value=sceneShare(input.value);input.value=String(value);
    root.style.setProperty('--cc-scene-share',`${value}fr`);
    root.style.setProperty('--cc-desk-share',`${100-value}fr`);
    output.textContent=`${value}% town`;
    input.setAttribute('aria-valuetext',`${value}% town, ${100-value}% workbench`);
    onResize(value);
  };
  input.addEventListener('input',apply);input.addEventListener('change',apply);apply();
  return ()=>{input.removeEventListener('input',apply);input.removeEventListener('change',apply);};
}
export function projectBounds(plots,town) {
  const matching=plots.filter(plot=>!town||(plot.agent.town||plot.agent.role||'WildTown')===town);
  if(!matching.length)return null;
  const x=Math.min(...matching.map(p=>p.x))-24,y=Math.min(...matching.map(p=>p.y))-36;
  return {x,y,w:Math.max(...matching.map(p=>p.x+78))-x,h:Math.max(...matching.map(p=>p.y+146))-y};
}
