import {createInterior,isWalkable,renderInterior,renderResident} from './interiors.mjs';
import {normalizePr,prStage,prCounts} from './pr.mjs';
import {movePoint,inside,normalizeRelationships,normalizedHandoffs} from './world.mjs';
import {createHistory} from './history.mjs';
import {createSound} from './sound.mjs';
import {activityAddress,mergeActivity,elapsedMs,validTime} from './feed-client.mjs';
import {cottageDoors,crossedDoor} from './interaction.mjs';
import {normalizeTodos} from './todos.mjs';
import {conversationCapability,MAX_MESSAGE_LENGTH} from './conversation.mjs';

export const STAGES={
  none:{label:'No PR',color:'#a3a99d',symbol:'—'},
  open:{label:'Opened',color:'#ecc45e',symbol:'□'},
  active:{label:'Babysitting',color:'#80b7e1',symbol:'⚒'},
  'waiting-codex':{label:'Codex review',color:'#d2a5e6',symbol:'⌕'},
  'waiting-ci':{label:'Waiting CI',color:'#a0cecb',symbol:'⌛'},
  blocked:{label:'Blocked',color:'#f08f7c',symbol:'!'},
  ready:{label:'Ready to merge',color:'#f6dc89',symbol:'★'},
  merged:{label:'Merged',color:'#99cf92',symbol:'✓'},
  closed:{label:'Closed',color:'#a9a7ad',symbol:'×'},
  unknown:{label:'Unknown',color:'#b4bbc3',symbol:'?'}
};
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=raw=>{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
const clock=value=>{const ms=validTime(value);return ms?new Date(ms).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Unavailable';};
const elapsed=agent=>{const duration=elapsedMs(agent);if(duration===null)return 'Unavailable';const sec=Math.floor(duration/1000);return Math.floor(sec/60)+'m '+(sec%60)+'s';};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export const button=(action,label,extra='')=>'<button type="button" data-action="'+esc(action)+'" '+extra+'>'+label+'</button>';
export function appendInlineHandoffs(events,append){
  for(const event of events||[])if(event?.kind==='handoff'&&event.from&&event.to)append(event);
}
const link=(url,text)=>safeUrl(url)?'<a href="'+esc(safeUrl(url))+'" target="_blank" rel="noreferrer">'+esc(text)+'</a>':'';
function nearRect(p,r){return Math.hypot(p.x-Math.max(r.x,Math.min(p.x,r.x+r.w)),p.y-Math.max(r.y,Math.min(p.y,r.y+r.h)));}

export function createObservatory(api){
  const {canvas}=api,panel=$('panel'),viewport=$('map-viewport'),roomCanvas=$('room-canvas'),roomCtx=roomCanvas.getContext('2d');
  const sound=createSound(),keys=new Set(),rooms=new Map(),activity=new Map(),inflight=new Map(),activityLines=new Map();
  const conversations=new Map();
  let mode='town',selected=null,interiorId=null,room=null,roomPlayer=null,player=null,returnTo=null,tab='overview',prFilter=null;
  let followId=null,lastFrame=0,transition=1,latestAgents=[],relationships=[],handoffs=[],couriers=[],apprentices=[],knownKids=new Set();
  let sourceKey='',history=null,historyInitialized=false,stageSignature='',rosterSignature='',panelKey='',lastHint='',replayIndex=-1,replaying=false,replayTimer=0,replayEvents=[];
  let lastHealthCheck=0,selectedObject=null,board=null,feedStale=false,historyView='since';
  let talkingId=null,talkingUntil=0;
  let reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{reduce=e.matches;if(reduce)transition=1;});
  let storage=null;try{storage=localStorage;}catch{}
  const byId=id=>latestAgents.find(a=>a.id===id);
  const plotFor=id=>{for(const p of api.getPlots()){if(p.agent.id===id)return p;const k=p.kids?.find(k=>k.agent.id===id);if(k)return {...k,agent:k.agent,parentPlot:p};}return null;};
  const roomFor=a=>{const key=a.id+'|'+(a.taskId||'');if(!rooms.has(key))rooms.set(key,createInterior(a));return rooms.get(key);};
  const conversationFor=a=>{const key=sourceKey+'|'+a.id+'|'+(a.taskId||'');if(!conversations.has(key))conversations.set(key,{text:'',phase:'idle',notice:'',sent:[],requestId:null,payload:''});return conversations.get(key);};
  const visible=a=>!prFilter||prStage(a.pr)===prFilter;
  const hint=text=>{if(text!==lastHint){$('scene-status').textContent=text;lastHint=text;}};
  function placePlayer(){
    if(player)return;
    const home=api.getWorld().jack;
    player=home?{x:home.x+27,y:home.y+44}:{x:api.getWorld().roadX+18,y:65};
  }
  function setMode(value){
    mode=value;keys.clear();
    const indoors=mode==='room';
    roomCanvas.hidden=!indoors;
    canvas.style.visibility=indoors?'hidden':'';
    $('mode-label').textContent=indoors?'INSIDE '+(byId(interiorId)?.name||'COTTAGE'):(followId?'FOLLOWING '+(byId(followId)?.name||'AGENT'):'TOWNMAP');
    $('leave-cottage').hidden=!indoors;
  }
  function enter(id){
    const a=byId(id),p=plotFor(id);if(!a||!p)return;
    selected=id;api.select(id);interiorId=id;room=roomFor(a);
    roomPlayer={...room.door};returnTo={x:p.x+(p.parentPlot?8:27),y:p.y+(p.parentPlot?22:76)};
    selectedObject=null;tab='overview';transition=reduce?1:0;
    followId=null;setMode('room');sound.play('door');renderPanel(id);roomCanvas.focus();
  }
  function leave(){
    if(mode!=='room')return;
    player=returnTo||player;interiorId=null;room=null;roomPlayer=null;selectedObject=null;
    setMode('town');sound.play('door');renderPanel(selected);canvas.focus();scrollToPlayer(true);
  }
  function follow(id){
    const p=plotFor(id);if(!p)return;
    if(mode==='room')leave();
    followId=followId===id?null:id;
    if(followId){player={x:p.x+35,y:p.y+102};api.select(id);selected=id;scrollToPlayer(true);}
    setMode('town');renderPanel(selected);
  }
  function focusCottage(id){
    if(!byId(id))return;
    if(mode==='room'&&id!==interiorId)leave();
    if(mode==='board'||mode==='scrapbook')setMode('town');
    selected=id;tab='overview';selectedObject=null;api.select(id);
    const p=plotFor(id);if(p)scrollTo(p.x,p.y,true);
    renderPanel(id);ensureActivity(byId(id));
  }
  function interact(){
    if(mode==='room'){
      if(distance(roomPlayer,room.resident)<30){talk(interiorId);return;}
      const nearest=room.objects.filter(o=>o.interactable&&o.id!=='exit').sort((a,b)=>nearRect(roomPlayer,a)-nearRect(roomPlayer,b))[0];
      if(nearest&&nearRect(roomPlayer,nearest)<30)inspect(nearest.id);
      return;
    }
    if(!player)return;
    const resident=(api.getResidents?.()||[]).filter(r=>visible(byId(r.id)||{})).sort((a,b)=>distance(player,a)-distance(player,b))[0];
    if(resident&&distance(player,resident)<30){talk(resident.id);return;}
    const targets=[];
    for(const p of api.getPlots()){
      if(visible(p.agent)){
        targets.push({kind:'bench',id:p.agent.id,x:p.x+35,y:p.y+105});
      }
    }
    if(board)targets.push({kind:'board',...board});
    const near=targets.sort((a,b)=>distance(player,a)-distance(player,b))[0];
    if(near&&distance(player,near)<(near.kind==='bench'?20:31)){
      if(near.kind==='board')showHistory('board');else if(near.kind==='bench')follow(near.id);
    }else hint('Walk into a doorway to enter. Press E near an agent to talk.');
  }
  function talk(id){
    const a=byId(id);if(!a)return;
    if(mode==='board'||mode==='scrapbook')setMode('town');
    selected=id;tab='talk';selectedObject=null;talkingId=id;talkingUntil=performance.now()+1500;
    api.select(id);sound.murmur({seed:roomFor(a).seed});ensureActivity(a);renderPanel(id);
  }
  function inspect(id){
    selectedObject=id;tab=({request:'request',clock:'overview',workbench:'journal',review:'review',shelf:'artifacts'})[id]||'overview';
    sound.play('talk');renderPanel(interiorId);
  }
  function scrollTo(x,y,immediate=false){
    const scale=canvas.clientWidth/canvas.width;
    const target=y*scale-viewport.clientHeight*.45;
    viewport.scrollTo({top:Math.max(0,target),behavior:immediate||reduce?'instant':'smooth'});
  }
  function scrollToPlayer(immediate=false){
    if(!player||mode==='room')return;
    const yy=player.y*(canvas.clientWidth/canvas.width);
    if(immediate||yy<viewport.scrollTop+60||yy>viewport.scrollTop+viewport.clientHeight-60)scrollTo(player.x,player.y,immediate);
  }
  function walkable(x,y){
    const w=api.getWorld();
    return x>8&&y>20&&x<w.width-8&&y<w.height-8 &&
      !api.getPlots().some(p=>inside({x,y},{x:p.x+5,y:p.y+27,w:44,h:37},2)||(p.kids||[]).some(k=>inside({x,y},{x:k.x,y:k.y+4,w:16,h:13},2))) &&
      !(w.solids||[]).some(r=>inside({x,y},r,2));
  }
  function move(dt){
    let dx=(keys.has('ArrowRight')||keys.has('d')?1:0)-(keys.has('ArrowLeft')||keys.has('a')?1:0);
    let dy=(keys.has('ArrowDown')||keys.has('s')?1:0)-(keys.has('ArrowUp')||keys.has('w')?1:0);
    if(!dx&&!dy)return false;
    const n=Math.hypot(dx,dy);dx/=n;dy/=n;followId=null;
    if(mode==='room'){
      const next={x:roomPlayer.x+dx*68*dt,y:roomPlayer.y+dy*68*dt};
      if(crossedDoor(roomPlayer,next,[{x:room.door.x,y:157,width:26}],'out')){leave();return true;}
      roomPlayer=movePoint(roomPlayer,dx*68*dt,dy*68*dt,(x,y)=>isWalkable(room,x,y));
    }
    else{
      placePlayer();
      const next={x:player.x+dx*88*dt,y:player.y+dy*88*dt},door=crossedDoor(player,next,cottageDoors(api.getPlots(),visible));
      if(door){enter(door.id);return true;}
      player=movePoint(player,dx*88*dt,dy*88*dt,walkable);scrollToPlayer();
    }
    sound.play('step');return true;
  }
  function onKey(e){
    const key=e.key.length===1?e.key.toLowerCase():e.key;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d'].includes(key)){
      if(mode==='board'||mode==='scrapbook')setMode('town');
      keys.add(key);e.preventDefault();
    }
    if((key==='e'||key==='Enter')&&!e.repeat){e.preventDefault();interact();}
    if(key==='Escape'){e.preventDefault();if(mode==='room')leave();else{followId=null;replaying=false;setMode('town');renderPanel(selected);}}
  }
  canvas.addEventListener('keydown',onKey);roomCanvas.addEventListener('keydown',onKey);
  window.addEventListener('keyup',e=>keys.delete(e.key.length===1?e.key.toLowerCase():e.key));
  window.addEventListener('blur',()=>keys.clear());
  canvas.addEventListener('blur',()=>keys.clear());roomCanvas.addEventListener('blur',()=>keys.clear());
  roomCanvas.addEventListener('click',e=>{
    if(!room||transition<1)return;
    const r=roomCanvas.getBoundingClientRect(),scale=Math.min(r.width/room.width,r.height/room.height);
    const p={x:(e.clientX-r.left-(r.width-room.width*scale)/2)/scale,y:(e.clientY-r.top-(r.height-room.height*scale)/2)/scale};
    if(inside(p,{x:room.resident.x-9,y:room.resident.y-21,w:18,h:24})){talk(interiorId);return;}
    const obj=room.objects.find(o=>o.interactable&&inside(p,o));
    if(obj){if(obj.id==='exit')leave();else inspect(obj.id);}
  });
  function handleClick(e){
    const r=canvas.getBoundingClientRect(),p={x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};
    const resident=(api.getResidents?.()||[]).find(a=>visible(byId(a.id)||{})&&inside(p,{x:a.x-7,y:a.y-18,w:14,h:20}));
    if(resident){talk(resident.id);return true;}
    for(const plot of api.getPlots()){
      if(!visible(plot.agent))continue;
      if(inside(p,{x:plot.x-18,y:plot.y+46,w:18,h:30})){
        if(safeUrl(plot.agent.pr?.url))window.open(safeUrl(plot.agent.pr.url),'_blank','noopener');
        else{focusCottage(plot.agent.id);tab='review';renderPanel(plot.agent.id);}return true;
      }
      if(inside(p,{x:plot.x+26,y:plot.y+91,w:26,h:18})){follow(plot.agent.id);return true;}
    }
    if(board&&distance(p,board)<20){showHistory('board');return true;}
    return false;
  }
  function replacePanel(html,key){
    if(panel.innerHTML===html)return;
    const old=panel.querySelector('.journal'),same=panelKey===key,scroll=old?.scrollTop||0,atEnd=old?(old.scrollHeight-old.clientHeight-old.scrollTop<25):true;
    const anchor=old&&[...old.querySelectorAll('[data-event]')].find(e=>e.offsetTop+e.offsetHeight>old.offsetTop+scroll);
    const anchorId=anchor?.dataset.event,anchorOffset=anchor&&old?anchor.getBoundingClientRect().top-old.getBoundingClientRect().top:0;
    const active=document.activeElement,focus=same&&panel.contains(active)?active.dataset.action:null,journalFocused=same&&active===old;
    const composing=same&&active?.id==='agent-message',selection=composing?[active.selectionStart,active.selectionEnd,active.scrollTop]:null;
    const todosOpen=same&&panel.querySelector('.talk-todos')?.open;
    const todoScroll=same?panel.querySelector('.todo-list')?.scrollTop:0;
    panel.innerHTML=html;panelKey=key;
    const log=panel.querySelector('.journal');
    if(log&&same)log.scrollTop=atEnd?log.scrollHeight:scroll;
    if(log&&same&&!atEnd&&anchorId){const current=[...log.querySelectorAll('[data-event]')].find(e=>e.dataset.event===anchorId);if(current)log.scrollTop+=current.getBoundingClientRect().top-log.getBoundingClientRect().top-anchorOffset;}
    if(log&&!same)log.scrollTop=log.scrollHeight;
    if(journalFocused)log?.focus({preventScroll:true});
    if(focus)[...panel.querySelectorAll('[data-action]')].find(node=>node.dataset.action===focus)?.focus({preventScroll:true});
    if(composing){const input=$('agent-message');if(input){input.focus({preventScroll:true});input.setSelectionRange(selection[0],selection[1]);input.scrollTop=selection[2];}}
    if(todosOpen&&panel.querySelector('.talk-todos'))panel.querySelector('.talk-todos').open=true;
    if(todoScroll&&panel.querySelector('.todo-list'))panel.querySelector('.todo-list').scrollTop=todoScroll;
  }
  function cacheFor(a){
    const identity=(a.taskId||'')+'|'+(a.activityUrl||'');
    if(activity.get(a.id)?.identity!==identity){
      inflight.get(a.id)?.abort();inflight.delete(a.id);
      activity.set(a.id,{identity,events:[],source:'none',cursor:null,hasMore:false,stale:false});
    }
    return activity.get(a.id);
  }
  function recordActivity(a,events){
    for(const e of events||[])if(e.id&&(e.kind==='result'||safeUrl(e.url))){
      history?.record({id:'activity:'+a.id+':'+(a.taskId||'')+':'+e.id,agentId:a.id,taskId:a.taskId||'',name:a.name,town:a.town,timestamp:Number(e.timestamp)>0?Number(e.timestamp):Date.now(),kind:'result',text:String(e.text||'Recorded artifact').slice(0,1200),url:safeUrl(e.url)});
    }
  }
  async function ensureActivity(a,{older=false}={}){
    if(!a)return;
    const cache=cacheFor(a);
    if(Array.isArray(a.events)){
      cache.events=mergeActivity(cache.events,a.events);cache.source=a.activitySource||a.source||(api.getEndpoint()?'feed':'demo');
      appendInlineHandoffs(cache.events,appendHandoff);return;
    }
    const url=activityAddress(a,api.getEndpoint());if(!url||inflight.has(a.id))return;
    if(older&&cache.events.length)url.searchParams.set('before',cache.events[0].id);
    else if(cache.events.length)url.searchParams.set('after',cache.cursor||cache.events.at(-1).id);
    const controller=new AbortController();inflight.set(a.id,controller);const epoch=sourceKey;
    const timeout=setTimeout(()=>controller.abort(),7000);
    try{
      const res=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}});
      if(!res.ok)throw new Error('Activity HTTP '+res.status);
      const data=await res.json();if(!Array.isArray(data.events))throw new Error('Activity response has no events');
      if(epoch!==sourceKey||activity.get(a.id)!==cache)return;
      if(data.cursorReset){
        if(!older)cache.events=[];
        cache.hasMore=!!data.hasMore;cache.warning='An activity cursor expired. Only retained source history is available.';
      }
      cache.events=(older?mergeActivity(data.events,cache.events):mergeActivity(cache.events,data.events)).slice(-1500);cache.source=String(data.source||'feed');
      if(older||!cache.cursor)cache.hasMore=!!data.hasMore;
      if(!older)cache.cursor=data.cursor||cache.events.at(-1)?.id||cache.cursor;
      cache.stale=!!data.stale;cache.error=data.error||'';
      if(Object.hasOwn(data,'todos'))cache.todos=normalizeTodos(data.todos);
      recordActivity(a,data.events);
      for(const e of data.events)if(e.kind==='handoff'&&e.from&&e.to)appendHandoff(e);
    }catch(err){if(epoch===sourceKey&&activity.get(a.id)===cache){cache.stale=true;cache.error=err.name==='AbortError'?'Activity request timed out':err.message;}}
    finally{clearTimeout(timeout);if(inflight.get(a.id)===controller)inflight.delete(a.id);if((selected===a.id||interiorId===a.id)&&epoch===sourceKey)renderPanel(selected);}
  }
  function eventHtml(events){
    if(!events.length)return '<p class="hint">No activity supplied for this task yet.</p>';
    return events.map(e=>'<li class="journal-event" data-event="'+esc(e.id)+'"><span class="event-head"><time>'+esc(clock(e.timestamp))+'</time><span>'+esc(e.kind||'progress')+'</span></span><p>'+esc(e.text)+'</p>'+link(e.url,'Open artifact')+'</li>').join('');
  }
  function latestLine(a){
    const events=activity.get(a.id)?.events||a.events||[];
    return [...events].reverse().find(e=>['progress','summary','tool','result'].includes(e.kind))?.text||a.activity||a.lastLine||'';
  }
  function todosHtml(a,cache){
    const supplied=normalizeTodos(a.todos),journal=normalizeTodos(cache.todos);
    const todos=journal&&(!supplied||(journal.updatedAt||0)>(supplied.updatedAt||0))?journal:supplied||journal;
    if(!todos)return '<p class="hint">This source has not supplied a to-do list. Check the journal for recorded progress.</p>';
    const done=todos.items.filter(item=>item.status==='completed').length;
    const labels={pending:'To do',in_progress:'In progress',completed:'Done',cancelled:'Cancelled'};
    return '<p class="hint">'+done+' / '+todos.items.length+' done · '+esc(todos.source||'Task source')+' · '+esc(clock(todos.updatedAt))+(todos.stale||cache.stale||feedStale?' · stale':'')+'</p>'+(todos.items.length?'<ul class="todo-list" aria-label="Agent to-do list">'+todos.items.map(item=>'<li data-todo-status="'+item.status+'"><span class="todo-mark" aria-hidden="true">'+({pending:'○',in_progress:'◉',completed:'✓',cancelled:'×'})[item.status]+'</span><span><small>'+labels[item.status]+'</small>'+esc(item.text)+'</span></li>').join('')+'</ul>':'<p class="hint">The agent’s list is empty.</p>')+(todos.truncated?'<p class="hint">Showing the first 100 items supplied.</p>':'');
  }
  function talkHtml(a,cache){
    const conversation=conversationFor(a),capability=conversationCapability(a,api.getEndpoint(),{stale:feedStale});
    const pending=conversation.phase==='sending',uncertain=conversation.phase==='unconfirmed';
    const enabled=capability.available&&!pending&&!uncertain&&!!conversation.text.trim()&&conversation.text.trim()!==conversation.uncertainPayload;
    const receipts=conversation.sent.map(message=>'<li><p>'+esc(message.text)+'</p><small>'+esc(clock(message.timestamp))+' · '+esc(message.label)+'</small></li>').join('');
    return '<h3>A word with '+esc(a.name)+'</h3><p class="hint">'+(sound.enabled?'Your host answers with a little murmur.':'Enable sound to hear your host’s little murmur.')+' Activity below comes from the task’s recorded updates.</p>'+
      '<form id="agent-conversation"><label for="agent-message">'+(capability.mode==='respond'?'Reply to the agent’s question':'Ask, clarify, or steer the work')+'</label><textarea id="agent-message" maxlength="'+MAX_MESSAGE_LENGTH+'" rows="3" placeholder="What would you like your agent to know?" '+(pending?'readonly':'')+'>'+esc(conversation.text)+'</textarea><p class="hint" id="message-capability">'+esc(capability.available?(capability.mode==='respond'?'Your reply will go to the task waiting for input.':'Your message will be submitted to the running agent’s terminal.')+' · '+(capability.source||'Connected feed'):capability.reason)+'</p><button type="submit" data-action="send-message" '+(enabled?'':'disabled')+'>'+(pending?'Sending…':capability.mode==='respond'?'Send reply':'Send to agent')+'</button><p id="message-status" role="status">'+esc(conversation.notice)+'</p></form>'+
      (receipts?'<ol class="sent-messages" aria-label="Your messages this visit">'+receipts+'</ol>':'')+
      '<details class="talk-todos"><summary>Agent’s to-do list</summary>'+todosHtml(a,cache)+'</details>'+
      '<div class="section-head"><h3>From the workbench</h3>'+button('older','Earlier entries',cache.hasMore?'':'disabled')+'</div><p class="hint">'+esc(cache.source)+(cache.stale?' · stale — '+esc(cache.error||'connection interrupted'):' · recorded activity')+'</p><ol class="journal" tabindex="0" aria-label="Agent conversation activity">'+eventHtml(cache.events)+'</ol>';
  }
  async function sendMessage(){
    const a=byId(interiorId||selected);if(!a)return;
    const conversation=conversationFor(a),capability=conversationCapability(a,api.getEndpoint(),{stale:feedStale});
    if(!capability.available||['sending','unconfirmed'].includes(conversation.phase)||!conversation.text.trim()||conversation.text.trim()===conversation.uncertainPayload)return;
    const text=conversation.text.trim();if(text.length>MAX_MESSAGE_LENGTH)return;
    conversation.requestId ||= crypto.randomUUID();conversation.payload=text;conversation.phase='sending';conversation.notice='Submitting your message…';
    const epoch=sourceKey,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);renderPanel(selected);
    try{
      const response=await fetch(capability.url,{method:'POST',credentials:'omit',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-cottagecode-request':'user-message'},body:JSON.stringify({taskId:a.taskId,message:text,requestId:conversation.requestId})});
      const result=await response.json();
      if(result.delivery==='unconfirmed')throw new Error('Delivery is unconfirmed. Check the task before sending this message again.');
      if(!response.ok){
        if(result.delivery!=='not_sent')throw new Error('Delivery is unconfirmed. Check the task before sending again.');
        conversation.phase='error';conversation.notice=String(result.error||'The source declined this message.');conversation.requestId=null;return;
      }
      if(!result.ok||!['submitted','accepted'].includes(result.delivery))throw new Error('The source did not confirm delivery. Check the task before sending again.');
      const label=result.delivery==='submitted'?'Submitted to agent terminal':'Accepted by task source';
      conversation.sent.push({text,timestamp:Date.now(),label});conversation.sent=conversation.sent.slice(-20);
      conversation.text='';conversation.requestId=null;conversation.phase='sent';conversation.notice=label+'. Replies appear in the recorded activity when the source supplies them.';
      if(epoch===sourceKey)ensureActivity(a);
    }catch(error){conversation.phase='unconfirmed';conversation.uncertainPayload=text;conversation.notice=error.name==='AbortError'?'Delivery is unconfirmed after a timeout. Check the task before sending again.':error.message||'Delivery is unconfirmed. Check the task before sending again.';}
    finally{clearTimeout(timeout);if(epoch===sourceKey&&(selected===a.id||interiorId===a.id))renderPanel(selected);}
  }
  function renderPanel(id){
    selected=id;
    if(mode==='board'||mode==='scrapbook'){renderHistory();return true;}
    const a=byId(mode==='room'?interiorId:id);if(!a)return false;
    const pr=normalizePr(a.pr),stage=pr.stage,s=STAGES[stage],cache=cacheFor(a);
    let content='';
    if(tab==='talk'){
      content=talkHtml(a,cache);
    }else if(tab==='todos'){
      content='<h3>The task checklist</h3>'+todosHtml(a,cache);
    }else if(tab==='request'){
      content='<h3>Pinned request</h3><p class="hint">'+(a.originalAskSource==='session'?'First request recorded in this session. Current task boundaries are unavailable.':'Original request supplied by the task source.')+'</p><div class="request-paper">'+esc(a.originalAsk||'The feed has not supplied the original request.')+'</div>';
    }else if(tab==='journal'){
      content='<div class="section-head"><h3>At the workbench</h3>'+button('older','Earlier entries',cache.hasMore?'':'disabled')+'</div><p class="hint">'+esc(cache.source)+(cache.stale?' · stale — '+esc(cache.error||'connection interrupted'):' · live activity')+'</p>'+(cache.warning?'<p class="hint">'+esc(cache.warning)+'</p>':'')+'<ol class="journal" tabindex="0" aria-label="Task activity journal">'+eventHtml(cache.events)+'</ol>';
    }else if(tab==='review'){
      content='<h3>Review desk</h3><div class="pr-summary" style="--pr-color:'+s.color+'"><strong>'+s.symbol+' '+s.label+'</strong><p>'+esc(pr.title||'')+'</p>'+link(pr.url,pr.number?'Open PR #'+pr.number:'Open PR')+'</div><dl><dt>Evidence</dt><dd>'+esc(pr.source||'Unavailable')+'</dd><dt>Checked</dt><dd>'+esc(clock(pr.checkedAt))+(pr.stale?' · stale':'')+'</dd><dt>Head</dt><dd class="mono">'+esc(pr.headSha?.slice(0,12)||'Unavailable')+'</dd><dt>Review</dt><dd>'+esc(pr.labels?.filter(l=>String(l).startsWith('babysit:')).join(', ')||pr.reviewState||'Not supplied')+'</dd></dl>'+(pr.reason?'<p class="hint review-reason">'+esc(pr.reason)+'</p>':'')+'<p class="hint">The parcel opens the PR. Review and merge stay in your existing workflow.</p>';
    }else if(tab==='artifacts'){
      const arts=[...(Array.isArray(a.artifacts)?a.artifacts:[]),...cache.events.filter(e=>e.url).map(e=>({url:e.url,title:e.text}))];
      if(pr.url)arts.unshift({url:pr.url,title:'PR #'+pr.number+' · '+(pr.title||s.label)});
      const seen=new Set();const rows=arts.filter(e=>safeUrl(e.url)&&!seen.has(e.url)&&seen.add(e.url));
      content='<h3>On the shelves</h3>'+(a.result?'<div class="request-paper">'+esc(a.result)+'</div>':'')+(rows.length?'<ul class="artifact-list">'+rows.map(e=>'<li>'+link(e.url,e.title||'Artifact')+'</li>').join('')+'</ul>':'<p class="hint">Artifacts appear here when the feed supplies them.</p>');
      if(stage==='merged')content='<h3>A keepsake from this work</h3><p class="hint">Merged · '+esc(clock(pr.mergedAt))+'</p>'+content;
    }else{
      content='<h3>Today’s work</h3><p>'+esc(a.task&&a.task!=='-'?a.task:'Task description unavailable')+'</p><div class="current-activity">'+esc(latestLine(a)||'No current activity supplied.')+'</div><dl><dt>Task started</dt><dd>'+esc(clock(a.taskStartedAt))+'</dd><dt>Elapsed</dt><dd>'+esc(elapsed(a))+'</dd><dt>Session started</dt><dd>'+esc(clock(a.sessionStartedAt))+'</dd><dt>Last signal</dt><dd>'+esc(clock(a.updatedAt))+'</dd><dt>Model</dt><dd>'+esc(a.model||'Unavailable')+'</dd><dt>Branch</dt><dd>'+esc(a.branch||'Unavailable')+'</dd></dl><h3>Pinned request</h3><p class="request-preview">'+esc(a.originalAsk?a.originalAsk.slice(0,230)+(a.originalAsk.length>230?'…':''):'Original request not supplied.')+'</p>'+button('tab:request','Read the pinned note');
    }
    const nav=[['overview','Clock'],['request','Request'],['journal','Journal'],['todos','To-do'],['review','PR desk'],['artifacts','Shelves']].map(([key,label])=>button('tab:'+key,label,'aria-pressed="'+(tab===key)+'"')).join('');
    const header='<div class="inspector-heading"><span class="eyebrow">'+esc(a.town)+' · '+(mode==='room'?'INSIDE':'COTTAGE')+'</span><h2>'+esc(a.name)+'</h2></div><div class="inspector-chips"><span class="status-chip">'+esc(a.status)+'</span><span class="pr-chip" style="--pr-color:'+s.color+'">'+s.symbol+' '+s.label+'</span></div>';
    const actions='<div class="cottage-actions">'+button(mode==='room'?'leave':'enter',mode==='room'?'Leave cottage ↗':'Enter cottage ↗')+button('talk','Talk to '+esc(a.name),'aria-pressed="'+(tab==='talk')+'"')+button('follow',followId===a.id?'Leave bench':'Follow from bench')+'</div>';
    const worktree=a.worktreePath?'<div class="launch">'+button('copy','Copy worktree path')+(a.worktreePath.startsWith('/')?'<a href="cursor://file'+a.worktreePath.split('/').map(encodeURIComponent).join('/')+'">Open worktree</a>':'')+'</div>':'';
    replacePanel(header+actions+'<nav class="room-tabs" aria-label="Cottage objects">'+nav+'</nav>'+content+worktree,(mode==='room'?interiorId:id)+'|'+(a.taskId||'')+':'+tab);
    return true;
  }
  function showHistory(next='board'){
    if(mode==='room')leave();followId=null;historyView=next==='board'?'since':'all';replaying=false;setMode(next);renderHistory();
  }
  function renderHistory(){
    if(!history)return;
    const events=history.events(),since=history.sinceVisit(),shown=(historyView==='since'?since:events).slice().reverse();
    const title=mode==='board'?'Village noticeboard':'Village scrapbook';
    const counts={done:0,blocked:0,ready:0};
    for(const e of since){if(e.kind==='status'&&e.text==='Task done')counts.done++;if(e.kind==='pr'&&e.text==='PR · ready')counts.ready++;if(e.text==='Task blocked'||e.text==='PR · blocked')counts.blocked++;}
    const top='<span class="eyebrow">OBSERVED HISTORY</span><h2>'+title+'</h2><p class="hint">Since '+esc(clock(history.baseline))+' · '+counts.done+' finished · '+counts.ready+' ready · '+counts.blocked+' need attention</p><div class="room-tabs">'+button('history:since','Since last visit','aria-pressed="'+(historyView==='since')+'"')+button('history:all','All recorded','aria-pressed="'+(historyView==='all')+'"')+'</div>';
    const replay=mode==='scrapbook'?'<div class="replay-controls">'+button('replay',replaying?'Pause replay':'Replay recorded events',events.length?'':'disabled')+'<input type="range" id="replay-range" min="0" max="'+Math.max(0,events.length-1)+'" value="'+Math.max(0,replayIndex)+'" aria-label="Recorded event"><p class="hint" id="replay-caption">'+esc(replayEvents[replayIndex]?.text||'Replay shows recorded milestones only; earlier activity is unavailable.')+'</p></div>':'';
    const list=shown.length?shown.map(e=>'<li><time>'+esc(clock(e.timestamp))+'</time>'+button('jump:'+e.agentId,esc(e.name||e.agentId))+ '<p>'+esc(e.text)+'</p>'+link(e.url,'Open artifact')+'</li>').join(''):'<li class="hint">No recorded changes in this view yet. Keep the town connected to collect milestones.</li>';
    replacePanel(top+replay+'<ol class="history-list">'+list+'</ol>'+button('back','Return to town'),mode+':'+historyView);
  }
  panel.addEventListener('input',e=>{
    if(e.target.id==='replay-range'){replaying=false;replayEvents=history.events();replayIndex=Number(e.target.value);showReplay();}
    if(e.target.id==='agent-message'){
      const a=byId(interiorId||selected);if(!a)return;
      const conversation=conversationFor(a);conversation.text=e.target.value;
      if(conversation.phase!=='sending'&&conversation.text.trim()!==conversation.payload){conversation.phase='idle';conversation.requestId=null;conversation.notice='';}
      const send=panel.querySelector('[data-action="send-message"]');if(send)send.disabled=!conversationCapability(a,api.getEndpoint(),{stale:feedStale}).available||!conversation.text.trim()||['sending','unconfirmed'].includes(conversation.phase)||conversation.text.trim()===conversation.uncertainPayload;
    }
  });
  panel.addEventListener('submit',e=>{if(e.target.id==='agent-conversation'){e.preventDefault();sendMessage();}});
  panel.addEventListener('click',async e=>{
    const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
    if(action==='enter')enter(selected);
    else if(action==='leave')leave();
    else if(action==='follow')follow(interiorId||selected);
    else if(action==='talk')talk(interiorId||selected);
    else if(action.startsWith('tab:')){tab=action.slice(4);selectedObject=({request:'request',journal:'workbench',review:'review',artifacts:'shelf',overview:'clock'})[tab];renderPanel(selected);if(['journal','todos'].includes(tab))ensureActivity(byId(interiorId||selected));}
    else if(action==='older')await ensureActivity(byId(interiorId||selected),{older:true});
    else if(action==='copy'){try{await navigator.clipboard.writeText(byId(interiorId||selected).worktreePath);e.target.textContent='Copied';}catch{e.target.textContent='Copy unavailable';}}
    else if(action.startsWith('jump:'))focusCottage(action.slice(5));
    else if(action.startsWith('history:')){historyView=action.slice(8);renderHistory();}
    else if(action==='back'){setMode('town');renderPanel(selected);}
    else if(action==='replay'){replayEvents=history.events();replaying=!replaying;if(replayIndex>=replayEvents.length-1||replayIndex<0)replayIndex=0;replayTimer=0;renderHistory();showReplay();}
  });
  function showReplay(){
    const e=replayEvents[replayIndex];if(!e)return;
    const p=plotFor(e.agentId);if(p)scrollTo(p.x,p.y,true);
    const caption=$('replay-caption');if(caption)caption.textContent=clock(e.timestamp)+' · '+e.name+' · '+e.text;
    const range=$('replay-range');if(range)range.value=replayIndex;
  }
  function updatePrTally(){
    const counts=prCounts(latestAgents),signature=JSON.stringify(counts)+prFilter;
    if(signature===stageSignature)return;stageSignature=signature;
    $('pr-tally').innerHTML=Object.entries(STAGES).filter(([k])=>counts[k]>0).map(([key,s])=>'<button type="button" data-pr="'+key+'" aria-pressed="'+(prFilter===key)+'"><i style="background:'+s.color+'"></i>'+s.label+' <span>'+counts[key]+'</span></button>').join('');
    $('pr-tally').setAttribute('aria-label','Filter by PR stage; shared pull requests counted once');
  }
  $('pr-tally').addEventListener('click',e=>{const b=e.target.closest('[data-pr]');if(!b)return;prFilter=prFilter===b.dataset.pr?null:b.dataset.pr;stageSignature='';updatePrTally();updateRoster();});
  function updateRoster(){
    const list=latestAgents.filter(a=>visible(a)&&(a.occupancy!=='settled'||api.getWorld().showSettled));
    const signature=JSON.stringify(list.map(a=>[a.id,a.name,a.status,prStage(a.pr)]))+selected;
    if(signature===rosterSignature)return;rosterSignature=signature;
    $('cottage-list').innerHTML=list.map(a=>'<button type="button" data-cottage="'+esc(a.id)+'" aria-pressed="'+(selected===a.id)+'"><span>'+esc(a.name)+'</span><small>'+esc(STAGES[prStage(a.pr)].label)+'</small></button>').join('');
  }
  $('cottage-list').addEventListener('click',e=>{const b=e.target.closest('[data-cottage]');if(b)focusCottage(b.dataset.cottage);});
  $('noticeboard').onclick=()=>showHistory('board');$('scrapbook').onclick=()=>showHistory('scrapbook');$('leave-cottage').onclick=leave;
  $('sound-toggle').onclick=async e=>{const on=await sound.enable(!sound.enabled);e.target.setAttribute('aria-pressed',String(on));e.target.textContent=on?'Sound on':'Sound off';$('sound-settings').hidden=!on;if(on)sound.play('chirp');};
  $('ambient-sound').onchange=e=>{sound.ambience=e.target.checked;};$('alert-sound').onchange=e=>{sound.alerts=e.target.checked;};
  const seenHandoffs=new Set();
  function appendHandoff(e){
    if(seenHandoffs.has(e.id))return;seenHandoffs.add(e.id);
    history?.record({id:'handoff:'+e.id,agentId:e.agentId||e.from,name:e.name||e.from,town:e.from,timestamp:e.timestamp,kind:'handoff',text:e.text||'Work handed over',url:e.url});
    const w=api.getWorld(),from=w.districts?.find(d=>d.key===e.from),to=w.districts?.find(d=>d.key===e.to);
    if(from&&to&&Date.now()-e.timestamp<60000)couriers.push({...e,start:performance.now()/1000,fromPoint:{x:from.x+from.w/2,y:from.y+from.h-10},toPoint:{x:to.x+to.w/2,y:to.y+to.h-10}});
  }
  function update(agents,meta={}){
    latestAgents=agents;feedStale=!!meta.stale;
    const nextKey=api.getSourceKey?.()||api.getEndpoint()||'demo';
    const sourceChanged=nextKey!==sourceKey;
    if(sourceChanged){
      if(mode==='room')leave();
      sourceKey=nextKey;for(const c of inflight.values())c.abort();inflight.clear();activity.clear();rooms.clear();activityLines.clear();
      history=createHistory({storage,key:sourceKey});historyInitialized=false;seenHandoffs.clear();couriers=[];knownKids.clear();apprentices=[];player=null;returnTo=null;followId=null;
      setMode('town');selected=null;prFilter=null;stageSignature='';rosterSignature='';replaying=false;replayEvents=[];replayIndex=-1;
    }
    const changes=history.observe(agents,{initial:!historyInitialized});
    for(const e of changes){if(e.text==='PR · ready')sound.play('ready');if(e.text==='Task done')sound.play('done');if(e.text==='Task blocked'||e.text==='PR · blocked')sound.play('blocked');}
    for(const a of agents){
      if(a.parent&&!knownKids.has(a.id)){
        knownKids.add(a.id);if(historyInitialized)apprentices.push({id:a.id,parent:a.parent,start:performance.now()/1000});
      }
      const c=cacheFor(a);if(Array.isArray(a.events)){
        c.events=mergeActivity(c.events,a.events);c.source=a.activitySource||a.source||(api.getEndpoint()?'feed':'demo');recordActivity(a,a.events);
        appendInlineHandoffs(c.events,appendHandoff);
      }
      const line=latestLine(a),oldLine=activityLines.get(a.id),p=plotFor(a.id);
      if(line&&oldLine&&line!==oldLine&&p&&player&&a.status==='working'){
        const proximity=mode==='room'?(a.id===interiorId?0:Infinity):distance(player,p);
        sound.play('talk',{distance:proximity,pan:(p.x-player.x)/180});
      }
      activityLines.set(a.id,line);
    }
    historyInitialized=true;placePlayer();if(sourceChanged)scrollToPlayer(true);
    if(mode==='room'&&!byId(interiorId))leave();
    if(!selected&&agents.length){selected=agents.find(a=>!a.parent)?.id||agents[0].id;api.select(selected);}
    const w=api.getWorld();relationships=normalizeRelationships(meta.relationships||[],[...new Set(agents.map(a=>a.town))]);
    handoffs=normalizedHandoffs(meta.handoffs||[]);handoffs.forEach(appendHandoff);
    board={x:w.roadX+26,y:(w.roadYs?.[0]||w.height-60)+16};
    if(mode==='room'&&byId(interiorId)){const newRoom=roomFor(byId(interiorId));if(newRoom.seed!==room.seed){room=newRoom;roomPlayer={...room.door};}}
    updatePrTally();updateRoster();ensureActivity(byId(interiorId||selected));renderPanel(selected);
  }
  function drawTown(ctx,time,dt,moving){
    placePlayer();const w=api.getWorld();
    // Relationship paths are explicit metadata, not guessed from project names.
    ctx.save();ctx.lineWidth=3;ctx.strokeStyle='#f8de9a';
    for(const rel of relationships){
      const from=w.districts.find(d=>d.key===rel.from),to=w.districts.find(d=>d.key===rel.to);if(!from||!to)continue;
      const a={x:from.x+from.w/2,y:from.y+from.h-8},b={x:to.x+to.w/2,y:to.y+to.h-8},mid=w.roadX+24;
      ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(mid,a.y);ctx.lineTo(mid,b.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
      const signY=Math.min(a.y,b.y)+23;
      ctx.font='7px "Silkscreen",monospace';ctx.fillStyle='#584631';ctx.fillRect(mid-19,signY,38,10);ctx.fillStyle='#f8de9a';ctx.fillText('↔',mid-4,signY+8);
    }
    ctx.restore();
    couriers=couriers.filter(e=>time-e.start<14);
    for(const c of couriers){
      const fraction=reduce?1:Math.min(1,(time-c.start)/12),mid=w.roadX+24;
      const pts=[c.fromPoint,{x:mid,y:c.fromPoint.y},{x:mid,y:c.toPoint.y},c.toPoint];
      const lengths=pts.slice(1).map((p,i)=>distance(p,pts[i])),total=lengths.reduce((a,b)=>a+b,0);
      let traveled=fraction*total,index=0;while(index<2&&traveled>lengths[index]){traveled-=lengths[index];index++;}
      const f=lengths[index]?traveled/lengths[index]:0,x=pts[index].x+(pts[index+1].x-pts[index].x)*f,y=pts[index].y+(pts[index+1].y-pts[index].y)*f;
      ctx.fillStyle='#eed19b';ctx.fillRect(x-3,y-8,7,6);ctx.strokeStyle='#564431';ctx.strokeRect(x-3,y-8,7,6);
    }
    apprentices=apprentices.filter(e=>time-e.start<8);
    for(const kid of apprentices){
      const from=plotFor(kid.parent),to=plotFor(kid.id);if(!from||!to)continue;
      const f=reduce?1:Math.min(1,(time-kid.start)/6),x=from.x+27+(to.x-from.x-19)*f,y=from.y+76+(to.y-from.y-60)*f;
      renderResident(ctx,x,y,roomFor(to.agent).resident,{time:time*1000,walking:!reduce,scale:.7});ctx.fillStyle='#b97847';ctx.fillRect(x+4,y-8,6,5);
    }
    if(board){
      ctx.fillStyle='#59402c';ctx.fillRect(board.x-14,board.y-17,28,21);ctx.fillRect(board.x-11,board.y+4,3,8);ctx.fillRect(board.x+8,board.y+4,3,8);
      ctx.fillStyle='#e4bd7c';ctx.fillRect(board.x-12,board.y-15,24,17);ctx.fillStyle='#fff1d0';ctx.fillRect(board.x-9,board.y-12,8,10);ctx.fillRect(board.x+2,board.y-12,8,10);
      if(history?.sinceVisit().length){ctx.fillStyle='#d55345';ctx.fillRect(board.x+11,board.y-19,5,5);}
    }
    if(player)api.drawJack(Math.round(player.x)-5,Math.round(player.y)-14,moving&&!reduce?Math.floor(time*8)%2:0);
    const replay=mode==='scrapbook'&&replayEvents[replayIndex];
    if(replay){
      const p=plotFor(replay.agentId);if(p){ctx.strokeStyle='#ffe296';ctx.lineWidth=3;ctx.strokeRect(p.x-5,p.y-12,64,91);ctx.font='8px "Silkscreen",monospace';ctx.fillStyle='#ffe296';ctx.fillText('RECORDED',p.x-5,p.y-17);}
    }
    if(followId)hint('On the bench with '+(byId(followId)?.name||'your agent')+' · Move or press Escape to leave');
    else if(mode==='town')hint('Arrow keys / WASD to walk · Walk into doors · E to talk or use a bench · Click to inspect');
  }
  function draw(time){
    const dt=Math.min(.05,lastFrame?time-lastFrame:1/60);lastFrame=time;
    if(time-lastHealthCheck>1){lastHealthCheck=time;updatePrTally();updateRoster();if(mode==='room'||mode==='town')renderPanel(selected);}
    const moving=move(dt);
    if(mode==='room'&&room){
      transition=Math.min(1,transition+dt*2.8);
      const r=roomCanvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
      const width=Math.max(1,Math.round(r.width*ratio)),height=Math.max(1,Math.round(r.height*ratio));
      if(roomCanvas.width!==width||roomCanvas.height!==height){roomCanvas.width=width;roomCanvas.height=height;}
      roomCtx.imageSmoothingEnabled=false;roomCtx.fillStyle='#171e22';roomCtx.fillRect(0,0,width,height);
      const scale=Math.min(width/room.width,height/room.height),eased=1-Math.pow(1-transition,3);
      roomCtx.save();roomCtx.translate(width/2,height/2);roomCtx.scale(scale*(.83+.17*eased),scale*(.83+.17*eased));roomCtx.translate(-room.width/2,-room.height/2);
      roomCtx.globalAlpha=eased;
      renderInterior(roomCtx,room,{time:time*1000,agent:byId(interiorId)||{},player:{...roomPlayer,walking:moving},selectedObject,reduce,talking:talkingId===interiorId&&performance.now()<talkingUntil});
      if(transition<1){roomCtx.globalAlpha=(1-eased)*.85;roomCtx.fillStyle='#b57d4d';roomCtx.beginPath();roomCtx.moveTo(8,60-eased*120);roomCtx.lineTo(120,-8-eased*120);roomCtx.lineTo(232,60-eased*120);roomCtx.closePath();roomCtx.fill();}
      roomCtx.restore();
      const near=room.objects.filter(o=>o.interactable&&o.id!=='exit').sort((a,b)=>nearRect(roomPlayer,a)-nearRect(roomPlayer,b))[0];
      hint(distance(roomPlayer,room.resident)<30?'E · Talk to '+(byId(interiorId)?.name||'your host')+' · Walk out through the door to leave':near&&nearRect(roomPlayer,near)<30?'E · '+near.label+' · Walk out through the door to leave':'Walk around your host’s cottage · E near your host to talk · Walk into the doorway to leave');
    }else drawTown(api.ctx,time,dt,moving);
    if(replaying){replayTimer+=dt;if(replayTimer>1.8){replayTimer=0;replayIndex++;if(replayIndex>=replayEvents.length){replaying=false;replayIndex=replayEvents.length-1;renderHistory();}showReplay();}}
  }
  function drawDispatch(ctx,p,time){
    const stage=prStage(p.agent.pr),s=STAGES[stage],x=p.x-15,y=p.y+55;
    ctx.fillStyle='#354231';ctx.fillRect(x-2,y+5,17,3);ctx.fillRect(x,y+8,2,9);ctx.fillRect(x+10,y+8,2,9);
    if(stage!=='none'){
      ctx.fillStyle=s.color;ctx.fillRect(x+1,y-3,10,9);ctx.strokeStyle='#344232';ctx.lineWidth=1;ctx.strokeRect(x+.5,y-3.5,10,9);
      if(stage==='ready'){ctx.fillStyle='#fff4b8';ctx.fillRect(x+5,y-5,2,13);ctx.fillRect(x-1,y,14,2);}
      if(stage==='merged'){ctx.clearRect(x+3,y-3,6,3);ctx.fillStyle='#c4e2a4';ctx.fillRect(x-1,y-6,5,3);ctx.fillRect(x+8,y-6,5,3);}
    }
    ctx.font='8px "Silkscreen",monospace';ctx.fillStyle=stage==='blocked'?'#ffe8d2':'#233728';
    const sym={none:'—',open:'+',active:'*','waiting-codex':'?','waiting-ci':':',blocked:'!',ready:'*',merged:'✓',closed:'×',unknown:'?'}[stage];
    if(stage==='blocked'){ctx.fillStyle='#d95540';ctx.fillRect(x+2,y-18,9,11);ctx.fillStyle='#fff2df';}
    ctx.fillText(sym,x+4,y-8+(stage==='active'&&!reduce?Math.floor(time*3)%2:0));
    if(p.agent.pr?.number){ctx.fillStyle='#253729';ctx.fillText('#'+p.agent.pr.number,x-2,y+26);}
    else if(stage==='none'){ctx.fillStyle='#253729';ctx.font='6px "Silkscreen",monospace';ctx.fillText('NO PR',x-4,y+26);}
  }
  return {update,draw,renderPanel,handleClick,enter,leave,follow,focusCottage,drawDispatch,latestLine,visible,talk,
    resident:a=>roomFor(a).resident,sound,
    isTalking:id=>talkingId===id&&performance.now()<talkingUntil,
    get player(){return player;},get mode(){return mode;},
    get state(){return {mode,selected,interiorId,roomSeed:room?.seed,roomPlayer,resident:room?.resident,roomDoor:room?.door,player,returnTo,tab,followId,prFilter,feedStale,talking:talkingId=== (interiorId||selected)&&performance.now()<talkingUntil,historyCount:history?.events().length||0,sound:sound.enabled,reduce,replaying,replayIndex,relationships,couriers:couriers.length,apprentices:apprentices.length,activity:activity.get(interiorId||selected)};}
  };
}
