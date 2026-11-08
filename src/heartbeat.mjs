/** Decorative street life. Only explicit, newly observed PR outcomes produce carts. */
import { parsePrUrl } from './pr.mjs';
const TTL = 20, MAX_SEEN = 256, MAX_CARTS = 16;
const town = t => t?.raw?.town || t?.town || '';
const active = t => t?.status === 'working' && !t.quiet && !t.sourceStale;
const clock = () => globalThis.performance.now() / 1000;
function identity(event) {
  const parsed = parsePrUrl(event.url);
  const key = parsed ? `${parsed.host}/${parsed.repo.toLowerCase()}#${parsed.number}` : String(event.prKey || '').toLowerCase();
  const match = key.match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/);
  return match ? { key, number: Number(match[4]) } : null;
}
function rect(ctx, color, x, y, w, h) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
export function createHeartbeat() {
  let sourceKey, shipments = [];
  const seen = new Map();
  function reset() { seen.clear(); shipments = []; sourceKey = undefined; }
  function prune(now) { shipments = shipments.filter(s => now - s.started < TTL); }
  function observe(events = [], options = {}) {
    const now = Number.isFinite(options.now) ? options.now : clock();
    if (options.sourceChanged || (sourceKey !== undefined && sourceKey !== options.sourceKey)) { reset(); }
    sourceKey = options.sourceKey; prune(now);
    for (const event of events) {
      if (event?.kind !== 'pr') continue;
      const outcome = /^PR · (merged|closed)$/.exec(event.text || '')?.[1], pr = identity(event);
      if (!outcome || !pr || seen.has(pr.key)) continue;
      seen.set(pr.key, now);
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
      shipments.push({ ...pr, outcome, town: event.town || '', agentIds: [...new Set([event.agentId, ...(event.agentIds || [])].filter(Boolean))], started: now });
      if (shipments.length > MAX_CARTS) shipments.shift();
    }
  }
  function drawGround(ctx, { plots = [], tasks = [], time = 0, reduce = false, stale = false, townFilter = '' } = {}) {
    ctx.save();
    for (const p of plots) {
      const residents = [p.agent, ...(p.agent?.roommates || []), ...(p.kids || []).map(k=>k.agent)].filter(Boolean);
      const members = tasks.filter(t=>residents.some(a=>a.id===t.id));
      if (townFilter && town(p.agent) !== townFilter) continue;
      const y = p.y + 67;
      if (members.some(t=>t.attention)) {
        rect(ctx,'#584c44',p.x+5,y-9,2,10); rect(ctx,'#8d7351',p.x+3,y-10,6,5); rect(ctx,'#ffd98b',p.x+4,y-9,4,3);
      }
      if (!members.some(active)) continue;
      const phase = reduce || stale ? 0 : Math.floor(time * 5) % 12;
      for (let i=0;i<3;i++) rect(ctx, stale?'#7b8270':i===1?'#d8bb76':'#8da76c', p.x+11+i*12+phase,y,4,1);
    }
    ctx.restore();
  }
  function drawLife(ctx, { districts = [], plots = [], tasks = [], time = 0, reduce = false, stale = false, townFilter = '' } = {}) {
    prune(time); ctx.save();
    for (const s of shipments) {
      const p = plots.find(p=>[p.agent,...(p.agent?.roommates||[]),...(p.kids||[]).map(k=>k.agent)].some(a=>a&&(s.agentIds.includes(a.id)||(a.prKey&&a.prKey===s.key))));
      if (!p || (townFilter && town(p.agent)!==townFilter)) continue;
      // The whole route is on this cottage's existing front lane.
      const progress = reduce || stale ? .5 : Math.max(0,Math.min(1,(time-s.started)/TTL));
      const routeProgress = s.outcome === 'closed' ? 1-progress : progress;
      const x = p.x+8+routeProgress*30, y=p.y+67;
      rect(ctx,'#4b4546',x+2,y+4,3,3); rect(ctx,'#4b4546',x+12,y+4,3,3);
      rect(ctx,'#a28a63',x,y,17,4); rect(ctx,'#6d5a49',x+17,y+1,5,1);
      if(s.outcome==='merged') { rect(ctx,'#c6a77a',x+4,y-7,9,7); rect(ctx,'#f0d29a',x+8,y-7,1,7); }
      if (ctx.fillText) { ctx.fillStyle='#f1dfb0'; ctx.font='7px monospace'; ctx.textAlign='center'; ctx.fillText(`#${s.number}`,Math.round(x+8),y-10); }
    }
    ctx.restore();
  }
  return { observe, reset, drawGround, drawLife, get state() { return { sourceKey, seenCount:seen.size, shipments:shipments.map(s=>({...s,agentIds:[...s.agentIds]})) }; } };
}
