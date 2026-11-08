/** Read-only command surfaces. Every source string passes through escapeHTML. */
import {durationLabel, safeUrl} from './command-model.mjs';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const e=escapeHTML;
export const townOf=task=>task.raw.town||task.raw.role||'WildTown';
export const ownerOf=task=>typeof task.raw.owner==='string'&&task.raw.owner.trim()?task.raw.owner:task.harness;
export const stageLabel=stage=>({'none':'No PR recorded','unknown':'PR unavailable','waiting-codex':'Awaiting review','waiting-ci':'Awaiting CI','active':'Review active','ready':'Ready','blocked':'Blocked','merged':'Merged','closed':'Closed','open':'Open'}[stage]||'PR unavailable');
export const isAnswerable=task=>Boolean(task.input&&task.capability.available&&task.capability.mode==='respond');
export function attentionQueue(tasks){return tasks.filter(task=>task.attention).sort((a,b)=>Number(isAnswerable(b))-Number(isAnswerable(a))||Number(Boolean(b.input))-Number(Boolean(a.input)));}
export function filteredTasks(tasks,filter){return tasks.filter(task=>filter==='all'||(filter==='attention'?task.attention:filter==='working'?task.status==='working':filter==='quiet'?task.quiet:filter==='ready'?task.prStage==='ready':true));}
export function searchTasks(tasks,query){const words=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);return tasks.filter(task=>words.every(word=>[task.title,task.raw.name,task.activity,task.id,task.town,task.project,ownerOf(task),task.model,task.pr.number,task.input?.prompt,...task.issues.flatMap(issue=>[issue.title,issue.number,issue.url])].join(' ').toLocaleLowerCase().includes(word))).slice(0,30);}
export function graphData(tasks,fleet){
  const nodes=new Map();
  for(const task of tasks){
    nodes.set(`task:${task.id}`,{id:`task:${task.id}`,kind:'task',task,title:task.title,caption:`${ownerOf(task)} · ${task.status}`});
    for(const issue of task.issues)if(safeUrl(issue.url))nodes.set(`issue:${issue.url}`,{id:`issue:${issue.url}`,kind:'issue',issue,task,title:issue.title,caption:issue.number?`Issue #${issue.number}`:'Recorded issue'});
    if(task.prKey){const group=fleet.prs.find(pr=>pr.key===task.prKey);nodes.set(`pr:${task.prKey}`,{id:`pr:${task.prKey}`,kind:'pr',task,group,title:group?.pr.title||`Pull request #${task.pr.number}`,caption:`${stageLabel(group?.stage||task.prStage)}${group?.taskIds.length>1?` · ${group.taskIds.length} cottages`:''}`});}
  }
  return {nodes,edges:fleet.edges.filter(edge=>nodes.has(edge.from)&&nodes.has(edge.to))};
}
function prButton(task){return `<button class="cc-pr cc-tone-${e(task.prStage)}" data-cc-pr="${e(task.id)}" data-cc-key="pr:${e(task.id)}" aria-label="Review ${e(task.pr.number?`PR #${task.pr.number}`:'PR evidence')} for ${e(task.title)}">${task.pr.number?`#${e(task.pr.number)} · `:''}${e(stageLabel(task.prStage))}</button>`;}
const clock=(label,ms,suffix='')=>`<span><small>${label}</small> ${e(durationLabel(ms))}${ms===null?'':suffix}</span>`;
export function dispatchHTML(tasks,{filter='all',selectedId=null,counts={}}={}){
  const rows=filteredTasks(tasks,filter);
  return `<div class="cc-filter-row" aria-label="Dispatch filters">${[['all','All',counts.tasks],['attention','Attention',counts.attention],['working','Working',counts.working],['quiet','Quiet',counts.quiet],['ready','Ready PRs',counts.ready]].map(([id,label,count])=>`<button data-cc-filter="${id}" data-cc-key="filter:${id}" aria-pressed="${filter===id}">${label} <span>${count??0}</span></button>`).join('')}</div><p class="cc-note">${filter==='quiet'?'Quiet means no explicit progress for at least 15 minutes; execution can still be working.':'Task age includes waits. Execution, session and progress are separate clocks. Shared PRs count once.'}</p><div class="cc-ledger-head" aria-hidden="true"><span>Work / public activity</span><span>Owner / execution</span><span>Independent clocks</span><span>Delivery</span></div><div class="cc-ledger">${rows.map(task=>`<article class="cc-row ${task.id===selectedId?'cc-selected':''}" data-cc-row="${e(task.id)}"><div class="cc-work"><span class="cc-status cc-status-${e(task.status)}" title="${e(task.status)}" aria-hidden="true">${task.input?'✉':task.status==='working'?'●':task.status==='blocked'?'!':'◇'}</span><div><button class="cc-title" data-cc-inspect="${e(task.id)}" data-cc-key="task:${e(task.id)}">${e(task.title)}</button><p>${e(task.activity||'Public activity unavailable.')}</p>${task.input?`<p class="cc-input-excerpt">${e(task.input.prompt.slice(0,240))}</p>`:''}</div></div><div class="cc-owner"><strong>${e(ownerOf(task))}</strong><span>${e(task.model==='Unknown'?'Model unavailable':task.model)}</span><small>${e(townOf(task))} · ${e(task.status)}${task.quiet?' · quiet':''}</small></div><div class="cc-clocks">${clock('Task',task.taskAgeMs)}${clock('Execution',task.recordedExecutionMs)}${clock('Session',task.sessionAgeMs)}${clock('Progress',task.progressAgeMs,' ago')}${clock('Observed',task.observedAgeMs,' ago')}</div><div class="cc-delivery">${prButton(task)}${task.pr.reason?`<small>${e(task.pr.reason.slice(0,140))}</small>`:''}</div></article>`).join('')||'<p class="cc-empty">No cottages match this filter in the current town.</p>'}</div>`;
}
function nodeHTML(node,{style='',selected=false,key='graph'}={}){
  const attributes=`class="cc-node cc-node-${node.kind} ${selected?'cc-selected':''}"${style?` style="${style}"`:''}`;
  const content=`<small>${e(node.kind==='task'?townOf(node.task):node.kind==='pr'?`PR #${node.task.pr.number}`:node.caption)}</small><strong>${e(node.title)}</strong><span>${e(node.caption)}</span>`;
  if(node.kind==='issue'&&!node.task.raw.illustrative)return `<a ${attributes} data-cc-key="${key}:${e(node.id)}" href="${e(safeUrl(node.issue.url))}" target="_blank" rel="noopener noreferrer">${content}</a>`;
  return `<button ${attributes} data-cc-${node.kind==='pr'?'pr':'inspect'}="${e(node.task.id)}" data-cc-key="${key}:${e(node.id)}">${content}</button>`;
}
const relationLabel=kind=>kind==='depends-on'?'prerequisite → dependent':kind==='parent'?'parent → child':kind==='implements'?'issue → work':kind==='produces'?'work → PR':kind;
export function threadsHTML(tasks,fleet,{selectedId=null,width=900}={}){
  const {nodes,edges}=graphData(tasks,fleet),active=tasks.find(task=>task.id===selectedId)||tasks[0];
  if(!active)return '<p class="cc-empty">No cottages in the current town. Choose another town to follow its recorded work.</p>';
  const selectedKey=`task:${active.id}`,prKey=active.prKey?`pr:${active.prKey}`:null;
  const direct=edges.filter(edge=>edge.from===selectedKey||edge.to===selectedKey||(prKey&&(edge.from===prKey||edge.to===prKey)));
  const connected=new Set([selectedKey,...direct.flatMap(edge=>[edge.from,edge.to])]);
  const trace=`<section class="cc-trace" aria-label="Selected cottage trace"><label for="cc-trace-task">Follow a cottage</label><select id="cc-trace-task" data-cc-trace data-cc-key="trace-select">${tasks.map(task=>`<option value="${e(task.id)}" ${task.id===active.id?'selected':''}>${e(townOf(task)+' · '+task.title)}</option>`).join('')}</select>${nodeHTML(nodes.get(selectedKey),{selected:true,key:'trace-selected'})}${direct.length?direct.map((edge,index)=>`<div class="cc-trace-edge"><span class="cc-relation">${e(relationLabel(edge.kind))}</span>${nodeHTML(nodes.get(edge.from),{key:`trace-from-${index}`})}<span class="cc-arrow" aria-hidden="true">↓</span>${nodeHTML(nodes.get(edge.to),{key:`trace-to-${index}`})}</div>`).join(''):'<p class="cc-note">No issue, parent, dependency or PR relationships recorded for this cottage.</p>'}</section>`;
  const intro=`<div class="cc-thread-intro"><span>Recorded relationships</span><span>${edges.length} paths · ${[...nodes.values()].filter(node=>node.kind==='pr').length} distinct PRs</span></div>${![...nodes.values()].some(node=>node.kind==='issue')?'<p class="cc-note">Issue links are not recorded in this feed. Known parent, dependency and PR links appear below.</p>':''}`;
  if(width<700||nodes.size>36)return intro+`<p class="cc-note">Following one cottage keeps its recorded path readable here.</p>`+trace;
  const columns={issue:[],task:[],pr:[]},positions=new Map();for(const node of nodes.values())columns[node.kind].push(node);
  const lanes=['issue','task','pr'].filter(kind=>columns[kind].length);
  const laneWidth=(96-6*(lanes.length-1))/lanes.length;
  const laneLeft=index=>1+index*(laneWidth+6);
  lanes.forEach((kind,lane)=>columns[kind].forEach((node,index)=>positions.set(node.id,{x:laneLeft(lane),y:20+index*128,w:laneWidth})));
  const height=Math.max(240,...[...positions.values()].map(point=>point.y+120));
  const paths=edges.map(edge=>{
    const from=positions.get(edge.from),to=positions.get(edge.to),same=from.x===to.x;
    const x1=(from.x+from.w)*width/100,x2=(same?to.x+to.w:to.x)*width/100,y1=from.y+42,y2=to.y+42;
    const bend=same?x1+24:(x1+x2)/2;
    return `<path d="M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}" class="${connected.has(edge.from)&&connected.has(edge.to)?'cc-connected':''}" marker-end="url(#cc-thread-arrow)"><title>${e(nodes.get(edge.from).title+' — '+relationLabel(edge.kind)+' — '+nodes.get(edge.to).title)}</title></path>`;
  }).join('');
  return intro+`<div class="cc-graph-head" aria-hidden="true">${lanes.map((kind,index)=>`<span style="left:${laneLeft(index)}%;width:${laneWidth}%">${{issue:'Issues',task:'Cottages',pr:'Pull requests'}[kind]}</span>`).join('')}</div><div class="cc-graph" style="height:${height}px"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="cc-thread-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6Z"/></marker></defs>${paths}</svg>${[...nodes.values()].map(node=>{const point=positions.get(node.id);return nodeHTML(node,{style:`left:${point.x}%;top:${point.y}px;width:${point.w}%`,selected:connected.has(node.id)});}).join('')}</div><details class="cc-trace-details"><summary>Selected cottage · readable path</summary>${trace}</details>`;
}
export function previewHTML(task){
  return `<strong>${e(task.pr.number?`PR #${task.pr.number}`:'PR evidence')} · ${e(stageLabel(task.prStage))}</strong><span>${e(task.pr.title||task.title)}</span><p>${e(task.pr.reason||'No additional review reason recorded.')}</p><small>CI ${e(task.ci.state)}${task.ci.total?` · ${task.ci.passed}/${task.ci.total} checks passed`:''} · ${e(task.pr.authority==='hub'?'Hub authority':'Source observation')}</small><small>${task.pr.checkedAt?`Verified ${e(new Date(task.pr.checkedAt).toLocaleString())}`:'Verification time unavailable'}</small>${task.sourceStale?'<small>Source is stale; canonical Hub evidence is retained.</small>':''}`;
}
