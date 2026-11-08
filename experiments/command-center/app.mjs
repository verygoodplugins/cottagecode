import {fleetView, durationLabel, safeUrl} from './model.mjs';
import {createScenario} from './scenario.mjs';
import {createReplyClient, isTerminalForMessage} from './replies.mjs';
import {inputRequestVersion} from '/src/input-request.mjs';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const endpoint = new URL('/agents', location.href).href;
const replies = createReplyClient({endpoint});
const params = new URLSearchParams(location.search);
const views = ['townwatch', 'dispatch', 'threads'];
const state = {
  view: views.includes(params.get('view')) ? params.get('view') : 'townwatch',
  scenario: params.get('scenario') === '1', snapshot: null, fleet: fleetView({agents:[]}),
  project: '', selected: null, lens: 'Attention', filter: 'all', attentionIndex: 0,
  stale: false, error: '', loading: true, fetchedAt: null, epoch: 0,
  order: new Map(), projectOrder: new Map(), drafts: new Map(), receipts: new Map(), threadTask: null,
};
let pollTimer;
let drawerIdentity = null;
let returnFocus = null;
let searchIndex = 0;
let previewTimer;
let previewOwner = null;
const age = value => durationLabel(value);
const date = value => { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'Unavailable'; };
const stageNames = {'waiting-codex':'Awaiting review','waiting-ci':'Awaiting checks',active:'In review',ready:'Ready',blocked:'Blocked',merged:'Merged',closed:'Closed',unknown:'Unknown',none:'No PR recorded',open:'Open'};
const stage = value => stageNames[value] || 'Unknown';
const sourceName = task => typeof task.raw.source === 'string' ? task.raw.source : (task.raw.source?.name || 'Unavailable');
const owner = task => task.harness === 'Unknown' ? 'Harness unavailable' : task.harness;
const short = (text, length = 180) => String(text || '').length > length ? `${String(text).slice(0,length).trimEnd()}…` : String(text || '');
// Visual execution follows canonical status; the delivery guard is deliberately stricter.
const displayTerminal = task => Boolean(task.raw.terminal || ['done','completed','offline','cancelled','failed','interrupted'].includes(task.status));
const terminal = task => isTerminalForMessage(task.raw);
const canReply = task => task.capability.available && !terminal(task);
const version = task => `${task.raw.taskId || task.id}:${inputRequestVersion(task.raw.inputRequest) || 'no-input'}`;
const taskById = id => state.fleet.tasks.find(task => task.id === id);
const scoped = () => state.fleet.tasks.filter(task => !state.project || task.project === state.project);
const prGroup = task => state.fleet.prs.find(pr => pr.key === task.prKey);
function counts(tasks) {
  const ids = new Set(tasks.map(task => task.id));
  return {tasks: tasks.length, working:tasks.filter(t=>t.status==='working').length, attention:tasks.filter(t=>t.attention).length,
    quiet:tasks.filter(t=>t.quiet).length, ready:state.fleet.prs.filter(pr=>pr.stage==='ready'&&pr.taskIds.some(id=>ids.has(id))).length};
}
function visibleTasks() {
  const tasks = scoped();
  return state.view !== 'dispatch' ? tasks : tasks.filter(task => state.filter === 'all' ||
    (state.filter === 'attention' && task.attention) || (state.filter === 'working' && task.status === 'working') ||
    (state.filter === 'quiet' && task.quiet) || (state.filter === 'ready' && prGroup(task)?.stage === 'ready'));
}
function stateMark(task) {
  if (task.input) return {symbol:'?', label:'Recorded input', tone:'input'};
  if (task.status === 'blocked' || task.prStage === 'blocked') return {symbol:'!', label:task.status === 'blocked'?'Blocked':'PR blocked', tone:'blocked'};
  if (['done','completed'].includes(task.status)) return {symbol:'✓',label:task.status,tone:'done'};
  if (['failed','interrupted'].includes(task.status)) return {symbol:'×',label:task.status,tone:'blocked'};
  if (task.status==='cancelled') return {symbol:'—',label:task.status,tone:''};
  return {symbol:task.status === 'working'?'◒':'○', label:task.status, tone:''};
}
function link(url, label, className='source-link') {
  const valid = safeUrl(url);
  if(state.scenario && valid && new URL(valid).hostname==='example.invalid')return `<span class="${className}">${escape(label)} · illustrative reference</span>`;
  return valid ? `<a class="${className}" href="${escape(valid)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>` : '';
}
function cottage(task, tiny=false) {
  const hash = [...task.id].reduce((sum,c)=>sum+c.charCodeAt(0),0);
  const roofs = ['#64788b','#7f798b','#6c8586','#7b756a','#627d91'];
  const roof = roofs[hash % roofs.length];
  return `<svg class="house ${task.status==='working'&&!displayTerminal(task)?'working':''} ${tiny?'tiny':''}" aria-hidden="true" viewBox="0 0 48 48" shape-rendering="crispEdges"><g class="smoke" fill="#9aaebc"><path d="M31 6h3v3h-3zM33 1h3v3h-3z"/></g><path fill="#283e4c" d="M3 40h41v3H3z"/><path fill="#56717e" d="M10 24h29v16H10z"/><path fill="#6a8390" d="M10 24h21v16H10z"/><path fill="#344e60" d="M31 25h8v15h-8z"/><path fill="#9b9b91" d="M30 10h5v13h-5z"/><path fill="${roof}" d="M7 23h3v-4h4v-4h5v-4h9v4h5v4h5v4h4v4H7z"/><path fill="#a4acaa" d="M7 25h35v2H7z"/><path fill="#2b414e" d="M22 29h7v11h-7z"/><path fill="#9c9d8f" d="M21 40h9v2h-9z"/><path class="window" d="M13 29h6v6h-6zM33 29h4v5h-4z"/><path fill="#596a6d" d="M15 29h1v6h-1zM13 31h6v1h-6z"/><path fill="#4b7270" d="M4 34h2v6H4zM2 36h2v2H2zM6 35h2v2H6zM41 36h2v4h-2zM43 34h2v4h-2z"/><path fill="#8d9c8f" d="M2 35h2v2H2zM43 33h2v2h-2z"/></svg>`;
}
function syncURL() {
  const url = new URL(location.href); url.searchParams.set('view',state.view);
  if(state.scenario) url.searchParams.set('scenario','1'); else url.searchParams.delete('scenario');
  history.replaceState(null,'',url);
}
function updateModel() {
  // Scenario is a frozen authored observation, including its capability evidence.
  state.fleet = fleetView(state.snapshot || {agents:[]}, {now:state.scenario ? state.snapshot.checkedAt : Date.now(),stale:state.stale,endpoint});
  for(const task of state.fleet.tasks) {
    if(!state.order.has(task.id)) state.order.set(task.id,state.order.size);
    if(!state.projectOrder.has(task.project)) state.projectOrder.set(task.project,state.projectOrder.size);
    const draft = state.drafts.get(task.id);
    if(draft && draft.version !== version(task)) draft.changed = true;
  }
  state.fleet.tasks.sort((a,b)=>state.order.get(a.id)-state.order.get(b.id));
  state.fleet.projects.sort((a,b)=>state.projectOrder.get(a.id)-state.projectOrder.get(b.id));
}
function focusedControl(root) {
  const active=document.activeElement;
  if(!active || !root.contains(active))return null;
  if(active.id)return `#${CSS.escape(active.id)}`;
  for(const name of ['project','select','pr','lens','filter','next-attention','close-drawer','review-draft','send','option']) {
    if(active.hasAttribute(`data-${name}`))return `[data-${name}="${CSS.escape(active.getAttribute(`data-${name}`))}"]`;
  }
  if(active.tagName==='SUMMARY'&&active.parentElement.dataset.detail)return `details[data-detail="${CSS.escape(active.parentElement.dataset.detail)}"] > summary`;
  return null;
}
function restoreControl(root,selector) {if(selector)root.querySelector(selector)?.focus({preventScroll:true});}
function renderChrome() {
  const railFocus=focusedControl($('#towns'));
  document.body.classList.toggle('illustrative',state.scenario);
  document.title = `CottageCode · ${state.view[0].toUpperCase()+state.view.slice(1)}`;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current',String(button.dataset.view===state.view)));
  $('#source-mark').textContent = state.scenario ? '◇ ILLUSTRATIVE SCENARIO' : '● LIVE FEED';
  $('#source-description').textContent = state.scenario ? 'Fictional cottages. Every response stays on this page.' : 'Your local village, as observed.';
  $('#source-switch').textContent = state.scenario ? 'Return to live village →' : 'Explore illustrative scenario →';
  $('#freshness').textContent = state.scenario ? 'Fictional evidence' : state.loading ? 'Connecting…' : state.stale ? 'Source unavailable' : `Fetched ${age(Date.now()-state.fetchedAt)} ago`;
  $('#connection').hidden = !state.error;
  $('#connection').innerHTML = state.error ? `${escape(state.error)} <button data-retry>Reconnect</button>` : '';
  const townButton = (id,name,count,attention) => `<button class="town-link ${state.project===id?'active':''}" data-project="${escape(id)}" aria-pressed="${state.project===id}"><span>${escape(name)}</span><span>${count}</span>${attention?`<small>${attention} attention</small>`:''}</button>`;
  $('#towns').innerHTML = townButton('','All towns',state.fleet.counts.tasks,state.fleet.counts.attention) + state.fleet.projects.map(p=>townButton(p.id,p.name,p.count,p.attention)).join('');
  restoreControl($('#towns'),railFocus);
  $('#town-select').innerHTML = `<option value="">All towns · ${state.fleet.counts.tasks}</option>` + state.fleet.projects.map(p=>`<option value="${escape(p.id)}" ${state.project===p.id?'selected':''}>${escape(p.name)} · ${p.count}</option>`).join('');
}
function renderHeading() {
  const c = counts(scoped());
  const titles = {townwatch:['THE NIGHT ATLAS','Townwatch','A small light for every piece of work.'],dispatch:['THE WORKING LEDGER','Dispatch','Read the work. Find the next useful move.'],threads:['THE RELATIONSHIP ATLAS','Threads','Recorded paths from request to delivery.']};
  const [caption,title,description] = titles[state.view];
  $('#view-heading').innerHTML = `<div class="view-intro"><div class="eyebrow">${caption}</div><h1>${title}</h1><p>${description} ${state.project?escape(state.project):`Across ${state.fleet.projects.length} towns.`}</p></div><div class="summary"><div><b>${c.working}</b><span>Working</span></div><div><b class="attention">${c.attention}</b><span>Attention</span></div><div><b class="ready">${c.ready}</b><span>Ready PR${c.ready===1?'':'s'}</span></div></div>`;
}
function attentionStrip() {
  const tasks = scoped().filter(t=>t.attention).sort((a,b)=>Number(Boolean(b.input&&canReply(b)))-Number(Boolean(a.input&&canReply(a))));
  if(!tasks.length) return `<div class="attention-strip"><span class="letter" aria-hidden="true">✉</span><p>No recorded attention in this scope.</p></div>`;
  const task = tasks[state.attentionIndex % tasks.length];
  const text = task.input?.prompt || task.pr.reason || task.activity || 'Inspect recorded evidence';
  return `<div class="attention-strip"><span class="letter" aria-hidden="true">✉</span><button class="strip-open" data-select="${escape(task.id)}"><span class="strip-meta">${tasks.length} ATTENTION · ${escape(task.project)} · ${task.input?(canReply(task)?'ANSWER AVAILABLE':'RECORDED INPUT'):'RECORDED BLOCKER'}</span><p>${escape(short(text,220))}</p></button><button class="strip-next" data-next-attention aria-label="Next attention item">→</button></div>`;
}
function annotation(task) {
  if(state.lens==='Time') return `Task ${age(task.taskAgeMs)}${task.quiet?` · Quiet ${age(task.progressAgeMs)}`:''}`;
  if(state.lens==='Delivery') return `${task.pr.number?`PR #${task.pr.number} · `:''}${stage(task.prStage)}`;
  if(state.lens==='Owner') return `${owner(task)}${task.model!=='Unknown'?` · ${task.model}`:''}`;
  if(task.input) return canReply(task) ? '✉ Answer available' : '✉ Recorded input';
  if(task.prStage==='blocked') return '！ PR blocked';
  if(task.status==='blocked') return '！ Blocked';
  if(task.prStage==='ready') return '✓ PR ready';
  return `${stateMark(task).symbol} ${task.status}${task.quiet?' · Quiet':''}`;
}
function renderTownwatch() {
  const tasks = scoped();
  const projects = state.fleet.projects.filter(p=>!state.project||p.id===state.project);
  return `${attentionStrip()}<div class="lens-row"><span class="eyebrow">TOWNMAP <span aria-hidden="true">/</span> ${tasks.length} COTTAGES</span><div class="lens-options" aria-label="Townmap lens">${['Attention','Time','Delivery','Owner'].map(lens=>`<button data-lens="${lens}" class="${state.lens===lens?'active':''}" aria-pressed="${state.lens===lens}">${lens}</button>`).join('')}</div></div><div class="atlas">${projects.map((project,index)=>`<section class="district"><div class="district-heading"><h2>${escape(project.name)}</h2><span>${String(index+1).padStart(2,'0')} / ${project.count} RESIDENT${project.count===1?'':'S'}</span></div><div class="cottage-grid">${tasks.filter(t=>t.project===project.id).map(task=>{
    const mark=stateMark(task); const badge=task.input?'?':mark.tone==='blocked'?'!':task.prStage==='ready'?'✓':'';
    return `<button class="cottage ${task.id===state.selected?'selected':''}" data-select="${escape(task.id)}" aria-label="Inspect ${escape(task.title)} — ${escape(mark.label)}" aria-pressed="${task.id===state.selected}"><span class="house-scene">${cottage(task)}${badge?`<span class="task-symbol ${task.input?'needs-input':task.prStage==='ready'?'ready':'blocked'}">${badge}</span>`:''}</span><span class="cottage-title">${escape(task.title)}</span><span class="cottage-annotation ${task.attention&&state.lens==='Attention'?'attention':''}">${escape(annotation(task))}</span></button>`;
  }).join('')}</div></section>`).join('')}</div><div class="atlas-legend"><span><span class="legend-symbol working">▪</span>Working windows &nbsp; <span class="legend-symbol blocked">!</span>Blocked &nbsp; <span class="legend-symbol ready">✓</span>Ready PR</span><span>Positions stay put. The lens changes the reading.</span></div>`;
}
function prBadge(task) {
  return `<button class="pr-badge ${escape(task.prStage)}" data-pr="${escape(task.id)}" aria-label="Inspect ${task.pr.number?`PR ${task.pr.number}`:'PR evidence'}: ${escape(stage(task.prStage))}" title="${escape(task.pr.reason || stage(task.prStage))}">${task.pr.number?`↗ #${task.pr.number}`:task.prStage==='none'?'— No PR recorded':'○ PR unknown'}<small>${escape(stage(task.prStage))}</small></button>`;
}
function renderDispatch() {
  const c=counts(scoped()); const rows=visibleTasks();
  return `<div class="filter-row" aria-label="Dispatch filters">${[['all','All',c.tasks],['attention','Attention',c.attention],['working','Working',c.working],['quiet','Quiet',c.quiet],['ready','Ready PRs',c.ready]].map(([id,label,n])=>`<button class="${state.filter===id?'active':''}" data-filter="${id}" aria-pressed="${state.filter===id}">${label}<b>${n}</b></button>`).join('')}</div><p class="view-note">${state.filter==='quiet'?'Quiet = no explicit recorded progress for 15 minutes or more. Execution may still be working.':'Task time, session time and observed activity tell different stories. PR totals count shared shipments once.'}</p><div class="ledger-head" aria-hidden="true"><span>WORK / PUBLIC ACTIVITY</span><span>OWNER / MODEL</span><span>INDEPENDENT CLOCKS</span><span>DELIVERY</span></div><div class="ledger">${rows.length?rows.map(task=>{
    const mark=stateMark(task);
    return `<article class="ledger-row ${task.id===state.selected?'selected':''}" data-task-row="${escape(task.id)}"><div class="ledger-work"><span class="state-icon ${mark.tone}" title="${escape(mark.label)}" aria-label="${escape(mark.label)}">${mark.symbol}</span><div><button class="task-title" data-select="${escape(task.id)}">${escape(task.title)}</button><p>${escape(task.activity || 'Public activity unavailable.')}</p>${task.input?`<p class="recorded">✉ ${escape(short(task.input.prompt,250))}</p>`:''}</div></div><div class="owner-cell">${escape(owner(task))}<small>${escape(task.model==='Unknown'?'Model unavailable':task.model)}</small><small>${escape(task.project)} · ${escape(task.status)}</small></div><div class="clocks-cell"><div><span>Task</span> ${age(task.taskAgeMs)}</div><div><span>Session</span> ${age(task.sessionAgeMs)}</div><div><small>Observed ${task.observedAgeMs===null?'unavailable':age(task.observedAgeMs)+' ago'}</small></div>${task.quiet?`<div>Quiet ${age(task.progressAgeMs)}</div>`:''}</div><div>${prBadge(task)}</div></article>`;
  }).join(''):`<div class="empty"><h2>No cottages in this view</h2><p>Try another filter or town.</p></div>`}</div>`;
}
function graphData(tasks) {
  const nodes=new Map();
  for(const task of tasks) {
    nodes.set(`task:${task.id}`,{id:`task:${task.id}`,kind:'task',task,title:task.title,caption:owner(task)});
    for(const issue of task.issues)nodes.set(`issue:${issue.url}`,{id:`issue:${issue.url}`,kind:'issue',issue,title:issue.title,caption:issue.number?`ISSUE #${issue.number}`:'RECORDED ISSUE'});
    if(task.prKey) {const group=prGroup(task);nodes.set(`pr:${task.prKey}`,{id:`pr:${task.prKey}`,kind:'pr',group,task,title:group.pr.title||`Pull request #${group.pr.number}`,caption:stage(group.stage)});}
  }
  const edges=state.fleet.edges.filter(edge=>nodes.has(edge.from)&&nodes.has(edge.to));
  return {nodes,edges};
}
function relatedNodes(edges,selected) {
  const seen=new Set(selected?[`task:${selected}`]:[]);
  // Show the explicitly connected path, including shared shipments and dependencies.
  for(let i=0;i<4;i++)for(const edge of edges)if(seen.has(edge.from)||seen.has(edge.to)){seen.add(edge.from);seen.add(edge.to);}
  return seen;
}
function nodeHTML(node,styleText,selected) {
  const common=`class="graph-node ${node.kind}-node ${selected?'selected':''}" style="${styleText}"`;
  if(node.kind==='issue' && state.scenario){const task=state.fleet.tasks.find(t=>t.issues.some(i=>i.url===node.issue.url));return `<button ${common} data-select="${escape(task?.id||'')}"><span class="node-kind">${escape(node.caption)}</span><strong>${escape(node.title)}</strong><small>Illustrative issue · inspect cottage</small></button>`;}
  if(node.kind==='issue')return `<a ${common} href="${escape(node.issue.url)}" target="_blank" rel="noopener noreferrer"><span class="node-kind">${escape(node.caption)} ↗</span><strong>${escape(node.title)}</strong></a>`;
  const isPR=node.kind==='pr';
  return `<button ${common} ${isPR?'data-pr':'data-select'}="${escape(node.task.id)}"><span class="node-kind">${isPR?`↗ PR #${node.group.pr.number}`:`⌂ ${escape(node.task.project)}`}</span><strong>${escape(node.title)}</strong><small>${escape(node.caption)}${isPR&&node.group.taskIds.length>1?` · ${node.group.taskIds.length} cottages`:''}</small></button>`;
}
function renderThreads() {
  const tasks=scoped(), {nodes,edges}=graphData(tasks);
  const active=tasks.find(t=>t.id===state.threadTask)||tasks.find(t=>t.id===state.selected)||tasks[0];
  const selected=relatedNodes(edges,state.selected||active?.id);
  const columns={issue:[],task:[],pr:[]};
  for(const node of nodes.values())columns[node.kind].push(node);
  const positions=new Map();
  columns.task.forEach((n,i)=>positions.set(n.id,{x:31,y:25+i*132,width:37}));
  for(const kind of ['issue','pr']) {
    let previous=-107;
    columns[kind].forEach(node=>{
      const related=edges.filter(e=>e.from===node.id||e.to===node.id).map(e=>positions.get(e.from===node.id?e.to:e.from)?.y).filter(Number.isFinite);
      const wanted=related.length?related.reduce((a,b)=>a+b,0)/related.length:previous+132;
      const y=Math.max(wanted,previous+132);previous=y;positions.set(node.id,{x:kind==='issue'?0:73,y,width:kind==='issue'?26:27});
    });
  }
  const height=Math.max(500,...[...positions.values()].map(p=>p.y+130));
  const graphWidth=Math.max(300,$('#scene').clientWidth);
  const pathHTML=edges.map(edge=>{
    const from=positions.get(edge.from),to=positions.get(edge.to); const same=from.x===to.x;
    const leftSide=same&&from.x===73;
    const x1=(leftSide?from.x:from.x+from.width)*graphWidth/100,x2=(same?(leftSide?to.x:to.x+to.width):to.x)*graphWidth/100;
    const bend=x1+(leftSide?-26:28);
    const y1=from.y+45,y2=to.y+45; const highlighted=selected.has(edge.from)&&selected.has(edge.to);
    const d=same?`M${x1} ${y1} C${bend} ${y1},${bend} ${y2},${x2} ${y2}`:`M${x1} ${y1} C${(x1+x2)/2} ${y1},${(x1+x2)/2} ${y2},${x2} ${y2}`;
    return `<path d="${d}" class="${highlighted?'selected':''}" marker-end="url(#arrow${highlighted?'-selected':''})" vector-effect="non-scaling-stroke"/><text x="${same?x1+(leftSide?-17:17):(x1+x2)/2}" y="${(y1+y2)/2-5}" text-anchor="middle" class="${highlighted?'selected':''}">${escape(edge.kind==='depends-on'?'required by':edge.kind)}</text>`;
  }).join('');
  return `<div class="threads-intro"><span>Only recorded relationships connect these cottages.</span><span>${edges.length} paths · ${columns.pr.length} distinct PRs</span></div><div class="graph"><div class="graph-head"><span>ISSUES</span><span>COTTAGES</span><span>PULL REQUESTS</span></div><div class="graph-body" style="height:${height}px"><svg class="graph-lines" viewBox="0 0 ${graphWidth} ${height}" preserveAspectRatio="none" aria-label="Recorded relationship connectors"><defs><marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L6 3L0 6" style="fill:#536b7b;stroke:none"/></marker><marker id="arrow-selected" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L6 3L0 6" style="fill:#e2be79;stroke:none"/></marker></defs>${pathHTML}</svg>${!columns.issue.length?'<p class="graph-placeholder">Issue links are not recorded in this feed.</p>':''}${[...nodes.values()].map(node=>{const p=positions.get(node.id);return nodeHTML(node,`left:${p.x}%;top:${p.y}px`,selected.has(node.id));}).join('')}</div></div>${renderTrace(active,nodes,edges)}`;
}
function renderTrace(active,nodes,edges) {
  if(!active)return '';
  const direct=edges.filter(e=>e.from===`task:${active.id}`||e.to===`task:${active.id}`);
  const traceNode=(node,relation)=>{
    if(!node)return '';
    if(node.kind==='issue'&&state.scenario)return `<p class="trace-caption">↓ ${escape(relation)}</p><div class="trace-card">${escape(node.caption)}<small>${escape(node.title)} · illustrative reference</small></div>`;
    if(node.kind==='issue')return `<p class="trace-caption">↓ ${escape(relation)}</p><a class="trace-card" href="${escape(node.issue.url)}" target="_blank" rel="noopener noreferrer">${escape(node.caption)}<small>${escape(node.title)} ↗</small></a>`;
    return `<p class="trace-caption">↓ ${escape(relation)}</p><button class="trace-card" ${node.kind==='pr'?'data-pr':'data-select'}="${escape(node.task.id)}">${escape(node.title)}<small>${escape(node.caption)}</small></button>`;
  };
  const incoming=direct.filter(e=>e.to===`task:${active.id}`),outgoing=direct.filter(e=>e.from===`task:${active.id}`);
  const shared=active.prKey ? prGroup(active) : null;
  const dependency=edges.filter(e=>e.kind==='depends-on'&&(e.from===`pr:${active.prKey}`||e.to===`pr:${active.prKey}`));
  return `<div class="trace"><label class="sr-only" for="trace-task">Cottage to trace</label><select id="trace-task" class="trace-select">${scoped().map(t=>`<option value="${escape(t.id)}" ${t.id===active.id?'selected':''}>${escape(t.project+' · '+t.title)}</option>`).join('')}</select><div class="trace-section"><div class="eyebrow">UPSTREAM / RECORDED ORIGINS</div>${incoming.length?incoming.map(e=>traceNode(nodes.get(e.from),e.kind)).join(''):'<p class="muted">No incoming issue or parent links recorded.</p>'}</div><div class="trace-section"><div class="eyebrow">COTTAGE</div><button class="trace-card selected" data-select="${escape(active.id)}">⌂ ${escape(active.title)}<small>${escape(owner(active))} · ${escape(active.status)}</small></button></div><div class="trace-section"><div class="eyebrow">DOWNSTREAM / RECORDED DELIVERY</div>${outgoing.length?outgoing.map(e=>traceNode(nodes.get(e.to),e.kind)).join(''):'<p class="muted">No outgoing relationships recorded.</p>'}${shared&&shared.taskIds.length>1?`<p class="trace-caption">Also linked to</p>${shared.taskIds.filter(id=>id!==active.id).map(id=>taskById(id)).filter(Boolean).map(t=>`<button class="trace-card" data-select="${escape(t.id)}">${escape(t.title)}<small>Shares PR #${shared.pr.number}</small></button>`).join('')}`:''}${dependency.map(e=>traceNode(nodes.get(e.from===`pr:${active.prKey}`?e.to:e.from),e.from===`pr:${active.prKey}`?`PR #${active.pr.number} is required by`:`PR #${active.pr.number} depends on`)).join('')}</div></div>`;
}
function renderScene() {
  $('.workspace').classList.toggle('has-drawer',Boolean(state.selected));
  const sceneFocus=focusedControl($('#scene'));
  hidePreview();
  renderHeading();
  if(!state.fleet.tasks.length) $('#scene').innerHTML=`<div class="empty"><h2>${state.loading?'Opening the village…':state.error?'The live source is unavailable':'No current cottages recorded'}</h2><p>${state.loading?'Reading your local feed.':state.error?'Reconnect to read the live village, or explicitly explore the illustrative scenario.':'This feed has no live or recent work to display. Missing information stays unavailable.'}</p></div>`;
  else $('#scene').innerHTML=state.view==='townwatch'?renderTownwatch():state.view==='dispatch'?renderDispatch():renderThreads();
  restoreControl($('#scene'),sceneFocus);
}
function draftFor(task) {
  if(!state.drafts.has(task.id))state.drafts.set(task.id,{text:'',version:version(task),raw:structuredClone(task.raw),changed:false});
  return state.drafts.get(task.id);
}
function receiptFor(task) {return state.scenario ? state.receipts.get(task.id) || {phase:'idle',notice:''} : replies.state(task.raw.taskId);}
function replyLocked(task,receipt) {
  return ['checking','sending','uncertain'].includes(receipt.phase) || (receipt.phase==='sent' && (state.scenario || (task.input && task.capability.mode==='respond' && receipt.inputVersion===inputRequestVersion(task.raw.inputRequest))));
}
function inputHTML(task) {
  const request=task.input, can=canReply(task), draft=draftFor(task),receipt=receiptFor(task);
  const title = request && can && task.capability.mode==='respond' ? 'Needs your answer' : 'Recorded input';
  const original=typeof task.raw.inputRequest==='string'?task.raw.inputRequest:task.raw.inputRequest?.prompt || task.raw.inputRequest?.question || task.raw.inputRequest?.text || request?.prompt;
  const options=request?.questions.flatMap(q=>q.options || [])||[];
  const full=original || request?.prompt || '';
  const detailed=request?.detail || '';
  const readonlyReason=terminal(task)?'The source records this task as ended. Continue in its original workflow.':task.capability.reason;
  return `${request?`<h3>${title}</h3><p class="question">${escape(short(request.prompt,400))}</p>${full.length>400||detailed||request.questions.length>1?`<details data-detail="input"><summary>Read full recorded input</summary><div class="full-text">${escape(full)}${detailed&&detailed!==full?'\n\n'+escape(detailed):''}${request.questions.length>1?'\n\n'+request.questions.map(q=>escape(q.prompt)).join('\n\n'):''}</div></details>`:''}<p class="input-source">${escape(request.kind)} · ${escape(request.source)} · ${date(request.updatedAt)}</p>`:can?'<h3>Message this cottage</h3>':'<h3>Conversation</h3>'}
    ${!can&&options.length?`<div class="options">${options.map(option=>`<div class="option">${escape(option.label)}${option.description?`<small>${escape(option.description)}</small>`:''}</div>`).join('')}</div>`:''}
    ${can?`<div class="composer" data-composer="${escape(task.id)}">${options.length?`<div class="options">${options.map((option,index)=>`<button class="option" data-option="${index}" ${replyLocked(task,receipt)?'disabled':''}>${escape(option.label)}${option.description?`<small>${escape(option.description)}</small>`:''}</button>`).join('')}</div>`:''}<label for="reply-text">${state.scenario?'Local scenario response':'Your message'}</label><textarea id="reply-text" maxlength="8000" placeholder="${state.scenario?'Try a response. It stays here.':'Write a message to this task…'}" ${replyLocked(task,receipt)?'disabled':''}>${escape(draft.text)}</textarea>${draft.changed?'<div class="draft-warning">The task or recorded input changed while you were drafting. Your draft is preserved. Review the current evidence before using it.<button data-review-draft>I reviewed the new input; use this draft</button></div>':''}<button class="send" data-send ${replyLocked(task,receipt)||draft.changed||!draft.text.trim()?'disabled':''}>${state.scenario?'Send local response':'Send message'}</button><p class="capability-note">${state.scenario?'Simulation only. This cannot contact an agent or change its status.':'Explicit Send rechecks the current task, question and message route.'}</p></div>`:`<p class="capability-note">${escape(readonlyReason || 'A message route is unavailable.')}</p>`}
    ${receipt.notice?`<p class="${receipt.phase==='sent'?'receipt':'reply-notice'}" role="status">${escape(receipt.notice)}</p>`:''}`;
}
function evidenceHTML(task) {
  const pr=task.pr, group=prGroup(task);
  return `<h3>Delivery evidence ${pr.number?`/ #${pr.number}`:''}</h3><dl class="evidence-list"><dt>Stage</dt><dd class="status ${escape(task.prStage)}">${escape(stage(task.prStage))}</dd><dt>Authority</dt><dd>${escape(pr.authority || 'Standalone observation')}</dd><dt>Source</dt><dd>${escape(pr.source || 'Unavailable')}</dd><dt>Verified</dt><dd>${date(pr.checkedAt)}</dd><dt>Freshness</dt><dd>${pr.checkedAt?pr.stale?'Marked stale':'Source has not marked evidence stale':'Unavailable'}${task.sourceStale&&pr.authority==='hub'?' · Last Hub state retained during feed outage':''}</dd><dt>Checks</dt><dd>${task.ci.total?`${task.ci.passed}/${task.ci.total} passed · ${escape(task.ci.state)}`:'Unavailable'}</dd><dt>Current head</dt><dd class="mono">${escape(pr.headSha || 'Unavailable')}</dd><dt>Reviewed head</dt><dd class="mono">${escape(pr.reviewedHeadSha || 'Unavailable')}</dd><dt>Reason</dt><dd>${escape(pr.reason || 'No reason supplied.')}</dd><dt>Labels</dt><dd>${pr.labels.length?escape(pr.labels.join(' · ')):'Unavailable'}</dd>${group&&group.taskIds.length>1?`<dt>Shared PR</dt><dd>${group.taskIds.length} cottages · one shipment<br>Fleet stage: ${escape(stage(group.stage))}</dd>`:''}</dl>${pr.checks.length?`<ul class="check-list">${pr.checks.map(check=>`<li><span>${check.url?link(check.url,check.name,''):escape(check.name||'Unnamed check')}</span><span>${escape(check.conclusion||check.status||'Unavailable')}</span></li>`).join('')}</ul>`:''}${link(pr.url,'Open original PR')}`;
}
function relationshipsHTML(task) {
  const edges=state.fleet.edges.filter(e=>e.from===`task:${task.id}`||e.to===`task:${task.id}`||task.prKey&&(e.from===`pr:${task.prKey}`||e.to===`pr:${task.prKey}`));
  const nodeText=id=>{
    if(id.startsWith('task:')){const t=taskById(id.slice(5));return t?`<button data-select="${escape(t.id)}">${escape(t.title)}</button>`:escape(id);}
    if(id.startsWith('pr:')){const pr=state.fleet.prs.find(p=>`pr:${p.key}`===id);return pr?`PR #${pr.pr.number}`:escape(id);}
    const issue=state.fleet.tasks.flatMap(t=>t.issues).find(i=>`issue:${i.url}`===id);return issue?link(issue.url,issue.title,''):escape(id);
  };
  return edges.length?`<ul class="relationship-list">${edges.map(e=>`<li>${nodeText(e.from)}<br><span class="mono">${escape(e.kind==='depends-on'?'required by':e.kind)} →</span> ${nodeText(e.to)}</li>`).join('')}</ul>`:'<p class="muted">No relationships recorded for this cottage.</p>';
}
function renderDrawer({force=false}={}) {
  const drawer=$('#drawer'),task=taskById(state.selected);
  drawer.hidden=!state.selected;
  $('.workspace').classList.toggle('has-drawer',Boolean(state.selected));
  if(!state.selected){drawerIdentity=null;return;}
  if(!task){drawer.innerHTML='<div class="drawer-head"><span class="eyebrow">EVIDENCE</span><button data-close-drawer aria-label="Close evidence">×</button></div><div class="drawer-content"><h2>This cottage is no longer in the current feed.</h2><p class="capability-note">Its draft is preserved locally in this page. Select a current cottage to continue.</p></div>';return;}
  const active=document.activeElement;
  const drawerFocus=focusedControl(drawer);
  const editing=active?.id==='reply-text';
  const start=editing?active.selectionStart:null,end=editing?active.selectionEnd:null;
  const oldScroll=drawer.scrollTop;
  const expanded=[...drawer.querySelectorAll('details[open]')].map(d=>d.dataset.detail);
  const same=drawerIdentity===task.id;
  const mark=stateMark(task),draft=state.drafts.get(task.id);
  // Keep the exact textarea node during an ordinary poll, preserving focus/IME/undo.
  const keepComposer=!force&&same&&editing&&!draft?.changed?drawer.querySelector('.composer'):null;
  if(keepComposer)keepComposer.remove();
  drawer.innerHTML=`<div class="drawer-head"><span class="eyebrow">COTTAGE / EVIDENCE</span><button data-close-drawer aria-label="Back to ${state.view}"><span class="back-label">Back</span>×</button></div><div class="drawer-content"><div class="identity"><h2>${escape(task.title)}</h2><div class="byline">${escape(task.project)} · ${escape(owner(task))}<br>${escape(task.model==='Unknown'?'Model unavailable':task.model)} · Source: ${escape(sourceName(task))}</div><div class="state-line"><span class="state-icon ${mark.tone}">${mark.symbol}</span><span>${escape(task.status)}</span>${task.quiet?`<span class="status">Quiet ${age(task.progressAgeMs)}</span>`:''}</div></div><section><h3>Latest public activity</h3><p class="activity-copy">${escape(short(task.activity || 'No public activity supplied.',700))}</p>${task.activity.length>700?`<details data-detail="activity"><summary>Read complete activity</summary><div class="full-text">${escape(task.activity)}</div></details>`:''}<dl class="data-grid"><div><dt>Task age</dt><dd>${age(task.taskAgeMs)}</dd></div><div><dt>Session age</dt><dd>${age(task.sessionAgeMs)}</dd></div>${Number.isFinite(task.recordedExecutionMs)?`<div><dt>Recorded execution</dt><dd>${age(task.recordedExecutionMs)}</dd></div>`:''}<div><dt>Observed</dt><dd>${task.observedAgeMs===null?'Unavailable':age(task.observedAgeMs)+' ago'}</dd></div><div><dt>Last explicit progress</dt><dd>${task.progressAgeMs===null?'Unavailable':age(task.progressAgeMs)+' ago'}</dd></div></dl><p class="input-source">Observed ${date(task.raw.updatedAt)}. Observation is not a progress signal.${task.quiet?' Quiet describes missing recent progress telemetry, not a stalled task.':''}</p></section><section class="input-section">${inputHTML(task)}</section><section id="delivery-evidence" tabindex="-1">${evidenceHTML(task)}</section><section><h3>Original request</h3><div class="full-text">${escape(short(task.raw.originalAsk || task.raw.request || 'The original request is unavailable.',500))}</div>${String(task.raw.originalAsk||task.raw.request||'').length>500?`<details data-detail="request"><summary>Read full request</summary><div class="full-text">${escape(task.raw.originalAsk||task.raw.request)}</div></details>`:''}${link(task.raw.url || task.raw.sourceUrl || task.raw.taskUrl,'Open original task')}<p class="input-source mono">Cottage: ${escape(task.id)}<br>Task: ${escape(task.raw.taskId || 'Unavailable')}</p></section><section><h3>Recorded relationships</h3>${relationshipsHTML(task)}</section>${task.events.length?`<section><h3>Public journal</h3>${task.events.slice(-8).map((event,i)=>`<details data-detail="event-${i}"><summary>${escape(event.kind)} · ${date(event.timestamp)}</summary><div class="full-text">${escape(event.text)}</div></details>`).join('')}</section>`:''}</div>`;
  if(keepComposer&&drawer.querySelector('.composer')) {
    drawer.querySelector('.composer').replaceWith(keepComposer);
    const receipt=receiptFor(task);keepComposer.querySelector('[data-send]').disabled=replyLocked(task,receipt)||!draftFor(task).text.trim();
  }
  if(same){for(const d of drawer.querySelectorAll('details'))if(expanded.includes(d.dataset.detail))d.open=true;drawer.scrollTop=oldScroll;}
  else drawer.scrollTop=0;
  drawerIdentity=task.id;
  if(!editing&&same)restoreControl(drawer,drawerFocus);
  if(editing&&same){const textarea=$('#reply-text');if(textarea&&!textarea.disabled){textarea.focus({preventScroll:true});if(start!==null)textarea.setSelectionRange(start,end);}}
}
function render() {renderChrome();renderScene();renderDrawer();}
function selectTask(id,{pr=false,focus=true}={}) {
  if(!taskById(id))return;
  returnFocus=document.activeElement;
  state.selected=id;state.threadTask=id;
  renderScene();renderDrawer();
  if(pr){$('#delivery-evidence')?.scrollIntoView({block:'nearest'});$('#delivery-evidence')?.focus({preventScroll:true});}
  else if(focus)$('#drawer [data-close-drawer]')?.focus({preventScroll:true});
}
function closeDrawer(){state.selected=null;renderScene();renderDrawer();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});else $('#canvas').focus({preventScroll:true});}
function setView(view){state.view=view;syncURL();render();}
function setProject(project){state.project=project;state.attentionIndex=0;render();}
function searchMatches() {
  const term=$('#search-input').value.trim().toLocaleLowerCase();
  return state.fleet.tasks.filter(task=>[task.title,task.project,task.id,task.raw.taskId,task.pr.number?`#${task.pr.number}`:'',task.pr.url].some(value=>String(value||'').toLocaleLowerCase().includes(term)));
}
function search() {
  const results=searchMatches().slice(0,60);
  searchIndex=Math.max(0,Math.min(searchIndex,results.length-1));
  $('#search-results').innerHTML=results.length?results.map((task,index)=>`<button class="search-result ${index===searchIndex?'active':''}" aria-current="${index===searchIndex}" data-search-select="${escape(task.id)}">${escape(task.title)}<small>${escape(task.project)} · ${escape(owner(task))}${task.pr.number?` · PR #${task.pr.number}`:''}</small></button>`).join(''):'<p class="empty">No cottages match this search.</p>';
}
function openSearch(){hidePreview();searchIndex=0;$('#search-dialog').showModal();search();$('#search-input').focus();}
async function poll(epoch=state.epoch) {
  if(state.scenario||epoch!==state.epoch)return;
  try {
    const response=await fetch(endpoint,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(`Source returned ${response.status}`);
    const snapshot=await response.json();
    if(!Array.isArray(snapshot)&&!Array.isArray(snapshot?.agents))throw new Error('Invalid feed');
    if(state.scenario||epoch!==state.epoch)return;
    state.snapshot=snapshot;state.stale=Boolean(snapshot.stale);state.error=state.stale?'The source reports a stale snapshot. Last observed work is retained.':'';state.loading=false;state.fetchedAt=Date.now();
  } catch {
    if(state.scenario||epoch!==state.epoch)return;
    state.stale=true;state.loading=false;state.error=state.snapshot?'Live feed unavailable. Showing the last observed snapshot; message sending is paused.':'Live feed unavailable. No illustrative work has been substituted.';
  }
  updateModel();render();
  if(!state.scenario&&epoch===state.epoch)pollTimer=setTimeout(()=>poll(epoch),5000);
}
function switchSource() {
  clearTimeout(pollTimer);state.epoch++;state.scenario=!state.scenario;
  state.snapshot=state.scenario?createScenario():null;state.selected=null;state.project='';state.stale=false;state.error='';state.loading=!state.scenario;state.order.clear();state.projectOrder.clear();state.attentionIndex=0;state.threadTask=null;
  syncURL();updateModel();render();if(!state.scenario)poll();
}
async function send() {
  const task=taskById(state.selected);if(!task)return;
  const draft=draftFor(task);if(draft.changed||version(task)!==draft.version||!draft.text.trim()||!task.capability.available||terminal(task)||replyLocked(task,receiptFor(task)))return;
  if(state.scenario){state.receipts.set(task.id,{phase:'sent',notice:'Local scenario response recorded. No agent was contacted; the source status is unchanged.'});renderDrawer({force:true});$('#announcer').textContent='Local scenario response recorded.';return;}
  const sending=replies.send(draft.raw,draft.text);
  renderDrawer({force:true});
  const receipt=await sending;
  renderDrawer({force:true});$('#announcer').textContent=receipt.notice;
}

document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.view)setView(button.dataset.view);
  else if(button.hasAttribute('data-project'))setProject(button.dataset.project);
  else if(button.dataset.lens){state.lens=button.dataset.lens;renderScene();}
  else if(button.dataset.filter){state.filter=button.dataset.filter;renderScene();}
  else if(button.dataset.select)selectTask(button.dataset.select);
  else if(button.dataset.pr)selectTask(button.dataset.pr,{pr:true});
  else if(button.dataset.searchSelect){$('#search-dialog').close();state.project='';state.filter='all';selectTask(button.dataset.searchSelect);renderChrome();renderHeading();}
  else if(button.hasAttribute('data-next-attention')){state.attentionIndex++;renderScene();}
  else if(button.hasAttribute('data-close-drawer'))closeDrawer();
  else if(button.hasAttribute('data-retry')){clearTimeout(pollTimer);state.epoch++;poll();}
  else if(button.hasAttribute('data-send'))send();
  else if(button.hasAttribute('data-review-draft')){const task=taskById(state.selected);const draft=draftFor(task);draft.raw=structuredClone(task.raw);draft.version=version(task);draft.changed=false;renderDrawer({force:true});}
  else if(button.hasAttribute('data-option')){const task=taskById(state.selected),options=task.input.questions.flatMap(q=>q.options||[]);const draft=draftFor(task);draft.text=options[Number(button.dataset.option)]?.label||'';renderDrawer({force:true});$('#reply-text')?.focus();}
});
$('#source-switch').addEventListener('click',switchSource);
$('#town-select').addEventListener('change',event=>setProject(event.target.value));
$('#search-open').addEventListener('click',openSearch);
$('#search-close').addEventListener('click',()=>$('#search-dialog').close());
$('#search-input').addEventListener('input',()=>{searchIndex=0;search();});
document.addEventListener('change',event=>{if(event.target.id==='trace-task'){state.threadTask=event.target.value;renderScene();}});
document.addEventListener('input',event=>{
  if(event.target.id==='reply-text'){const task=taskById(state.selected);if(!task)return;const draft=draftFor(task);draft.text=event.target.value;const button=$('[data-send]');if(button)button.disabled=draft.changed||!draft.text.trim()||replyLocked(task,receiptFor(task));}
});
document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$('#search-dialog').open)openSearch();return;}
  if(event.key==='Escape'){
    if($('#search-dialog').open){event.preventDefault();event.stopPropagation();$('#search-dialog').close();return;}
    hidePreview();if(state.selected){event.preventDefault();closeDrawer();}return;
  }
  if($('#search-dialog').open&&event.target.id==='search-input') {
    const results=searchMatches().slice(0,60);
    if(['ArrowDown','ArrowUp'].includes(event.key)&&results.length){event.preventDefault();searchIndex=(searchIndex+(event.key==='ArrowDown'?1:-1)+results.length)%results.length;search();$('#search-results .active')?.scrollIntoView({block:'nearest'});return;}
    if(event.key==='Enter'&&results.length){event.preventDefault();$('#search-results .active')?.click();return;}
  }
  if(event.target.closest('input,textarea,select,[contenteditable="true"]')||event.metaKey||event.ctrlKey||event.altKey||$('#search-dialog').open)return;
  if(['1','2','3'].includes(event.key)){event.preventDefault();setView(views[Number(event.key)-1]);}
  if(['j','k'].includes(event.key.toLowerCase())){const tasks=visibleTasks();if(!tasks.length)return;event.preventDefault();const i=tasks.findIndex(t=>t.id===state.selected),delta=event.key.toLowerCase()==='j'?1:-1;selectTask(tasks[i<0?(delta>0?0:tasks.length-1):(i+delta+tasks.length)%tasks.length].id);}
});
function hidePreview() {
  clearTimeout(previewTimer);
  $('#pr-preview').hidden=true;
  previewOwner?.removeAttribute('aria-describedby');previewOwner=null;
}
function showPreview(button) {
  const task=taskById(button.dataset.pr);if(!task)return;
  clearTimeout(previewTimer);
  if(previewOwner&&previewOwner!==button)previewOwner.removeAttribute('aria-describedby');
  previewOwner=button;button.setAttribute('aria-describedby','pr-preview');
  const preview=$('#pr-preview'),pr=task.pr;
  preview.innerHTML=`<div class="eyebrow">DELIVERY PREVIEW</div><strong>${pr.number?`PR #${pr.number}`:'PR evidence'} <span class="status ${escape(task.prStage)}">${escape(stage(task.prStage))}</span></strong><dl><dt>Authority</dt><dd>${escape(pr.authority||'Standalone observation')}</dd><dt>Verified</dt><dd>${date(pr.checkedAt)}</dd><dt>Checks</dt><dd>${task.ci.total?`${task.ci.passed}/${task.ci.total} passed · ${escape(task.ci.state)}`:'Unavailable'}</dd><dt>Head</dt><dd class="mono">${escape(short(pr.headSha||'Unavailable',28))}</dd></dl><p>${escape(short(pr.reason||'No reason supplied.',240))}</p><small>${state.scenario?'Illustrative evidence · ':''}Click or press Enter for full evidence.</small>`;
  preview.hidden=false;
  const rect=button.getBoundingClientRect(),width=preview.offsetWidth,height=preview.offsetHeight;
  preview.style.left=`${Math.max(10,Math.min(rect.left,innerWidth-width-10))}px`;
  preview.style.top=`${Math.max(10,rect.bottom+8+height<innerHeight?rect.bottom+8:rect.top-height-8)}px`;
}
document.addEventListener('focusin',event=>{const button=event.target.closest?.('[data-pr]');if(button)showPreview(button);else hidePreview();});
document.addEventListener('pointerover',event=>{const button=event.target.closest?.('[data-pr]');if(button)showPreview(button);else if(event.target.closest?.('#pr-preview'))clearTimeout(previewTimer);});
document.addEventListener('pointerout',event=>{
  if(event.target.closest?.('[data-pr],#pr-preview')&&!event.relatedTarget?.closest?.('[data-pr],#pr-preview'))previewTimer=setTimeout(()=>{if(!document.activeElement?.matches('[data-pr]'))hidePreview();},120);
});
document.addEventListener('scroll',hidePreview,{capture:true,passive:true});
let sceneWidth=0;
new ResizeObserver(entries=>{
  const width=entries[0].contentRect.width;
  if(Math.abs(width-sceneWidth)>1){sceneWidth=width;if(state.view==='threads'&&state.fleet.tasks.length)renderScene();}
}).observe($('#scene'));
window.addEventListener('storage',event=>{if(event.key?.startsWith('cottagecode:command-center:reply:'))renderDrawer({force:true});});
if(state.scenario){state.snapshot=createScenario();state.loading=false;updateModel();}
syncURL();render();if(!state.scenario)poll();
