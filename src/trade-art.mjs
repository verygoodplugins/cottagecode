/** Evidence-backed trades, painted only on the supplied visible town geometry. */
const townOf = a => a?.town || a?.raw?.town || '';
const finiteRect = r => r && ['x','y','w','h'].every(k => Number.isFinite(r[k])) && r.w > 0 && r.h > 0;
const contains = (a,b) => b.x >= a.x && b.y >= a.y && b.x+b.w <= a.x+a.w && b.y+b.h <= a.y+a.h;
const overlaps = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
function household(plots,id,town) {
  if (!id) return;
  return plots.find(p => (!town || townOf(p.agent) === town) &&
    [p.agent,...(p.agent?.roommates || []),...(p.kids || []).map(k=>k.agent)].some(a=>a?.id===id));
}
function districtFor(districts,p,town) {
  return districts.find(d=>d.key===town && contains(d,{x:p.x,y:p.y,w:p.w||54,h:p.h||66}));
}
/** Shared geometry for painting and evidence hit-testing. No input is mutated. */
export function tradeSites({trades={},plots=[],districts=[],roads=[],townFilter=''}={}) {
  const sites=[], yardPlots=new Set(), allowed = town => !townFilter || town===townFilter;
  const visibleDistricts=districts.filter(finiteRect);
  for (const [role,work] of [['miner',trades.miners],['workshop',trades.workshops]]) for (const m of work || []) {
    if (!allowed(m.town)) continue;
    const p=household(plots,m.taskId,m.town);
    if (!p || yardPlots.has(p)) continue;
    const d=districtFor(visibleDistricts,p,m.town);
    if (!d) continue;
    // Try either side of this exact household. The last column has no right
    // margin, but its left yard can still fit without covering the front lane.
    const candidates=[p.x+(p.w||54)+2,p.x-25].map(x=>({x,y:p.y+(p.h||66)-25,w:23,h:24}));
    const box=candidates.find(b=>contains(d,b) && !sites.some(s=>overlaps(s,b)) &&
      !plots.some(q=>overlaps(b,{x:q.x,y:q.y,w:q.w||54,h:(q.h||66)+24}) ||
        (q.kids||[]).some(k=>overlaps(b,{x:k.x,y:k.y,w:16,h:18}))));
    if (!box) continue;
    yardPlots.add(p);
    sites.push({...box,role,taskId:m.taskId,town:m.town,evidence:m,clip:d});
  }
  for (const work of trades.roads || []) {
    // Prefer the recorded destination. Never substitute an unrelated cottage.
    const endpoints=[[work.toId,work.toTown],[work.fromId,work.fromTown]];
    let p,town,taskId=null,d;
    for (const [id,t] of endpoints) {
      if (!t || !allowed(t)) continue;
      if (id) {
        p=household(plots,id,t);
        d=p && districtFor(visibleDistricts,p,t);
      } else {
        p=null;
        d=visibleDistricts.find(candidate=>candidate.key===t && plots.some(plot=>
          townOf(plot.agent)===t && contains(candidate,{x:plot.x,y:plot.y,w:plot.w||54,h:plot.h||66})));
      }
      if (d) { town=t;taskId=id || null;break; }
    }
    if (!d) continue;
    const cx=p?p.x+(p.w||54)/2:d.x+d.w/2, cy=p?p.y+(p.h||66)+5:d.y+d.h/2;
    const candidates=roads.filter(r=>finiteRect(r) && r.w>=28 && r.h>=22 &&
      // Only a street in or immediately beside this recorded district belongs.
      overlaps(r,{x:d.x-16,y:d.y-16,w:d.w+32,h:d.h+32})).map(r=>{
      const x=clamp(cx-14,r.x,r.x+r.w-28), y=clamp(cy-11,r.y,r.y+r.h-22);
      return {x,y,w:28,h:22,clip:r,distance:(x+14-cx)**2+(y+11-cy)**2};
    }).sort((a,b)=>a.distance-b.distance);
    const box=candidates.find(candidate=>!sites.some(s=>s.role==='road' && overlaps(s,candidate)));
    if (!box) continue;
    sites.push({...box,role:'road',taskId,town,evidence:work});
  }
  for (const garden of trades.gardens || []) {
    if (!allowed(garden.town)) continue;
    // Do not decorate a filtered-away district on the strength of its bounds alone.
    const local=plots.filter(p=>townOf(p.agent)===garden.town);
    if (!local.length) continue;
    const districtsForTown=visibleDistricts.filter(d=>d.key===garden.town && local.some(p=>contains(d,{x:p.x,y:p.y,w:54,h:66})));
    for (const d of districtsForTown) {
      const candidates=[{x:d.x+8,y:d.y+d.h-25,w:66,h:23},{x:d.x+d.w-74,y:d.y+d.h-25,w:66,h:23}];
      const box=candidates.find(b=>contains(d,b) && !local.some(p=>overlaps(b,{x:p.x-2,y:p.y-2,w:(p.w||54)+4,h:(p.h||66)+24})) && !sites.some(s=>overlaps(s,b)));
      if (box) sites.push({...box,role:'gardener',taskId:(garden.taskIds||[]).find(id=>household(local,id,garden.town)),town:garden.town,evidence:garden,clip:d});
    }
  }
  return sites;
}
function rect(ctx,c,x,y,w,h) {ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),w,h);}
function worker(ctx,x,y,coat,step=0) {
  rect(ctx,'#493d3c',x+2,y,4,2);rect(ctx,'#e2b98e',x+2,y+2,4,4);
  rect(ctx,coat,x+1,y+6,6,6);rect(ctx,'#4c535b',x+1+step,y+12,2,3);rect(ctx,'#4c535b',x+5-step,y+12,2,3);
}
function miner(ctx,s,phase,moving) {
  const {x,y}=s;
  rect(ctx,'#82745e',x+1,y+12,11,9);rect(ctx,'#b2a087',x+3,y+10,7,3);
  rect(ctx,'#393e43',x+4,y+14,6,7);rect(ctx,'#af936c',x+2,y+13,2,8);
  rect(ctx,'#89b6b1',x+6,y+16,2,2);rect(ctx,'#d1b879',x+1,y+22,4,2);
  worker(ctx,x+14,y+6,'#7f9ca2');
  rect(ctx,'#d4ad53',x+15,y+6,6,3);rect(ctx,'#f7df9a',x+14,y+8,2,2);
  const lift=moving && phase%4<2?3:0;
  rect(ctx,'#99764f',x+11,y+13-lift,2,9);rect(ctx,'#b4c1bb',x+8,y+12-lift,7,2);
  if (moving && phase%4===3) {rect(ctx,'#f7df9a',x+6,y+11,1,2);rect(ctx,'#d5bd7a',x+9,y+8,2,1);}
}
function workshop(ctx,s,phase,moving) {
  const {x,y}=s;
  rect(ctx,'#9a7953',x+1,y+15,12,3);rect(ctx,'#594f40',x+2,y+18,2,6);rect(ctx,'#594f40',x+10,y+18,2,6);
  rect(ctx,'#b6bab0',x+4,y+11,5,4);rect(ctx,'#7a8785',x+3,y+12,7,2);rect(ctx,'#d2caa7',x+5,y+10,3,6);rect(ctx,'#586d70',x+6,y+12,1,2);
  rect(ctx,'#766b4d',x+1,y+2,1,9);rect(ctx,'#b8a471',x,y+2,6,1);rect(ctx,'#e9cb78',x+3,y+3,3,3);
  if(moving&&phase%4<2)rect(ctx,'#f8e3a4',x+4,y+4,1,1);
  worker(ctx,x+14,y+6,'#a48769');
  const lift=moving&&phase%4<2?3:0;
  rect(ctx,'#876c49',x+12,y+12-lift,1,7);rect(ctx,'#768d90',x+10,y+11-lift,5,3);
}
function roadmender(ctx,s,phase,moving) {
  const {x,y}=s;
  for(let i=0;i<4;i++) {rect(ctx,'#747b76',x+i*6,y+17,5,3);rect(ctx,'#b4baa3',x+i*6,y+17,5,1);}
  rect(ctx,'#85704e',x+1,y+2,2,7);rect(ctx,'#85704e',x+11,y+2,2,7);rect(ctx,'#c9a56b',x,y+3,14,2);
  rect(ctx,'#dfce9a',x+4,y+3,3,2);rect(ctx,'#dfce9a',x+10,y+3,3,2);
  rect(ctx,'#919b97',x+2,y+12,7,3);rect(ctx,'#b8c0ac',x+3,y+10,5,2);
  worker(ctx,x+18,y+2,'#b79568');rect(ctx,'#b8b092',x+19,y+2,6,2);
  const lift=moving && phase%4<2?4:0;
  rect(ctx,'#8f7455',x+15,y+11-lift,1,7);rect(ctx,'#596b70',x+12,y+10-lift,6,3);
}
function gardener(ctx,s,phase,moving) {
  const {x,y,evidence:g}=s;
  rect(ctx,'#80654d',x+1,y+10,18,3);rect(ctx,'#554f40',x+2,y+13,2,7);rect(ctx,'#554f40',x+16,y+13,2,7);
  const count=Math.min(6,Math.max(1,Number(g.arrivals)||0));
  for(let i=0;i<count;i++) {
    const px=x+2+(i%3)*5,py=y+5-Math.floor(i/3)*5;
    rect(ctx,'#b6805d',px,py+3,4,3);rect(ctx,'#74995e',px+1,py,1,4);rect(ctx,'#a5b977',px,py+1,4,1);
  }
  const hauling=moving && g.growth==='growing', offset=hauling?Math.floor(phase%6/2):0;
  const wx=x+41+offset;
  rect(ctx,'#4f5350',wx+3,y+18,4,4);rect(ctx,'#8e9c85',wx,y+11,15,3);rect(ctx,'#6c7a64',wx+2,y+14,10,3);rect(ctx,'#a38c62',wx+14,y+11,5,1);
  rect(ctx,'#987652',wx+4,y+8,6,3);rect(ctx,'#9ab37a',wx+6,y+6,3,3);
  worker(ctx,x+27,y+6,'#7f9c7a',hauling?phase%2:0);
  rect(ctx,'#c6b178',x+27,y+6,8,2);rect(ctx,'#ac9564',x+29,y+4,4,2);
  // A quiet pause signifies a growth spurt, never an inferred emotional state.
  if (g.growth==='spurt') {rect(ctx,'#e2b98e',x+34,y+10,2,4);rect(ctx,'#e2b98e',x+32,y+9,3,2);}
  else rect(ctx,'#b9c7b5',x+24,y+15,3,4);
}
export function drawTradeLife(ctx,options={}) {
  const {time=0,reduce=false,stale=false}=options;
  const moving=!reduce && !stale, phase=moving && Number.isFinite(time)?Math.floor(time*3):0;
  ctx.save();
  try {
    for (const site of tradeSites(options)) {
      ctx.save();
      try {
        // Clip each work yard to both its hit area and supplied world geometry.
        ctx.beginPath();ctx.rect(site.x,site.y,site.w,site.h);ctx.clip();
        ctx.beginPath();ctx.rect(site.clip.x,site.clip.y,site.clip.w,site.clip.h);ctx.clip();
        if(site.role==='miner') miner(ctx,site,phase,moving);
        else if(site.role==='workshop') workshop(ctx,site,phase,moving);
        else if(site.role==='road') roadmender(ctx,site,phase,moving);
        else gardener(ctx,site,phase,moving);
      } finally {ctx.restore();}
    }
  } finally {ctx.restore();}
}
