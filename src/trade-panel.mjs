/** Small, escaped, evidence-only companions to the canvas trades. */
import {escapeHTML as e,townOf} from './command-render.mjs';
import {validTime} from './feed-client.mjs';
import {durationLabel} from './command-model.mjs';
const inTown=(story,town)=>!town||story.town===town||(story.role==='road'&&(story.fromTown===town||story.toTown===town));
const roles={miner:'Miner',workshop:'Workshop',road:'Roadmender',gardener:'Gardener'};
const recordedTime=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleString():String(at);};
export function scopedTrades(trades={},townFilter='') {
  const matches=s=>!townFilter||s.town===townFilter;
  return {miners:(trades.miners||[]).filter(matches),workshops:(trades.workshops||[]).filter(matches),roads:(trades.roads||[]).filter(s=>!townFilter||s.toTown===townFilter||s.fromTown===townFilter),gardens:(trades.gardens||[]).filter(matches),stories:(trades.stories||[]).filter(s=>inTown(s,townFilter))};
}
export function tradeStoryForSite(site,trades={},townFilter='') {
  if(!site||!roles[site.role]||(townFilter&&site.town!==townFilter))return null;
  const stories=scopedTrades(trades,townFilter).stories;
  const role=story=>story.role===site.role && inTown(story,site.town);
  const source=site.evidence;
  // Prefer exact recorded event identity; never manufacture a story from a prop.
  if(source?.id)return stories.find(s=>role(s)&&(s.id===source.id||s.id===`${site.role}:${source.id}`))||null;
  return stories.find(s=>role(s)&&(site.role==='gardener'||(site.taskId?[s.taskId,...(site.role==='road'?[s.fromId,s.toId]:[])].includes(site.taskId):!s.taskId)))||null;
}
export function toolEvidence(tasks,{townFilter='',now=Date.now(),stale=false}={}) {
  const result={recent:0,older:0,unreported:0,total:0,working:[]};
  for(const task of tasks.filter(task=>!townFilter||townOf(task)===townFilter)){
    const tool=task.raw?.toolActivity,at=validTime(tool?.at);
    const valid=tool&&typeof tool.name==='string'&&tool.name.trim()&&['started','succeeded','failed','cancelled'].includes(tool.state)&&at!==null&&at<=now;
    const ageMs=valid?now-at:null;
    const freshness=!valid?'unreported':stale||task.sourceStale||tool.stale||ageMs>=120000?'older':'recent';
    result[freshness]++;result.total++;
    if(task.status==='working')result.working.push({taskId:task.id,name:task.raw?.name||task.title||task.id,
      toolName:valid?tool.name:null,state:valid?tool.state:null,ageMs,freshness});
  }
  return result;
}
function toolRowsHTML(coverage){
  if(!coverage.working.length)return '';
  return `<section aria-label="Working cottage tool observations"><p class="cc-note">${coverage.working.length} recorded working · latest tool observations</p><div class="cc-trade-stories">${coverage.working.map(row=>`<button data-cc-inspect="${e(row.taskId)}" data-cc-key="tool-inspect:${e(row.taskId)}" title="Inspect ${e(row.name)}"><strong>${e(row.name)}</strong> · ${row.freshness==='unreported'?'tool unreported':`${e(row.toolName)} · ${e(row.state)} · ${e(durationLabel(row.ageMs))} ago${row.freshness==='older'?' · older/stale':''}`} ↗</button>`).join('')}</div></section>`;
}
export function tradePanelHTML({trades={},tasks=[],townFilter='',stale=false,illustrative=false,selectedId=null,canRehearseGrowth=true,now=Date.now()}={}) {
  const scope=scopedTrades(trades,townFilter),selected=scope.stories.find(s=>s.id===selectedId);
  const exactIds=selected?[selected.taskId,...(selected.role==='road'?[selected.toId,selected.fromId]:[])].filter(Boolean):[];
  const exactTask=exactIds.map(id=>tasks.find(t=>t.id===id&&(!townFilter||townOf(t)===townFilter))).find(Boolean);
  const arrivals=scope.gardens.reduce((sum,g)=>sum+(Number(g.arrivals)||0),0);
  const coverage=toolEvidence(tasks,{townFilter,now,stale});
  return `<summary>Village activity <span>${scope.miners.length} miners${scope.workshops.length?` · ${scope.workshops.length} workshops`:''} · ${scope.roads.length} road crews · ${arrivals} arrivals</span></summary><div class="cc-trade-body"><p class="cc-note">${e(townFilter||'All towns')} · ${illustrative?'Illustrative town · local demo':stale?'Source stale · last recorded evidence':'Recorded feed'}${illustrative&&stale?' · paused evidence':''}</p><p class="cc-note">Tool evidence · ${coverage.recent} recent (&lt;2m) · ${coverage.older} older/stale · ${coverage.unreported} unreported across ${coverage.total} cottages. Unreported does not mean idle.</p>${toolRowsHTML(coverage)}<div class="cc-trade-stories" role="group" aria-label="Inspect village activity">${scope.stories.map(s=>`<button data-cc-trade="${e(s.id)}" data-cc-key="trade:${e(s.id)}" aria-pressed="${s.id===selectedId}">${e(roles[s.role]||'Activity')} · ${e(s.title)}</button>`).join('')||'<span class="cc-note">No new recorded trade activity in this view.</span>'}</div>${selected?`<section class="cc-trade-story" aria-label="Recorded trade evidence"><strong>${e(selected.title)}</strong><p>${e(selected.reason)}</p>${selected.at?`<p class="cc-note">Recorded ${e(recordedTime(selected.at))}</p>`:''}${exactTask?`<button data-cc-inspect="${e(exactTask.id)}" data-cc-key="trade-inspect:${e(exactTask.id)}">Inspect cottage</button>`:''}<button data-cc-trade-close aria-label="Close trade evidence">Close evidence</button></section>`:''}${illustrative?`<button data-cc-rehearse-growth data-cc-key="rehearse-growth" ${canRehearseGrowth?'':'disabled'}>${canRehearseGrowth?'Rehearse growth':'Rehearsal complete · reload to reset'}</button>`:''}</div>`;
}
