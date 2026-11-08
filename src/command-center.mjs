/** A presentation coordinator. Polling, walking and the single inspector stay with town.mjs. */
import {fleetView, durationLabel} from './command-model.mjs';
import {tradePanelHTML,tradeStoryForSite,scopedTrades} from './trade-panel.mjs';
import {commandStyles} from './command-styles.mjs';
import {townPulses,townPulseLabel,activityVisit,bindSceneBalance} from './command-workbench.mjs';
import {escapeHTML as e,townOf,ownerOf,stageLabel,attentionQueue,filteredTasks,searchTasks,dispatchHTML,threadsHTML,previewHTML} from './command-render.mjs';
const VIEWS=['town','dispatch','threads'],LENSES=['village','attention','time','delivery','owner'];
const label=value=>value[0].toUpperCase()+value.slice(1);
const editing=target=>Boolean(target?.closest?.('input,textarea,select,[contenteditable=true],[role=textbox]'));

export function lensLabel(task,lens){
  if(lens==='attention')return task.input?'INPUT':task.attention?'! CHECK':'';
  if(lens==='time')return task.quiet?`Q ${durationLabel(task.progressAgeMs)}`:durationLabel(task.taskAgeMs);
  if(lens==='delivery')return task.pr.number?`#${task.pr.number} ${stageLabel(task.prStage)}`:stageLabel(task.prStage);
  if(lens==='owner')return ownerOf(task);
  return '';
}
export function lensContext(task,lens){
  if(!task)return 'Select a cottage for its recorded details.';
  if(lens==='attention')return `${task.title} · ${task.input?.prompt||task.pr.reason||task.raw.attention||'No recorded attention request.'}`;
  if(lens==='time')return `${task.title} · Task ${durationLabel(task.taskAgeMs)} · Execution ${durationLabel(task.recordedExecutionMs)} · Session ${durationLabel(task.sessionAgeMs)} · Progress ${durationLabel(task.progressAgeMs)}${task.progressAgeMs===null?'':' ago'}`;
  if(lens==='delivery')return `${task.title} · ${stageLabel(task.prStage)} · ${task.pr.reason||'Further delivery evidence unavailable.'}`;
  return `${task.title} · Owner ${ownerOf(task)} · Harness ${task.harness} · Model ${task.model}`;
}
/** Labels only: world coordinates, plot geometry and household membership are never changed. */
export function drawPlotLens(ctx,plots,tasks,lens,{selectedId=null,hoverId=null,townFilter=null,visible=()=>true}={}){
  if(lens==='village'||!LENSES.includes(lens))return;
  const byId=new Map(tasks.map(task=>[task.id,task]));
  const draw=(agent,x,y,w=54,roommates=[])=>{
    const members=[agent,...roommates].map(member=>byId.get(String(member.id))).filter(Boolean);
    const allowed=members.filter(task=>(!townFilter||townOf(task)===townFilter)&&visible(task.raw)!==false);
    if(!allowed.length)return;
    const focus=allowed.find(task=>task.id===selectedId||task.id===hoverId),task=focus||allowed.find(task=>task.attention)||allowed[0];
    let text=lensLabel(task,lens);if(!text)return;
    if(text==='Unavailable')text='Time ?';
    text=text.slice(0,16)+(members.length>1?` +${members.length-1}`:'');
    ctx.save();
    try{
      ctx.globalAlpha=focus?1:.9;ctx.font='6px monospace';ctx.textBaseline='middle';ctx.textAlign='center';
      const width=Math.min(125,Math.ceil(ctx.measureText(text).width)+8),cx=Math.round(x+w/2),cy=Math.round(y-10);
      ctx.fillStyle='#23332f';ctx.fillRect(cx-width/2,cy-5,width,10);
      ctx.fillStyle=lens==='attention'?'#efd397':lens==='delivery'&&task.prStage==='ready'?'#b9d9a4':'#e2dfbd';
      ctx.fillRect(cx-width/2,cy-5,1,10);ctx.fillText(text,cx,cy);
    }finally{ctx.restore();}
  };
  for(const plot of plots||[]){
    if(!plot.agent)continue;
    draw(plot.agent,plot.x,plot.y,plot.w||54,plot.agent.roommates||[]);
    for(const child of plot.kids||[])if(child.agent)draw(child.agent,child.x,child.y,16);
  }
}

export function createCommandCenter({root,onInspect=()=>{},onLocate=()=>{},onViewChange=()=>{},onTownFilter=()=>{},onBalanceChange=()=>{},onRehearseGrowth=()=>{}}){
  if(!root)throw new TypeError('Command center requires the existing map shell.');
  const doc=root.ownerDocument,win=doc.defaultView;
  const bar=root.querySelector('#command-bar'),attention=root.querySelector('#command-attention'),surface=root.querySelector('#command-view');
  if(!bar||!attention||!surface)throw new TypeError('Command center mounts are missing.');
  const style=doc.createElement('style');style.dataset.commandStyles='';style.textContent=commandStyles;root.append(style);
  bar.classList.add('cc-bar');attention.classList.add('cc-attention');surface.classList.add('cc-surface');surface.tabIndex=-1;
  surface.setAttribute('aria-label','Command view');surface.hidden=true;
  const pulse=doc.createElement('div');pulse.className='cc-pulse-rail';pulse.setAttribute('aria-label','Project heartbeat');
  attention.before(pulse);
  const balance=doc.createElement('div');balance.className='cc-balance';balance.hidden=true;
  balance.innerHTML='<span class="cc-workbench-name">Dispatch workbench</span><label for="cc-scene-balance">More detail <input id="cc-scene-balance" type="range" min="30" max="75" value="55" aria-label="Town and workbench balance"> More town</label><output for="cc-scene-balance">55% town</output><button data-cc-view="town" title="Close workbench (Escape)">✕ <span>Close</span></button>';
  surface.before(balance);
  const disposeBalance=bindSceneBalance({input:balance.querySelector('input'),output:balance.querySelector('output'),root,onResize:onBalanceChange});
  const guide=doc.createElement('details');guide.className='cc-field-guide';
  guide.innerHTML='<summary>Read the village <span>· a field guide to its heartbeat</span></summary><div class="cc-guide-grid"><p><b>Find your neighbourhood.</b> Choose a project above to frame its cottages. All towns brings the wider village back. Click a cottage for evidence; walk into its doorway to visit.</p><p><b>Watch the ground.</b> Moving lights mark working cottages. Amber lanterns mark attention. Miners mark recent recorded read/search tools at a working cottage. Workshops mark other recent tool use, such as Bash or shell, without guessing what the command did. Missing tool evidence is unknown. Roadmenders mark newly recorded explicit links, never guessed connections.</p><p><b>A growing garden.</b> Seedlings count residents first observed after the initial town inventory, within ten minutes. Three or more arrivals bring a gardener’s pause. These are arrival observations, never inferred stress or productivity.</p><p><b>One PR, one parcel.</b> A newly observed merge sends a labeled cart down its cottage lane. The parcel is that PR’s changes, not a measure of size or proof of deployment. Shared PRs travel once.</p><p><b>Closing is a return.</b> A PR closed without merging sends an empty cart home. Villagers keep their place. Stale feeds pause the new activity cues; no fresh news is invented.</p></div><p class="cc-guide-foot">WASD / arrows · walk &nbsp; E · talk &nbsp; 2 / 3 · workbenches &nbsp; Esc · close &nbsp; ⌘ K · find a cottage</p>';
  pulse.after(guide);
  const tradesPanel=doc.createElement('details');tradesPanel.className='cc-trades';tradesPanel.setAttribute('aria-label','Village activity');guide.before(tradesPanel);
  let selectedTradeId=null;
  const state={view:'town',lens:'village',selectedId:null,filter:'all',sourceKey:null,counts:{},townFilter:null};
  let options={},fleet=fleetView([]),scoped=fleetView([]),queue=[],attentionIndex=0,searchIndex=0,searchResults=[],searchReturn=null,previewTarget=null,previewDismissedKey=null,lastWidth=0;
  const dialog=doc.createElement('dialog');dialog.className='cc-search';dialog.setAttribute('aria-label','Find a cottage');
  dialog.innerHTML='<div class="cc-search-head"><label for="cc-search-input">Find a cottage · name, town, owner, PR or issue</label><button class="cc-search-close" data-cc-close-search aria-label="Close search">Esc</button></div><input id="cc-search-input" type="search" autocomplete="off" placeholder="Where shall we look?" role="combobox" aria-controls="cc-search-results" aria-expanded="true" aria-autocomplete="list"><div id="cc-search-results" class="cc-search-results" role="listbox" aria-label="Matching cottages"></div><p class="cc-note">↑ ↓ choose · Enter inspect · Escape return</p>';
  root.append(dialog);
  const searchInput=dialog.querySelector('input'),resultsNode=dialog.querySelector('#cc-search-results');
  const preview=doc.createElement('div');preview.id='cc-pr-preview';preview.className='cc-preview';preview.setAttribute('role','tooltip');preview.hidden=true;root.append(preview);
  const taskById=id=>scoped.tasks.find(task=>task.id===id)||fleet.tasks.find(task=>task.id===id);
  const sourceNote=()=>options.builtInDemo||options.publicDemo?'Illustrative town · local demo':scoped.stale?'Source stale · last recorded evidence':
    scoped.checkedAt!==null&&scoped.checkedAt<=Date.now()?`Live feed · checked ${durationLabel(Date.now()-scoped.checkedAt)} ago`:'Recorded feed';
  const generatedMarkup=new WeakMap();
  function replace(node,html){
    // Runtime text/ARIA updates must not invalidate the stable generated structure.
    if(generatedMarkup.get(node)===html)return;
    const active=doc.activeElement,key=node.contains(active)?active?.getAttribute('data-cc-key'):null,scroll=node.scrollTop;
    const openTrace=node.querySelector?.('.cc-trace-details')?.open;
    node.innerHTML=html;generatedMarkup.set(node,html);
    if(openTrace&&node.querySelector('.cc-trace-details'))node.querySelector('.cc-trace-details').open=true;
    if(key){const target=[...node.querySelectorAll('[data-cc-key]')].find(item=>item.getAttribute('data-cc-key')===key);target?.focus({preventScroll:true});}
    node.scrollTop=scroll;
  }
  function renderBar(){
    const towns=[...new Set(fleet.tasks.map(townOf))].sort(),visit=activityVisit(scoped.tasks,state.selectedId);
    replace(bar,`<div class="cc-views" role="group" aria-label="Town perspectives">${VIEWS.map((view,index)=>`<button data-cc-view="${view}" data-cc-key="view:${view}" aria-pressed="${state.view===view}" title="${index+1} · ${view==='town'?'Townmap':label(view)}"><span class="cc-key">${index+1}</span>${view==='town'?'Townmap':label(view)}</button>`).join('')}</div><div class="cc-tools"><label class="cc-label">Town <select data-cc-town data-cc-key="town"><option value="">All towns</option>${towns.map(town=>`<option value="${e(town)}" ${state.townFilter===town?'selected':''}>${e(town)}</option>`).join('')}</select></label><label class="cc-label">Lens <select data-cc-lens data-cc-key="lens">${LENSES.map(lens=>`<option value="${lens}" ${state.lens===lens?'selected':''}>${label(lens)}</option>`).join('')}</select></label><button data-cc-visit data-cc-key="visit" ${visit?'':'disabled'} title="${e(visit?`Visit ${visit.reason}: ${visit.task.raw.name||visit.task.title} · ${townOf(visit.task)}`:'No activity or selected cottage in this view')}">Visit activity ↗</button><button class="cc-search-open" data-cc-search data-cc-key="search" title="Find a cottage (Command or Control K)">Find <span class="cc-key">⌘ K</span></button></div>${state.lens!=='village'?`<span class="cc-note" style="flex-basis:100%;margin:0" data-cc-lens-context></span>`:''}`);
    const context=bar.querySelector('[data-cc-lens-context]');
    if(context){const text=lensContext(taskById(state.selectedId),state.lens);if(context.textContent!==text)context.textContent=text;}
  }
  function renderAttention(){
    attentionIndex=queue.length?attentionIndex%queue.length:0;
    const task=queue[attentionIndex];attention.classList.toggle('cc-calm',!task);
    const tab=task?.input?'talk':task?.prStage==='blocked'?'review':'overview';
    replace(attention,`<span class="cc-attention-label">${queue.length?`${queue.length} need attention`:'Village in view'}</span>${task?`<button class="cc-attention-main" data-cc-inspect="${e(task.id)}" data-cc-tab="${tab}" data-cc-key="attention" title="${e((task.input?.prompt||task.pr.reason||task.raw.attention||task.activity||'Inspect recorded evidence').slice(0,240))}"><strong>${e(task.title)}</strong><span>${e((task.input?.prompt||task.pr.reason||task.raw.attention||task.activity||'Inspect recorded evidence').slice(0,240))}</span></button>`:`<span class="cc-attention-main">${scoped.counts.working} working · ${scoped.counts.ready} ready PRs</span>`}<span class="cc-attention-meta">${e(sourceNote())}${queue.length?` · ${scoped.counts.answerable} answerable here`:''}</span>${queue.length>1?`<button class="cc-attention-next" data-cc-next data-cc-key="next" aria-label="Next attention item">${attentionIndex+1}/${queue.length} →</button>`:''}`);
  }
  function renderSurface(){
    if(state.view==='town')return;
    const previewKey=previewTarget?.getAttribute('data-cc-key');
    const title=state.view==='dispatch'?'Dispatch':'Threads';
    const selected=taskById(state.selectedId);
    replace(surface,`<div class="cc-surface-head"><div><h2>${title}</h2><p>${e(state.townFilter||'All towns')} · ${scoped.counts.tasks} cottages · ${e(sourceNote())}</p></div><button class="cc-locate" data-cc-locate data-cc-key="locate" ${selected?'':'disabled'} title="Locate the selected cottage in the existing town">Show in town ↗</button></div>${state.view==='dispatch'?dispatchHTML(scoped.tasks,{...state,counts:scoped.counts}):threadsHTML(scoped.tasks,scoped,{selectedId:state.selectedId,width:surface.clientWidth-32})}`);
    if(previewKey){const target=[...surface.querySelectorAll('[data-cc-pr]')].find(node=>node.getAttribute('data-cc-key')===previewKey);if(target)showPreview(target);else hidePreview();}
  }
  function renderPulse(){
    const towns=townPulses(fleet.tasks);
    replace(pulse,`<button data-cc-focus-town="" data-cc-key="pulse:all" aria-pressed="${!state.townFilter}" class="cc-pulse-all"><span class="cc-heart" aria-hidden="true">❧</span><strong>All towns</strong><small>${towns.length} neighbourhoods</small></button>${towns.map(town=>`<button data-cc-focus-town="${e(town.name)}" data-cc-key="pulse:${e(town.name)}" aria-pressed="${state.townFilter===town.name}" class="cc-pulse-town ${town.working&&!town.stale?'cc-alive':''} ${town.stale?'cc-faded':''}" title="Focus ${e(town.name)} · ${town.total} cottages${town.quiet?` · ${town.quiet} with no progress for 15m+`:''}"><span class="cc-pulse-lamps" aria-hidden="true">${[0,1,2,3,4].map(i=>`<i class="${i<town.working?'lit':''}"></i>`).join('')}</span><strong>${e(town.name)}</strong><small>${e(townPulseLabel(town))}</small></button>`).join('')}`);
  }
  function focusTown(town){state.townFilter=town||null;onTownFilter(state.townFilter||'');refreshScope();render();}
  function renderTrades(){
    if(selectedTradeId&&!scopedTrades(options.trades,state.townFilter).stories.some(s=>s.id===selectedTradeId))selectedTradeId=null;
    replace(tradesPanel,tradePanelHTML({trades:options.trades,tasks:fleet.tasks,townFilter:state.townFilter,stale:options.stale||scoped.stale,illustrative:options.builtInDemo||options.publicDemo,selectedId:selectedTradeId,canRehearseGrowth:options.canRehearseGrowth}));
  }
  function inspectTrade(site){
    const story=tradeStoryForSite(site,options.trades,state.townFilter);
    selectedTradeId=story?.id||null;renderTrades();tradesPanel.open=true;
    tradesPanel.querySelector('.cc-trade-story')?.scrollIntoView({block:'nearest'});
  }
  function render(){renderTrades();renderBar();renderPulse();renderAttention();renderSurface();if(dialog.open)renderSearch();}
  function inspect(id,tab='overview'){
    if(!taskById(id))return;
    state.selectedId=id;hidePreview();render();onInspect(id,tab);
  }
  function setView(view){
    if(!VIEWS.includes(view)||view===state.view)return;
    state.view=view;hidePreview();surface.hidden=view==='town';balance.hidden=view==='town';balance.querySelector('.cc-workbench-name').textContent=`${label(view)} workbench`;root.dataset.commandView=view;render();onViewChange(view);
  }
  function hidePreview(){preview.hidden=true;previewTarget?.removeAttribute('aria-describedby');previewTarget=null;}
  function showPreview(target){
    const task=taskById(target?.dataset.ccPr);if(!task||target?.getAttribute('data-cc-key')===previewDismissedKey)return;
    hidePreview();previewTarget=target;preview.innerHTML=previewHTML(task);preview.hidden=false;target.setAttribute('aria-describedby',preview.id);
    const rect=target.getBoundingClientRect(),box=preview.getBoundingClientRect();
    preview.style.left=`${Math.max(12,Math.min(rect.left,(win?.innerWidth||900)-box.width-12))}px`;
    preview.style.top=`${Math.max(12,Math.min(rect.bottom+8,(win?.innerHeight||700)-box.height-12))}px`;
  }
  function renderSearch(){
    const previous=searchResults[searchIndex]?.id;searchResults=searchTasks(scoped.tasks,searchInput.value);
    const same=searchResults.findIndex(task=>task.id===previous);searchIndex=Math.max(0,Math.min(same>=0?same:searchIndex,searchResults.length-1));
    resultsNode.innerHTML=searchResults.map((task,index)=>`<button id="cc-result-${index}" role="option" tabindex="-1" aria-selected="${index===searchIndex}" class="cc-search-result" data-cc-search-result="${e(task.id)}"><span>${e(task.title)}</span><small>${e(townOf(task))} · ${e(ownerOf(task))} · ${e(task.status)}${task.pr.number?` · #${e(task.pr.number)}`:''}</small></button>`).join('')||'<p class="cc-empty">No matching cottages in the current town.</p>';
    if(searchResults.length)searchInput.setAttribute('aria-activedescendant',`cc-result-${searchIndex}`);else searchInput.removeAttribute('aria-activedescendant');
  }
  function openSearch(){
    hidePreview();searchReturn=doc.activeElement;searchIndex=0;renderSearch();
    if(!dialog.open)dialog.showModal();searchInput.focus();searchInput.select();
  }
  function closeSearch({restore=true}={}){
    if(dialog.open)dialog.close();if(restore&&searchReturn?.isConnected)searchReturn.focus({preventScroll:true});searchReturn=null;
  }
  function chooseSearch(id){closeSearch();inspect(id,taskById(id)?.input?'talk':'overview');}
  function click(event){
    const target=event.target.closest?.('button');if(!target||!root.contains(target))return;
    if(target.hasAttribute('data-cc-trade')){selectedTradeId=target.dataset.ccTrade;renderTrades();}
    else if(target.hasAttribute('data-cc-trade-close')){selectedTradeId=null;renderTrades();}
    else if(target.hasAttribute('data-cc-rehearse-growth')&&(options.builtInDemo||options.publicDemo))onRehearseGrowth();
    else if(target.hasAttribute('data-cc-view'))setView(target.dataset.ccView);
    else if(target.hasAttribute('data-cc-focus-town'))focusTown(target.dataset.ccFocusTown);
    else if(target.hasAttribute('data-cc-visit')){const visit=activityVisit(scoped.tasks,state.selectedId);if(visit){state.selectedId=visit.task.id;setView('town');onLocate(visit.task.id);}}
    else if(target.hasAttribute('data-cc-search'))openSearch();
    else if(target.hasAttribute('data-cc-close-search'))closeSearch();
    else if(target.hasAttribute('data-cc-search-result'))chooseSearch(target.dataset.ccSearchResult);
    else if(target.hasAttribute('data-cc-pr'))inspect(target.dataset.ccPr,'review');
    else if(target.hasAttribute('data-cc-inspect'))inspect(target.dataset.ccInspect,target.dataset.ccTab||'overview');
    else if(target.hasAttribute('data-cc-filter')){state.filter=target.dataset.ccFilter;renderSurface();}
    else if(target.hasAttribute('data-cc-next')){attentionIndex++;renderAttention();}
    else if(target.hasAttribute('data-cc-locate')&&state.selectedId){setView('town');onLocate(state.selectedId);}
  }
  function change(event){
    if(event.target.hasAttribute('data-cc-lens')){state.lens=event.target.value;renderBar();}
    else if(event.target.hasAttribute('data-cc-town'))focusTown(event.target.value);
    else if(event.target.hasAttribute('data-cc-trace'))inspect(event.target.value);
  }
  function refreshScope(){
    const envelope=Array.isArray(options.snapshot)?{agents:options.snapshot}:options.snapshot||{agents:[]};
    const modelOptions={endpoint:options.endpoint,stale:options.stale,includeSettled:Boolean(options.showSettled),builtInDemo:Boolean(options.builtInDemo||options.publicDemo)};
    fleet=fleetView(envelope,modelOptions);
    // Scope after global PR reconciliation: another town may hold the Hub authority.
    const agents=fleet.tasks.filter(task=>!state.townFilter||townOf(task)===state.townFilter).map(task=>({...task.raw,pr:task.pr}));
    scoped=fleetView({...envelope,agents},modelOptions);
    state.counts={...scoped.counts};const prior=queue[attentionIndex]?.id;queue=attentionQueue(scoped.tasks);attentionIndex=Math.max(0,queue.findIndex(task=>task.id===prior));
  }
  function keydown(event){
    const otherDialog=[...doc.querySelectorAll('dialog[open],[role=dialog][aria-modal=true]')].some(node=>node!==dialog&&!node.hidden);
    if(otherDialog)return;
    const consume=()=>{event.preventDefault();event.stopImmediatePropagation();};
    if(dialog.open){
      if(event.key==='Escape'){consume();closeSearch();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        consume();if(searchResults.length)searchIndex=(searchIndex+(event.key==='ArrowDown'?1:-1)+searchResults.length)%searchResults.length;
        // Preserve input focus while exposing the active option to assistive technology.
        for(const [index,node] of [...resultsNode.querySelectorAll('[role=option]')].entries())node.setAttribute('aria-selected',String(index===searchIndex));
        const active=resultsNode.querySelector(`#cc-result-${searchIndex}`);if(active){searchInput.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});}return;
      }
      if(event.key==='Enter'&&event.target===searchInput){consume();const task=searchResults[searchIndex];if(task)chooseSearch(task.id);}return;
    }
    if(editing(event.target))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){consume();openSearch();return;}
    if(event.metaKey||event.ctrlKey||event.altKey)return;
    if(event.key==='Escape'){
      if(!preview.hidden){consume();previewDismissedKey=previewTarget?.getAttribute('data-cc-key');hidePreview();return;}
      if(state.view!=='town'){consume();setView('town');}return;
    }
    if(['1','2','3'].includes(event.key)){consume();setView(VIEWS[Number(event.key)-1]);return;}
    if(state.view!=='town'&&['j','k'].includes(event.key.toLowerCase())){
      consume();const tasks=state.view==='dispatch'?filteredTasks(scoped.tasks,state.filter):scoped.tasks;if(!tasks.length)return;
      const current=tasks.findIndex(task=>task.id===state.selectedId),forward=event.key.toLowerCase()==='j',next=current<0?(forward?0:tasks.length-1):(current+(forward?1:-1)+tasks.length)%tasks.length;
      inspect(tasks[next].id);const row=[...surface.querySelectorAll('[data-cc-row]')].find(node=>node.dataset.ccRow===tasks[next].id);row?.scrollIntoView({block:'nearest'});
    }
  }
  const over=event=>{const target=event.target.closest?.('[data-cc-pr]');if(target&&target!==previewTarget)showPreview(target);};
  const out=event=>{const target=event.target.closest?.('[data-cc-pr]');if(target&&!target.contains(event.relatedTarget)){previewDismissedKey=null;hidePreview();}};
  root.addEventListener('click',click);root.addEventListener('change',change);root.addEventListener('pointerover',over);root.addEventListener('pointerout',out);root.addEventListener('focusin',over);root.addEventListener('focusout',out);
  surface.addEventListener('scroll',hidePreview,{passive:true});doc.addEventListener('keydown',keydown,true);
  searchInput.addEventListener('input',()=>{searchIndex=0;searchResults=[];renderSearch();});
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeSearch();});
  const observer=win?.ResizeObserver?new win.ResizeObserver(()=>{const width=surface.clientWidth;if(width!==lastWidth){lastWidth=width;if(state.view==='threads')renderSurface();}}):null;observer?.observe(surface);
  root.dataset.commandView='town';render();
  return {
    update(next={}){
      const changed=state.sourceKey!==null&&next.sourceKey!==undefined&&next.sourceKey!==state.sourceKey;
      options={...options,...next};
      if(changed&&!Object.hasOwn(next,'trades'))options.trades={};
      if(changed){selectedTradeId=null;tradesPanel.open=false;state.selectedId=null;state.lens='village';state.filter='all';queue=[];attentionIndex=0;searchInput.value='';searchResults=[];closeSearch({restore:false});hidePreview();surface.scrollTop=0;}
      state.sourceKey=options.sourceKey??null;state.townFilter=options.townFilter||null;
      if(!changed&&Object.hasOwn(next,'selectedId'))state.selectedId=next.selectedId==null?null:String(next.selectedId);
      refreshScope();if(state.selectedId&&!fleet.tasks.some(task=>task.id===state.selectedId))state.selectedId=null;render();
    },
    select(id){const next=id==null?null:String(id);if(next===state.selectedId)return;state.selectedId=next;render();},
    setView,
    inspectTrade,
    drawLens(ctx,plots,settings={}){
      drawPlotLens(ctx,plots,fleet.tasks,state.lens,{selectedId:state.selectedId,townFilter:state.townFilter,...settings});
      const context=bar.querySelector('[data-cc-lens-context]'),task=taskById(settings.hoverId||settings.selectedId||state.selectedId);
      if(context){const text=lensContext(task,state.lens);if(context.textContent!==text)context.textContent=text;}
    },
    get tasks(){return fleet.tasks;},
    get state(){return {...state,counts:{...state.counts}};},
    destroy(){disposeBalance();balance.remove();pulse.remove();guide.remove();tradesPanel.remove();observer?.disconnect();doc.removeEventListener('keydown',keydown,true);root.removeEventListener('click',click);root.removeEventListener('change',change);root.removeEventListener('pointerover',over);root.removeEventListener('pointerout',out);root.removeEventListener('focusin',over);root.removeEventListener('focusout',out);surface.removeEventListener('scroll',hidePreview);dialog.remove();preview.remove();style.remove();}
  };
}
