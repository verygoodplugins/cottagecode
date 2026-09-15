import {normalizePr,hasOutstandingPr} from './pr.mjs';
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
    role:town(a.town||a.role),status,parent:a.parent??null,task:String(a.task??'-'),
    originalAsk:typeof a.originalAsk==='string'?a.originalAsk:'',
    taskId:a.taskId?String(a.taskId):null,
    taskStartedAt:validTime(a.taskStartedAt),sessionStartedAt:validTime(a.sessionStartedAt),
    startedAt:validTime(a.startedAt),endedAt:validTime(a.endedAt),updatedAt:validTime(a.updatedAt),terminal:!!a.terminal,
    worktree:String(a.worktree||''),worktreePath:String(a.worktreePath||''),branch:String(a.branch||''),
    activity:String(a.activity||''),lastLine:String(a.lastLine||''),result:String(a.result||''),
    attention:String(a.attention||''),model:model(a.model),tokens:Number(a.tokens)||0,cost:Number(a.cost)||0,
    dispatchedBy:String(a.dispatchedBy||a.parent||'unknown'),pr};
  result.occupancy=hasOutstandingPr(result,now)?'live':(a.occupancy||occupancy(result,now));
  return result;
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
  const start=validTime(agent.taskStartedAt);
  if(!start)return null;
  const terminal=['done','offline'].includes(agent.status)||agent.terminal===true;
  const end=terminal?validTime(agent.endedAt):now;
  return end&&end>=start?end-start:null;
}
