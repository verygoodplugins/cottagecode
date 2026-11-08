/** Shared presentation model. Observation, progress, execution and review stay independent. */
import {normalizePr,prStage as stageOf,prCi,prKey as keyOf} from './pr.mjs';
import {normalizeInputRequest} from './input-request.mjs';
import {conversationCapability} from './conversation.mjs';
import {validTime} from './feed-client.mjs';
import {classifyOccupancy} from './occupancy.mjs';
import {taskText} from './task-text.mjs';
import {isTerminalForMessage} from './command-replies.mjs';

const text=value=>typeof value==='string'?value.trim():'';
const publicKinds=new Set(['request','progress','summary','tool','result','status','handoff']);
export const QUIET_AFTER_MS=15*60*1000;
/** Join only accepted identities; the renderer's PR normalization remains authoritative. */
export function commandSnapshot(agents,meta={}, {stale=false}={}) {
  const evidence=new Map((meta.agents||[]).filter(a=>a&&a.id!=null).map(a=>[String(a.id),a]));
  const snapshot={...meta,stale:Boolean(stale||meta.stale),agents:(agents||[]).map(agent=>{
    const raw=evidence.get(String(agent.id));
    return raw?{...raw,...agent,model:raw.model,status:raw.status,terminal:raw.terminal}:{...agent};
  })};
  const shared=new Map(fleetView(snapshot,{includeSettled:true}).prs.filter(group=>group.taskIds.length>1).map(group=>[group.key,group.pr]));
  if(shared.size)snapshot.agents=snapshot.agents.map(agent=>shared.has(keyOf(agent.pr))?{...agent,pr:shared.get(keyOf(agent.pr))}:agent);
  return snapshot;
}
export function safeUrl(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
export function durationLabel(milliseconds){
  if(!Number.isFinite(milliseconds)||milliseconds<0)return 'Unavailable';
  let seconds=Math.floor(milliseconds/1000);const parts=[];
  for(const [size,unit] of [[86400,'d'],[3600,'h'],[60,'m'],[1,'s']]){
    const amount=Math.floor(seconds/size);seconds%=size;
    if(amount||parts.length)parts.push(`${amount}${unit}`);
    if(parts.length===2)break;
  }
  return parts.join(' ')||'0s';
}
const age=(value,now)=>{const time=validTime(value);return time!==null&&time<=now?now-time:null;};
function issuesOf(agent){
  const supplied=[...(Array.isArray(agent.issues)?agent.issues:[]),...(agent.issue?[agent.issue]:[]),...(Array.isArray(agent.resultLinks)?agent.resultLinks:[]).filter(link=>link?.kind==='issue'||link?.type==='issue')];
  const issues=new Map();
  for(const value of supplied){const raw=typeof value==='string'?{url:value}:value;const url=safeUrl(raw?.url);if(url)issues.set(url,{...raw,url,title:text(raw.title)||'Recorded issue'});}
  return [...issues.values()];
}
export function taskView(agent,{now=Date.now(),stale=false,endpoint='http://127.0.0.1:8790/agents',builtInDemo=false}={}){
  const raw=agent||{},sourceStale=Boolean(stale||raw.isStale||raw.freshness?.isStale);
  // Canonical Hub readiness survives an outage. Standalone readiness needs fresh evidence.
  const pr=normalizePr(raw.pr?.authority==='hub'?raw.pr:{...raw.pr,...(sourceStale?{stale:true}:{})},now);
  const input=normalizeInputRequest(raw.inputRequest);
  const terminal=raw.terminal===true||['done','offline','completed','failed','cancelled','interrupted'].includes(raw.status);
  const end=terminal?validTime(raw.endedAt):now,start=validTime(raw.sessionStartedAt);
  const sessionAgeMs=start!==null&&end!==null&&end>=start?end-start:null;
  // Hub durationMs measures execution only; Task age includes input/review/merge waits.
  const taskStart=validTime(raw.taskStartedAt);
  const taskAgeMs=taskStart!==null&&end!==null&&end>=taskStart&&end<=now?end-taskStart:null;
  const recordedExecutionMs=Number.isFinite(raw.durationMs)&&raw.durationMs>=0?raw.durationMs:null;
  const progressAgeMs=age(raw.lastProgressAt??raw.telemetry?.progressAt,now);
  const status=text(raw.status)||'unknown';
  const capability=builtInDemo&&raw.source==='demo'&&input?{available:true,mode:'respond',demo:true}:isTerminalForMessage(raw)?{available:false,reason:'This task has finished.'}:conversationCapability(raw,endpoint,{stale:sourceStale,now});
  const events=(Array.isArray(raw.events)?raw.events:Array.isArray(raw.activityEvents)?raw.activityEvents:[]).filter(event=>publicKinds.has(event?.kind)&&typeof event.text==='string').map(event=>({...event}));
  return {id:String(raw.id??raw.taskId??''),raw,title:taskText(raw.task)||text(raw.title)||text(raw.name)||'Untitled task',
    project:text(raw.project?.name)||text(raw.project)||text(raw.town)||text(raw.repo)||'Unassigned',town:text(raw.town)||'Unknown town',
    harness:text(raw.harness)||text(raw.execution?.harness)||'Unknown',model:text(raw.model)||'Unknown',status,
    taskAgeMs,recordedExecutionMs,sessionAgeMs,observedAgeMs:age(raw.updatedAt,now),progressAgeMs,
    quiet:!terminal&&status==='working'&&progressAgeMs!==null&&progressAgeMs>=QUIET_AFTER_MS,
    input,capability,pr,prKey:keyOf(pr),prStage:stageOf(pr,now),ci:prCi(pr),
    attention:Boolean(input||status==='blocked'||pr.stage==='blocked'||text(raw.attention)),
    activity:text(raw.activity)||text(raw.lastLine),events,issues:issuesOf(raw),parent:raw.parent==null?null:String(raw.parent),sourceStale};
}

export function fleetView(snapshot,options={}){
  const now=options.now??Date.now(),envelope=Array.isArray(snapshot)?{agents:snapshot}:snapshot||{};
  const stale=Boolean(options.stale||envelope.stale),all=Array.isArray(envelope.agents)?envelope.agents:[];
  const settled=agent=>agent.inventoryScope==='history'||(agent.inventoryScope!=='dashboard'&&(agent.occupancy?agent.occupancy==='settled':classifyOccupancy(agent,now)==='settled'));
  let tasks=all.filter(agent=>options.includeSettled||!settled(agent)).map(agent=>taskView(agent,{...options,now,stale}));
  const projects=new Map(),groups=new Map();
  for(const task of tasks){
    if(task.prKey){if(!groups.has(task.prKey))groups.set(task.prKey,[]);groups.get(task.prKey).push(task);}
  }
  const prs=[...groups].map(([key,members])=>{
    const canonical=members.filter(task=>task.pr.authority==='hub');const candidates=canonical.length?canonical:members;
    const latest=Math.max(...candidates.map(task=>task.pr.checkedAt||0));const current=candidates.filter(task=>(task.pr.checkedAt||0)===latest);
    const conflict=new Set(current.map(task=>task.prStage)).size>1||new Set(current.map(task=>task.pr.headSha).filter(Boolean)).size>1;
    const pr=conflict?{...current[0].pr,state:'unknown',stage:'unknown',reviewState:'unknown',reviewUncertain:true,reason:'Shared PR observations conflict at the same verification time.'}:current[0].pr;
    return {key,pr,stage:pr.stage,taskIds:members.map(task=>task.id)};
  });
  const canonicalByKey=new Map(prs.map(group=>[group.key,group]));
  tasks=tasks.map(task=>{
    const group=canonicalByKey.get(task.prKey);if(!group)return task;
    return {...task,pr:group.pr,prStage:group.stage,ci:prCi(group.pr),
      attention:Boolean(task.input||task.status==='blocked'||group.stage==='blocked'||text(task.raw.attention))};
  });
  for(const task of tasks){
    if(!projects.has(task.project))projects.set(task.project,{id:task.project,name:task.project,count:0,working:0,attention:0});
    const project=projects.get(task.project);project.count++;project.working+=Number(task.status==='working');project.attention+=Number(task.attention);
  }
  const nodes=new Set(tasks.map(task=>`task:${task.id}`)),aliases=new Map();
  for(const task of tasks){aliases.set(task.id,task.id);if(task.raw.taskId)aliases.set(String(task.raw.taskId),task.id);for(const issue of task.issues)nodes.add(`issue:${issue.url}`);if(task.prKey)nodes.add(`pr:${task.prKey}`);}
  const edges=new Map();
  function edge(from,to,kind){if(from!==to&&nodes.has(from)&&nodes.has(to)&&kind)edges.set(`${from}|${to}|${kind}`,{from,to,kind});}
  for(const task of tasks){
    if(aliases.has(task.parent))edge(`task:${aliases.get(task.parent)}`,`task:${task.id}`,'parent');
    for(const issue of task.issues)edge(`issue:${issue.url}`,`task:${task.id}`,'implements');
    if(task.prKey)edge(`task:${task.id}`,`pr:${task.prKey}`,'produces');
  }
  // Unstructured project paths and prose never become task relationships.
  for(const relation of Array.isArray(envelope.relationships)?envelope.relationships:[]){
    if(typeof relation?.from==='string'&&typeof relation?.to==='string')edge(relation.from,relation.to,text(relation.kind));
  }
  return {tasks,projects:[...projects.values()],prs,edges:[...edges.values()],counts:{tasks:tasks.length,working:tasks.filter(t=>t.status==='working').length,
    attention:tasks.filter(t=>t.attention).length,answerable:tasks.filter(t=>t.input&&t.capability.available&&t.capability.mode==='respond').length,
    quiet:tasks.filter(t=>t.quiet).length,ready:prs.filter(p=>p.stage==='ready').length,blockedPr:prs.filter(p=>p.stage==='blocked').length,settled:all.length-tasks.length},
    stale,checkedAt:validTime(envelope.checkedAt)??validTime(envelope.timestamp)??null};
}
