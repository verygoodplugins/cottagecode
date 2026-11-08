import test from "node:test";
import assert from "node:assert/strict";
import { blankFeedMeta, blankFeedState, createLatestRefresh, createFeedNotifications, readCurrentFeed, snapshotForEndpoint } from "../src/live-feed.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("a superseded endpoint response is discarded before normalization", async () => {
  let current = "https://feed.example/a";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const read = readCurrentFeed(current, {
    fetchFn: async () => { await gate; return response({ agents: [{ id: "from-a" }] }); },
    isCurrent: endpoint => endpoint === current,
  });
  current = "https://feed.example/b";
  release();

  assert.deepEqual(await read, { kind: "superseded" });
});

test("an endpoint switch reruns immediately and applies only its current response", async () => {
  let current = "https://feed.example/a";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const applied = [];
  const refresh = createLatestRefresh(async () => {
    const endpoint = current;
    const result = await readCurrentFeed(endpoint, {
      fetchFn: async request => {
        requests.push(request);
        if (request.endsWith("/a")) await gate;
        return response({ agents: [{ id: request.endsWith("/a") ? "from-a" : "from-b" }] });
      },
      isCurrent: candidate => candidate === current,
    });
    if (result.kind === "superseded") return true;
    assert.equal(result.kind, "success");
    applied.push(result.data.agents[0].id);
    return false;
  });

  const first = refresh();
  current = "https://feed.example/b";
  const joined = refresh({ latest: true });
  assert.equal(joined, first, "the endpoint change joins and schedules the active refresh");
  release();
  await first;

  assert.deepEqual(requests, ["https://feed.example/a", "https://feed.example/b"]);
  assert.deepEqual(applied, ["from-b"]);
});

test("a demo fallback clears a prior endpoint snapshot and metadata", () => {
  const prior = { snapshot: [{ id: "real-agent" }], endpoint: "http://localhost:8787/agents", meta: blankFeedMeta() };
  prior.meta.relationships.push({ from: "HubTown", to: "AppTown" });
  prior.meta.handoffs.push({ id: "from-real-feed" });
  assert.deepEqual(snapshotForEndpoint(prior, prior.endpoint), prior.snapshot);

  const fallback = blankFeedState();
  assert.deepEqual(fallback, { snapshot: null, endpoint: null, meta: { source: "", relationships: [], handoffs: [] } });
  assert.equal(snapshotForEndpoint(fallback, prior.endpoint), null,
    "a later local-feed failure must not restore real cottages into the demo namespace");
  assert.notEqual(fallback.meta, prior.meta);
});

test("push wakeups follow only the current bundled feed and stop for pause/demo", () => {
  const sources = [];
  class EventSourceStub {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    addEventListener(name, callback) { assert.equal(name, "change"); this.notify = callback; }
    close() { this.closed = true; }
  }
  let updates = 0;
  const origin = "http://127.0.0.1:8787";
  const notifications = createFeedNotifications({ origin, EventSourceClass: EventSourceStub, onChange: () => updates++ });
  notifications.sync(origin + "/agents");
  notifications.sync(origin + "/agents");
  assert.equal(sources.length, 1, "one subscription per active endpoint");
  assert.equal(sources[0].url, origin + "/agents/events");
  sources[0].notify();
  assert.equal(updates, 1);
  notifications.sync(origin + "/agents", { enabled: false });
  sources[0].notify();
  assert.equal(updates, 1, "queued notifications cannot update a paused feed");
  assert.equal(sources[0].closed, true);
  notifications.sync(origin + "/agents");
  sources[1].notify();
  assert.equal(updates, 2);
  for (const endpoint of ["https://custom.example/agents", origin + "/custom.json", null, origin + "/agents?source=other"]) {
    notifications.sync(endpoint);
    sources[1].notify();
  }
  assert.equal(updates, 2, "old connections cannot cross endpoint or demo boundaries");
  assert.equal(sources.length, 2, "custom feeds are not assumed to support SSE");
});

test("an unavailable notification transport leaves JSON polling usable", async () => {
  const notifications = createFeedNotifications({ origin: "http://localhost", EventSourceClass: class { constructor() { throw new Error("Unavailable"); } } });
  assert.doesNotThrow(() => notifications.sync("http://localhost/agents"));
  const result = await readCurrentFeed("http://localhost/agents", { fetchFn: async () => response({ agents: [{ id: "still-polling" }] }) });
  assert.equal(result.kind, "success");
});
