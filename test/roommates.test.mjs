import test from "node:test";
import assert from "node:assert/strict";
import { roommateKey, plotAgentsForLayout } from "../src/roommates.mjs";

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

test("shared worktreePath collapses to one host with cramped roommates", () => {
  const agents = [
    { id: "host", worktreePath: "/tmp/shared", status: "idle", occupancy: "live", startedAt: 100 },
    { id: "guest", worktreePath: "/tmp/shared", status: "working", occupancy: "live", startedAt: 200 },
    { id: "kid", parent: "host", worktreePath: "/tmp/shared", status: "working", occupancy: "live" },
  ];
  const plots = plotAgentsForLayout(agents);
  assert.equal(plots.length, 1);
  assert.equal(plots[0].id, "guest"); // working preferred as host
  assert.deepEqual(plots[0].roommates.map((r) => r.id), ["host"]);
  // parented agents stay sheds, not roommates of the shared checkout
  assert.ok(!plots[0].roommates.some((r) => r.id === "kid"));
});

test("missing paths never roommate together", () => {
  const agents = [
    { id: "a", worktreePath: "", status: "working" },
    { id: "b", worktreePath: "", status: "working" },
  ];
  assert.equal(plotAgentsForLayout(agents).length, 2);
});
