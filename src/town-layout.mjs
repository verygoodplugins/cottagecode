/** The old two-district width remains the reference for 100% cottage scale. */
export const MAP_REFERENCE_WIDTH = 768;

/** Choose a packing budget once, including space for fullscreen Details. */
export function townWidthBudget({windowWidth, standardWidth}) {
  const scale = Math.max(1, standardWidth) / MAP_REFERENCE_WIDTH;
  const clearWidth = windowWidth - (windowWidth > 600 ? 364 : 24);
  return Math.round(Math.max(MAP_REFERENCE_WIDTH, Math.min(1920, clearWidth / scale)));
}

const townOf = agent => agent.town || agent.role || 'WildTown';
const keyOf = agent => agent.plotKey || agent.id;
const textOrder = (a, b) => String(a).localeCompare(String(b), 'en');
const branchRank = a => !a.branch ? 2 : a.defaultBranch && a.branch === a.defaultBranch ? 0 : 1;
function branchOrder(a, b) {
  return textOrder(a.repo || '', b.repo || '') || branchRank(a) - branchRank(b) ||
    textOrder(a.branch || '', b.branch || '') || textOrder(keyOf(a), keyOf(b));
}

/** Stable rectangles: only unallocated cottages participate in packing. */
export function createTownLayout(options = {}, seed = null) {
  const {columns = 4, rows = 2, houseWidth = 54, houseHeight = 66, gapX = 26, gapY = 70,
    margin = 30, road = 48, pad = 18, signHeight = 48, maxWidth = MAP_REFERENCE_WIDTH} = options;
  const slots = new Map(seed?.slots), blocks = (seed?.blocks || []).map(b => ({...b}));
  const childSlots = new Map(seed?.childSlots), parentCounts = new Map(seed?.parentCounts);
  const byTown = new Map();
  for (const block of blocks) {
    if (!byTown.has(block.key)) byTown.set(block.key, []);
    byTown.get(block.key).push(block);
  }
  // Leave room beside the spine for the noticeboard square, including its benches.
  const roadX = margin + 36, startX = roadX + road;
  const districtWidth = columns * (houseWidth + gapX) - gapX + pad * 2;
  const limit = Math.max(startX + districtWidth + road + margin, maxWidth);

  function place(w, h, home) {
    const xs = [...new Set([startX, ...blocks.map(b => b.x + b.w + road)])];
    let best = null;
    for (const x of xs) {
      if (x + w + road + margin > limit) continue;
      let y = margin;
      const across = blocks.filter(b => x < b.x + b.w + road && x + w + road > b.x).sort((a,b) => a.y-b.y);
      for (const b of across) {
        if (y + h + road <= b.y) break;
        y = Math.max(y, b.y + b.h + road);
      }
      const distance = home ? Math.abs(x-home.x) + Math.abs(y-home.y) : x;
      if (!best || y < best.y || y === best.y && distance < best.distance) best = {x,y,distance};
    }
    return {x:best.x,y:best.y};
  }

  function newBlock(town, count) {
    const pages = byTown.get(town) || [];
    // At least two lots, and enough frontage for the sign and Jack's home.
    const minColumns = Math.min(columns, town === 'HubTown' ? 3 : 2);
    const cols = Math.max(minColumns, Math.min(columns, count));
    const rowCount = Math.max(1, Math.min(rows, Math.ceil(count / cols)));
    const w = cols * (houseWidth + gapX) - gapX + pad * 2;
    const h = signHeight + rowCount * (houseHeight + gapY) + pad * 2;
    const block = {key:town,id:town+':'+pages.length,page:pages.length,used:0,
      ...place(w,h,pages[0]),w,h,columns:cols,rows:rowCount,capacity:cols*rowCount};
    pages.push(block);byTown.set(town,pages);blocks.push(block);
    return block;
  }

  return {
    update(agents, {trimEmptyBlocks = false} = {}) {
      const ids = new Set(agents.map(a => a.id));
      for (const a of agents) {
        if (a.parent && !childSlots.has(a.id)) {
          const n = parentCounts.get(a.parent) || 0;
          childSlots.set(a.id,n);parentCounts.set(a.parent,n+1);
        }
      }
      const roots = agents.filter(a => !a.parent || !ids.has(a.parent) || childSlots.get(a.id) >= 3 || slots.has(keyOf(a)) || slots.has(a.id));
      const arrivals = new Map();
      for (const a of roots) if (!slots.has(keyOf(a))) {
        const town = townOf(a);
        if (!arrivals.has(town)) arrivals.set(town, []);
        arrivals.get(town).push(a);
      }
      const activity = townActivity(agents);
      const towns = [...arrivals.keys()].sort((a,b) =>
        Number(b === 'HubTown') - Number(a === 'HubTown') ||
        (activity.get(b)?.active || 0) - (activity.get(a)?.active || 0) ||
        arrivals.get(b).length - arrivals.get(a).length || textOrder(a,b));
      for (const town of towns) {
        const incoming = arrivals.get(town).sort(branchOrder);
        for (let i = 0; i < incoming.length; i++) {
          const a = incoming[i];
          // A duplicate identity in a snapshot must not consume a second plot.
          if (slots.has(keyOf(a))) continue;
          const block = (byTown.get(town) || []).find(b => b.used < b.capacity) || newBlock(town,incoming.length-i);
          const n = block.used++;
          slots.set(keyOf(a), {x:block.x+pad+(n%block.columns)*(houseWidth+gapX),
            y:block.y+pad+signHeight+Math.floor(n/block.columns)*(houseHeight+gapY),blockId:block.id});
        }
      }
      const plots = roots.map(agent => ({...slots.get(keyOf(agent)),agent}));
      const occupied = new Set(plots.map(p => p.blockId));
      const shown = trimEmptyBlocks ? blocks.filter(b => occupied.has(b.id)) : blocks;
      const width = Math.max(startX+districtWidth,...shown.map(b => b.x+b.w)) + road + margin;
      // The first courtyard anchors the square even after its residents depart.
      const squareY = (blocks[0] ? blocks[0].y+blocks[0].h : margin+signHeight+houseHeight+gapY+pad*2)+road/2;
      const height = Math.max(squareY-road/2,margin+signHeight+houseHeight+gapY+pad*2,...shown.map(b => b.y+b.h)) + margin;
      // Retired blocks retain their roads while other towns still use them.
      const roads = [{x:roadX,y:0,w:road,h:height+112}];
      for (const b of blocks) {
        if (b.y >= height || b.x >= width) continue;
        roads.push({x:b.x-road,y:Math.max(0,b.y-road),w:road,h:b.h+road+Math.min(road,b.y)});
        roads.push({x:b.x+b.w,y:Math.max(0,b.y-road),w:road,h:b.h+road+Math.min(road,b.y)});
        roads.push({x:b.x-road,y:b.y+b.h,w:b.w+road*2,h:road});
      }
      return {plots,blocks:shown.map(b => ({...b})),shedSlots:Object.fromEntries(childSlots),width,height,
        districtWidth,columns,roadX,roadYs:[...new Set(shown.map(b => b.y+b.h))].sort((a,b) => a-b),roads,road,
        square:{x:roadX+road/2,y:squareY}};
    },
    fork() { return createTownLayout(options,{slots,blocks,childSlots,parentCounts}); },
    reset() { slots.clear();blocks.length=0;byTown.clear();childSlots.clear();parentCounts.clear(); },
  };
}

export function townActivity(agents) {
  const result = new Map(), seen = new Set();
  for (const host of agents) for (const a of [host,...(host.roommates || [])]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const town = townOf(a), count = result.get(town) || {working:0,blocked:0,total:0,active:0};
    count.total++;
    if (a.status === 'working') count.working++;
    if (a.status === 'blocked') count.blocked++;
    count.active = count.working + count.blocked;
    result.set(town,count);
  }
  return result;
}

/** Overview includes the cottage yard when a roommate or shed resident is active. */
export function overviewBounds(plots) {
  const active = plots.filter(p => [p.agent,...(p.agent.roommates || []),...(p.kids || []).map(k => k.agent)]
    .some(a => a.status === 'working' || a.status === 'blocked'));
  const included = active.length ? active : plots;
  if (!included.length) return null;
  const x = Math.min(...included.map(p => p.x))-16, y = Math.min(...included.map(p => p.y))-28;
  return {x,y,w:Math.max(...included.map(p => p.x+72))-x,h:Math.max(...included.map(p => p.y+142))-y};
}

/** Orthogonal routes on actual streets, used only for explicit relationships. */
export function districtRoute(world, from, to) {
  if (!from || !to) return [];
  const road = world.road || 48;
  const start = {x:from.x+from.w/2,y:from.y+from.h+road/2};
  const end = {x:to.x+to.w/2,y:to.y+to.h+road/2};
  const lines = world.roads.map(r => r.w === road
    ? {x1:r.x+road/2,y1:r.y,x2:r.x+road/2,y2:r.y+r.h}
    : {x1:r.x,y1:r.y+road/2,x2:r.x+r.w,y2:r.y+road/2});
  const nodes = new Map(), edges = new Map();
  const key = p => p.x+','+p.y;
  const add = p => {const id=key(p);nodes.set(id,p);if(!edges.has(id))edges.set(id,new Map());return id;};
  const on = (p,l) => p.x>=l.x1 && p.x<=l.x2 && p.y>=l.y1 && p.y<=l.y2;
  add(start);add(end);
  for (const l of lines) {add({x:l.x1,y:l.y1});add({x:l.x2,y:l.y2});}
  for (const a of lines) for (const b of lines) {
    if (a.x1 !== a.x2 || b.y1 !== b.y2) continue;
    const p={x:a.x1,y:b.y1};if(on(p,a)&&on(p,b))add(p);
  }
  for (const l of lines) {
    const points=[...nodes].filter(([,p])=>on(p,l)).sort(([,a],[,b])=>a.x-b.x||a.y-b.y);
    for (let i=1;i<points.length;i++) {
      const [a,p]=points[i-1],[b,q]=points[i],distance=Math.abs(p.x-q.x)+Math.abs(p.y-q.y);
      edges.get(a).set(b,distance);edges.get(b).set(a,distance);
    }
  }
  const first=key(start),last=key(end),cost=new Map([[first,0]]),previous=new Map(),pending=new Set(nodes.keys());
  while(pending.size) {
    const next=[...pending].reduce((best,id)=>(cost.get(id)??Infinity)<(cost.get(best)??Infinity)?id:best,null);
    if(next===null)break;
    pending.delete(next);if(next===last)break;
    for(const [id,distance] of edges.get(next))if((cost.get(next)+distance)<(cost.get(id)??Infinity)) {
      cost.set(id,cost.get(next)+distance);previous.set(id,next);
    }
  }
  if(!cost.has(last))return [];
  const path=[];let cursor=last;
  while(cursor){path.unshift(nodes.get(cursor));cursor=previous.get(cursor);}
  return path.filter((p,i)=>!i||i===path.length-1||!(path[i-1].x===p.x&&p.x===path[i+1].x||path[i-1].y===p.y&&p.y===path[i+1].y));
}
