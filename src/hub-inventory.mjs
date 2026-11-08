/** Canonical AutoHub task inventory, adapted to the existing cottage contract.
 * Only this server holds the optional bearer token; it is never in feed JSON. */
import {toCottage} from './hub.mjs';
import {timestampMs,safeActivityUrl} from './activity.mjs';
import {taskText} from './task-text.mjs';
import {classifyOccupancy} from './occupancy.mjs';
import {normalizePr} from './pr.mjs';
import {attachHubTelemetry} from './hub-telemetry.mjs';
import {createHubEventStream} from './hub-event-stream.mjs';

// Hub's dashboard is a list of roots, not a lifecycle filter for their children.
// Promote only explicitly linked, canonically fresh active sessions; cached
// history remains untouched so a disappearing root cannot leave ghosts behind.
function includeActiveFamilies(tasks, now) {
  const active = cottage => cottage.conversationTarget?.recordKind==='external_session' &&
    cottage.freshness?.isStale===false && ['working','blocked','idle'].includes(cottage.status) &&
    ['running','queued','pending','needs_input','awaiting_input','awaiting_review'].includes(cottage.executionStatus);
  for(const cottage of tasks.values()) {
    if(cottage.inventoryScope!=='history'||!cottage.parent||!active(cottage))continue;
    const seen=new Set([cottage.id]);let ancestor=tasks.get(cottage.parent),anchored=false,valid=false;
    while(ancestor) {
      if(seen.has(ancestor.id))break;
      seen.add(ancestor.id);
      if(ancestor.inventoryScope==='dashboard')anchored=true;
      else if(!active(ancestor))break;
      if(!ancestor.parent){valid=anchored;break;}
      ancestor=tasks.get(ancestor.parent);
    }
    if(valid) {
      const family={...cottage,inventoryScope:'family'};
      family.occupancy=classifyOccupancy(family,now);
      tasks.set(cottage.id,family);
    }
  }
}

export function toInventoryCottage(task, now=Date.now()) {
  const context=typeof task.context==='object' && task.context ? task.context : {};
  const resultLinks=Array.isArray(task.resultLinks) ? task.resultLinks.flatMap(link=>{
    const url=safeActivityUrl(link?.url);
    return url?[{...link,url}]:[];
  }) : [];
  const prLink=resultLinks.find(link=>link.kind==='pull_request');
  const cottage=toCottage({...task,
    model:task.model || context.agentKernel?.route?.model ||
      (task.backend==='codex'?'openai':task.provider || task.backend || 'unknown'),
    record_kind:task.recordKind,parent_id:task.parentId,session_id:task.sessionId,
    status:task.normalizedStatus==='completed_without_report'?'completed':task.normalizedStatus || task.status,
    queued_at:task.queuedAt,started_at:task.startedAt,completed_at:task.completedAt,updated_at:task.updatedAt,
    input_tokens:task.inputTokens,output_tokens:task.outputTokens,cache_write_tokens:task.cacheWriteTokens,cache_read_tokens:task.cacheReadTokens,total_cost:task.totalCost,
    result_summary:task.displayResult || task.resultSummary,
    context:{...context,projectPath:task.projectPath || context.projectPath,workFolder:task.worktreePath || task.projectPath,
      branch:task.branch,originalAsk:task.originalRequest,
      ...(prLink ? {pr:{url:prLink.url,state:'unknown',source:'context'}} : {})},
  },now);
  const request=taskText(task.originalRequest);
  cottage.taskId=task.id;
  // The inventory's execution backend is explicit harness evidence; a model or
  // the caller who dispatched the task is not a substitute for it.
  cottage.harness=typeof task.harness==='string'&&task.harness.trim()?task.harness.trim().slice(0,120):
    typeof task.backend==='string'&&task.backend.trim()?task.backend.trim().slice(0,120):null;
  // The shared inventory owns lifecycle evidence. Old local context and prose
  // must never override a fresher reconciliation (or invent a missing PR).
  const finalizationState=task.finalization?.status;
  const blocker=taskText(typeof task.finalization?.blocker==='string' ? task.finalization.blocker : task.finalization?.blocker?.message);
  cottage.pr=normalizePr(task.pr ? {...task.pr,authority:'hub',
    reviewState:['ready','blocked'].includes(finalizationState) ? finalizationState : task.pr.reviewState,
    reason:blocker || task.pr.reason,
  } : (prLink ? {url:prLink.url,state:'unknown',source:'hub',authority:'hub'} : null),now);
  cottage.durationMs=Number.isFinite(task.durationMs)&&task.durationMs>=0?task.durationMs:null;
  cottage.executionStatus=task.normalizedStatus || task.status;
  cottage.finalization=task.finalization ? {
    status:task.finalization.status,disposition:task.finalization.disposition,
    summary:taskText(task.finalization.summary),
    blocker:taskText(typeof task.finalization.blocker==='string' ? task.finalization.blocker : task.finalization.blocker?.message),
  } : null;
  cottage.cleanup=task.cleanup ? {status:task.cleanup.status,reason:taskText(task.cleanup.reason),checkedAt:task.cleanup.checkedAt} : null;
  cottage.version=task.version || 0;
  cottage.originalAsk=request.slice(0,32768);
  cottage.originalAskTruncated=request.length>32768;
  cottage.originalAskSource=task.recordKind==='external_session'?'session':'task';
  cottage.task=(request || taskText(task.title || task.task) || 'Task').slice(0,150);
  cottage.activity=task.currentActivity || task.currentStep || cottage.activity;
  cottage.lastLine=cottage.activity || cottage.result || cottage.task;
  cottage.worktreePath=task.worktreePath || task.projectPath || '';
  cottage.branch=task.branch || '';
  cottage.updatedAt=timestampMs(task.updatedAt) || cottage.updatedAt;
  cottage.inventorySource=task.source || null;
  // The rollout observer writes cumulative usage to the shared event stream,
  // not the legacy task counters (whose storage defaults are zero).
  if(task.recordKind==='external_session'&&task.source==='codex_rollout') {
    if(cottage.tokens===0)cottage.tokens=null;
    if(cottage.cost===0)cottage.cost=null;
  }
  cottage.dispatchedBy=task.provenance?.caller || task.provenance?.platform || task.platform || task.provider || 'hub';
  cottage.freshness=task.freshness || {lastSeenAt:task.lastSeenAt || null,isStale:typeof task.isStale==='boolean'?task.isStale:null};
  cottage.resultLinks=resultLinks.map(({kind,url})=>({kind,url}));
  cottage.artifacts=resultLinks.map(link=>({url:link.url,title:taskText(link.label || link.title) || (link.kind==='pull_request'?'Pull request':'Result')}));
  cottage.conversationTarget={...cottage.conversationTarget,
    taskId:task.id,taskStatus:task.normalizedStatus || task.status,recordKind:task.recordKind,
    controlTargetId:typeof task.controlTargetId==='string'?task.controlTargetId:null,
    capabilities:{canRespond:task.capabilities?.canRespond===true,canSteer:task.capabilities?.canSteer===true},
  };
  const canonicalFresh = task.freshness?.isStale===false || task.isStale===false;
  if((task.normalizedStatus || task.status)==='running' && canonicalFresh && !cottage.inputRequest) cottage.status='working';
  if(task.isStale || cottage.freshness.isStale) {
    if(cottage.status==='working')cottage.status='offline';
    if(cottage.inputRequest)cottage.inputRequest={...cottage.inputRequest,stale:true};
  }
  cottage.occupancy=classifyOccupancy(cottage,now);
  return cottage;
}

export function createHubInventoryReader({
  baseUrl=process.env.AUTOHUB_HUB_BASE || '',token=process.env.AUTOHUB_HUB_TOKEN || process.env.COTTAGE_HUB_TOKEN || '',
  fetchFn=globalThis.fetch,now=Date.now,ttl=5000,pageSize=500,historyTtl=60000,timeoutMs=45000,telemetryTimeoutMs=3000,
  streamFactory=createHubEventStream,streamCoalesceMs=100,
}={}) {
  let base=null;
  if(baseUrl) {
    try {
      base=new URL(baseUrl);
      if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error();
      base.pathname=base.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1/';base.search='';base.hash='';
    } catch {throw new Error('AUTOHUB_HUB_BASE must be an HTTP(S) URL without credentials.');}
  }
  let previous=null,checkedAt=0,inFlight=null,history=null,historyCheckedAt=0;
  let revision=0,appliedRevision=0,fullRevision=0,appliedFullRevision=0,canonicalRevision=0;
  const changedTasks=new Map();
  let stream=null,onChange=null,notifyTimer=null;
  function scheduleChange() {
    if(onChange&&notifyTimer===null) {
      notifyTimer=setTimeout(()=>{notifyTimer=null;onChange?.();},streamCoalesceMs);
      notifyTimer.unref?.();
    }
  }
  function invalidate(hint) {
    const next=++revision;
    if(hint.type==='resync'){fullRevision=next;canonicalRevision=next;}
    else if(hint.type==='task'&&typeof hint.taskId==='string') {
      canonicalRevision=next;
      changedTasks.set(hint.taskId,next);
      if(hint.parentTaskId)changedTasks.set(hint.parentTaskId,next);
      // A replay burst is cheaper and more complete as one canonical rebuild.
      if(changedTasks.size>200){fullRevision=next;changedTasks.clear();}
    }
    scheduleChange();
  }
  async function get(path,{allowMissing=false}={}) {
    const response=await fetchFn(new URL(path,base),{headers:{accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{})},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(allowMissing&&response.status===404)return null;
    if(!response.ok)throw new Error('Hub inventory temporarily unavailable');
    return response.json();
  }
  async function telemetry() {
    const controller=new AbortController();let timer;
    try {
      return await Promise.race([
        (async()=>{
          const response=await fetchFn(new URL('agent-events/snapshot?limit=200',base),{headers:{accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{})},redirect:'error',signal:controller.signal});
          if(!response.ok)return null;
          return await response.json();
        })(),
        new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},Math.max(1,telemetryTimeoutMs));}),
      ]);
    }catch{return null;}finally{clearTimeout(timer);}
  }
  async function refresh() {
    try {
      const readingRevision=revision,readingFullRevision=fullRevision;
      const changed=[...changedTasks].filter(([,value])=>value<=readingRevision).map(([id])=>id);
      const telemetryRead=telemetry();
      const tasks=new Map();
      let nextHistory=null,historyPaginated=false;
      // The Hub owns Live + recent membership. History alone cannot reproduce
      // it from PR links or task clocks, and includes old external children.
      // Read dashboard last so its newer rows win if a task changes mid-scan.
      for(const scope of ['history','dashboard']) {
        if(scope==='history'&&history&&readingFullRevision===appliedFullRevision&&now()-historyCheckedAt<historyTtl){
          for(const [id,cottage] of history)tasks.set(id,cottage);
          // Notifications supply identity only. Hydrate the current canonical
          // row (and missing ancestry), including archive/delete/unlink changes.
          const queue=[...changed],seen=new Set();
          while(queue.length) {
            const batch=queue.splice(0,4).filter(id=>!seen.has(id));
            for(const id of batch)seen.add(id);
            const details=await Promise.all(batch.map(async id=>({id,task:await get(`tasks/${encodeURIComponent(id)}`,{allowMissing:true})})));
            for(const {id,task} of details) {
              if(task&&task.id!==id)throw new Error();
              if(!task||task.archived===true){tasks.delete(id);continue;}
              const cottage={...toInventoryCottage(task,now()),inventoryScope:'history'};
              cottage.occupancy=classifyOccupancy(cottage,now());
              const cached=tasks.get(id);
              // Version, not updatedAt: a parent-link change may preserve clocks.
              if(!cached||cottage.version>=cached.version)tasks.set(id,cottage);
              if(cottage.parent&&!tasks.has(cottage.parent)&&!seen.has(cottage.parent)) {
                if(seen.size+queue.length>=200)throw new Error();
                queue.push(cottage.parent);
              }
            }
          }
          nextHistory=new Map(tasks);
          continue;
        }
        const seen=new Set();let cursor='';
        do {
          const query=new URLSearchParams({scope,limit:String(pageSize)});
          if(cursor)query.set('cursor',cursor);
          const page=await get(`tasks?${query}`);
          if(!Array.isArray(page.tasks))throw new Error();
          for(const task of page.tasks) {
            if(typeof task?.id!=='string'||!task.id)throw new Error();
            if(task.archived===true){tasks.delete(task.id);continue;}
            const incoming=toInventoryCottage(task,now()),cached=tasks.get(task.id);
            const cottage={...(cached&&cached.version>incoming.version?cached:incoming),inventoryScope:scope};
            cottage.occupancy=classifyOccupancy(cottage,now());
            tasks.set(task.id,cottage);
          }
          cursor=page.has_more ? page.next_cursor : '';
          if(page.has_more && (typeof cursor!=='string'||!cursor||seen.has(cursor)))throw new Error();
          if(cursor)seen.add(cursor);
        }while(cursor);
        if(scope==='history'){nextHistory=new Map(tasks);historyPaginated=true;}
      }
      if(nextHistory){
        history=nextHistory;
        if(historyPaginated)historyCheckedAt=now();
      }
      includeActiveFamilies(tasks,now());
      const toolSnapshot=await telemetryRead;
      previous={ok:true,agents:[...tasks.values()].map(cottage=>attachHubTelemetry(cottage,toolSnapshot,now())),keys:new Set(tasks.keys()),links:new Map([...tasks.keys()].map(id=>[id,new Set([id])]))};
      checkedAt=now();appliedRevision=readingRevision;appliedFullRevision=readingFullRevision;
      for(const [id,value] of changedTasks)if(value<=readingRevision)changedTasks.delete(id);
      return previous;
    }catch {throw new Error('Hub inventory temporarily unavailable');}
  }
  return {configured:Boolean(base),
    start(callback) {
      if(!base||stream)return;
      onChange=callback;
      stream=streamFactory({url:new URL('agent-events/stream',base),token,fetchFn,onChange:invalidate});
      stream.start();
    },
    stop() {
      stream?.stop();stream=null;onChange=null;
      clearTimeout(notifyTimer);notifyTimer=null;
    },
    async read(){
      if(!base)return {ok:true,missing:true,agents:[],keys:new Set(),links:new Map()};
      if(previous && appliedRevision===revision && now()-checkedAt<ttl)return previous;
      if(!inFlight)inFlight=(async()=>{
        // An event arriving during canonical hydration cannot be marked served
        // by the older response. Catch up once, then publish a coherent pass
        // even when canonical writes continue; dirty versions and IDs survive
        // for the next scan rather than requiring global stream quiescence.
        let passes=0;
        do {await refresh();passes++;}while(appliedRevision<canonicalRevision&&passes<2);
        if(appliedRevision!==revision)scheduleChange();
        return previous;
      })().finally(()=>{inFlight=null;});
      return inFlight;
    },
    async detail(id){
      if(!base||!id)return null;
      try {
        const task=await get(`tasks/${encodeURIComponent(id)}`);
        if(task.id!==id)throw new Error();
        const cottage=toInventoryCottage(task,now());
        const scope=previous?.agents.find(agent=>agent.id===id)?.inventoryScope;
        if(scope)cottage.inventoryScope=scope==='family'?'history':scope;
        if(scope==='family') {
          const family=new Map(previous.agents.map(agent=>[agent.id,agent]));
          family.set(id,cottage);includeActiveFamilies(family,now());
          cottage.inventoryScope=family.get(id).inventoryScope;
        }
        cottage.occupancy=classifyOccupancy(cottage,now());
        return cottage;
      }catch {throw new Error('Hub task detail temporarily unavailable');}
    },
  };
}
