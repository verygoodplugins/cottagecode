import {districtRoute} from './town-layout.mjs';

const compact = points => points.filter((p,i) => !i || p.x !== points[i-1].x || p.y !== points[i-1].y)
  .filter((p,i,all) => !i || i === all.length-1 ||
    !(all[i-1].x === p.x && p.x === all[i+1].x || all[i-1].y === p.y && p.y === all[i+1].y));

/** Paths describe recorded family links, never proximity or matching branches.
 * Yard turns go around the sign/workbench; longer links reuse the actual streets.
 */
export function parentPaths(plots, world, {houseHeight = 66, laneOffset = 5} = {}) {
  const endpoints = new Map(), blocks = new Map(world.blocks.map(b => [b.id,b]));
  const streetRoutes = new Map();
  for (const plot of plots) {
    for (const agent of [plot.agent,...(plot.agent.roommates || [])]) {
      endpoints.set(agent.id,{agent,plot,door:{x:plot.x+27,y:plot.y+houseHeight-2}});
    }
    for (const kid of plot.kids || []) {
      endpoints.set(kid.agent.id,{agent:kid.agent,plot,shed:true,door:{x:kid.x+11,y:kid.y+15}});
    }
  }
  const laneY = endpoint => endpoint.plot.y+houseHeight+laneOffset;
  // A shed opens south. Its apron joins the lane around the yard's west edge.
  const toLane = endpoint => endpoint.shed
    ? [endpoint.door,{x:endpoint.door.x,y:endpoint.door.y+2},
      {x:endpoint.plot.x-4,y:endpoint.door.y+2},
      {x:endpoint.plot.x-4,y:laneY(endpoint)}]
    : [endpoint.door,{x:endpoint.door.x,y:laneY(endpoint)}];
  const toStreet = (endpoint,block) => [...toLane(endpoint),
    {x:block.x+7,y:laneY(endpoint)},
    {x:block.x+7,y:block.y+block.h+(world.road || 48)/2},
    {x:block.x+block.w/2,y:block.y+block.h+(world.road || 48)/2}];
  const paths = [];
  for (const child of endpoints.values()) {
    const parent = endpoints.get(child.agent.parent);
    if (!parent || parent.agent.id === child.agent.id) continue;
    // Roommates use one doorway; a line inside their shared house says nothing.
    if (parent.plot === child.plot && !parent.shed && !child.shed) continue;
    let points;
    if (parent.plot === child.plot && parent.shed && child.shed && parent.door.y === child.door.y) {
      points = [parent.door,{x:parent.door.x,y:parent.door.y+2},
        {x:child.door.x,y:child.door.y+2},child.door];
    } else if (parent.plot.blockId === child.plot.blockId) {
      const from = toLane(parent), to = toLane(child);
      const a = from.at(-1), b = to.at(-1);
      if (a.y === b.y) points = [...from,...to.reverse()];
      else {
        const block = blocks.get(parent.plot.blockId);
        if (!block) continue;
        points = [...from,{x:block.x+7,y:a.y},{x:block.x+7,y:b.y},...to.reverse()];
      }
    } else {
      const from = blocks.get(parent.plot.blockId), to = blocks.get(child.plot.blockId);
      if (!from || !to) continue;
      const key = from.id+'\0'+to.id;
      if (!streetRoutes.has(key)) streetRoutes.set(key,districtRoute(world,from,to));
      const street = streetRoutes.get(key);
      if (!street.length) continue;
      points = [...toStreet(parent,from),...street,...toStreet(child,to).reverse()];
    }
    paths.push({parent:parent.agent,child:child.agent,parentHost:parent.plot.agent.id,
      childHost:child.plot.agent.id,kind:child.shed && parent.plot === child.plot ? 'yard' : 'street',
      points:compact(points)});
  }
  return paths;
}
