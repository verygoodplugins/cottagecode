import test from "node:test";
import assert from "node:assert/strict";
import {
  roommateKey,
  plotAgentsForLayout,
  plotHostId,
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

test("missing paths never roommate together", () => {
  const agents = [
    { id: "a", worktreePath: "", status: "working" },
    { id: "b", worktreePath: "", status: "working" },
  ];
  assert.equal(plotAgentsForLayout(agents).length, 2);
});
