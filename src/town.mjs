import { normalizePr, prStage, hasOutstandingPr } from "./pr.mjs";
import { createTownLayout, advanceDuck } from "./world.mjs";
import { renderResident } from "./interiors.mjs";
import { createObservatory } from "./observatory.mjs";
import { feedEnvelope, normalizeCottage } from "./feed-client.mjs";
import { lettersOf } from "./occupancy.mjs";
import { PUBLIC_DEMO } from "./runtime.mjs";
import { createBedtimeRoutine, paintCoop, routineForAgent, villageLifeLabel } from "./bedtime.mjs";


/* =======================================================================
   DATA ADAPTER
   Cottage = { id, name, town, status, task, startedAt, tokens, lastLine, parent }
   town   : HubTown | MemTown | FusionTown | AppTown | VaultTown | {Stem}Town
   status : working | idle | blocked | done | offline
   ======================================================================= */
const POLL_MS = 1500;
let ENDPOINT = null;
let builtInDemo = true;
let LIVE = false, feedStale = false, lastSnapshot = null, lastEndpoint = null;
let FEED_META = {source:"demo",relationships:[],handoffs:[]};
let observatory;
const stableLayout = createTownLayout();
let sceneSolids = [], scenePonds = [], sceneDistricts = [];
let showSettled = false;

function townKey(ag){
  return ag.town || ag.role || "WildTown";
}

function normalizeTown(raw){
  const s = String(raw || "").trim();
  if(!s) return "WildTown";
  const legacy = {dev:"HubTown", research:"MemTown", ops:"FusionTown", content:"AppTown"};
  if(legacy[s]) return legacy[s];
  // Keep word boundaries (my-project → MyProjectTown) while stripping markup.
  const withoutTown = s.replace(/town$/i, "");
  const words = withoutTown.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if(!words.length) return "WildTown";
  const stem = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /town$/i.test(stem) ? stem : stem + "Town";
}

function isAllowedFeedUrl(raw){
  try{
    const u = new URL(String(raw || "").trim(), location.href);
    return u.protocol === "http:" || u.protocol === "https:";
  }catch{
    return false;
  }
}

export function feedNamespace(endpoint, isBuiltInDemo = false){
  return isBuiltInDemo || !endpoint ? "demo" : "feed:" + String(endpoint);
}

function shortModel(m){
  const s = String(m || "").toLowerCase();
  if(s.includes("opus")) return "opus";
  if(s.includes("haiku")) return "haiku";
  if(s.includes("sonnet")) return "sonnet";
  if(s.includes("gpt") || s.includes("openai")) return "gpt";
  if(s.includes("mlx")) return "mlx";
  if(s.includes("local") || s.includes("ollama") || s.includes("lmstudio") || s.includes("llama")) return "local";
  return MODELS[s] ? s : (s || "sonnet");
}

const RECENT_MS = 2 * 60 * 60 * 1000;
const CLAUDE_IDLE_MS = 15 * 60 * 1000;

function hasShowableWork(c){
  if(c.pr && c.pr.state && c.pr.state !== "none") return true;
  if(c.result && String(c.result).trim() && c.result !== "-") return true;
  const task = String(c.task || "").trim();
  return Boolean(task && task !== "-");
}

/** Mirror of src/occupancy.mjs when a feed omits occupancy. */
function classifyOccupancy(c, now = Date.now()){
  if(hasOutstandingPr(c, now) || c.status === "working" || c.status === "blocked") return "live";
  if(c.status === "idle"){
    if(c.source === "claude"){
      const t = Number(c.updatedAt || c.endedAt || c.startedAt || 0);
      if(Number.isFinite(t) && now - t > CLAUDE_IDLE_MS) return "settled";
    }
    return "live";
  }
  const t = Number(c.endedAt || c.updatedAt || 0);
  const age = Number.isFinite(t) && t > 1e12 ? now - t : Infinity;
  if(c.status === "done" && age <= RECENT_MS && hasShowableWork(c)) return "recent";
  return "settled";
}

async function fetchAgents(){
  if(PUBLIC_DEMO||!ENDPOINT){
    if(PUBLIC_DEMO)ENDPOINT=null;
    builtInDemo=true;LIVE=false;feedStale=false;FEED_META=DEMO_META;
    return SIM.snapshot();
  }
  const endpoint=ENDPOINT;
  try{
    const res=await fetch(endpoint,{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw new Error("HTTP "+res.status);
    const data=feedEnvelope(await res.json());
    if(endpoint!==ENDPOINT)return agents;
    let bundledEmpty=false;
    try{const u=new URL(endpoint,location.href);bundledEmpty=!data.stale&&!data.agents.length&&u.origin===location.origin&&u.pathname==="/agents"&&(!data.source||data.source==="none");}catch{}
    if(bundledEmpty){builtInDemo=true;LIVE=false;feedStale=false;FEED_META=DEMO_META;feedNote("local feed empty. demo townmap until cottages show up.");return SIM.snapshot();}
    builtInDemo=false;LIVE=true;feedStale=!!data.stale;FEED_META=data;
    const list=data.agents.filter(a=>a&&typeof a==="object").map((a,i)=>normalizeCottage(data.stale?{...a,pr:{...a.pr,stale:true,reason:"The feed is stale; PR readiness is unverified."}}:a,i,{town:normalizeTown,model:shortModel,occupancy:classifyOccupancy}));
    lastSnapshot=list;lastEndpoint=endpoint;
    feedNote((feedStale?"Stale snapshot · ":"live. ")+list.length+" cottages ("+(data.source||"custom feed")+")",feedStale?"#e7b778":"#94c99e");
    return list;
  }catch(err){
    if(endpoint!==ENDPOINT)return agents;
    feedStale=true;
    if(lastSnapshot&&lastEndpoint===endpoint){LIVE=true;feedNote("Connection interrupted · showing last live snapshot. Retrying…","#e7b778");return lastSnapshot.map(a=>({...a,pr:normalizePr({...a.pr,stale:true,reason:"Feed connection interrupted; PR readiness is unverified."})}));}
    LIVE=false;feedNote("Feed unavailable · "+err.message+". Retrying…","#e7b778");
    return [];
  }
}

/* ---- mock world ---- */
const TASKS = {
  HubTown:["refactor webhook queue","patch CRM sync retry","bump deps + run suite","write migration 0042","fix flaky auth test","port settings page"],
  MemTown:["read arXiv 2508.11912","compare vector stores","summarise competitor pricing","trace recall regression","survey MCP servers"],
  FusionTown:["deploy to Railway","rotate staging certs","watch error budget","prune D1 snapshots","tail prod logs"],
  AppTown:["draft changelog 3.46","reply to Derek","outline launch post","clean up docs nav","write release notes"],
  VaultTown:["sign a skill bundle","rotate vault keys","audit SKILL.md hashes","sync profile links"]
};
const ACTIVITY = {
  working:["editing src/sync.ts","running the test suite","reading 12 search results","waiting on API response","writing the PR description","diffing two schema versions"],
  idle:["polling the queue","nothing queued"],
  blocked:["waiting on you","retrying in 40s"],
  done:["handed back to you","report written"],
  offline:["—"]
};
const DISPATCH = ["Jack","cron: nightly","webhook: github","Jack","slack: #ops","Jack"];
const MODELS = {opus:"#b07bd4", sonnet:"#63a4e0", haiku:"#6fc98a", gpt:"#10a37f", local:"#c9a227", mlx:"#e07a5f"};
const BRANCHES = {
  HubTown:["fix/sync-429","feat/settings","main","chore/deps"],
  MemTown:["main","spike/vectors"],
  FusionTown:["deploy/prod","main"],
  AppTown:["docs/changelog","main"],
  VaultTown:["feat/signing","main"]
};
const RATE = 0.000009;   // $ per token, rough blended estimate

const LINES = {
  working:["> 47 files scanned, 3 candidates","> tests 118 passed, 2 skipped","> streaming... 4.1k tokens","> commit staged, awaiting review"],
  idle:["> queue empty, waiting for work","> heartbeat ok"],
  blocked:["! rate limited by upstream (429)","! needs approval: destructive migration","! auth token expired","! merge conflict in src/sync.ts"],
  done:["ok finished in 4m12s","ok PR opened, 6 files changed"],
  offline:["- shut down cleanly"]
};
const pick = a => a[Math.floor(Math.random()*a.length)];
const demoTodos=(a,stamp)=>({source:'demo',updatedAt:stamp,items:[
  {id:'read',text:'Read the existing behavior and the pinned request',status:'completed'},
  {id:'change',text:a.task,status:['done','offline'].includes(a.status)?'completed':a.status==='idle'?'pending':'in_progress'},
  {id:'check',text:'Verify the result and leave a reviewable handoff',status:a.status==='done'?'completed':'pending'}
]});
const demoInput=(a,stamp)=>({
  id:a.id+':question:'+stamp,kind:'question',source:'demo',updatedAt:stamp,
  prompt:'Before I continue with “'+a.task+'”, how much should I include?',
  questions:[{id:'scope',header:'Scope',prompt:'Choose the scope of this practice task.',multiSelect:false,options:[
    {label:'Keep it focused',description:'Finish the requested change and verify it.'},
    {label:'Include related cleanup',description:'Also tidy the nearby code while I’m here.'}
  ]}]
});

const DEMO_META={source:"demo",relationships:[
  {id:"hub-app",from:"HubTown",to:"AppTown",label:"Application API"},
  {id:"hub-mem",from:"HubTown",to:"MemTown",label:"Memory services"},
  {id:"hub-vault",from:"HubTown",to:"VaultTown",label:"Skill bundles"}
],handoffs:[]};
const SIM = (() => {
  // [name, town, status]  optional 4th value is the index of the cottage that spawned it
  const seed = [
    ["Bolt","HubTown","working"],["Marge","HubTown","working"],["Kip","HubTown","blocked"],
    ["Otto","HubTown","idle"],["Vera","HubTown","done"],["Gus","HubTown","working"],["Ida","HubTown","idle"],
    ["Juno","MemTown","working"],["Pim","MemTown","working"],["Wren","MemTown","idle"],
    ["Sable","MemTown","offline"],
    ["Hollis","FusionTown","working"],["Dov","FusionTown","idle"],["Tess","FusionTown","blocked"],["Nils","FusionTown","working"],
    ["Odie","AppTown","working"],["Ruth","AppTown","done"],["Cass","AppTown","idle"],
    ["Nyx","VaultTown","working"],["Reed","VaultTown","idle"],
    ["Bolt-1","HubTown","working",0],["Bolt-2","HubTown","blocked",0],
    ["Juno-1","MemTown","working",7],["Juno-2","MemTown","done",7],["Juno-3","MemTown","working",7],
    ["Hollis-1","FusionTown","idle",11]
  ];
  const now = Date.now();
  const agents = seed.map((s,i)=>({
    source:"demo", id:"a"+i, name:s[0], town:s[1], role:s[1], status:s[2],
    occupancy: s[2]==="offline" ? "settled" : (s[2]==="done" ? "recent" : "live"),
    parent: s[3]==null ? null : "a"+s[3],
    task: s[2]==="offline" ? "Claude Code session ended." : pick(TASKS[s[1]]),
    worktree: s[2]==="offline" ? "" : pick(["dreamy-pare","gifted-neumann","pensive-yonath",""]),
    worktreePath: "",
    result: s[2]==="done" ? "PR opened, 6 files changed" : "",
    pr: s[2]==="done" ? {number:412, url:"", title:"fix sync", state:"open"} : {number:null,url:"",title:"",state:"none"},
    attention: s[2]==="blocked" ? pick(LINES.blocked) : "",
    handoffUrl: "",
    activity: pick(ACTIVITY[s[2]]),
    model: s[3]==null ? pick(["opus","sonnet","sonnet","haiku","gpt","local"]) : "haiku",
    branch: s[3]==null ? pick(BRANCHES[s[1]]) : null,
    dispatchedBy: s[3]==null ? pick(DISPATCH) : seed[s[3]][0],
    startedAt: now - Math.floor(Math.random()*40*60*1000),
    endedAt: s[2]==="done" || s[2]==="offline" ? now - 20*60*1000 : 0,
    tokens: Math.floor(Math.random()*180000),
    cost: 0,
    lastLine: pick(LINES[s[2]])
  }));
  agents.forEach(a=>{
    a.cost = a.tokens * RATE;
    a.taskId="demo-task-"+a.id;
    a.originalAsk="Please "+a.task+". Check the existing behavior, make the smallest useful change, and leave a clear result I can review.";
    a.taskStartedAt=a.startedAt;a.sessionStartedAt=a.startedAt-8*60000;a.updatedAt=now;
    a.endedAt=['done','offline'].includes(a.status)?Math.max(a.startedAt,now-20*60000):0;
    a.todos=demoTodos(a,now);
    a.inputRequest=a.status==='blocked'?demoInput(a,now):null;
    if(a.inputRequest){a.attention=a.inputRequest.prompt;a.activity='Waiting for your choice about the scope of this task.';}
    a.events=[
      {id:a.id+":request",timestamp:a.startedAt,kind:"request",text:a.originalAsk},
      {id:a.id+":read",timestamp:a.startedAt+12000,kind:"progress",text:"I’m reading the existing implementation and checking the task requirements."},
      {id:a.id+":tool",timestamp:a.startedAt+35000,kind:"tool",text:"Read source files and inspect the relevant tests."},
      {id:a.id+":latest",timestamp:now,kind:"progress",text:a.activity}
    ];
    const stages=["active","waiting-codex","blocked","none","ready","waiting-ci","open","active","merged","closed","unknown"];
    const review=stages[Number(a.id.slice(1))%stages.length];
    a.pr=review==="none"?{state:"none",source:"demo",checkedAt:now}:review==="unknown"?{state:"unknown",source:"demo",checkedAt:now,reason:"This demo cottage has no verified PR observation."}:
      {number:412+Number(a.id.slice(1)),repo:"demo/"+a.town,url:"",title:a.task,state:review==="merged"?"merged":review==="closed"?"closed":"open",
       reviewState:["active","waiting-codex","blocked","ready","waiting-ci"].includes(review)?review:"unknown",
       labels:["active","waiting-codex","blocked","ready","waiting-ci"].includes(review)?["babysit:"+review]:[],
       headSha:"demo-head-"+a.id,source:"demo",checkedAt:now};
    if(a.parent){a.pr={...agents.find(x=>x.id===a.parent)?.pr};}
    a.occupancy=hasOutstandingPr(a)?"live":a.occupancy;
    if(!a.branch){
      const mum = agents.find(x=>x.id===a.parent);
      a.branch = mum ? mum.branch : "main";
    }
  });
  let live = true;
  let demoBeat=0;
  setInterval(()=>{
    if(!live) return;
    demoBeat++;
    if(demoBeat===5){
      const parent=agents[0],stamp=Date.now(),id="demo-apprentice";
      agents.push({...parent,id,name:"Pip",parent:parent.id,status:"working",occupancy:"live",endedAt:0,inputRequest:null,attention:'',taskId:"demo-task-pip",task:"Check the webhook edge cases",originalAsk:"Please test the webhook edge cases while Bolt finishes the queue changes.",taskStartedAt:stamp,startedAt:stamp,sessionStartedAt:stamp,updatedAt:stamp,tokens:0,cost:0,events:[{id:id+":arrival",timestamp:stamp,kind:"request",text:"Please test the webhook edge cases while Bolt finishes the queue changes."}]});
      agents.at(-1).todos=demoTodos(agents.at(-1),stamp);
    }
    if(demoBeat%14===6){
      const stamp=Date.now(),event={id:"demo-handoff-"+stamp,timestamp:stamp,kind:"handoff",from:"HubTown",to:"AppTown",agentId:"a0",name:"Bolt",text:"Demo handoff: the queue contract is ready for AppTown’s interface work."};
      DEMO_META.handoffs.push(event);DEMO_META.handoffs=DEMO_META.handoffs.slice(-20);agents[0].events.push(event);
    }
    agents.forEach(a=>{
      if(a.status==="working"){
        const d = Math.floor(Math.random()*900);
        a.tokens += d; a.cost += d * RATE;
        if(Math.random() > 0.85) a.activity = pick(ACTIVITY.working);
      }
      if(Math.random() > 0.94){
        const s = pick({
          working:["working","working","blocked","done"],
          idle:["idle","working","working"],
          blocked:["blocked"],
          done:["done","idle"],
          offline:["offline","offline","idle"]
        }[a.status]);
        if(s !== a.status){
          a.status = s; a.lastLine = pick(LINES[s]); a.activity = pick(ACTIVITY[s]);
          a.endedAt=['done','offline'].includes(s)?Date.now():0;
          a.todos=demoTodos(a,Date.now());
          a.inputRequest=s==='blocked'?demoInput(a,Date.now()):null;
          a.attention=a.inputRequest?.prompt||'';
          if(a.inputRequest)a.activity='Waiting for your choice about the scope of this task.';
        }
      } else if(Math.random() > 0.8){ a.lastLine = pick(LINES[a.status]); }
      const last=a.events.at(-1);
      if(last?.text!==a.activity){
        const time=Date.now();a.updatedAt=time;
        a.events.push({id:a.id+":event:"+time,timestamp:time,kind:"progress",text:a.activity});
        a.events=a.events.slice(-100);
      }
      if(a.pr) a.pr.checkedAt=Date.now();
    });
  }, 2200);
  return {
    snapshot: () => agents.map(a=>({...a,pr:normalizePr(a.pr)})),
    set(id, status){
      const a = agents.find(x=>x.id===id); if(!a) return;
      a.status = status; a.lastLine = pick(LINES[status]); a.activity = pick(ACTIVITY[status]);
      a.endedAt=['done','offline'].includes(status)?Date.now():0;
      a.todos=demoTodos(a,Date.now());
      a.inputRequest=status==='blocked'?(a.inputRequest||demoInput(a,Date.now())):null;
      a.attention=a.inputRequest?.prompt||'';
      if(status==="offline") a.task = "-";
    },
    answer(id,text,requestId){
      const a=agents.find(x=>x.id===id);
      if(!a?.inputRequest||a.inputRequest.id!==requestId||!text.trim())return false;
      const stamp=Date.now();
      a.status='working';a.occupancy='live';a.endedAt=0;a.inputRequest=null;a.attention='';a.updatedAt=stamp;
      a.activity='Practice reply received. I’m continuing the sample task with your guidance.';
      a.lastLine='> sample resident is back at work';a.todos=demoTodos(a,stamp);
      a.events.push(
        {id:a.id+':practice-reply:'+stamp,timestamp:stamp,kind:'request',text:'Practice reply: '+text.trim()},
        {id:a.id+':practice-resume:'+stamp,timestamp:stamp+1,kind:'progress',text:a.activity}
      );
      a.events=a.events.slice(-100);return true;
    },
    setLive(v){ live = v; }
  };
})();

/* =======================================================================
   TOWNMAP
   ======================================================================= */
const TOWN_PALETTE = [
  {roof:"#e08a3c", roofDark:"#a85c1e"},
  {roof:"#6f83d6", roofDark:"#47549f"},
  {roof:"#4fb08c", roofDark:"#2f7a63"},
  {roof:"#cc5f78", roofDark:"#933d52"},
  {roof:"#c9a227", roofDark:"#8a6e14"},
  {roof:"#5c9ead", roofDark:"#3a6d78"}
];
const FALLBACK_TOWN = {key:"WildTown", label:"WILDTOWN", roof:"#7d868e", roofDark:"#525b63"};
let TOWNS = [];

function districtsFrom(list){
  const keys = [...new Set(list.map(a=>townKey(a)))];
  if(!keys.includes("HubTown")) keys.unshift("HubTown");
  keys.sort((a,b)=>{
    if(a==="HubTown") return -1;
    if(b==="HubTown") return 1;
    return a.localeCompare(b);
  });
  return keys.map((key,i)=>({
    key,
    label: key.toUpperCase(),
    ...TOWN_PALETTE[key==="HubTown" ? 0 : (i % TOWN_PALETTE.length)]
  }));
}
function townStyle(ag){
  const k = townKey(ag);
  return TOWNS.find(z=>z.key===k) || TOWNS[0] || FALLBACK_TOWN;
}

const HOUSE_W=54, HOUSE_H=66;
let COLS=4;
const GAP_X=26, GAP_Y=70, PAD=18, SIGN_H=32, MARGIN=30, ROAD=48;
// where things sit in the yard, measured down from the bottom of the house
const LANE_Y = 1, LANE_H = 9, SIGN_Y = 13, BENCH_Y = 29, SHED_Y = 49;
let D_W = COLS*HOUSE_W + (COLS-1)*GAP_X + PAD*2;
let W = MARGIN*2 + D_W*2 + ROAD;
let H = 400, ROAD_Y = 200, DR = [];
let VERT_ROAD = MARGIN + D_W;
let HORZ_ROADS = [];

const C = {
  grass:"#63b85f", grassDk:"#46914b", grassLt:"#84d472", grassSh:"#3a7a43",
  dirt:"#e3a860", dirtDk:"#c4823f", dirtEdge:"#a3672f",
  outline:"#2b3a2c",
  wood:"#a86e3e", woodDk:"#6f4526", woodLt:"#c78e55",
  wall:"#f2e2c2", wallDk:"#d9c39c",
  stone:"#9fa9b0", stoneDk:"#6e7a83",
  winOn:"#ffd166", winOff:"#5d7382",
  water:"#4f9fc4", waterDk:"#3a7ea3",
  smoke:"#e8eef2", alert:"#e2504a", ok:"#79c25f",
  off:"#7d868e", offDk:"#525b63",
  leaf:"#4fa04f", leafDk:"#347a3f", leafLt:"#7ecb6c",
  soil:"#d8944e", soilDk:"#b5713a", crop:"#3f8a45", fruit:"#d9463f"
};

const MODEL_COLOR = {opus:"#b07bd4", sonnet:"#63a4e0", haiku:"#6fc98a", gpt:"#10a37f", local:"#c9a227", mlx:"#e07a5f"};

const cv = document.getElementById("town");
const ctx = cv.getContext("2d");
cv.width = W; cv.height = 0;
ctx.imageSmoothingEnabled = false;
const bg = document.createElement("canvas");
const bx = bg.getContext("2d");
let reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change",e=>{reduce=e.matches;});

let agents = [], plots = [], gardens = [];
const actors = new Map();   // agent id -> villager sprite state, survives each poll
const bedtime = createBedtimeRoutine();
let bedtimeFrames = new Map(), lastBedtimeLabel = '';
let pops = 0;               // how many thought bubbles are currently popped open
let selectedId = null, hoverId = null, filter = null, paused = false, t = 0, frameDt=1/60, lastDrawAt=0;
const JACK_ID = "__jack__";
let jackPlot = null;

const px = (x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(x|0,y|0,w|0,h|0); };

/* ---------- scenery, painted once per layout ---------- */
function paintBackground(){
  sceneSolids=[];scenePonds=[];
  const p = (x,y,w,h,c)=>{ bx.fillStyle=c; bx.fillRect(x|0,y|0,w|0,h|0); };
  let s = 7;
  const rnd = ()=> (s = (s*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  p(0,0,W,H,C.grass);
  // soft two-tone patches so the field isn't a flat slab
  for(let i=0;i<48;i++){
    const gx=(rnd()*W)|0, gy=(rnd()*H)|0, r=4+((rnd()*6)|0);
    const tone = C.grassDk;
    for(let dy=-r; dy<=r; dy++){
      const hw = Math.round(Math.sqrt(Math.max(0, r*r-dy*dy)));
      if(hw) p(gx-hw, gy+dy, hw*2, 1, tone);
    }
  }
  for(let i=0;i<1100;i++){
    const gx=(rnd()*W)|0, gy=(rnd()*H)|0, r=rnd();
    if(r>0.74){ p(gx,gy,3,1,C.grassLt); p(gx+1,gy-1,1,1,C.grassLt); }
    else if(r>0.4) p(gx,gy,2,1,C.grassDk);
  }

  const rx = VERT_ROAD;
  const roadsY = HORZ_ROADS.length ? HORZ_ROADS : (H > ROAD + MARGIN*2 ? [ROAD_Y] : []);
  p(rx-1, 0, ROAD+2, H, C.dirtEdge);
  p(rx, 0, ROAD, H, C.dirt);
  p(rx+7, 0, 1, H, C.dirtDk);
  p(rx+ROAD-8, 0, 1, H, C.dirtDk);
  roadsY.forEach(ry=>{
    p(0, ry-1, W, ROAD+2, C.dirtEdge);
    p(0, ry, W, ROAD, C.dirt);
    p(0, ry+7, W, 1, C.dirtDk);
    p(0, ry+ROAD-8, W, 1, C.dirtDk);
    p(rx, ry, ROAD, ROAD, C.dirt);
  });
  for(let i=0;i<700;i++){
    const gx=(rnd()*W)|0, gy=(rnd()*H)|0;
    const onH = roadsY.some(ry => gy>ry && gy<ry+ROAD);
    if(onH || (gx>rx && gx<rx+ROAD)){
      const r=rnd();
      if(r>0.9){ p(gx,gy,2,2,C.stone); p(gx,gy+1,2,1,C.stoneDk); }
      else if(r>0.55) p(gx,gy,2,1,C.dirtDk);
    }
  }

  const spurs = [];
  TOWNS.forEach((d, di) => {
    const r = DR[di];
    if(!r) return;
    const mine = plots.filter(pl => townKey(pl.agent) === d.key);
    if (!mine.length) return;
    const rows = Math.max(...mine.map(pl => Math.round((pl.y - (r.y+PAD+SIGN_H)) / (HOUSE_H+GAP_Y)))) + 1;
    const nearest = roadsY.reduce((best, ry)=>{
      const dist = Math.min(Math.abs((r.y+r.h) - ry), Math.abs(r.y - (ry+ROAD)));
      return dist < best.dist ? {ry, dist} : best;
    }, {ry: roadsY[0] ?? r.y+r.h, dist: Infinity});
    const topSide = r.y + r.h/2 <= (nearest.ry + ROAD/2);

    for (let row = 0; row < rows; row++) {
      const rowY = r.y + PAD + SIGN_H + row*(HOUSE_H+GAP_Y);
      const laneY = rowY + HOUSE_H + LANE_Y + (LANE_H>>1);
      const inRow = mine.filter(pl => Math.abs(pl.y - rowY) < 4);
      if (!inRow.length) continue;
      const x0 = Math.min(...inRow.map(pl => pl.x)) - 8;
      const x1 = Math.max(...inRow.map(pl => pl.x)) + HOUSE_W + 8;
      dirtPath(p, [[x0, laneY], [x1, laneY]], LANE_H);
      inRow.forEach(pl => dirtPath(p, [[pl.x+27, laneY], [pl.x+27, rowY+HOUSE_H-2]], 7));
    }

    const lastY = r.y + PAD + SIGN_H + (rows-1)*(HOUSE_H+GAP_Y) + HOUSE_H + LANE_Y + (LANE_H>>1);
    const spurX = r.x + PAD + Math.round(D_W*0.34);
    const jogX = spurX + (r.col % 2 ? -34 : 38);
    if (roadsY.length) {
      const roadY = topSide ? nearest.ry + 4 : nearest.ry + ROAD - 4;
      const midY = topSide
        ? lastY + Math.round((roadY - lastY) * 0.55)
        : lastY - Math.round((lastY - roadY) * 0.55);
      dirtPath(p, [[spurX, lastY], [spurX, midY], [jogX, midY], [jogX, roadY]], 8);
    } else {
      const roadX = r.col === 0 ? rx + 4 : rx + ROAD - 4;
      dirtPath(p, [[spurX, lastY], [roadX, lastY]], 8);
    }
    spurs.push(jogX);
  });

  TOWNS.forEach((d, di) => {
    const r = DR[di];
    if(!r) return;
    const mine = plots.filter(pl => townKey(pl.agent) === d.key);
    const rows = mine.length ? Math.ceil(mine.length / COLS) : 0;
    const used = SIGN_H + rows*(HOUSE_H+GAP_Y) + PAD*2;
    const spare = r.h - used;
    if (spare < 70) return;
    const top = r.y + used - PAD + 6;
    pondTo(p, r.x + PAD + 10, top + 8, Math.round(D_W*0.42), Math.min(58, spare-24), rnd);
    const ox = r.x + PAD + Math.round(D_W*0.55);
    const tone = di % 2
      ? {light:"#ffd7e6", mid:"#f2a8c4", dark:"#c9789c"}
      : {light:"#fff3c9", mid:"#f2d98a", dark:"#c9ab52"};
    for (let oy = 0; oy < Math.min(2, Math.floor((spare-30)/34)); oy++)
      for (let ox2 = 0; ox2 < 3; ox2++)
        blossomTreeTo(p, ox + ox2*26, top + 10 + oy*34, 7, tone);
  });

  TOWNS.forEach((d, di) => {
    const r = DR[di];
    if(!r) return;
    for(let i = 2; i < r.w - 6; i += 7){
      const hx = r.x + i;
      if(spurs.some(sx => Math.abs(hx - sx) < 16)) continue;
      const hy = r.y + r.h - 12;
      const onPlaza = roadsY.some(ry =>
        Math.abs(hx - (rx + (ROAD>>1))) < PLAZA*0.6 &&
        Math.abs(hy - (ry + (ROAD>>1))) < PLAZA*0.6);
      if(onPlaza) continue;
      bushTo(p, hx, hy, 5);
    }
  });

  const onRoad = (ax,ay)=> roadsY.some(ry => ay>ry-10 && ay<ry+ROAD+10) || (ax>rx-10 && ax<rx+ROAD+10);
  const inPlot = (ax,ay)=> DR.some(d=> ax>d.x-9 && ax<d.x+d.w+9 && ay>d.y-9 && ay<d.y+d.h+9);
  for(let gy=-6; gy<H+6; gy+=17){
    for(let gx=-6; gx<W+6; gx+=19){
      const r = 6+((rnd()*3)|0);
      const jx = gx + ((rnd()*7)|0), jy = gy + ((rnd()*7)|0);
      if(onRoad(jx+r, jy+r) || inPlot(jx+r, jy+r)) continue;
      const roll = rnd();
      if(roll > 0.93)      stumpTo(p, jx+2, jy+4);
      else if(roll > 0.89) rockTo(p, jx+2, jy+3, 4 + ((rnd()*2)|0));
      else if(roll > 0.86) logsTo(p, jx, jy+4);
      else if(roll > 0.84) barrelsTo(p, jx+1, jy+3);
      else {
        treeTo(p, jx, jy, r);
        if(rnd() > 0.86) shroomsTo(p, jx+r+4, jy+r*2-2);
      }
    }
  }

  // grass overhangs the dirt in scalloped bumps rather than a ruled line
  const scallop = (edge, horizontal, inward) => {
    const len = horizontal ? W : H;
    let d = 2;
    for(let i = 0; i < len; i += 3){
      d = Math.max(1, Math.min(4, d + ((rnd()*3)|0) - 1));   // random walk, stays continuous
      const w2 = 3;
      const y0 = inward ? edge : edge - d + 1;
      if(horizontal){
        p(i, y0, w2, d, C.grass);
        p(i, inward ? y0 + d : y0 - 1, w2, 1, C.grassDk);
      } else {
        p(y0, i, d, w2, C.grass);
        p(inward ? y0 + d : y0 - 1, i, 1, w2, C.grassDk);
      }
    }
  };
  scallop(rx, false, true);
  scallop(rx + ROAD, false, false);
  roadsY.forEach(ry=>{
    scallop(ry, true, true);
    scallop(ry + ROAD, true, false);
  });
  plots.forEach(pl=>{
    benchTo(p, pl.x+30, pl.y+HOUSE_H+BENCH_Y, townKey(pl.agent));
    if(!(pl.kids && pl.kids.length)) bushTo(p, pl.x-12, pl.y+HOUSE_H+BENCH_Y-2, 4);
    if((pl.x+pl.y) % 3 === 0) flowersTo(p, pl.x+HOUSE_W+2, pl.y+HOUSE_H-4, rnd);
  });

  if(roadsY.length){
    roadsY.forEach(ry => plazaTo(p, rx + (ROAD>>1), ry + (ROAD>>1), rnd));
  } else {
    plazaTo(p, rx + (ROAD>>1), Math.round(H/2), rnd);
  }
  gardens.forEach(g => gardenTo(p, g.x, g.y, g.w, g.h));
  // A permanent pond on the reserved second row of the home district.
  if(!scenePonds.length && DR.length){
    pondTo(p,MARGIN+PAD,H-85,100,48,rnd);
  }
}

function treeTo(p, x, y, r){
  sceneSolids.push({x:x+r-3,y:y+r*2-3,w:6,h:8});
  const cx = x+r, cy = y+r;
  p(x+2, cy+r+2, r*2-4, 3, C.grassSh);
  p(cx-3, cy+r-3, 6, 9, C.outline);
  p(cx-2, cy+r-3, 4, 8, C.woodDk);
  p(cx-2, cy+r-3, 2, 8, C.wood);
  for(let dy=-r; dy<=r; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, r*r - dy*dy)));
    if(!hw) continue;
    p(cx-hw-1, cy+dy, hw*2+2, 1, C.outline);
    if(hw>0) p(cx-hw, cy+dy, hw*2, 1, dy > r*0.35 ? C.leafDk : C.leaf);
  }
  for(let dy=-r+1; dy<-r*0.1; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, (r-1)*(r-1) - dy*dy)));
    if(hw>1) p(cx-hw, cy+dy, hw+1, 1, C.leafLt);
  }
  p(cx-2, cy-r+2, 3, 2, "#a3e388");
}

function dirtPath(p, pts, w){
  const seg = (x1,y1,x2,y2,ww,col) => {
    if(x1 === x2) p(x1-(ww>>1), Math.min(y1,y2), ww, Math.abs(y2-y1)+1, col);
    else          p(Math.min(x1,x2), y1-(ww>>1), Math.abs(x2-x1)+1, ww, col);
  };
  for(const pass of [[w+2, C.dirtEdge],[w, C.dirt]]){
    for(let i=0;i<pts.length-1;i++){
      seg(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], pass[0], pass[1]);
      p(pts[i+1][0]-(pass[0]>>1), pts[i+1][1]-(pass[0]>>1), pass[0], pass[0], pass[1]);
    }
  }
}

function pondTo(p, x, y, w, h, rnd){
  scenePonds.push({x,y,w,h});
  sceneSolids.push({x:x+4,y:y+4,w:w-8,h:h-8});
  // irregular blob, wider in the middle
  const cx = x + w/2, cy = y + h/2, rx2 = w/2, ry2 = h/2;
  let wob = 0;
  for(let dy=0; dy<h; dy++){
    const ny = (y+dy - cy) / ry2;
    if(Math.abs(ny) > 1) continue;
    wob = Math.max(-2, Math.min(2, wob + ((rnd()*3)|0) - 1));
    const half = rx2 * Math.sqrt(1 - ny*ny) + wob;
    const x0 = Math.round(cx - half), ww = Math.round(half*2);
    if(ww < 4) continue;
    p(x0-1, y+dy, ww+2, 1, C.outline);
    p(x0, y+dy, ww, 1, dy < 3 ? C.waterDk : C.water);
    if(dy > h-4) p(x0, y+dy, ww, 1, C.waterDk);
  }
  // lily pads and a glint
  for(let i=0;i<3;i++){
    const px2 = x + 6 + ((rnd()*(w-14))|0), py2 = y + 4 + ((rnd()*(h-8))|0);
    p(px2-1, py2-1, 7, 5, C.outline);
    p(px2, py2, 5, 3, C.leafDk);
    p(px2+1, py2, 3, 1, C.leaf);
    if(i === 0){ p(px2+1, py2-3, 3, 3, C.outline); p(px2+2, py2-2, 1, 1, "#f2d05a"); }
  }
  p(x+Math.round(w*0.3), y+3, 6, 1, "#bfe4f2");
  p(x+Math.round(w*0.3)+2, y+5, 4, 1, "#bfe4f2");
}

function blossomTreeTo(p, x, y, r, tone){
  const cx = x+r, cy = y+r;
  p(x+2, cy+r+2, r*2-4, 3, C.grassSh);
  p(cx-3, cy+r-3, 6, 9, C.outline);
  p(cx-2, cy+r-3, 4, 8, C.woodDk);
  p(cx-2, cy+r-3, 2, 8, C.wood);
  for(let dy=-r; dy<=r; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, r*r - dy*dy)));
    if(!hw) continue;
    p(cx-hw-1, cy+dy, hw*2+2, 1, C.outline);
    p(cx-hw, cy+dy, hw*2, 1, dy > r*0.35 ? tone.dark : tone.mid);
  }
  for(let dy=-r+1; dy<-r*0.1; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, (r-1)*(r-1) - dy*dy)));
    if(hw>1) p(cx-hw, cy+dy, hw+1, 1, tone.light);
  }
  // petals on the grass below
  p(cx-r-1, cy+r+3, 2, 1, tone.mid);
  p(cx+2, cy+r+4, 2, 1, tone.light);
  p(cx-2, cy+r+2, 2, 1, tone.mid);
}

function hedgeTo(p, x, y, len, vertical){
  for(let i=0; i<len; i+=7) {
    if(vertical) bushTo(p, x, y+i, 5);
    else bushTo(p, x+i, y, 5);
  }
}

function stumpTo(p, x, y){
  p(x+1, y+7, 10, 2, C.grassSh);
  p(x, y+2, 12, 7, C.outline);
  p(x+1, y+3, 10, 5, C.woodDk);
  p(x+1, y, 10, 4, C.outline);
  p(x+2, y+1, 8, 3, C.wood);
  p(x+4, y+2, 4, 1, C.woodLt);
  p(x+5, y+2, 2, 1, C.woodDk);
}

function logsTo(p, x, y){
  p(x+1, y+9, 14, 2, C.grassSh);
  for(let i=0;i<2;i++){
    const yy = y + 5 - i*4, w = 14 - i*3, xx = x + i*2;
    p(xx-1, yy-1, w+2, 6, C.outline);
    p(xx, yy, w, 4, C.woodDk);
    p(xx, yy, w, 1, C.wood);
    p(xx+w-4, yy, 4, 4, C.wood);
    p(xx+w-3, yy+1, 2, 2, C.woodLt);
  }
}

function barrelsTo(p, x, y){
  for(let i=0;i<2;i++){
    const xx = x + i*8, yy = y + (i?2:0);
    p(xx, yy+9, 7, 2, C.grassSh);
    p(xx-1, yy-1, 9, 11, C.outline);
    p(xx, yy, 7, 10, C.wood);
    p(xx, yy+2, 7, 1, C.woodDk);
    p(xx, yy+7, 7, 1, C.woodDk);
    p(xx+1, yy, 2, 10, C.woodLt);
  }
}

function rockTo(p, x, y, r){
  p(x, y+r*2-1, r*2+2, 2, C.grassSh);
  for(let dy=-r; dy<=r; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, r*r - dy*dy)));
    if(!hw) continue;
    p(x+r-hw, y+r+dy, hw*2, 1, C.outline);
    if(hw>1) p(x+r-hw+1, y+r+dy, hw*2-2, 1, dy>0 ? C.stoneDk : C.stone);
  }
  p(x+r-2, y+2, 2, 2, "#c3ccd2");
}

function shroomsTo(p, x, y){
  for(let i=0;i<2;i++){
    const xx = x + i*5, yy = y + (i?2:0);
    p(xx, yy+3, 3, 3, C.outline);
    p(xx+1, yy+3, 1, 2, "#f0e6d2");
    p(xx-1, yy, 5, 4, C.outline);
    p(xx, yy+1, 3, 2, "#d94f4a");
    p(xx+1, yy+1, 1, 1, "#f7dcd0");
  }
}

function benchTo(p, x, y, town){
  const d = TOWNS.find(z=>z.key===town) || FALLBACK_TOWN;
  p(x, y+12, 18, 2, C.grassSh);
  p(x-1, y+3, 20, 5, C.outline);
  p(x, y+4, 18, 3, C.wood);
  p(x, y+6, 18, 1, C.woodDk);
  p(x+1, y+8, 3, 5, C.woodDk);
  p(x+14, y+8, 3, 5, C.woodDk);
  p(x+3, y-1, 5, 5, C.outline);
  p(x+4, y, 3, 3, C.stone);
  p(x+11, y-2, 3, 6, C.outline);
  p(x+12, y-1, 1, 5, C.woodDk);
  p(x+10, y-3, 5, 3, C.outline);
  p(x+11, y-2, 3, 1, d.roofDark);
}

function bushTo(p, x, y, r){
  const cx=x+r, cy=y+r;
  p(x+1, cy+r+1, r*2-2, 2, C.grassSh);
  for(let dy=-r; dy<=r; dy++){
    const hw = Math.round(Math.sqrt(Math.max(0, r*r-dy*dy)));
    if(!hw) continue;
    p(cx-hw-1, cy+dy, hw*2+2, 1, C.outline);
    p(cx-hw, cy+dy, hw*2, 1, dy > r*0.3 ? C.leafDk : C.leaf);
  }
  p(cx-r+1, cy-r+2, 2, 2, C.leafLt);
}

function flowersTo(p, x, y, rnd){
  const petals = ["#f2d05a","#e87ba8","#f0f0f0"];
  for(let i=0;i<3;i++){
    const fx = x + i*4 + ((rnd()*2)|0), fy = y + ((rnd()*6)|0);
    p(fx, fy+2, 1, 2, C.leafDk);
    p(fx-1, fy, 3, 2, petals[i % petals.length]);
  }
}

/* ── the town square ────────────────────────────────────────────────────
   Where the two roads meet. Cobbled, with the wishing well at the centre,
   a couple of market stalls, a noticeboard and somewhere to sit.        */
const PLAZA = 108;

function cobbleTo(p, cx, cy, size, rnd){
  const half = size >> 1, rad = 20;
  const rowHalf = dy => {
    const d = Math.abs(dy) - (half - rad);
    if(d <= 0) return half;
    return Math.round((half - rad) + Math.sqrt(Math.max(0, rad*rad - d*d)));
  };
  for(let dy = -half; dy <= half; dy++){
    const hw = rowHalf(dy);
    p(cx-hw-1, cy+dy, hw*2+2, 1, C.outline);
    p(cx-hw, cy+dy, hw*2, 1, "#b9b2a4");
  }
  // individual cobbles, offset every other course
  for(let dy = -half+2; dy <= half-3; dy += 5){
    const hw = rowHalf(dy) - 2;
    const shift = ((dy/5)|0) % 2 ? 3 : 0;
    for(let dx = -hw+shift; dx < hw-4; dx += 7){
      const tone = rnd() > 0.72 ? "#cfc7b6" : (rnd() > 0.4 ? "#c4bcac" : "#aba393");
      p(cx+dx, cy+dy, 6, 4, tone);
      p(cx+dx, cy+dy+3, 6, 1, "#9d9585");
    }
  }
  // kerb
  for(let dy = -half; dy <= half; dy++){
    const hw = rowHalf(dy);
    p(cx-hw, cy+dy, 2, 1, "#8d857a");
    p(cx+hw-2, cy+dy, 2, 1, "#8d857a");
  }
}

function stallTo(p, x, y, stripe){
  // counter
  p(x+1, y+24, 30, 2, C.grassSh);
  p(x-1, y+15, 34, 11, C.outline);
  p(x, y+16, 32, 9, C.wood);
  p(x, y+18, 32, 1, C.woodDk);
  p(x+2, y+23, 3, 4, C.woodDk);
  p(x+27, y+23, 3, 4, C.woodDk);
  // posts
  p(x+1, y+2, 3, 14, C.woodDk);
  p(x+28, y+2, 3, 14, C.woodDk);
  // striped awning
  p(x-2, y-1, 36, 9, C.outline);
  for(let i=0;i<32;i+=4){
    p(x+i, y, 4, 7, (i/4)%2 ? "#f4f0e4" : stripe);
  }
  p(x-2, y+7, 36, 2, C.outline);
  for(let i=0;i<34;i+=6) p(x-1+i, y+8, 3, 2, (i/6)%2 ? "#f4f0e4" : stripe);
  // goods on the counter
  p(x+4, y+12, 5, 4, C.outline); p(x+5, y+13, 3, 2, "#d94f4a");
  p(x+11, y+13, 4, 3, C.outline); p(x+12, y+14, 2, 1, "#f2d05a");
  p(x+18, y+11, 6, 5, C.outline); p(x+19, y+12, 4, 3, C.leafDk);
  p(x+25, y+13, 4, 3, C.outline); p(x+26, y+14, 2, 1, "#e8a33c");
}

function noticeTo(p, x, y){
  p(x+2, y+22, 16, 2, C.grassSh);
  p(x+3, y+14, 3, 9, C.woodDk);
  p(x+13, y+14, 3, 9, C.woodDk);
  p(x-1, y-1, 22, 17, C.outline);
  p(x, y, 20, 15, C.woodDk);
  p(x+1, y+1, 18, 12, C.wood);
  // pinned notices
  p(x+3, y+3, 6, 5, "#f4f0e4"); p(x+4, y+4, 4, 1, "#8d857a"); p(x+4, y+6, 3, 1, "#8d857a");
  p(x+11, y+2, 6, 4, "#efe4c8"); p(x+12, y+3, 4, 1, "#8d857a");
  p(x+10, y+8, 7, 4, "#f4f0e4"); p(x+11, y+9, 5, 1, "#8d857a");
}

function plazaBenchTo(p, x, y){
  p(x+1, y+9, 20, 2, C.grassSh);
  p(x-1, y+1, 24, 5, C.outline);
  p(x, y+2, 22, 3, C.wood);
  p(x, y+4, 22, 1, C.woodDk);
  p(x+2, y+6, 3, 4, C.woodDk);
  p(x+17, y+6, 3, 4, C.woodDk);
  p(x-1, y-4, 24, 4, C.outline);
  p(x, y-3, 22, 2, C.wood);
}

function lanternTo(p, x, y){
  p(x, y+14, 6, 2, C.grassSh);
  p(x+1, y+4, 3, 11, C.outline);
  p(x+2, y+4, 1, 10, C.woodDk);
  p(x-1, y-3, 8, 8, C.outline);
  p(x, y-2, 6, 6, "#f2d05a");
  p(x+1, y-1, 4, 4, "#fff3c9");
  p(x, y-4, 6, 2, C.stoneDk);
}

function planterTo(p, x, y){
  p(x+1, y+9, 12, 2, C.grassSh);
  p(x-1, y+3, 16, 8, C.outline);
  p(x, y+4, 14, 6, C.wood);
  p(x, y+6, 14, 1, C.woodDk);
  p(x+1, y, 12, 4, C.leafDk);
  p(x+2, y-1, 10, 3, C.leaf);
  p(x+3, y-2, 2, 2, "#f2d05a");
  p(x+7, y-2, 2, 2, "#e87ba8");
  p(x+10, y-1, 2, 2, "#f4f0e4");
}

function plazaTo(p, cx, cy, rnd){
  cobbleTo(p, cx, cy, PLAZA, rnd);
  const h = PLAZA >> 1;
  stallTo(p, cx - h + 6,  cy - h + 8, "#d94f4a");
  stallTo(p, cx + 4,      cy + h - 34, "#4f8fd9");
  noticeTo(p, cx + h - 28, cy - h + 12);
  plazaBenchTo(p, cx - h + 8, cy + h - 22);
  lanternTo(p, cx - h + 4,  cy - 6);
  lanternTo(p, cx + h - 10, cy + 8);
  planterTo(p, cx + h - 24, cy + h - 18);
  planterTo(p, cx - h + 34, cy - h + 4);
  wellTo(p, cx - 11, cy - 6);
}

function wellTo(p, x, y){
  // stone ring
  p(x+1, y+21, 20, 3, C.grassSh);
  p(x-2, y+8, 26, 15, C.outline);
  p(x-1, y+9, 24, 13, C.stoneDk);
  for(let r2=0;r2<2;r2++)
    for(let i=0;i<24;i+=6)
      p(x+i-1 + (r2?3:0), y+10+r2*6, 5, 5, r2 ? C.stone : "#b3bdc4");
  p(x+4, y+11, 14, 8, C.outline);
  p(x+5, y+12, 12, 6, C.waterDk);
  p(x+6, y+13, 10, 4, C.water);
  p(x+7, y+13, 4, 1, "#bfe4f2");
  // posts and shingled roof
  p(x+1, y-6, 4, 15, C.outline);
  p(x+2, y-6, 2, 14, C.woodDk);
  p(x+17, y-6, 4, 15, C.outline);
  p(x+18, y-6, 2, 14, C.woodDk);
  for(let i=0;i<7;i++){
    const w = 8 + i*3, rx2 = x + 11 - (w>>1);
    p(rx2-1, y-13+i, w+2, 1, C.outline);
    p(rx2, y-13+i, w, 1, i%3===2 ? "#8f5a2e" : C.wood);
  }
  p(x-3, y-7, 28, 2, C.outline);
  p(x-2, y-7, 26, 1, "#8f5a2e");
  // rope and bucket
  p(x+10, y-5, 1, 8, "#e8dcc0");
  p(x+7, y+2, 8, 7, C.outline);
  p(x+8, y+3, 6, 5, C.wood);
  p(x+8, y+5, 6, 1, C.woodDk);
  p(x+6, y+2, 10, 1, C.woodDk);
}

function gardenTo(p, x, y, w, h){
  p(x-1, y-1, w+2, h+2, C.outline);
  p(x, y, w, h, C.soil);
  for(let ry=3; ry<h-2; ry+=7) p(x+2, y+ry, w-4, 3, C.soilDk);
  for(let ry=3; ry<h-2; ry+=7){
    for(let cx=4; cx<w-4; cx+=8){
      p(x+cx, y+ry-3, 4, 4, C.crop);
      p(x+cx+1, y+ry-4, 2, 2, "#5cb45f");
      if((cx+ry)%3===0) p(x+cx+1, y+ry-1, 2, 2, C.fruit);
    }
  }
  for(let fx=0; fx<=w; fx+=8){ p(x+fx-1, y-4, 2, h+8, C.woodDk); }
  p(x-1, y-3, w+2, 2, C.wood);
  p(x-1, y+h+1, w+2, 2, C.wood);
}

/* ---------- sprites ---------- */
function cottageName(raw){
  ctx.font = '8px "Silkscreen", monospace';
  let name=String(raw||'');
  while(name.includes('-')&&ctx.measureText(name).width>40)name=name.slice(0,name.lastIndexOf('-'));
  while(name.length>1&&ctx.measureText(name).width>40)name=name.slice(0,-1);
  return name;
}

function drawHouse(x, y, ag){
  const d = townStyle(ag);
  const dead = ag.status==="offline";
  const roof = dead ? C.off : d.roof, roofDk = dead ? C.offDk : d.roofDark;
  const wall = dead ? "#aab2b8" : C.wall, wallDk = dead ? "#8d959b" : C.wallDk;
  const O = C.outline;

  px(x+5, y+HOUSE_H-3, HOUSE_W-10, 3, C.grassSh);

  const bodyX = x+6, bodyW = 42, bodyY = y+36, bodyH = 27;
  px(bodyX-1, bodyY-1, bodyW+2, bodyH+2, O);
  px(bodyX, bodyY, bodyW, bodyH, wall);
  px(bodyX, bodyY+bodyH-8, bodyW, 8, wallDk);
  px(bodyX, bodyY, 4, bodyH, C.wood);
  px(bodyX+bodyW-4, bodyY, 4, bodyH, C.wood);
  px(bodyX+3, bodyY, 1, bodyH, C.woodDk);
  px(bodyX+bodyW-4, bodyY, 1, bodyH, C.woodDk);
  px(bodyX, bodyY+bodyH-4, bodyW, 4, C.stoneDk);
  for(let i=0;i<bodyW-2;i+=6) px(bodyX+i+1, bodyY+bodyH-3, 4, 2, C.stone);

  // roof
  const roofTop = y+2, rows = 21;
  for(let i=0;i<rows;i++){
    const w = 14 + Math.round(i*(HOUSE_W-14)/(rows-1));
    const rxx = x + ((HOUSE_W-w)>>1), ryy = roofTop+i;
    px(rxx-1, ryy, w+2, 1, O);
    px(rxx, ryy, w, 1, (i%3===2) ? roofDk : roof);
    if(i%3!==2) px(rxx+1, ryy, 2, 1, dead ? C.off : "#ffffff22");
  }
  px(x+19, roofTop-2, 16, 2, O);
  px(x+20, roofTop-1, 14, 1, roofDk);
  px(x, roofTop+rows, HOUSE_W, 2, O);
  px(x+1, roofTop+rows, HOUSE_W-2, 1, roofDk);
  px(x+37, y+4, 9, 17, O);
  px(x+38, y+5, 7, 16, C.stoneDk);
  px(x+38, y+5, 7, 3, C.stone);
  px(x+39, y+10, 2, 2, C.stone);
  px(x+42, y+14, 2, 2, C.stone);

  // model pennant on the ridge
  const flag = dead ? C.offDk : (MODEL_COLOR[ag.model] || "#63a4e0");
  px(x+25, y-8, 2, 13, O);
  px(x+27, y-8, 10, 2, O);
  for(let i=0;i<5;i++) px(x+27, y-6+i, 10-i*2, 1, i===2 ? O : flag);

  // facade nameplate
  const nb = {x: bodyX-2, y: y+23, w: bodyW+4, h: 13};
  px(nb.x-1, nb.y-1, nb.w+2, nb.h+2, O);
  px(nb.x, nb.y, nb.w, nb.h, C.woodDk);
  px(nb.x+1, nb.y+1, nb.w-2, nb.h-3, dead ? "#6c7278" : C.wood);
  px(nb.x+1, nb.y+1, nb.w-2, 1, dead ? "#7d8288" : C.woodLt);
  ctx.font = '8px "Silkscreen", monospace';
  ctx.textBaseline = "top";
  const nm = cottageName(ag.name);
  ctx.fillStyle = dead ? "#2d3238" : "#2b1d10";
  ctx.fillText(nm, nb.x + Math.round((nb.w - ctx.measureText(nm).width)/2), nb.y+3);

  // windows + door
  const lit = ag.status==="working";
  const winC = dead ? "#3d454b" : (lit ? C.winOn : C.winOff);
  [x+12, x+34].forEach(wx=>{
    px(wx-1, bodyY+4, 10, 10, O);
    px(wx, bodyY+5, 8, 8, winC);
    px(wx+3, bodyY+5, 1, 8, C.woodDk);
    px(wx, bodyY+8, 8, 1, C.woodDk);
    px(wx-2, bodyY+14, 12, 2, C.woodDk);
    if(lit) px(wx, bodyY+5, 8, 1, "#fff0b8");
  });
  const dx = x+23, dy = bodyY+9;
  px(dx-1, dy-1, 10, 19, O);
  px(dx, dy, 8, 18, C.woodDk);
  px(dx+1, dy+1, 6, 16, C.wood);
  px(dx+4, dy+1, 1, 16, C.woodDk);
  px(dx+5, dy+9, 1, 2, "#ffd166");
  px(dx-3, bodyY+bodyH, 14, 3, C.stone);
  px(dx-3, bodyY+bodyH+2, 14, 1, C.stoneDk);
}

function drawBranchPost(x, y, branch, dim){
  if(!branch) return;
  ctx.font = '8px "Silkscreen", monospace';
  ctx.textBaseline = "top";
  const seg = String(branch).split("/");
  let txt = seg[seg.length-1];
  while(txt.length > 1 && ctx.measureText(txt).width > 42) txt = txt.slice(0,-1);
  const w = Math.max(24, Math.round(ctx.measureText(txt).width) + 8);
  const bx2 = x + ((HOUSE_W - w) >> 1);
  px(bx2 + (w>>1) - 1, y+10, 3, 5, C.outline);
  px(bx2-1, y-1, w+2, 12, C.outline);
  px(bx2, y, w, 10, dim ? "#6c7278" : "#3f4c56");
  px(bx2, y, w, 1, dim ? "#7d8288" : "#55636f");
  ctx.fillStyle = dim ? "#9aa1a7" : "#bcd3e0";
  ctx.fillText(txt, bx2+4, y+1);
}

function drawShed(x, y, ag){
  const d = townStyle(ag);
  const dead = ag.status==="offline";
  const O = C.outline;
  px(x+1, y+15, 14, 2, C.grassSh);
  px(x+1, y+7, 14, 9, O);
  px(x+2, y+8, 12, 7, dead ? "#aab2b8" : C.wallDk);
  for(let i=0;i<5;i++){
    const w = 6 + i*2, rxx = x + 8 - (w>>1);
    px(rxx-1, y+2+i, w+2, 1, O);
    px(rxx, y+2+i, w, 1, (i===3) ? (dead?C.offDk:d.roofDark) : (dead?C.off:d.roof));
  }
  px(x, y+7, 16, 1, O);
  const lit = ag.status==="working";
  px(x+3, y+10, 4, 4, O);
  px(x+4, y+10, 2, 3, dead ? "#3d454b" : (lit ? C.winOn : C.winOff));
  px(x+9, y+9, 4, 6, C.woodDk);
  if(ag.status==="blocked" || ag.status==="done"){
    const col = ag.status==="blocked" ? C.alert : C.ok;
    px(x+6, y-3, 5, 5, O); px(x+7, y-2, 3, 3, col);
  }
}

const PERSON = [
  "...oooo...",
  "..ohhhho..",
  ".ohhhhhho.",
  ".ohssssho.",
  ".ohssssho.",
  "..osssso..",
  ".obbbbbbo.",
  "obbbbbbbbo",
  "obbbbbbbbo",
  "obbbbbbbbo",
  ".opp..ppo.",
  ".opp..ppo.",
  ".okk..kko.",
  "..oo..oo.."
];
function drawPerson(x, y, body, step){
  const pal = {o:C.outline, h:"#4a3320", s:"#f0bd8e", b:body, p:"#3f4a57", k:"#2b2118"};
  px(x+1, y+14, 8, 2, C.grassSh);
  PERSON.forEach((row, ry)=>{
    for(let cx=0; cx<row.length; cx++){
      const ch = row[cx];
      if(ch===".") continue;
      const ox = (step && ry>=10) ? (cx<5 ? 1 : -1) : 0;
      px(x+cx+ox, y+ry, 1, 1, pal[ch]);
    }
  });
}

/* Jack: navy shirt, red cap. Not a town-roof villager. */
const JACK = [
  "...rrrr....",
  "..rrrrrr...",
  ".rrhhhhrr..",
  ".ohssssho..",
  ".ohssssho..",
  "..osssso...",
  ".onnnnnno..",
  "onnnnnnnno.",
  "onnnnnnnno.",
  ".opp..ppo..",
  ".opp..ppo..",
  ".okk..kko..",
  "..oo..oo..."
];
function drawJack(x, y, step){
  const pal = {o:C.outline, r:"#c23b2e", h:"#3d2918", s:"#f0bd8e", n:"#2c4a6e", p:"#3f4a57", k:"#2b2118"};
  px(x+1, y+13, 8, 2, C.grassSh);
  JACK.forEach((row, ry)=>{
    for(let cx=0; cx<row.length; cx++){
      const ch = row[cx];
      if(ch===".") continue;
      const ox = (step && ry>=9) ? (cx<5 ? 1 : -1) : 0;
      px(x+cx+ox, y+ry, 1, 1, pal[ch]);
    }
  });
}

function letters(){
  return lettersOf(agents);
}

function letterWhy(ag){
  const attn = (ag.attention || "").trim();
  if(attn) return attn;
  const task = (ag.task || "").trim();
  if(task && task !== "-" && !/session ended/i.test(task)) return task;
  return (ag.lastLine || "needs you").trim();
}

function cursorUrl(p){
  const s = String(p || "");
  if(!s.startsWith("/") || s.length < 2) return "";
  return "cursor://file" + s.split("/").map(encodeURIComponent).join("/");
}

function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function drawMailbox(x, y, n){
  px(x+6, y+10, 2, 10, C.outline);
  px(x+6, y+10, 2, 9, C.stoneDk);
  px(x+1, y+2, 14, 10, C.outline);
  px(x+2, y+3, 12, 8, n ? "#3d4854" : "#6e7a83");
  px(x+3, y+4, 10, 2, n ? "#55636f" : "#8a949c");
  const flag = n ? "#c23b2e" : "#7d868e";
  px(x+13, y+3, 2, 7, C.outline);
  px(x+15, y+3, 5, 3, C.outline);
  px(x+15, y+4, 4, 2, flag);
  if(n){
    px(x+3, y+14, 8, 6, C.outline);
    px(x+4, y+15, 6, 4, "#f7f2e4");
    px(x+4, y+15, 6, 1, "#c23b2e");
    if(n > 1){
      px(x+5, y+17, 8, 6, C.outline);
      px(x+6, y+18, 6, 4, "#f4e6c8");
    }
    ctx.font = '8px "Silkscreen", monospace';
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff0e8";
    const label = n > 9 ? "9+" : String(n);
    ctx.fillText(label, x+18, y+14);
  }
}

function drawJackStoop(plot, n, on, over){
  const x = plot.x, y = plot.y;
  px(x+2, y+20, 28, 6, C.stoneDk);
  px(x+3, y+20, 26, 4, C.stone);
  px(x+6, y+6, 18, 14, C.outline);
  px(x+7, y+7, 16, 12, "#d9c39c");
  for(let i=0;i<6;i++){
    const w = 8 + i*2, rx = x + 15 - (w>>1);
    px(rx-1, y+i, w+2, 1, C.outline);
    px(rx, y+i, w, 1, i===3 ? "#6b1f1a" : "#c23b2e");
  }
  px(x+12, y+12, 6, 8, C.woodDk);
  px(x+13, y+13, 4, 6, C.wood);
  ctx.font = '8px "Silkscreen", monospace';
  ctx.textBaseline = "top";
  ctx.fillStyle = "#2b1d10";
  const you = "YOU";
  ctx.fillText(you, x + 15 - (ctx.measureText(you).width>>1), y-8);
  const bob = reduce ? 0 : Math.round(Math.sin(t*2)*0.5);
  if(!observatory) drawJack(x+22, y+12+bob, 0);
  drawMailbox(x+38, y+8, n);
  if(on || over){
    ctx.strokeStyle = on ? "#ffd166" : "#ffffff";
    ctx.lineWidth = 1;
    ctx.strokeRect(x-1.5, y-9, plot.w+3, plot.h+12);
  }
}

/* Livestock. Purely decorative — they carry no data, they just make the
   place feel inhabited instead of like a dashboard with grass on it. */
const SPRITES = {
  goose: { pal:{o:C.outline,h:"#f6f4ee",b:"#e8a33c",e:"#2b2118"}, rows:[
    "...ooo..",
    "..ohho..",
    "..oheo..",
    "..ohbb..",
    ".oohhoo.",
    "ohhhhhho",
    "ohhhhhho",
    ".ohhhho.",
    "..b..b.."
  ]},
  pig: { pal:{o:C.outline,p:"#e39aa8",n:"#c4707f",e:"#2b2118"}, rows:[
    "..oooooo..",
    ".opppppppo",
    "opppppppno",
    "oppeppppno",
    "oppppppppo",
    ".opppppppo",
    "..o.oo.o.."
  ]},
  duck: { pal:{o:C.outline,h:"#8fae5c",b:"#e8a33c",e:"#2b2118"}, rows:[
    "...ooo..",
    "..ohho..",
    "..oheo..",
    "..ohbb..",
    ".oohhoo.",
    "ohhhhhho",
    "ohhhhhho",
    ".ohhhho.",
    "..b..b.."
  ]},
  hen: { pal:{o:C.outline,h:"#c98a5a",b:"#d94f4a",e:"#2b2118"}, rows:[
    "...bb...",
    "..ohho..",
    "..oheo..",
    "..ohbb..",
    ".oohhoo.",
    "ohhhhhho",
    "ohhhhhho",
    ".ohhhho.",
    "..b..b.."
  ]},
  cat: { pal:{o:C.outline,a:"#d98b3a",e:"#2b2118",w:"#f2e2c2"}, rows:[
    ".o.o.....",
    "oaoao....",
    "oaeaeo...",
    "oaawaoooo",
    "oaaaaaaao",
    ".oaaaaao.",
    "..o.o.o.."
  ]}
};

function drawSprite(kind, x, y, flip){
  const s = SPRITES[kind];
  const w = s.rows[0].length;
  s.rows.forEach((row, ry)=>{
    for(let cx=0; cx<w; cx++){
      const ch = row[flip ? w-1-cx : cx];
      if(ch === ".") continue;
      px(x+cx, y+ry, 1, 1, s.pal[ch]);
    }
  });
}

const fauna = [];
function stockTown(){
  fauna.length = 0;
  // no fenced-off roaming boxes — the whole town is theirs, and if a goose
  // parks itself in front of a nameplate for a minute, so be it
  const box = { x: 14, y: 14, w: W-30, h: H-30 };
  const add = (kind, x, y) => fauna.push({
    kind, x, y, tx:x, ty:y, wait:Math.random()*4,
    box, flip:false, bob:Math.random()*6
  });
  const spread = [
    ["goose", 0.14, 0.30], ["goose", 0.62, 0.18],
    ["duck", 0.46, 0.52], ["pig", 0.34, 0.44],
    ["cat",   0.18, 0.82], ["cat",   0.86, 0.36]
  ];
  spread.forEach(([k, fx, fy]) => add(k, Math.round(W*fx), Math.round(H*fy)));
  const duck=fauna.find(f=>f.kind==="duck"),pond=scenePonds[0];
  if(duck&&pond){duck.x=pond.x+pond.w*.5;duck.y=pond.y+pond.h+12;duck.tx=duck.x;duck.ty=duck.y;duck.mode="wandering";}

}

function moveFauna(){
  for(const f of fauna){
    const player=observatory?.mode==="town"?observatory?.player:null;
    if(f.kind==="duck"&&scenePonds[0]&&player){
      const event=advanceDuck(f,player,scenePonds[0],frameDt,t);
      if(event)observatory.sound.play(event,{distance:Math.hypot(f.x-player.x,f.y-player.y)});
      if(event==="splash")f.splashUntil=t+1.1;
      if(reduce&&f.mode==="fleeing"){f.x=f.target.x;f.y=f.target.y;}
      if(["fleeing","swimming","returning"].includes(f.mode))continue;
      // Ducks linger at their pond instead of vanishing into a distant wood.
      const pond=scenePonds[0];
      if(f.ty<pond.y+pond.h+8||Math.hypot(f.tx-(pond.x+pond.w/2),f.ty-(pond.y+pond.h+16))>50){f.tx=pond.x+pond.w/2;f.ty=pond.y+pond.h+16;}
    }
    if(reduce)continue;
    if(player&&f.kind==="goose"&&Math.hypot(f.x-player.x,f.y-player.y)<48){f.tx=player.x-12;f.ty=player.y-10;if(Math.hypot(f.x-player.x,f.y-player.y)<15)observatory.sound.play("quack",{distance:12});}
    if(player&&f.kind==="cat"&&Math.hypot(f.x-player.x,f.y-player.y)<22){f.tx=f.x+(f.x-player.x)*3;f.ty=f.y+(f.y-player.y)*3;}
    if(f.wait > 0){ f.wait -= frameDt; continue; }
    const dx = f.tx - f.x, dy = f.ty - f.y;
    if(Math.hypot(dx, dy) < 1.2){
      const pond=f.kind==="duck"?scenePonds[0]:null;
      f.tx = pond?pond.x+8+Math.random()*(pond.w-16):f.box.x + Math.random()*f.box.w;
      f.ty = pond?pond.y+pond.h+10+Math.random()*20:f.box.y + Math.random()*f.box.h;
      f.wait = 0.6 + Math.random()*4;
      continue;
    }
    const spd = (f.kind === "pig" ? 9.6 : (f.kind === "cat" ? 18 : 14.4))*frameDt;
    f.x += Math.max(-spd, Math.min(spd, dx * 0.05));
    f.y += Math.max(-spd, Math.min(spd, dy * 0.05));
    f.flip = dx < 0;
  }
}

function drawFauna(){
  for(const f of fauna){
    const moving = !reduce&&f.wait <= 0;
    if(f.splashUntil>t){
      const spread=reduce?7:Math.round((1.1-(f.splashUntil-t))*12);
      px(Math.round(f.x)-spread,Math.round(f.y)+5,4,2,"#c4eeeb");px(Math.round(f.x)+spread,Math.round(f.y)+5,4,2,"#c4eeeb");
      px(Math.round(f.x)+4,Math.round(f.y)-spread,2,3,"#d9f5ef");
    }
    if(f.mode==="swimming"){
      px(Math.round(f.x)-2,Math.round(f.y)+7,15,1,"#a2d9dd");
      px(Math.round(f.x)+1,Math.round(f.y)+10,9,1,"#76bccd");
    }
    const hop = (moving && f.kind !== "pig" && f.kind !== "cat"
                 && Math.floor(t*6 + f.bob) % 2) ? -1 : 0;
    px(Math.round(f.x)+1, Math.round(f.y)+ (f.kind==="pig"?7:9), 6, 2, C.grassSh);
    drawSprite(f.kind, Math.round(f.x), Math.round(f.y)+hop, f.flip);
  }
}

function drawBubble(x, y, kind){
  const col = kind==="blocked" ? C.alert : C.ok;
  px(x-1, y-1, 13, 13, C.outline);
  px(x, y, 11, 11, col);
  px(x+1, y+1, 9, 2, "#ffffff33");
  px(x+4, y+11, 3, 3, C.outline);
  px(x+4, y+11, 3, 2, col);
  if(kind==="blocked"){
    px(x+5, y+2, 2, 5, "#fff"); px(x+5, y+8, 2, 2, "#fff");
  } else {
    px(x+2, y+5, 2, 2, "#1f3a1a"); px(x+3, y+6, 2, 2, "#1f3a1a");
    px(x+4, y+5, 2, 2, "#1f3a1a"); px(x+5, y+4, 2, 2, "#1f3a1a"); px(x+7, y+2, 2, 2, "#1f3a1a");
  }
}

function wrapText(text, maxW){
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for(const w of words){
    const attempt = line ? line+" "+w : w;
    if(ctx.measureText(attempt).width > maxW && line){ lines.push(line); line = w; }
    else line = attempt;
    if(lines.length === 2) break;
  }
  if(lines.length < 2 && line) lines.push(line);
  if(lines.length === 2){
    let last = lines[1];
    const consumed = lines.join(" ").length;
    if(consumed < String(text).length){
      while(ctx.measureText(last+"...").width > maxW && last.length) last = last.slice(0,-1);
      lines[1] = last + "...";
    }
  }
  return lines;
}

function drawThought(cx, bottomY, text, revealed){
  if(!text) return;
  ctx.font = '8px "Silkscreen", monospace';
  ctx.textBaseline = "top";
  const lines = wrapText(text, 78);
  const shown = (revealed == null) ? Infinity : revealed;
  const w = Math.max(34, Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width))) + 10);
  const h = lines.length*10 + 7;
  const x = Math.min(W-w-2, Math.max(2, Math.round(cx - w/2)));
  const y = bottomY - h - 9;
  px(cx-2, bottomY-3, 4, 4, C.outline);
  px(cx-1, bottomY-2, 2, 2, "#f7f2e4");
  px(cx-3, bottomY-8, 5, 5, C.outline);
  px(cx-2, bottomY-7, 3, 3, "#f7f2e4");
  px(x-1, y-1, w+2, h+2, C.outline);
  px(x, y, w, h, "#f7f2e4");
  px(x+1, y+1, w-2, 1, "#ffffff");
  // reveal the message a character at a time, like it's still being written
  ctx.fillStyle = C.outline;
  let budget = shown;
  lines.forEach((l,i)=>{
    if(budget <= 0) return;
    const part = l.slice(0, Math.max(0, Math.floor(budget)));
    ctx.fillText(part, x+5, y+4+i*10);
    if(part.length < l.length || (i === lines.length-1 && budget < l.length + 0.5)){
      if(Math.floor(t*6) % 2) px(x+5+ctx.measureText(part).width, y+4+i*10, 4, 7, C.outline);
    }
    budget -= l.length;
  });
}

function drawSparks(x, y, seed){
  for(let i=0;i<3;i++){
    const life = ((t*1.6 + i*0.4 + seed*0.05) % 1);
    ctx.globalAlpha = 1-life;
    px(x + Math.round(Math.sin((life+i)*6)*5), y - Math.round(life*9), 2, 2, i===1 ? "#ffd166" : "#fff0b8");
  }
  ctx.globalAlpha = 1;
}

function drawSmoke(x, y, phase){
  for(let i=0;i<3;i++){
    const life = (phase + i*0.33) % 1;
    const sy = y - life*20;
    const sx = x + Math.sin((life*3+i)*2.2)*4;
    const sz = 3 + Math.round(life*3);
    ctx.globalAlpha = 0.8*(1-life);
    px(sx, sy, sz, sz, C.smoke);
    ctx.globalAlpha = 1;
  }
}

function signWidth(label){
  ctx.font = '8px "Silkscreen", monospace';
  return Math.max(46, Math.round(ctx.measureText(label).width) + 12);
}
function drawSign(x, y, label, color){
  ctx.font = '8px "Silkscreen", monospace';
  const w = signWidth(label);
  px(x+4, y+14, 4, 9, C.outline);
  px(x+w-8, y+14, 4, 9, C.outline);
  px(x+5, y+14, 2, 8, C.wood);
  px(x+w-7, y+14, 2, 8, C.wood);
  px(x-1, y-1, w+2, 16, C.outline);
  px(x, y, w, 14, C.woodDk);
  px(x+2, y+2, w-4, 10, color);
  px(x+2, y+2, w-4, 2, "#ffffff2e");
  ctx.fillStyle = C.outline;
  ctx.textBaseline = "top";
  ctx.fillText(label, x+6, y+4);
}

/* ---------- layout ---------- */
function visibleAgents(){
  return agents.filter(a => showSettled || a.occupancy !== "settled" || hasOutstandingPr(a) || observatory?.state.interiorId===a.id);
}

function drawParcel(x, y, state){
  if(!state || state === "none") return;
  const col = state === "merged" ? C.ok : "#e8c15a";
  px(x-6, y+HOUSE_H-10, 8, 7, C.outline);
  px(x-5, y+HOUSE_H-9, 6, 5, col);
  px(x-4, y+HOUSE_H-11, 4, 2, C.woodDk);
  if(state === "merged"){
    px(x-4, y+HOUSE_H-7, 4, 1, C.outline);
    px(x-3, y+HOUSE_H-6, 2, 1, C.outline);
  }
}

function layout(){
  const vis=visibleAgents();
  const world=stableLayout.update(vis);
  const styles=districtsFrom(agents);
  TOWNS=world.blocks.map(b=>({...styles.find(d=>d.key===b.key)||FALLBACK_TOWN,key:b.key,label:b.key.toUpperCase()+(b.page?" ANNEX":"")}));
  DR=world.blocks;sceneDistricts=DR;
  if(!TOWNS.length){TOWNS=[{key:"HubTown",label:"HOME HUBTOWN",...TOWN_PALETTE[0]}];DR=[{key:"HubTown",x:MARGIN,y:MARGIN,w:world.districtWidth,h:340,row:0,col:0}];sceneDistricts=DR;}
  COLS=world.columns;D_W=world.districtWidth;VERT_ROAD=world.roadX;HORZ_ROADS=world.roadYs;
  ROAD_Y=HORZ_ROADS[0];W=world.width;H=world.height+112;
  if(cv.width!==W||cv.height!==H){cv.width=W;cv.height=H;bg.width=W;bg.height=H;ctx.imageSmoothingEnabled=false;}
  plots=world.plots.map(p=>({...p,district:townStyle(p.agent),
    kids:vis.filter(a=>a.parent===p.agent.id&&world.shedSlots[a.id]<3&&!world.plots.some(q=>q.agent.id===a.id)).map(a=>({agent:a,x:p.x+1+world.shedSlots[a.id]*18,y:p.y+HOUSE_H+SHED_Y}))}));
  gardens=[];
  const signature=JSON.stringify(plots.map(p=>[p.agent.id,p.x,p.y,p.kids.map(k=>k.agent.id)]))+W+":"+H;
  if(signature!==layoutSignature){paintBackground();layoutSignature=signature;}
  if(!fauna.length)stockTown();
  placeJack();
}
let layoutSignature="";

function placeJack(){
  const di = TOWNS.findIndex(d => d.key === "HubTown");
  if(di < 0 || !DR[di]){ jackPlot = null; return; }
  const r = DR[di];
  const signW = signWidth("HOME HUBTOWN");
  const signX = r.col === 1 ? r.x + r.w - PAD - signW : r.x + PAD;
  const x = r.col === 1 ? signX - 72 : signX + signW + 8;
  const y = r.y + PAD + 2;
  jackPlot = { x, y, w: 62, h: 28 };
}

/* ---------- frame ---------- */
function draw(){
  t = performance.now()/1000;
  frameDt=Math.min(.05,lastDrawAt?t-lastDrawAt:1/60);lastDrawAt=t;
  const villageLight=observatory?.lightAt(t);
  bedtimeFrames=bedtime.update(plots,villageLight,{time:t,reduce});
  const bedtimeLabel=villageLifeLabel(villageLight,bedtimeFrames);
  if(bedtimeLabel!==lastBedtimeLabel){const note=document.getElementById('village-life');if(note)note.textContent=bedtimeLabel;cv.setAttribute('aria-description',bedtimeLabel+'. Warm windows mark agents still working.');lastBedtimeLabel=bedtimeLabel;}
  ctx.drawImage(bg, 0, 0);

  TOWNS.forEach((d, di)=>{
    const r = DR[di];
    if(!r) return;
    ctx.globalAlpha = (filter && filter!==d.key) ? 0.35 : 1;
    const sx = r.col === 1 ? r.x + r.w - PAD - signWidth(d.key === "HubTown" ? "HOME HUBTOWN" : d.label) : r.x + PAD;
    drawSign(sx, r.y + PAD, d.key === "HubTown" ? "HOME HUBTOWN" : d.label, d.roof);
    ctx.globalAlpha = 1;
  });
  if(jackPlot){
    ctx.globalAlpha = (filter && filter !== "HubTown") ? 0.35 : 1;
    drawJackStoop(jackPlot, letters().length, selectedId===JACK_ID, hoverId===JACK_ID);
    ctx.globalAlpha = 1;
  }

  plots.forEach(p=>{
    const ag = p.agent;
    const faded = (filter && filter !== townKey(ag)) || (observatory && !observatory.visible(ag));
    ctx.globalAlpha = faded ? 0.3 : 1;

    drawHouse(p.x, p.y, ag);
    drawBranchPost(p.x, p.y+HOUSE_H+SIGN_Y, ag.branch || ag.worktree, ag.status==="offline");
    if(ag.status === "working"){
      const phase = reduce ? 0.4 : (t*0.35 + p.x*0.07) % 1;
      drawSmoke(p.x+40, p.y+2, phase);
    }

    const routine=bedtimeFrames.get(ag.id);
    if(routine)paintCoop(ctx,routine);
    // Villagers bring their family home; real work continues behind lit glass.
    const door = {x: p.x+22, y: p.y+HOUSE_H-15};
    let a = actors.get(ag.id);
    if(!a){
      a = {x:door.x, y:door.y, indoors:true, line:ag.lastLine, popUntil:0};
      actors.set(ag.id, a);
    }
    if(ag.lastLine !== a.line){
      a.line = ag.lastLine;
      a.streamAt = t;
      const typeTime = ag.lastLine.length / 26;
      if(!reduce && pops < 2 && ag.status !== "offline"){ a.popUntil = t + typeTime + 2.6; pops++; }
    }
    if(a.popUntil && t > a.popUntil){ a.popUntil = 0; pops = Math.max(0, pops-1); }

    let target = {x: door.x, y: door.y+3}, working = false;
    if(ag.status === "working"){
      target = {x: p.x+16, y: p.y+HOUSE_H+BENCH_Y-3}; working = true;   // at the bench
    } else if(ag.status === "idle"){
      const pace = reduce ? 0 : Math.sin(t*0.7 + p.x)*10;
      target = {x: p.x+22+pace, y: p.y+HOUSE_H-14};
    } else if(ag.status === "offline"){
      target = door;
    }
    if(routine?.evening){target={x:routine.parent.x-5,y:routine.parent.y-14};working=false;}
    if(routine?.settled){a.indoors=true;a.x=routine.door.x-5;a.y=routine.door.y-14;}

    if(!routine?.settled&&!(ag.status === "offline" && a.indoors)){
      const spd = reduce ? 999 : frameDt*40;
      const dx = target.x - a.x, dy = target.y - a.y;
      const dist = Math.hypot(dx, dy);
      a.x += Math.max(-spd, Math.min(spd, dx));
      a.y += Math.max(-spd, Math.min(spd, dy));
      const moving = dist > 1;
      if(ag.status === "offline" && dist < 1.5) a.indoors = true;
      else if(ag.status !== "offline") a.indoors = false;

      if(!a.indoors){
        const atBench = working && dist < 2;
        const step = reduce ? 0 : (moving ? (Math.floor(t*6 + p.x) % 2) : 0);
        const bob  = (atBench && !reduce) ? (Math.floor(t*7) % 2) : 0;
        if(observatory)renderResident(ctx,Math.round(a.x)+5,Math.round(a.y)+bob+14,observatory.resident(ag),{time:t*1000,walking:!!step,scale:1,talking:observatory.isTalking(ag.id),reduce});
        else drawPerson(Math.round(a.x),Math.round(a.y)+bob,townStyle(ag).roof,step);
        if(atBench && !reduce) drawSparks(p.x+35, p.y+HOUSE_H+3, p.x);
        if(ag.status === "blocked" || ag.status === "done"){
          const bb = reduce ? 0 : Math.round(Math.sin(t*3 + p.x));
          drawBubble(Math.round(a.x)+9, Math.round(a.y)-15+bb, ag.status);
        }
      }
    }
    (p.kids||[]).forEach(k=>{
      drawShed(k.x, k.y, k.agent);
      if(k.agent.status==="working" && !reduce){
        const ph = (t*0.5 + k.x*0.1) % 1;
        ctx.globalAlpha = (faded?0.3:1) * 0.6*(1-ph);
        px(k.x+10, k.y+1 - ph*8, 2, 2, C.smoke);
        ctx.globalAlpha = faded ? 0.3 : 1;
      }
      if(k.agent.id===selectedId || k.agent.id===hoverId){
        ctx.strokeStyle = k.agent.id===selectedId ? "#ffd166" : "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(k.x-1.5, k.y-1.5, 19, 19);
      }
    });
    for(const kid of routine?.kids||[]){
      if(kid.hidden)continue;
      const agent=p.kids.find(k=>k.agent.id===kid.id)?.agent;
      if(agent)renderResident(ctx,Math.round(kid.x),Math.round(kid.y),observatory.resident(agent),{time:t*1000,walking:kid.walking,scale:.62,reduce});
    }
    for(const hen of routine?.hens||[]){
      if(hen.hidden)continue;
      const hop=!reduce&&hen.walking&&Math.floor(t*5+hen.index)%2?-1:0;
      drawSprite('hen',Math.round(hen.x)-4,Math.round(hen.y)-9+hop,hen.flip);
    }
    ctx.globalAlpha = 1;

    const on = ag.id===selectedId, over = ag.id===hoverId;
    if(on || over){
      ctx.strokeStyle = on ? "#ffd166" : "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x-1.5, p.y-1.5, HOUSE_W+3, HOUSE_H+3);
    }
  });
  moveFauna();
  drawFauna();
  observatory?.drawAtmosphere(ctx,{width:W,height:H,ponds:scenePonds,trees:sceneSolids.filter(r=>r.w===6&&r.h===8),plots:plots.map(p=>({...p,opacity:(filter&&filter!==townKey(p.agent))||!observatory.visible(p.agent)?0.3:1}))},t);
  const nightInk=Math.min(1,(observatory?.lightAt(t).darkness||0)/.4);
  if(nightInk>0){
    ctx.textBaseline='top';ctx.fillStyle='#bacbe2';
    TOWNS.forEach((d,di)=>{
      const r=DR[di];if(!r)return;
      const label=d.key==='HubTown'?'HOME HUBTOWN':d.label;
      const sx=r.col===1?r.x+r.w-PAD-signWidth(label):r.x+PAD;
      ctx.globalAlpha=nightInk*((filter&&filter!==d.key) ? .35 : 1);
      ctx.fillText(label,sx+6,r.y+PAD+4);
    });
    for(const p of plots){
      ctx.globalAlpha=nightInk*(((filter&&filter!==townKey(p.agent))||!observatory.visible(p.agent)) ? .3 : 1);
      const name=cottageName(p.agent.name);
      ctx.fillText(name,p.x+4+Math.round((46-ctx.measureText(name).width)/2),p.y+26);
    }
    ctx.globalAlpha=1;
  }
  // Operational colors are drawn after the blue palette, without daylight holes.
  for(const p of plots){
    ctx.globalAlpha=(filter&&filter!==townKey(p.agent))||!observatory?.visible(p.agent)?0.3:1;
    observatory?.drawDispatch(ctx,p,t);
    if(bedtimeFrames.get(p.agent.id)?.settled&&['blocked','done'].includes(p.agent.status))drawBubble(p.x+47,p.y+22,p.agent.status);
    for(const kid of p.kids||[])if(['blocked','done'].includes(kid.agent.status)){
      px(kid.x+6,kid.y-3,5,5,C.outline);px(kid.x+7,kid.y-2,3,3,kid.agent.status==='blocked'?C.alert:C.ok);
    }
  }
  ctx.globalAlpha=1;

  plots.forEach(p=>{
    if(filter && filter !== townKey(p.agent)) return;
    const a = actors.get(p.agent.id);
    if(!a) return;
    if(a.indoors&&!(bedtimeFrames.get(p.agent.id)?.evening&&(p.agent.id===hoverId||p.agent.id===selectedId)))return;
    const show = p.agent.id===hoverId || p.agent.id===selectedId || (a.popUntil && t < a.popUntil);
    if(!show) return;
    const revealed = reduce ? Infinity : (t - (a.streamAt ?? 0)) * 26;
    const thought = observatory?.latestLine(p.agent) || p.agent.activity || p.agent.lastLine;
    drawThought(Math.round(a.x)+5, a.indoors?p.y+20:Math.round(a.y)-2, thought, revealed);
  });

  observatory?.draw(t);
  requestAnimationFrame(draw);
}

/* ---------- interaction ---------- */
function hit(evt){
  const r = cv.getBoundingClientRect();
  const x = (evt.clientX - r.left) * (W / r.width);
  const y = (evt.clientY - r.top) * (H / r.height);
  if(jackPlot && !(filter && filter !== "HubTown")){
    const j = jackPlot;
    if(x>=j.x-2 && x<=j.x+j.w+8 && y>=j.y-10 && y<=j.y+j.h+10) return JACK_ID;
  }
  for(const p of plots){
    if(filter && filter !== townKey(p.agent)) continue;
    for(const k of (p.kids||[])) if(x>=k.x-2 && x<=k.x+18 && y>=k.y-4 && y<=k.y+17) return k.agent.id;
    if(x>=p.x && x<=p.x+HOUSE_W && y>=p.y-4 && y<=p.y+HOUSE_H+6) return p.agent.id;
  }
  return null;
}
function walkIds(){
  const vis = [];
  if(jackPlot && !(filter && filter !== "HubTown")) vis.push(JACK_ID);
  plots.forEach(p=>{
    if(filter && filter!==townKey(p.agent)) return;
    vis.push(p.agent.id);
    (p.kids||[]).forEach(k=>vis.push(k.agent.id));
  });
  return vis;
}
function openBest(ag){
  if(!ag) return;
  if(ag.pr && ag.pr.url){ window.open(ag.pr.url, "_blank", "noopener"); return; }
  const cur = cursorUrl(ag.worktreePath);
  if(cur){
    const a = document.createElement("a");
    a.href = cur;
    a.click();
  }
}
cv.addEventListener("mousemove", e=>{ hoverId = hit(e); cv.style.cursor = hoverId ? "pointer":"default"; });
cv.addEventListener("mouseleave", ()=>{ hoverId = null; });
cv.addEventListener("click", e=>{
  if(observatory?.handleClick(e))return;
  const id=hit(e);if(id){selectedId=id;renderPanel();}
});
cv.addEventListener("dblclick", e=>{
  const id = hit(e);
  if(!id || id === JACK_ID) return;
  e.preventDefault();
  openBest(agents.find(a=>a.id===id));
});
/* ---------- panel ---------- */
const STATUS_COLOR = {working:"#ffd166", idle:"#93a1b0", blocked:"#e2504a", done:"#79c25f", offline:"#7d868e"};
const STATUS_TEXT  = {working:"working", idle:"idle", blocked:"blocked", done:"finished", offline:"offline"};
const panel = document.getElementById("panel");

function uptime(ms){
  const s = Math.max(0, Math.floor((Date.now()-ms)/1000));
  const h = (s/3600)|0, m = ((s%3600)/60)|0;
  return h ? `${h}h ${m}m` : `${m}m ${s%60}s`;
}
function clock(ms){
  return new Date(ms).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}
function money(n){
  return n >= 1 ? `$${n.toFixed(2)}` : `${(n*100).toFixed(1)}c`;
}
function burnRate(ag){
  const mins = ag.taskStartedAt ? (Date.now() - ag.taskStartedAt) / 60000 : 0;
  return mins > 0.5 ? money(ag.cost/mins) + "/min" : "—";
}
function renderJackPanel(){
  const pile = letters();
  const n = pile.length;
  panel.innerHTML = `
    <h2>Jack</h2>
    <p class="role-line">HubTown · you</p>
    <span class="status-chip"><i style="width:8px;height:8px;background:${n ? "#e2504a" : "#79c25f"};display:inline-block"></i>${n ? n + " letter" + (n===1?"":"s") : "stoop is clear"}</span>
    ${n ? `<div class="letters">${pile.map(ag => `
      <button type="button" class="letter" data-jump="${esc(ag.id)}">
        <div class="who">${esc(ag.name)} · ${esc(ag.town || "")}</div>
        <div class="why">${esc(letterWhy(ag))}</div>
      </button>`).join("")}</div>` : `<p class="hint">No mail. Nobody on the map needs you right now.</p>`}`;
  panel.querySelectorAll("[data-jump]").forEach(b=>{
    b.onclick = ()=>{ selectedId = b.dataset.jump; renderPanel(); };
  });
}

function launchHtml(ag){
  const bits = [];
  const cur = cursorUrl(ag.worktreePath);
  if(cur){
    bits.push(`<a class="go" href="${esc(cur)}">open worktree</a>`);
    bits.push(`<button type="button" data-copy="${esc(ag.worktreePath)}">copy path</button>`);
  }
  if(ag.pr && ag.pr.url){
    const merged = ag.pr.state === "merged";
    bits.push(`<a class="go pr${merged ? " merged" : ""}" href="${esc(ag.pr.url)}" target="_blank" rel="noreferrer">${merged ? "open merged PR" : "open PR"}</a>`);
  }
  if(ag.handoffUrl){
    bits.push(`<a class="go" href="${esc(ag.handoffUrl)}" target="_blank" rel="noreferrer">babysit</a>`);
  }
  return bits.length ? `<div class="launch">${bits.join("")}</div>` : "";
}

function renderPanel(){
  if(observatory?.renderPanel(selectedId))return;
  if(selectedId === JACK_ID){
    renderJackPanel();
    return;
  }
  const ag = agents.find(a=>a.id===selectedId);
  if(!ag){
    panel.innerHTML = `<p class="hint">Click a cottage to inspect, or focus the map and use arrow keys to walk. E enters a nearby door.</p>`;
    return;
  }
  const d = townStyle(ag);
  const mum = ag.parent ? agents.find(a=>a.id===ag.parent) : null;
  const kids = agents.filter(a=>a.parent===ag.id);
  const live = ag.status !== "offline";
  const pr = ag.pr || {};
  const prLine = pr.state && pr.state !== "none"
    ? `${pr.state === "merged" ? "merged" : "open"} ${pr.number ? "#"+pr.number : ""} ${pr.title || ""}`.trim()
    : "none we can see";
  const startedOk = ag.startedAt && ag.startedAt > Date.parse("2020-01-01");
  panel.innerHTML = `
    <h2>${esc(ag.name)}</h2>
    <p class="role-line">${mum ? `shed in ${esc(mum.name)}'s yard` : (d.key === "HubTown" ? "HubTown · home" : esc(d.key))}</p>
    <span class="status-chip"><i style="width:8px;height:8px;background:${STATUS_COLOR[ag.status]};display:inline-block"></i>${STATUS_TEXT[ag.status]}</span>
    ${live && ag.activity ? `<p class="doing">${esc(ag.activity)}</p>` : ""}
    <dl>
      <dt>Worktree</dt><dd>${esc(ag.worktree || ag.worktreePath || "-")}</dd>
      <dt>Branch</dt><dd>${esc(ag.branch || "-")}</dd>
      <dt>Task</dt><dd>${esc(ag.task)}</dd>
      <dt>Result</dt><dd>${esc(ag.result || ag.lastLine || "-")}</dd>
      <dt>PR</dt><dd>${pr.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noreferrer">${esc(prLine)}</a>` : esc(prLine)}</dd>
      <dt>Model</dt><dd><span style="color:${MODEL_COLOR[ag.model]||'#63a4e0'}">&#9646;</span> ${esc(ag.model)}</dd>
      <dt>Sent by</dt><dd>${mum ? `${esc(mum.name)} <span class="muted">(agent)</span>` : esc(ag.dispatchedBy)}</dd>
      <dt>Started</dt><dd>${startedOk ? `${clock(ag.startedAt)} <span class="muted">· ${uptime(ag.startedAt)} ago</span>` : "-"}</dd>
      <dt>Cost</dt><dd>${money(ag.cost)} <span class="muted">· ${live ? burnRate(ag) : "this run"}</span></dd>
      <dt>Tokens</dt><dd>${ag.tokens.toLocaleString()}</dd>
      ${kids.length ? `<dt>Spawned</dt><dd>${kids.map(k=>`<span style="color:${STATUS_COLOR[k.status]}">●</span> ${esc(k.name)} <span class="muted">${money(k.cost)}</span>`).join("<br>")}</dd>` : ""}
    </dl>
    <div class="log">${esc(ag.result || ag.lastLine || "")}</div>
    ${launchHtml(ag)}
    ${LIVE ? `<p class="hint">Pause, wake, and shut down stay on the demo townmap. They do not touch live cottages.</p>` : `<div class="acts">
      <button data-act="${ag.status==="working" ? "idle" : "working"}">${ag.status==="working" ? "pause" : "wake"}</button>
      <button class="danger" data-act="offline">shut down</button>
    </div>`}`;
  panel.querySelectorAll("[data-act]").forEach(b=>{
    b.onclick = ()=>{ SIM.set(ag.id, b.dataset.act); refresh(); };
  });
  panel.querySelectorAll("[data-copy]").forEach(b=>{
    b.onclick = async ()=>{
      try{
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = "copied";
        setTimeout(()=>{ b.textContent = "copy path"; }, 1200);
      }catch{
        b.textContent = "copy failed";
      }
    };
  });
}

/* ---------- chrome ---------- */
const tally = document.getElementById("tally");
function renderTally(){
  tally.innerHTML = "";
  const vis = visibleAgents();
  const towns = districtsFrom(vis);
  towns.forEach(d=>{
    const n = vis.filter(a=>townKey(a)===d.key).length;
    const busy = vis.filter(a=>townKey(a)===d.key && a.status==="working").length;
    const b = document.createElement("button");
    b.setAttribute("aria-pressed", filter===d.key ? "true":"false");
    b.innerHTML = `<span class="dot" style="background:${d.roof}"></span>${esc(d.key === "HubTown" ? "HubTown home" : d.key)}<span class="n">${busy}/${n}</span>`;
    b.onclick = ()=>{ filter = (filter===d.key) ? null : d.key; renderTally(); };
    tally.appendChild(b);
  });
  const mailN = letters().length;
  const mailBtn = document.createElement("button");
  mailBtn.setAttribute("aria-pressed", selectedId===JACK_ID ? "true":"false");
  mailBtn.innerHTML = `<span class="dot" style="background:#c23b2e"></span>letters<span class="n">${mailN}</span>`;
  mailBtn.onclick = ()=>{ selectedId = JACK_ID; renderTally(); renderPanel(); };
  tally.appendChild(mailBtn);
  const busy = vis.filter(a=>a.status==="working").length;
  const spend = vis.filter(a=>a.occupancy==="live" || a.occupancy==="recent").reduce((n,a)=>n + (a.cost||0), 0);
  const settledN = agents.filter(a=>a.occupancy==="settled").length;
  document.querySelector(".sub").textContent =
    `${busy} working · ${money(spend)} this window` +
    (mailN ? ` · ${mailN} letter${mailN===1?"":"s"}` : "") +
    (settledN ? ` · ${settledN} settled` : "");
  const sb = document.getElementById("settled");
  if(sb){
    sb.textContent = `settled (${settledN})`;
    sb.setAttribute("aria-pressed", showSettled ? "true":"false");
  }
}
const noteEl = document.getElementById("note");
function feedNote(msg, color){ noteEl.textContent = msg; noteEl.style.color = color || "#93a1b0"; }

document.getElementById("connect").onclick = ()=>{
  if(PUBLIC_DEMO){
    ENDPOINT=null;document.getElementById("endpoint").value="";
    feedNote("Sample village · fictional agents and activity.");
    return;
  }
  const v = document.getElementById("endpoint").value.trim();
  if(!v){ ENDPOINT=null;builtInDemo=true;stableLayout.reset();layoutSignature="";feedNote("Back on the demo townmap.");return refresh();}
  if(!isAllowedFeedUrl(v)){
    feedNote("feed URL must be http(s). data: and other schemes are blocked.", "#e2504a");
    return;
  }
  ENDPOINT=new URL(v,location.href).href;builtInDemo=false;lastSnapshot=null;stableLayout.reset();layoutSignature="";feedNote("connecting...");refresh();
};
document.getElementById("endpoint").addEventListener("keydown", e=>{
  if(e.key==="Enter") document.getElementById("connect").click();
});
document.getElementById("settled").onclick = (e)=>{
  showSettled = !showSettled;
  e.target.setAttribute("aria-pressed", String(showSettled));
  layout(); renderTally(); renderPanel();
};
document.getElementById("pause").onclick = (e)=>{
  paused = !paused; SIM.setLive(!paused);
  e.target.setAttribute("aria-pressed", String(paused));
  e.target.textContent = paused ? "resume feed" : "pause feed";
};

let refreshing=false,layoutSource="";
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try{
    agents=await fetchAgents();
    const nextSource=feedNamespace(ENDPOINT,builtInDemo);
    if(nextSource!==layoutSource){layoutSource=nextSource;stableLayout.reset();layoutSignature="";fauna.length=0;}
    layout();observatory?.update(agents,{...FEED_META,stale:feedStale});renderTally();renderPanel();
  }finally{refreshing=false;}
}

observatory=createObservatory({
  canvas:cv,ctx,getAgents:()=>agents,getPlots:()=>plots,getEndpoint:()=>ENDPOINT,getSourceKey:()=>feedNamespace(ENDPOINT,builtInDemo),
  getBedtimeRoutine:id=>routineForAgent(bedtimeFrames,agents.find(agent=>agent.id===id)),
  getResidents:()=>[...actors].filter(([id,a])=>!a.indoors&&agents.some(agent=>agent.id===id)).map(([id,a])=>({id,x:a.x+5,y:a.y+14})).concat([...bedtimeFrames.values()].flatMap(r=>r.kids.filter(k=>!k.hidden).map(k=>({id:k.id,x:k.x,y:k.y})))),
  getWorld:()=>({width:W,height:H,solids:sceneSolids,ponds:scenePonds,districts:sceneDistricts,roadX:VERT_ROAD,roadYs:HORZ_ROADS,jack:jackPlot,showSettled}),
  select(id){selectedId=id;renderPanel();},drawJack,
  answerDemo:(id,text,requestId)=>SIM.answer(id,text,requestId),refresh
});
window.cottageObservatory=observatory;
window.cottageState=()=>({agents,plots:plots.map(p=>({id:p.agent.id,x:p.x,y:p.y,kids:p.kids})),solids:sceneSolids,ponds:scenePonds,fauna,bedtime:[...bedtimeFrames].map(([id,routine])=>({id,...routine})),live:LIVE,stale:feedStale,width:W,height:H,scene:observatory.state});

(function boot(){
  const box = document.getElementById("endpoint");
  if(PUBLIC_DEMO){
    ENDPOINT=null;box.value="";box.disabled=true;
    document.getElementById("connect").disabled=true;
    box.closest(".feed").hidden=true;
    feedNote("Sample village · fictional agents and activity.");
    return;
  }
  const params = new URLSearchParams(location.search);
  const same = `${location.origin}/agents`;
  if (params.has("demo")) {
    box.value = "";
    ENDPOINT = null;
    feedNote("demo townmap. connect a cottage JSON feed when you have one.");
    return;
  }
  const ep = params.get("endpoint") || params.get("feed");
  if (ep) {
    box.value = ep;
    // Prefill only. Never auto-fetch a query-string feed (XSS / exfil risk on
    // localhost). User must hit connect.
    ENDPOINT = null;
    feedNote("feed URL prefilled. hit connect when you trust it.");
    return;
  }
  box.value = same;
  if (location.protocol.startsWith("http")) {
    ENDPOINT = same;
    builtInDemo = false;
    feedNote("connecting to local feed...");
  }
})();
refresh();
setInterval(()=>{ if(!paused) refresh(); }, POLL_MS);
requestAnimationFrame(draw);
