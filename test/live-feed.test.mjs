import test from "node:test";
import assert from "node:assert/strict";
import { blankFeedMeta, createLatestRefresh, readCurrentFeed } from "../src/live-feed.mjs";

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

test("a new endpoint starts with empty metadata instead of prior handoffs", () => {
  const prior = blankFeedMeta();
  prior.relationships.push({ from: "HubTown", to: "AppTown" });
  prior.handoffs.push({ id: "from-a" });
  const next = blankFeedMeta();

  assert.deepEqual(next, { source: "", relationships: [], handoffs: [] });
  assert.notEqual(next, prior);
  assert.deepEqual(next.handoffs, []);
});
