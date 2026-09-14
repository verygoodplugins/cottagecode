import {prStage,prKey,prCounts,PR_STAGES} from './pr.mjs';

const LIMIT=1600;
const ARTIFACT_LIMIT=100;
const safeUrl=raw=>{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'?value:'';
const stages=new Set(PR_STAGES);
const finiteTime=value=>Number.isFinite(value)&&value>=0;
const taskKey=(id,taskId)=>JSON.stringify([id,taskId]);
const groupKey=(key,id,taskId)=>key?'pr:'+key:'cottage:'+taskKey(id,taskId);

function boundedMap(entries){
  return new Map(entries.sort((a,b)=>(a[1].observedAt||0)-(b[1].observedAt||0)).slice(-LIMIT));
}
function trimMap(map){while(map.size>LIMIT)map.delete(map.keys().next().value);}
function recentSet(map,key,value){map.delete(key);map.set(key,value);}

export function createHistory({storage=null,key='demo',now=()=>Date.now()}={}){
  const storageKey='cottagecode:journal:v1:'+key;
  let saved=null;
  try{saved=JSON.parse(storage?.getItem(storageKey)||'null');}catch{}
  if(!object(saved))saved={};
  const events=new Map();
  for(const e of Array.isArray(saved.events)?saved.events:[]){
    if(object(e)&&text(e.id)&&finiteTime(e.timestamp))events.set(e.id,{...e,url:safeUrl(e.url)});
  }
  let data={
    events:[...events.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-LIMIT),
    lastVisit:finiteTime(saved.lastVisit)?saved.lastVisit:0,
    sequence:Number.isSafeInteger(saved.sequence)&&saved.sequence>=0?saved.sequence:0,
    states:{},prStates:{},
  };
  let previous=boundedMap(Object.entries(object(saved.states)?saved.states:{}).filter(([id,s])=>id&&object(s)&&typeof s.status==='string').map(([id,s])=>[id,{
    status:s.status,stage:stages.has(s.stage)?s.stage:'unknown',taskId:text(s.taskId),result:text(s.result).slice(0,350),
    prKey:text(s.prKey),observedAt:finiteTime(s.observedAt)?s.observedAt:data.lastVisit,
    artifacts:(Array.isArray(s.artifacts)?s.artifacts:[]).map(safeUrl).filter(Boolean).slice(-ARTIFACT_LIMIT),
  }]));
  let previousPr=boundedMap(Object.entries(object(saved.prStates)?saved.prStates:{}).filter(([id,s])=>id&&object(s)&&stages.has(s.stage)).map(([id,s])=>[id,{
    stage:s.stage,observedAt:finiteTime(s.observedAt)?s.observedAt:data.lastVisit,
  }]));
  let initialized=previous.size>0||previousPr.size>0;
  const since=data.lastVisit||now();
  const seen=new Set(data.events.map(e=>e.id));
  const persist=()=>{
    data.states=Object.fromEntries(previous);data.prStates=Object.fromEntries(previousPr);
    try{storage?.setItem(storageKey,JSON.stringify(data));}catch{/* history still works in memory */}
  };
  function append(e){
    if(!object(e)||!text(e.id)||!finiteTime(e.timestamp)||seen.has(e.id))return false;
    seen.add(e.id);data.events.push({...e,url:safeUrl(e.url)});
    data.events.sort((a,b)=>a.timestamp-b.timestamp);
    if(data.events.length>LIMIT){
      for(const old of data.events.splice(0,data.events.length-LIMIT))seen.delete(old.id);
    }
    return seen.has(e.id);
  }
  function record(e){const added=append(e);if(added)persist();return added;}

  return {
    observe(agents,{initial=false}={}){
      const time=now(),additions=[],next=new Map(previous),groups=new Map();
      const observedTasks=new Set(data.events.filter(e=>e.agentId).map(e=>taskKey(e.agentId,e.taskId||'')));
      const add=(base,kind,message,identity,extra={})=>{
        const e={...base,...extra,kind,text:message,id:kind+':'+identity+':'+time+':'+(++data.sequence)};
        if(append(e))additions.push(e);
      };
      for(const a of agents){
        if(!a||a.id==null)continue;
        const id=String(a.id),taskId=a.taskId==null?'':String(a.taskId),key=prKey(a.pr);
        const artifacts=[...new Map((Array.isArray(a.artifacts)?a.artifacts:[])
          .filter(object).map(artifact=>[safeUrl(artifact.url),artifact]).filter(([url])=>url)).entries()].slice(-ARTIFACT_LIMIT);
        const state={status:text(a.status)||'unknown',stage:prStage(a.pr,time),taskId,result:text(a.result).slice(0,350),
          prKey:key,observedAt:time,artifacts:artifacts.map(([url])=>url)};
        const prev=previous.get(id),sameTask=prev&&prev.taskId===taskId;
        recentSet(next,id,state);
        const base={agentId:id,name:a.name||id,town:a.town||a.role,timestamp:time,url:safeUrl(a.pr?.url),taskId};
        if(!prev){
          // The first snapshot cannot establish when work or a review finished.
          if(!observedTasks.has(taskKey(id,taskId)))
            add(base,initialized&&!initial?'arrival':'observed',initialized&&!initial?'Arrived in '+base.town:'First observed · '+state.status,taskKey(id,taskId));
        }else if(!sameTask){
          if(taskId)add(base,'task','New task observed',taskKey(id,taskId));
        }else{
          if(prev.status!==state.status)add(base,'status','Task '+state.status,taskKey(id,taskId)+':'+state.status);
          if(state.result&&state.result!==prev.result)add(base,'result',state.result,taskKey(id,taskId));
        }
        for(const [url,artifact] of artifacts){
          if(sameTask&&prev.artifacts.includes(url))continue;
          // Artifact IDs are stable across polls, and task-scoped across reuse.
          append({...base,kind:'artifact',text:String(artifact.title||'Artifact'),url,id:'artifact:'+taskKey(id,taskId)+':'+url});
        }
        const gkey=groupKey(key,id,taskId);
        if(!groups.has(gkey))groups.set(gkey,{key,agents:[],bases:[],prior:[]});
        const group=groups.get(gkey);
        group.agents.push(a);group.bases.push(base);
        if(sameTask&&(!key||!prev.prKey||prev.prKey===key))group.prior.push(prev.stage);
      }

      const nextPr=new Map(previousPr);
      for(const [gkey,group] of groups){
        // Use the exact same fresh/conflicting-evidence policy as the PR tally.
        const counts=prCounts(group.agents,time),stage=PR_STAGES.find(stage=>counts[stage]>0)||'unknown';
        let prev=previousPr.get(gkey);
        if(!prev&&group.prior.length){
          const priorStages=new Set(group.prior);
          prev={stage:priorStages.size===1?group.prior[0]:'unknown'};
        }
        if(prev&&prev.stage!==stage){
          // One parcel can belong to a parent and several apprentices.
          const index=group.agents.findIndex(a=>!a.parent);
          const base=group.bases[index<0?0:index];
          add(base,'pr','PR · '+stage,gkey+':'+stage,{prKey:group.key,agentIds:group.bases.map(b=>b.agentId)});
        }
        recentSet(nextPr,gkey,{stage,observedAt:time});
      }
      trimMap(next);trimMap(nextPr);previous=next;previousPr=nextPr;
      initialized=true;data.lastVisit=time;persist();return additions;
    },
    record,
    events:()=>data.events.map(e=>({...e})),
    sinceVisit:()=>data.events.filter(e=>e.timestamp>since&&e.kind!=='observed').map(e=>({...e})),
    baseline:since,
    clear(){data.events=[];seen.clear();previous.clear();previousPr.clear();initialized=false;persist();},
  };
}

export function replayFrame(events,index){
  const bounded=events.slice(0,Math.max(0,index+1)),states=new Map();
  for(const e of bounded){
    const ids=e.kind==='pr'&&Array.isArray(e.agentIds)?e.agentIds:[e.agentId];
    for(const id of ids){
      const s=states.get(id)||{name:id===e.agentId?e.name:id,town:e.town};
      if(e.kind==='observed'&&e.text?.startsWith('First observed · '))s.status=e.text.slice('First observed · '.length);
      if(e.kind==='status')s.status=e.text.replace(/^Task /,'');
      if(e.kind==='pr')s.pr=e.text.replace(/^PR · /,'');
      states.set(id,s);
    }
  }
  return {event:bounded.at(-1)||null,states};
}
