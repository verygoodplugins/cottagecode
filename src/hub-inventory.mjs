/** Canonical AutoHub task inventory, adapted to the existing cottage contract.
 * Only this server holds the optional bearer token; it is never in feed JSON. */
import {toCottage} from './hub.mjs';
import {timestampMs} from './activity.mjs';
import {taskText} from './task-text.mjs';
import {classifyOccupancy} from './occupancy.mjs';

export function toInventoryCottage(task, now=Date.now()) {
  const context=typeof task.context==='object' && task.context ? task.context : {};
  const prLink=(task.resultLinks || []).find(link=>link.kind==='pull_request');
  const cottage=toCottage({...task,
    record_kind:task.recordKind,parent_id:task.parentId,session_id:task.sessionId,
    status:task.normalizedStatus==='completed_without_report'?'completed':task.normalizedStatus || task.status,
    queued_at:task.queuedAt,started_at:task.startedAt,completed_at:task.completedAt,updated_at:task.updatedAt,
    input_tokens:task.inputTokens,output_tokens:task.outputTokens,cache_write_tokens:task.cacheWriteTokens,cache_read_tokens:task.cacheReadTokens,total_cost:task.totalCost,
    result_summary:task.resultSummary || task.displayResult,
    context:{...context,projectPath:task.projectPath || context.projectPath,workFolder:task.worktreePath || task.projectPath,
      branch:task.branch,originalAsk:task.originalRequest,
      ...(prLink ? {pr:{url:prLink.url,state:'unknown',source:'context'}} : {})},
  },now);
  const request=taskText(task.originalRequest);
  cottage.taskId=task.id;
  cottage.originalAsk=request;
  cottage.originalAskSource=task.recordKind==='external_session'?'session':'task';
  cottage.task=(request || taskText(task.title || task.task) || 'Task').slice(0,150);
  cottage.activity=task.currentActivity || task.currentStep || cottage.activity;
  cottage.lastLine=cottage.activity || cottage.result || cottage.task;
  cottage.worktreePath=task.worktreePath || task.projectPath || '';
  cottage.branch=task.branch || '';
  cottage.updatedAt=timestampMs(task.updatedAt) || cottage.updatedAt;
  cottage.inventorySource=task.source || null;
  cottage.dispatchedBy=task.provenance?.caller || task.provenance?.platform || task.platform || task.provider || 'hub';
  cottage.freshness=task.freshness || {lastSeenAt:task.lastSeenAt || null,isStale:task.isStale===true};
  cottage.resultLinks=Array.isArray(task.resultLinks) ? task.resultLinks.filter(link=>typeof link?.url==='string' && /^https?:\/\//.test(link.url)).map(({kind,url})=>({kind,url})) : [];
  cottage.conversationTarget={...cottage.conversationTarget,
    taskId:task.id,taskStatus:task.normalizedStatus || task.status,recordKind:task.recordKind,
    controlTargetId:typeof task.controlTargetId==='string'?task.controlTargetId:null,
    capabilities:{canRespond:task.capabilities?.canRespond===true,canSteer:task.capabilities?.canSteer===true},
  };
  if(task.isStale || cottage.freshness.isStale) {
    if(cottage.status==='working')cottage.status='offline';
    if(cottage.inputRequest)cottage.inputRequest={...cottage.inputRequest,stale:true};
  }
  cottage.occupancy=classifyOccupancy(cottage,now);
  return cottage;
}

export function createHubInventoryReader({
  baseUrl=process.env.AUTOHUB_HUB_BASE || '',token=process.env.AUTOHUB_HUB_TOKEN || process.env.COTTAGE_HUB_TOKEN || '',
  fetchFn=globalThis.fetch,now=Date.now,ttl=5000,pageSize=250,
}={}) {
  let base=null;
  if(baseUrl) {
    try {
      base=new URL(baseUrl);
      if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();
      base.pathname=base.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1/';base.search='';base.hash='';
    } catch {throw new Error('AUTOHUB_HUB_BASE must be an HTTP(S) URL without credentials.');}
  }
  let previous=null,checkedAt=0,inFlight=null;
  async function get(path) {
    const response=await fetchFn(new URL(path,base),{headers:{accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{})},redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Hub inventory temporarily unavailable');
    return response.json();
  }
  async function refresh() {
    try {
      const tasks=new Map(),seen=new Set();let cursor='';
      do {
        const query=new URLSearchParams({scope:'history',limit:String(pageSize)});
        if(cursor)query.set('cursor',cursor);
        const page=await get(`tasks?${query}`);
        if(!Array.isArray(page.tasks))throw new Error();
        for(const task of page.tasks) {
          if(typeof task?.id!=='string'||!task.id)throw new Error();
          tasks.set(task.id,toInventoryCottage(task,now()));
        }
        cursor=page.has_more ? page.next_cursor : '';
        if(page.has_more && (typeof cursor!=='string'||!cursor||seen.has(cursor)))throw new Error();
        if(cursor)seen.add(cursor);
      }while(cursor);
      previous={ok:true,agents:[...tasks.values()],keys:new Set(tasks.keys()),links:new Map([...tasks.keys()].map(id=>[id,new Set([id])]))};
      checkedAt=now();return previous;
    }catch {throw new Error('Hub inventory temporarily unavailable');}
  }
  return {configured:Boolean(base),
    async read(){
      if(!base)return {ok:true,missing:true,agents:[],keys:new Set(),links:new Map()};
      if(previous && now()-checkedAt<ttl)return previous;
      if(!inFlight)inFlight=refresh().finally(()=>{inFlight=null;});
      return inFlight;
    },
    async detail(id){
      if(!base||!id)return null;
      try {
        const task=await get(`tasks/${encodeURIComponent(id)}`);
        if(task.id!==id)throw new Error();
        return toInventoryCottage(task,now());
      }catch {throw new Error('Hub task detail temporarily unavailable');}
    },
  };
}
