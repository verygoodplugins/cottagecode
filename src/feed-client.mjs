import {normalizePr,hasOutstandingPr} from './pr.mjs';
import {taskText} from './task-text.mjs';
const statuses=new Set(['working','idle','blocked','done','offline']);
export function feedEnvelope(data){
  if(Array.isArray(data))return {agents:data,source:'',relationships:[],handoffs:[]};
  if(!data||!Array.isArray(data.agents)) throw new Error('response must be an agents array or { agents: [] }');
  return {agents:data.agents,source:String(data.source||''),relationships:data.relationships||[],handoffs:data.handoffs||[],stale:!!data.stale,errors:data.errors||[]};
}
export function validTime(value){
  const n=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(n)&&n>=1577836800000?n:null;
}
export function normalizeCottage(a,i,{town,model,occupancy,now=Date.now()}){
  const status=statuses.has(a.status)?a.status:'idle';
  const pr=normalizePr(a.pr,now);
  const result={...a,id:String(a.id??'n'+i),name:String(a.name??a.id??'agent-'+i),town:town(a.town||a.role),
    role:town(a.town||a.role),status,parent:a.parent??null,task:taskText(a.task)||'-',
    originalAsk:taskText(a.originalAsk),
    taskId:a.taskId?String(a.taskId):null,
    taskStartedAt:validTime(a.taskStartedAt),sessionStartedAt:validTime(a.sessionStartedAt),
    startedAt:validTime(a.startedAt),endedAt:validTime(a.endedAt),updatedAt:validTime(a.updatedAt),terminal:!!a.terminal,
    worktree:String(a.worktree||''),worktreePath:String(a.worktreePath||''),branch:String(a.branch||''),
    activity:String(a.activity||''),lastLine:String(a.lastLine||''),result:String(a.result||''),
    attention:String(a.attention||''),model:model(a.model),tokens:Number(a.tokens)||0,cost:Number(a.cost)||0,
    dispatchedBy:String(a.dispatchedBy||a.parent||'unknown'),pr};
  // The Hub owns dashboard membership. A historical PR link is still useful
  // at the desk, but it cannot bring an archived task back into the village.
  result.occupancy=a.inventoryScope==='history'?'settled':
    a.inventoryScope==='dashboard'?(a.occupancy||(['working','blocked','idle'].includes(status)?'live':'recent')):
    hasOutstandingPr(result,now)?'live':(a.occupancy||occupancy(result,now));
  return result;
}
export function isCottageVisible(agent,{showSettled=false,interiorId=null,now=Date.now()}={}){
  return showSettled||interiorId===agent.id||
    (agent.inventoryScope!=='history'&&(agent.occupancy!=='settled'||hasOutstandingPr(agent,now)));
}
export function layoutCottages(agents,options={}){
  // Standalone feeds retain their stable household anchors. Canonical history
  // gets plots only when requested, so it cannot crowd out the live village.
  return agents.filter(agent=>agent.inventoryScope!=='history'||isCottageVisible(agent,options));
}
export function feedStatusNote(agents,{source='',stale=false}={}){
  const visible=agents.filter(agent=>isCottageVisible(agent)).length;
  const sourceName=({hub:'AutoHub',claude:'Claude sessions','hub+claude':'AutoHub + Claude sessions',codex:'Codex tasks',demo:'Demo village',none:'Local feed'})[source]||source||'Custom feed';
  return `${stale?'Stale snapshot · ':''}${sourceName} · ${visible} live + recent · ${agents.length-visible} settled`;
}
export function activityAddress(agent,endpoint){
  if(!agent.activityUrl)return null;
  try{const url=new URL(agent.activityUrl,endpoint);return ['http:','https:'].includes(url.protocol)?url:null;}catch{return null;}
}
export function mergeActivity(current,incoming){
  const events=new Map(current.map(e=>[String(e.id),e]));
  for(const e of incoming||[]){
    if(!e||e.id==null||typeof e.text!=='string')continue;
    events.set(String(e.id),{...e,id:String(e.id)});
  }
  const ordered=[...events.values()];
  let anchor=ordered.find(e=>Number.isFinite(e.timestamp))?.timestamp||0;
  return ordered.map(event=>{
    if(Number.isFinite(event.timestamp))anchor=event.timestamp;
    return {event,order:anchor};
  }).sort((a,b)=>a.order-b.order).map(item=>item.event);
}
export function elapsedMs(agent,now=Date.now()){
  // Delivery may finish long after execution, when its PR merges.
  if(Number.isFinite(agent.durationMs)&&agent.durationMs>=0)return agent.durationMs;
  const start=validTime(agent.taskStartedAt);
  if(!start)return null;
  const terminal=['done','offline'].includes(agent.status)||agent.terminal===true;
  const end=terminal?validTime(agent.endedAt):now;
  return end&&end>=start?end-start:null;
}
