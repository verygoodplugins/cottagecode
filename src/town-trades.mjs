/** World cues derived from bounded, observed facts. Never a task status authority. */
import {validTime} from './feed-client.mjs';
import {normalizeTown} from './world.mjs';
export const TOOL_WINDOW_MS=120000, ROAD_WINDOW_MS=180000, GROWTH_WINDOW_MS=600000;
const LIMIT=4096, EVENTS=512;
const reads=new Set(['read','read_file','read_files','readfile','glob','grep','rg','search','search_query','search_code','code_search','web_search','websearch','webfetch','read_resource','read_mcp_resource','recall_memory','fetch']);
const toolLeaf=name=>typeof name==='string'?name.split(/__|[./:]/).at(-1).toLowerCase():'';
const active=t=>t.status==='working'&&!t.quiet&&!t.sourceStale;
const resident=t=>t.raw?.inventoryScope==='dashboard'||(t.raw?.inventoryScope!=='history'&&t.raw?.occupancy!=='settled');
const recent=(at,now,window)=>Number.isFinite(at)&&at<=now&&now-at<window;
function remember(map,key,value){map.set(key,value);while(map.size>LIMIT)map.delete(map.keys().next().value);}
function linksOf(tasks,relationships=[],handoffs=[]){
  const aliases=new Map(),towns=new Set(tasks.map(t=>t.town)),links=new Map();
  for(const t of tasks)for(const id of [t.id,t.raw?.taskId].filter(Boolean)){
    const key=String(id);aliases.set(key,aliases.has(key)&&aliases.get(key)?.id!==t.id?null:t);
  }
  const resolve=id=>typeof id==='string'?aliases.get(id.replace(/^task:/,'')):null;
  const endpoint=id=>{const task=resolve(id),town=typeof id==='string'&&!id.startsWith('task:')?normalizeTown(id):null;return task?{id:task.id,town:task.town}:towns.has(town)?{id:null,town}:null;};
  function add(id,kind,from,to,stamp){
    const a=endpoint(from),b=endpoint(to);if(!a||!b||(a.id===b.id&&a.town===b.town))return;
    links.set(id,{id,kind,fromId:a.id,toId:b.id,fromTown:a.town,toTown:b.town,recordedAt:validTime(stamp)});
  }
  for(const t of tasks)if(t.parent&&resolve(t.parent))add(`parent:${t.parent}:${t.id}`,'parent',t.parent,t.id);
  for(const r of Array.isArray(relationships)?relationships:[]){
    if(typeof r?.from!=='string'||typeof r?.to!=='string')continue;
    const kind=typeof r.kind==='string'?r.kind:'relationship';
    add(`relationship:${r.id||`${r.from}:${r.to}:${kind}`}`,kind,r.from,r.to);
  }
  for(const h of Array.isArray(handoffs)?handoffs:[]){
    if(typeof h?.id!=='string'||typeof h?.from!=='string'||typeof h?.to!=='string')continue;
    add(`handoff:${h.id}`,'handoff',h.from,h.to,h.timestamp??h.at);
  }
  return links;
}
export function createTownTrades(){
  let sourceKey,initialized=false,arrivals=[],roadEvents=[];
  const seenResidents=new Map(),seenLinks=new Map();
  function reset(){sourceKey=undefined;initialized=false;arrivals=[];roadEvents=[];seenResidents.clear();seenLinks.clear();}
  function prune(now){arrivals=arrivals.filter(e=>recent(e.at,now,GROWTH_WINDOW_MS));roadEvents=roadEvents.filter(e=>recent(e.at,now,ROAD_WINDOW_MS));}
  function observeSnapshot({tasks=[],relationships=[],handoffs=[]}={},options={}){
    const {now=Date.now(),stale=false}=options;
    if(sourceKey!==undefined&&sourceKey!==options.sourceKey)reset();
    sourceKey=options.sourceKey;prune(now);if(stale)return;
    for(const t of tasks){
      if(!seenResidents.has(t.id)&&initialized&&resident(t)&&!t.sourceStale)arrivals.push({taskId:t.id,town:t.town,at:now});
      remember(seenResidents,t.id,now);
    }
    for(const [id,link] of linksOf(tasks,relationships,handoffs)){
      if(!seenLinks.has(id)&&initialized&&(link.kind!=='handoff'||recent(link.recordedAt,now,ROAD_WINDOW_MS)))roadEvents.push({...link,at:link.kind==='handoff'?link.recordedAt:now});
      remember(seenLinks,id,now);
    }
    arrivals=arrivals.slice(-EVENTS);roadEvents=roadEvents.slice(-EVENTS);initialized=true;
  }
  function snapshot({tasks=[],now=Date.now(),stale=false}={}){
    prune(now);const visible=tasks.filter(resident),ids=new Set(visible.map(t=>t.id)),towns=new Set(visible.map(t=>t.town));
    const miners=[],workshops=[],stories=[];let toolTasks=0,missingToolTasks=0;
    for(const t of visible){
      const tool=t.raw?.toolActivity,at=validTime(tool?.at),hasTool=tool&&typeof tool.name==='string'&&tool.name.trim().length>0&&['started','succeeded','failed','cancelled'].includes(tool.state)&&at!==null&&at<=now;
      if(hasTool)toolTasks++;else missingToolTasks++;
      if(stale||!active(t)||!hasTool||tool.stale||!recent(at,now,TOOL_WINDOW_MS)||!['started','succeeded'].includes(tool.state))continue;
      const gathering=reads.has(toolLeaf(tool.name)),role=gathering?'miner':'workshop';
      (gathering?miners:workshops).push({taskId:t.id,town:t.town,toolName:tool.name,state:'working',at});
      stories.push({id:`${role}:${t.id}`,role,taskId:t.id,town:t.town,title:`${gathering?'Gathering material':'Workshop activity'} · ${t.raw?.name||t.title}`,reason:`${tool.name} ${tool.state==='started'?'started':'succeeded'}. ${gathering?'A read or search tool':'Tool use'} was observed within the last two minutes; the task is recorded as working. ${gathering?'':'The tool name alone does not establish what work it performed. '}This does not assert that the tool is still running.`,at});
    }
    const roads=roadEvents.filter(r=>towns.has(r.toTown)||towns.has(r.fromTown)).filter(r=>(!r.toId||ids.has(r.toId))&&(!r.fromId||ids.has(r.fromId)));
    for(const r of roads)stories.push({id:r.id,role:'road',taskId:r.toId||r.fromId||null,town:r.toTown,fromTown:r.fromTown,toTown:r.toTown,fromId:r.fromId,toId:r.toId,title:`Laying a connection · ${r.toTown}`,reason:`${r.kind==='handoff'?'Recorded handoff':'Newly observed '+r.kind+' link'} from ${r.fromTown}${r.fromId?' / '+r.fromId:''} to ${r.toTown}${r.toId?' / '+r.toId:''}. Road work lasts three minutes on existing streets.`,at:r.at});
    const gardens=[...towns].map(town=>{
      const local=visible.filter(t=>t.town===town),newcomers=arrivals.filter(a=>a.town===town),count=newcomers.length;
      const g={town,arrivals:count,activeCount:stale?0:local.filter(active).length,growth:count>=3?'spurt':count?'growing':'settled',taskIds:newcomers.map(a=>a.taskId).filter(id=>ids.has(id))};
      stories.push({id:`garden:${town}`,role:'gardener',taskId:g.taskIds[0]||null,town,title:`${count>=3?'Growth spurt':count?'New seedlings':'A settled garden'} · ${town}`,reason:count?`${count} residents first observed here during the last ten minutes. Each seedling marks an arrival observed by this browser, not an inferred task creation. ${count>=3?'The gardener pauses beside a full bench.':'The gardener carries new pots.'}`:'No new residents observed here during the last ten minutes. The first snapshot is a baseline; a calm garden does not mean the tasks are idle.',at:newcomers.at(-1)?.at??null});
      return g;
    });
    return {miners,workshops,roads,gardens,stories,coverage:{toolTasks,missingToolTasks},stale};
  }
  return {observeSnapshot,snapshot,reset};
}
