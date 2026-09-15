/** Explicit user messages through supported AutoHub task routes. GitHub and
 * transcript adapters remain read-only. Never infer a terminal from a name. */
import {createHash} from 'node:crypto';
import {mkdir,readFile,open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {isIP} from 'node:net';
import {MAX_MESSAGE_LENGTH} from './conversation.mjs';
import {normalizeInputRequest,inputRequestFromHub,inputRequestVersion} from './input-request.mjs';

const result=(status,body)=>({status,body});
const rejected=(status,error)=>result(status,{ok:false,delivery:'not_sent',error});
const unknown=()=>result(409,{ok:false,delivery:'unconfirmed',error:'Delivery is unconfirmed. Check the task before sending this message again.'});
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value||{};}catch{return {};}};
const inputIdentity=input=>input?JSON.stringify([input.id,input.kind,input.prompt,input.detail,input.questions]):null;
function hubBase(raw){try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.search='';url.hash='';url.pathname=url.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1/';return url;}catch{return null;}}

export function acceptsMessageOrigin(req){
  try{
    const peer=String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
    if(peer!=='::1'&&!(isIP(peer)===4&&peer.startsWith('127.')))return false;
    const expected=new URL('http://'+req.headers.host),host=expected.hostname.replace(/^\[|\]$/g,'');
    return (host==='localhost'||!!isIP(host))&&req.headers.origin===expected.origin&&
      req.headers['x-cottagecode-request']==='user-message'&&
      /^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'');
  }catch{return false;}
}

export function createHubMessenger({
  baseUrl=process.env.COTTAGE_HUB_URL||'',token=process.env.COTTAGE_HUB_TOKEN||'',
  fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000,
  ledgerPath=process.env.COTTAGE_MESSAGE_LEDGER||join(homedir(),'.cottagecode','message-receipts.jsonl'),
}={}){
  const base=hubBase(baseUrl),entries=new Map();let loaded=false,queue=Promise.resolve();
  function capability(agent,{stale=false,checkedAt=now()}={}){
    const unavailable=reason=>({available:false,reason,source:'autohub',checkedAt});
    if(!base)return unavailable('Messaging needs a configured AutoHub connection. This source currently provides activity only.');
    if(stale||!checkedAt||now()-checkedAt>120000)return unavailable('The task feed is stale. Reconnect before sending.');
    if(agent.inputRequest?.stale)return unavailable('The input request is stale. Refresh before replying.');
    const target=agent.conversationTarget;
    if(agent.source!=='hub'||target?.recordKind!=='logical_task'||!agent.taskId||target.taskId!==agent.taskId)return unavailable('This observed session has no supported task messaging route.');
    const shownInput=normalizeInputRequest(agent.inputRequest);
    let mode='';
    if(['awaiting_input','needs_input'].includes(target.taskStatus))mode='respond';
    // A transitional Hub row can expose an explicit question before its raw
    // status flips from running. Do not turn that answer into a free-form
    // redirect: wait until Hub offers the matching response route.
    else if(shownInput)return unavailable('This task has a pending input request. Wait for AutoHub to expose its response route.');
    else if(target.taskStatus==='running'&&target.transport==='tmux'&&target.supportsRedirection!==false)mode='redirect';
    else return unavailable(['completed','failed','cancelled','interrupted'].includes(target.taskStatus)?'This task has finished. Start any follow-up in its original workflow.':target.transport==='direct'?'This direct session does not support mid-task messages.':'This task has no supported live message route.');
    const resolution=agent.inputRequestResolution;
    const newerThanUnidentifiedResolution=!resolution?.id&&shownInput?.updatedAt&&resolution?.resolvedAt&&shownInput.updatedAt>resolution.resolvedAt;
    if(mode==='respond'&&resolution&&(!shownInput||(resolution.id?shownInput.id===resolution.id:!newerThanUnidentifiedResolution)))return unavailable('This input request was already resolved. Refresh before replying.');
    return {available:true,mode,source:'autohub',checkedAt,messageUrl:'/agents/'+encodeURIComponent(agent.id)+'/messages'};
  }
  async function load(){
    if(loaded)return;
    if(ledgerPath){
      try{
        const text=await readFile(ledgerPath,'utf8'),endsWithNewline=text.endsWith('\n'),lines=text.split('\n');
        const last=endsWithNewline?lines.length-1:lines.length;
        for(let index=0;index<last;index++){
          const line=lines[index];if(!line)continue;
          try{const entry=JSON.parse(line);if(!entry||!entry.id||!entry.hash)throw new Error('Invalid receipt ledger');entries.set(entry.id,entry);}
          catch(error){
            if(index!==last-1||endsWithNewline)throw error;
            const partial=await open(ledgerPath,'r+');
            try{await partial.truncate(Buffer.byteLength(text.slice(0,text.lastIndexOf('\n')+1)));await partial.sync();}finally{await partial.close();}
            break;
          }
        }
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    loaded=true;
  }
  async function remember(entry){
    if(ledgerPath){
      await mkdir(dirname(ledgerPath),{recursive:true,mode:0o700});
      const file=await open(ledgerPath,'a',0o600);
      try{await file.writeFile(JSON.stringify(entry)+'\n');await file.sync();}finally{await file.close();}
    }
    entries.set(entry.id,entry);
  }
  async function request(path,options={}){
    return fetchImpl(new URL(path,base),{...options,redirect:'error',headers:{accept:'application/json',...(token?{authorization:'Bearer '+token}:{}),...options.headers},signal:AbortSignal.timeout(timeoutMs)});
  }
  async function sendNow(agent,payload,meta){
    const message=typeof payload?.message==='string'?payload.message.trim():'';
    if(!message||message.length>MAX_MESSAGE_LENGTH)return rejected(400,'Write a message of 1–'+MAX_MESSAGE_LENGTH+' characters.');
    if(typeof payload.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(payload.requestId))return rejected(400,'A unique message request ID is required.');
    if(!agent||payload.taskId!==agent.taskId)return rejected(409,'The task changed. Reopen its cottage before sending.');
    const hash=createHash('sha256').update(JSON.stringify([agent.id,agent.taskId,payload.inputRequestId||null,payload.inputRequestVersion||null,message])).digest('hex');
    try{await load();}catch{return rejected(503,'The message receipt ledger is unavailable. Nothing was sent.');}
    const previous=entries.get(payload.requestId);
    if(previous){
      if(previous.hash!==hash)return rejected(409,'That message request ID belongs to a different message.');
      return previous.response||unknown();
    }
    const supported=capability(agent,meta);if(!supported.available)return rejected(409,supported.reason);
    const shownInput=normalizeInputRequest(agent.inputRequest);
    if(supported.mode==='respond'&&(shownInput?.id||null)!==(payload.inputRequestId||null))return rejected(409,'The input request changed. Reopen the current question before replying.');
    if(supported.mode==='respond'&&inputRequestVersion(shownInput)!==(payload.inputRequestVersion||null))return rejected(409,'The question or its choices changed. Refresh before replying.');
    const path='tasks/'+encodeURIComponent(agent.taskId);
    try{
      // Native Hub question rounds live in orchestrator context. Request it
      // only server-side so identical wording in a new round stays distinct.
      const response=await request(path+'?context=raw');
      if(!response.ok)return rejected(502,'AutoHub could not verify the current task. Nothing was sent.');
      const task=await response.json(),context=parse(task.context),execution=context.lifecycle?.execution||{};
      const current={...agent,conversationTarget:{taskId:task.id,taskStatus:task.status,recordKind:task.recordKind,transport:execution.sessionMode,supportsRedirection:execution.supportsRedirection}};
      if(task.id!==agent.taskId||task.isStale||task.archived)return rejected(409,'The task is no longer available for messages.');
      const verified=capability(current);
      if(!verified.available||verified.mode!==supported.mode|| (supported.mode==='respond'&&task.canRespond===false))return rejected(409,'The task’s input state changed. Refresh before sending.');
      if(supported.mode==='respond'&&inputIdentity(inputRequestFromHub(task))!==inputIdentity(shownInput))return rejected(409,'The agent is now asking a different question. Refresh before replying.');
    }catch{return rejected(502,'AutoHub could not verify the current task. Nothing was sent.');}
    const entry={id:payload.requestId,hash,at:now(),response:null};
    try{await remember(entry);}catch{return rejected(503,'The message receipt could not be saved. Nothing was sent.');}
    let receipt;
    try{
      const response=await request(path+'/'+supported.mode,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(supported.mode==='redirect'?{instruction:message}:{response:message})});
      const body=await response.json();
      if(response.ok&&((supported.mode==='redirect'&&body.ok===true&&body.taskId===agent.taskId)||(supported.mode==='respond'&&body.id===agent.taskId))){
        receipt=result(200,{ok:true,delivery:supported.mode==='redirect'?'submitted':'accepted',requestId:payload.requestId,source:'autohub',timestamp:now()});
      }else if(response.status===401 ||
        (response.status===403&&body.error==='owner_approval_required') ||
        (response.status===404&&['task_not_found','Task not found'].includes(body.error)) ||
        (response.status===409&&['no_running_session','not_awaiting_input'].includes(body.error)) ||
        (response.status===400&&body.error==='instruction_required')){
        // Only known pre-delivery errors are safe to retry. AutoHub can return
        // already_answered/cancellation_in_progress after affecting the task.
        // Omit upstream bodies, which can
        // contain task context or terminal paths not intended for the browser.
        receipt=rejected(response.status,response.status===403?'AutoHub requires an authorized owner response. Nothing was sent.':response.status===401?'AutoHub authentication failed. Nothing was sent.':'AutoHub declined the message because the task or input state changed.');
      }else receipt=unknown();
    }catch{receipt=unknown();}
    try{await remember({...entry,response:receipt});}catch{return unknown();}
    return receipt;
  }
  return {capability,
    send(agent,payload,meta={}){
      // The durable reservation precedes the only write request. Repeated Send,
      // a timeout, or a process restart cannot replay an uncertain instruction.
      const work=queue.then(()=>sendNow(agent,payload,meta));queue=work.catch(()=>{});return work;
    },
  };
}
