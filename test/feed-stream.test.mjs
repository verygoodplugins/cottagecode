import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createFeed, createFeedServer } from "../src/feed.mjs";

const inventory = agents => ({ ok: true, agents, keys: new Set(agents.map(a => a.id)), links: new Map() });
const task = status => ({ id: "child", taskId: "child", sessionId: "session", source: "hub", town: "HubTown", name: "Child", status, parent: "parent" });

test("stream invalidation during a scan gets another pass and publishes committed state", async () => {
  let reads = 0, release, changed, stopped = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const feed = createFeed({ hubInventory: {
    configured: true,
    start(callback) { changed = callback; },
    stop() { stopped++; },
    async read() { reads++; if (reads === 1) { await gate; return inventory([task("working")]); } return inventory([task("done")]); },
  } });
  const observed = [];
  const unsubscribe = feed.subscribe(() => observed.push(feed.snapshot().agents[0].status));
  feed.start();
  const scanning = feed.scan();
  await Promise.resolve();
  changed();
  changed();
  release();
  await scanning;
  assert.equal(reads, 2, "event bursts coalesce but never disappear behind an active scan");
  assert.deepEqual(observed, ["working", "done"], "callbacks see the committed snapshot");
  unsubscribe(); feed.stop();
  assert.equal(stopped, 1);
});

test("continuous invalidation yields after two passes and a later scan catches up", async t => {
  let reads=0,changed,release;const gate=new Promise(resolve=>{release=resolve;});
  const feed=createFeed({hubInventory:{configured:true,start(callback){changed=callback;},stop(){},async read(){reads++;if(reads<=2)changed();if(reads===3)await gate;return inventory([task(reads>=3?'done':'working')]);}}});
  feed.start();t.after(()=>{release();feed.stop();});
  const first=feed.scan(),joined=feed.scan();assert.equal(first,joined,'ordinary callers share the active promise');
  let resolved=false;const settled=first.then(()=>{resolved=true;});
  await new Promise(resolve=>setTimeout(resolve,25));
  const resolvedBeforeCatchup=resolved;
  release();await settled;
  assert.equal(resolvedBeforeCatchup,true,'the shared scan resolves after its two-pass budget');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(reads,3,'the coalesced catch-up pass runs after yielding');
  assert.equal(feed.snapshot().agents[0].status,'done');
});

test("a fresh scan coalesces pending catch-up and stop cancels it and ignores invalidations", async t => {
  let reads=0,invalidations=2,changed;const feed=createFeed({hubInventory:{configured:true,start(callback){changed=callback;},stop(){},async read(){reads++;if(invalidations>0){invalidations--;changed();}return inventory([task('working')]);}}});
  feed.start();t.after(()=>feed.stop());
  await feed.scan();assert.equal(reads,2);
  await feed.scan();assert.equal(reads,3,'an explicit fresh scan consumes the dirty state');
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(reads,3,'the superseded timer does not duplicate the fresh scan');
  // Create another dirty scan, then stop before its queued catch-up can run.
  invalidations=2;changed();await feed.scan();
  const beforeStop=reads;feed.stop();changed();
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(reads,beforeStop,'stopped feeds ignore callbacks and pending work');
});

test("message POST completes while invalidations continue during its shared scan", async t => {
  let reads=0,changed,release,thirdReadStarted,sends=0;const gate=new Promise(resolve=>{release=resolve;}),thirdRead=new Promise(resolve=>{thirdReadStarted=resolve;});
  const feed=createFeed({hubInventory:{configured:true,start(callback){changed=callback;},stop(){},async read(){reads++;if(reads<=2)changed();if(reads===3){thirdReadStarted();await gate;}return inventory([task('working')]);}}});
  feed.start();const server=createFeedServer(feed,{messages:{async send(){sends++;return {status:200,body:{ok:true,delivery:'accepted'}};}}}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(async()=>{release();feed.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=fetch(`${base}/agents/child/messages`,{method:'POST',headers:{origin:base,'content-type':'application/json','x-cottagecode-request':'user-message'},body:JSON.stringify({taskId:'child',message:'stub test',requestId:'stub-request'})});
  await thirdRead;
  let timeout;
  try {
    const result=await Promise.race([request.then(response=>response.status),new Promise(resolve=>{timeout=setTimeout(()=>resolve('pending'),1500);})]);
    assert.equal(result,200,'POST returns while the coalesced catch-up read is still gated');
  } finally { clearTimeout(timeout);release(); }
  const response=await request;assert.equal(response.status,200);
  assert.equal(sends,1);
});

test("local SSE wakes after commit, exposes only revision, and rejects foreign origins", async t => {
  let status = "working", stamp = 1_800_000_000_000;
  const feed = createFeed({ now: () => stamp, hubInventory: { configured: true, read: async () => inventory([task(status)]) } });
  await feed.scan();
  const server = createFeedServer(feed).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal((await fetch(base + "/agents/events", { headers: { origin: "https://foreign.example" } })).status, 403);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + "/agents/events", { signal: controller.signal, headers: { origin: base } });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader(), decode = new TextDecoder();
  assert.equal(decode.decode((await reader.read()).value), 'event: change\ndata: {"revision":null}\n\n');
  let notifications = 0;
  const off = feed.subscribe(() => notifications++);
  stamp += 2000;
  await feed.scan();
  assert.equal(notifications, 0, "unchanged fallback scan does not publish checkedAt churn");
  status = "done";
  const next = reader.read();
  await feed.scan();
  const frame = decode.decode((await next).value);
  assert.match(frame, /^event: change\ndata: \{"revision":\d+\}\n\n$/);
  assert.equal((await (await fetch(base + "/agents")).json()).agents[0].status, "done");
  assert.doesNotMatch(frame, /taskId|session|authorization|parent/);
  off(); await reader.cancel();
});
