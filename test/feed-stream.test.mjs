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
