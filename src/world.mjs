/** Stable plots: a growing town gets an annex instead of moving existing homes. */
export function createTownLayout({columns=4, rows=2, houseWidth=54, houseHeight=66, gapX=26, gapY=70, margin=30, road=48, pad=18, signHeight=32}={}) {
  const slots = new Map(), blocks = [], byTown = new Map(), childSlots=new Map(), parentCounts=new Map();
  const width = columns * (houseWidth + gapX) - gapX + pad*2;
  const height = signHeight + rows * (houseHeight+gapY) + pad*2;
  const capacity=columns*rows;
  function allocate(agent) {
    if(slots.has(agent.id)) return slots.get(agent.id);
    const town=agent.town || agent.role || 'WildTown';
    const pages=byTown.get(town)||[];
    let block=pages.find(b=>b.used<capacity);
    if(!block) {
      const i=blocks.length;
      block={key:town, id:town+':'+pages.length, page:pages.length, used:0,
        x:margin+(i%2)*(width+road), y:margin+Math.floor(i/2)*(height+road),
        w:width,h:height,col:i%2,row:Math.floor(i/2)};
      pages.push(block);byTown.set(town,pages);blocks.push(block);
    }
    const n=block.used++;
    const slot={x:block.x+pad+(n%columns)*(houseWidth+gapX),
      y:block.y+pad+signHeight+Math.floor(n/columns)*(houseHeight+gapY),blockId:block.id};
    slots.set(agent.id,slot);
    return slot;
  }
  return {
    update(agents) {
      const ids=new Set(agents.map(a=>a.id));
      for(const a of agents){
        if(a.parent&&!childSlots.has(a.id)){const n=parentCounts.get(a.parent)||0;childSlots.set(a.id,n);parentCounts.set(a.parent,n+1);}
      }
      const roots=agents.filter(a=>!a.parent||!ids.has(a.parent)||childSlots.get(a.id)>=3||slots.has(a.id));
      const plots=roots.map(a=>({...allocate(a),agent:a}));
      const n=Math.max(1,blocks.length);
      return {plots,shedSlots:Object.fromEntries(childSlots),blocks:blocks.map(b=>({...b})),width:margin*2+2*width+road,
        height:margin*2+Math.ceil(n/2)*height+(Math.ceil(n/2)-1)*road,
        districtWidth:width,roadX:margin+width,
        roadYs:Array.from({length:Math.ceil(n/2)},(_,i)=>margin+height+i*(height+road)),
        columns};
    },
    reset(){ slots.clear();blocks.length=0;byTown.clear();childSlots.clear();parentCounts.clear(); }
  };
}
export function inside(point,rect,pad=0) {
  return point.x>=rect.x-pad && point.x<=rect.x+rect.w+pad &&
    point.y>=rect.y-pad && point.y<=rect.y+rect.h+pad;
}
export function movePoint(point, dx, dy, canWalk) {
  // Small substeps avoid tunneling through thin furniture at low frame rates.
  const n=Math.max(1,Math.ceil(Math.hypot(dx,dy)/2));
  let {x,y}=point;
  for(let i=0;i<n;i++){
    if(canWalk(x+dx/n,y)) x+=dx/n;
    if(canWalk(x,y+dy/n)) y+=dy/n;
  }
  return {...point,x,y};
}
/** Browser-safe counterpart of townName(): aliases must match cottage normalization. */
const TOWN_STEMS={autohub:'Hub',automem:'Mem','wp-fusion':'Fusion',wpfusion:'Fusion',autoapp:'App',autovault:'Vault'};
const LEGACY_TOWNS={dev:'HubTown',research:'MemTown',ops:'FusionTown',content:'AppTown'};
export function normalizeTown(raw){
  const value=String(raw||'').trim();
  if(!value)return 'WildTown';
  const legacy=LEGACY_TOWNS[value.toLowerCase()];
  if(legacy)return legacy;
  const withoutTown=value.replace(/town$/i,'');
  const words=withoutTown.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if(!words.length)return 'WildTown';
  const key=words.join('-').toLowerCase();
  if(TOWN_STEMS[key])return TOWN_STEMS[key]+'Town';
  const stem=words.map(word=>word.charAt(0).toUpperCase()+word.slice(1).toLowerCase()).join('');
  return stem+'Town';
}
export function normalizeRelationships(raw=[], towns=[]) {
  const valid=new Set((Array.isArray(towns)?towns:[]).map(normalizeTown)), seen=new Set();
  return (Array.isArray(raw)?raw:[]).flatMap(r=>{
    const from=normalizeTown(r?.from),to=normalizeTown(r?.to);
    if(!r||!valid.has(from)||!valid.has(to)||from===to) return [];
    const key=[from,to].sort().join('|');
    if(seen.has(key)) return [];
    seen.add(key);return [{id:String(r.id||key),from,to,label:String(r.label||'Related projects')}];
  });
}
export function normalizedHandoffs(raw=[]) {
  const seen=new Set();
  return (Array.isArray(raw)?raw:[]).flatMap(e=>{
    const from=normalizeTown(e?.from),to=normalizeTown(e?.to);
    if(!e||!e.id||!e.from||!e.to||!Number.isFinite(Number(e.timestamp))||seen.has(e.id))return [];
    seen.add(e.id);return [{...e,id:String(e.id),from,to,timestamp:Number(e.timestamp),text:String(e.text||'Work handed over')}];
  });
}
export function advanceDuck(duck, player, pond, dt, time) {
  const distance=Math.hypot(duck.x-player.x,duck.y-player.y);
  let event=null;
  if(duck.mode!=='swimming' && duck.mode!=='fleeing' && time>=(duck.safeUntil||0) && distance<28){
    duck.mode='fleeing';duck.target={x:pond.x+pond.w*.45,y:pond.y+pond.h*.55};event='quack';
  }
  if(duck.mode==='fleeing'){
    const d=Math.hypot(duck.target.x-duck.x,duck.target.y-duck.y), step=Math.min(d,dt*58);
    if(d>0){duck.x+=(duck.target.x-duck.x)/d*step;duck.y+=(duck.target.y-duck.y)/d*step;}
    if(d<3){duck.mode='swimming';duck.until=time+9;event='splash';}
  }else if(duck.mode==='swimming'){
    duck.x=pond.x+pond.w*.45+Math.sin(time*.5)*pond.w*.18;
    duck.y=pond.y+pond.h*.55+Math.cos(time*.4)*pond.h*.12;
    if(time>duck.until){duck.mode='returning';duck.target={x:pond.x+pond.w*.5,y:pond.y+pond.h+12};}
  }else if(duck.mode==='returning'){
    const d=Math.hypot(duck.target.x-duck.x,duck.target.y-duck.y),step=Math.min(d,dt*20);
    if(d>0){duck.x+=(duck.target.x-duck.x)/d*step;duck.y+=(duck.target.y-duck.y)/d*step;}
    if(d<2){duck.mode='wandering';duck.safeUntil=time+6;}
  }
  return event;
}
