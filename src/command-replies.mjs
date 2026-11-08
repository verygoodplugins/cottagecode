/** Explicit Send only. The server still owns authoritative validation and receipts. */
import {conversationCapability,MAX_MESSAGE_LENGTH} from './conversation.mjs';
import {normalizeInputRequest,inputRequestVersion} from './input-request.mjs';

/** Explicit current lifecycle flags outrank an end timestamp retained from an earlier attempt. */
export function isTerminalForMessage(agent){
  return agent?.terminal===true||['done','offline','completed','cancelled','failed','interrupted'].includes(agent?.status)||Boolean(agent?.endedAt&&agent?.terminal!==false);
}

export function createReplyClient({endpoint='http://127.0.0.1:8790/agents',fetchImpl=globalThis.fetch,storage,now=Date.now}={}){
  const feed=new URL(endpoint),states=new Map(),active=new Set();
  if(storage===undefined){try{storage=globalThis.localStorage;}catch{storage=null;}}
  const key=taskId=>`cottagecode:command-center:reply:${feed.href}:${encodeURIComponent(taskId)}`;
  const idle=()=>({phase:'idle',notice:''});
  const uncertainNotice='Delivery is unconfirmed. Check the original task before sending again. Automatic retry is locked.';
  function state(taskId,{persistent=false}={}){
    if(!persistent&&active.has(taskId))return {...states.get(taskId)};
    try{
      const raw=storage?.getItem(key(taskId));
      if(raw){const saved=JSON.parse(raw);if(!saved||saved.taskId!==taskId||!['sending','uncertain','sent','error'].includes(saved.phase))throw new Error('Invalid receipt');
        return {...saved,...(saved.phase==='sending'?{phase:'uncertain',notice:uncertainNotice}:{})};}
    }catch{return {phase:'uncertain',notice:'The saved delivery receipt is unavailable. Check the original task before sending again.'};}
    return {...(states.get(taskId)||idle())};
  }
  function remember(taskId,value){
    if(!storage||typeof storage.setItem!=='function'||typeof storage.getItem!=='function')throw new Error('Persistent receipt storage is unavailable.');
    const record={...value,taskId,at:now()};storage.setItem(key(taskId),JSON.stringify(record));
    if(storage.getItem(key(taskId))!==JSON.stringify(record))throw new Error('The delivery receipt could not be verified.');
    states.set(taskId,record);return {...record};
  }
  function fail(taskId,notice){const result={phase:'error',notice};states.set(taskId,result);return {...result};}
  function capability(agent,stale=false){return conversationCapability(agent,feed.href,{now:now(),stale:Boolean(stale||agent?.isStale||agent?.freshness?.isStale)});}
  async function send(agent,message){
    const taskId=agent?.taskId;
    if(!taskId)return {phase:'error',notice:'The source has not identified a supported task.'};
    if(active.has(taskId))return {...states.get(taskId)};
    const shownInput=normalizeInputRequest(agent.inputRequest),version=inputRequestVersion(shownInput),previous=state(taskId);
    if(['sending','uncertain'].includes(previous.phase)||(shownInput&&agent.conversation?.mode==='respond'&&previous.phase==='sent'&&previous.inputVersion===version))return previous;
    if(isTerminalForMessage(agent))return fail(taskId,'This task has finished. Start any follow-up in its original workflow.');
    if(agent.illustrative||agent.source==='illustrative')return fail(taskId,'Illustrative replies stay local. No live message was sent.');
    const value=typeof message==='string'?message.trim():'';
    if(!value||value.length>MAX_MESSAGE_LENGTH)return fail(taskId,`Write a message of 1–${MAX_MESSAGE_LENGTH} characters.`);
    const shownCapability=capability(agent);
    if(!shownCapability.available)return fail(taskId,shownCapability.reason||'The task has no supported local message route.');
    active.add(taskId);states.set(taskId,{phase:'checking',notice:'Checking the current task and question…'});
    let reserved=false,requestId;
    try{
      const response=await fetchImpl(feed.href,{credentials:'omit',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(10_000)});
      if(!response.ok)return fail(taskId,'The feed could not verify the current task. Nothing was sent.');
      const snapshot=await response.json(),agents=Array.isArray(snapshot)?snapshot:snapshot.agents;
      const matches=Array.isArray(agents)?agents.filter(current=>String(current.id)===String(agent.id)):[];
      const latest=matches.length===1?matches[0]:null;
      if(!latest||latest.taskId!==taskId||latest.status!==agent.status||isTerminalForMessage(latest)||latest.inventoryScope==='history'||latest.occupancy==='settled')return fail(taskId,'The task changed. Refresh before sending.');
      const currentInput=normalizeInputRequest(latest.inputRequest);
      if((currentInput?.id??null)!==(shownInput?.id??null)||inputRequestVersion(currentInput)!==version)return fail(taskId,'The question or its choices changed. Refresh before replying.');
      const supported=capability(latest,snapshot.stale);
      if(!supported.available)return fail(taskId,supported.reason);
      if(supported.mode!==shownCapability.mode||supported.url!==shownCapability.url)return fail(taskId,'The supported message route changed. Refresh before sending.');
      if(supported.mode==='respond'&&!currentInput)return fail(taskId,'The source has not supplied an exact current question.');
      if(supported.mode==='redirect'&&currentInput)return fail(taskId,'The task has a pending question. Refresh before replying.');
      // Check persistent state again after the read preflight, before reserving the write.
      const saved=state(taskId,{persistent:true});
      if(['sending','uncertain'].includes(saved.phase)||(supported.mode==='respond'&&currentInput&&saved.phase==='sent'&&saved.inputVersion===version))return saved;
      requestId=globalThis.crypto.randomUUID();
      const reservation={phase:'sending',notice:'Submitting your message…',requestId,inputVersion:version};
      try{remember(taskId,reservation);}catch{return fail(taskId,'The delivery receipt could not be saved. Nothing was sent.');}
      reserved=true;
      const payload={taskId,message:value,requestId,...(supported.mode==='respond'?{inputRequestId:currentInput.id,inputRequestVersion:version}:{})};
      const result=await fetchImpl(supported.url,{method:'POST',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12_000),headers:{'content-type':'application/json','x-cottagecode-request':'user-message'},body:JSON.stringify(payload)});
      const receipt=await result.json();
      let next;
      if(result.ok&&receipt.ok===true&&['accepted','submitted'].includes(receipt.delivery)&&receipt.requestId===requestId)
        next={...reservation,phase:'sent',notice:receipt.delivery==='accepted'?'Answer accepted by the task source.':'Message submitted to the task source.',receipt};
      else if(!result.ok&&receipt.ok===false&&receipt.delivery==='not_sent')next={...reservation,phase:'error',notice:typeof receipt.error==='string'?receipt.error:'The source declined this message. Nothing was sent.'};
      else next={...reservation,phase:'uncertain',notice:uncertainNotice};
      try{return remember(taskId,next);}catch{const locked={...reservation,phase:'uncertain',notice:uncertainNotice};states.set(taskId,locked);return locked;}
    }catch{
      if(!reserved)return fail(taskId,'The feed could not verify the current task. Nothing was sent.');
      const locked={phase:'uncertain',notice:uncertainNotice,requestId,inputVersion:version};
      try{return remember(taskId,locked);}catch{states.set(taskId,locked);return locked;}
    }finally{active.delete(taskId);}
  }
  return {state,send};
}
