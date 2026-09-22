import test from "node:test";
import assert from "node:assert/strict";
import {
  roommateKey,
  plotAgentsForLayout,
  plotHostId,
  roommateLodgerIds,
  householdWorking,
} from "../src/roommates.mjs";

test("roommateKey only groups absolute worktree paths", () => {
  assert.equal(roommateKey({ worktreePath: "/tmp/wt-a" }), "/tmp/wt-a");
  assert.equal(roommateKey({ worktreePath: "relative" }), "");
  assert.equal(roommateKey({ worktreePath: "" }), "");
  assert.equal(roommateKey({}), "");
});

test("plotAgentsForLayout keeps unique paths as their own cottages", () => {
  const agents = [
    { id: "a", worktreePath: "/tmp/one", status: "working", occupancy: "live" },
    { id: "b", worktreePath: "/tmp/two", status: "idle", occupancy: "live" },
  ];
  const plots = plotAgentsForLayout(agents);
  assert.equal(plots.length, 2);
  assert.deepEqual(plots.map((p) => p.id).sort(), ["a", "b"]);
  assert.equal(plots[0].roommates.length, 0);
});

test("shared worktreePath collapses to a stable host regardless of status or children", () => {
  const agents = [
    { id: "aaa", worktreePath: "/tmp/shared", status: "idle", occupancy: "live", startedAt: 100 },
    { id: "zzz", worktreePath: "/tmp/shared", status: "working", occupancy: "live", startedAt: 200 },
    { id: "kid", parent: "zzz", worktreePath: "/tmp/shared", status: "working", occupancy: "live" },
  ];
  const plots = plotAgentsForLayout(agents);
  assert.equal(plots.length, 1);
  assert.equal(plots[0].id, "aaa");
  assert.equal(plots[0].plotKey, "wt:/tmp/shared");
  assert.deepEqual(plots[0].roommates.map((r) => r.id), ["zzz"]);
  assert.ok(householdWorking(plots[0]));

  // Status flip or parenting must not move the cottage to another agent id.
  const flipped = plotAgentsForLayout([
    { ...agents[0], status: "working" },
    { ...agents[1], status: "idle" },
    { ...agents[2], parent: "aaa" },
  ]);
  assert.equal(flipped[0].id, "aaa");
  assert.equal(flipped[0].plotKey, "wt:/tmp/shared");
  assert.equal(plotHostId(agents, "zzz"), "aaa");
});

test("plotKey stays on the worktree after the earliest host leaves", () => {
  const before = plotAgentsForLayout([
    { id: "aaa", worktreePath: "/tmp/shared", status: "idle" },
    { id: "zzz", worktreePath: "/tmp/shared", status: "working" },
  ]);
  const after = plotAgentsForLayout([
    { id: "zzz", worktreePath: "/tmp/shared", status: "working" },
  ]);
  assert.equal(before[0].plotKey, after[0].plotKey);
});

test("showing shared historical tasks keeps the dashboard host and worktree identity", () => {
  const history = [
    { id: "aaa", inventoryScope: "history", worktreePath: "/tmp/shared", name: "Old task", status: "done", pr: { state: "merged", number: 1 } },
    { id: "bbb", inventoryScope: "history", worktreePath: "/tmp/shared", status: "done" },
  ];
  const dashboard = [
    { id: "zzz", inventoryScope: "dashboard", worktreePath: "/tmp/shared", status: "blocked" },
    { id: "yyy", inventoryScope: "dashboard", worktreePath: "/tmp/shared", name: "Current task", status: "working", pr: { state: "open", number: 42 } },
  ];
  const current = plotAgentsForLayout(dashboard)[0];
  for (const agents of [[...history, ...dashboard], [...history, ...dashboard].reverse()]) {
    const plots = plotAgentsForLayout(agents);
    assert.equal(plots.length, 1);
    const host = plots[0];
    assert.equal(host.id, "yyy");
    assert.equal(host.name, "Current task");
    assert.equal(host.status, "working");
    assert.deepEqual(host.pr, { state: "open", number: 42 });
    assert.equal(host.plotKey, current.plotKey);
    assert.equal(host.plotKey, "wt:/tmp/shared");
    assert.deepEqual(host.roommates.map(agent => agent.id), ["aaa", "bbb", "zzz"]);
    for (const agent of agents) assert.equal(plotHostId(agents, agent.id), "yyy");
    assert.deepEqual([...roommateLodgerIds(agents)].sort(), ["aaa", "bbb", "zzz"]);
  }
  assert.equal(plotAgentsForLayout(history)[0].id, "aaa");
  assert.equal(plotAgentsForLayout([...history].reverse())[0].id, "aaa");
});

test("missing paths never roommate together", () => {
  const agents = [
    { id: "a", worktreePath: "", status: "working" },
    { id: "b", worktreePath: "", status: "working" },
  ];
  assert.equal(plotAgentsForLayout(agents).length, 2);
});
