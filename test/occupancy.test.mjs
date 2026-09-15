import test from "node:test";
import assert from "node:assert/strict";
import { classifyOccupancy, inferPr, isLetter, lettersOf, stampOccupancy, RECENT_MS } from "../src/occupancy.mjs";

const now = Date.parse("2026-09-14T12:00:00Z");
const pr = { number: 4, url: "https://github.com/example/repo/pull/4", state: "open",
  labels: ["babysit:blocked"], source: "github", checkedAt: now, headSha: "head" };

test("completed cottages remain live while their PR is outstanding", () => {
  const old = { status: "offline", endedAt: now - 10 * RECENT_MS, pr };
  assert.equal(classifyOccupancy(old, now), "live");
  assert.equal(classifyOccupancy({ ...old, pr: { ...pr, state: "unknown" } }, now), "live");
  assert.equal(classifyOccupancy({ ...old, pr: { ...pr, state: "merged" } }, now), "settled");
  assert.equal(classifyOccupancy({ ...old, pr: { ...pr, state: "closed" } }, now), "settled");
  assert.equal(classifyOccupancy({ status: "done", endedAt: now, pr: { state: "unknown" } }, now), "settled");
  assert.equal(classifyOccupancy({ status: "done", endedAt: now, result: "Tests passed" }, now), "recent");
});

test("blocked PRs make one letter per PR while independently blocked tasks remain visible", () => {
  const agents = stampOccupancy([
    { id: "a", status: "done", pr }, { id: "b", status: "offline", pr },
    { id: "c", status: "blocked", attention: "Need a decision" },
  ], now);
  assert.equal(isLetter(agents[0], now), true);
  assert.equal(lettersOf(agents, now).length, 2);
  assert.equal(isLetter({ ...agents[0], occupancy: "settled" }, now), false);
});

test("transcript prose only identifies a PR; it never fabricates state or absence", () => {
  const inferred = inferPr("I merged https://github.com/example/repo/pull/4 and landed on main.");
  assert.equal(inferred.number, 4);
  assert.equal(inferred.url, pr.url);
  assert.equal(inferred.state, "unknown");
  assert.equal(inferPr("No PR was mentioned").state, "unknown");
  assert.equal(inferPr("Check PR #4").state, "unknown");
  const ambiguous = inferPr("First https://github.com/example/repo/pull/4 then https://github.com/example/repo/pull/5");
  assert.equal(ambiguous.number, null);
  assert.match(ambiguous.reason, /Multiple/);
});

test("issue targets do not become PRs and explicit structured records remain available", () => {
  const issue = inferPr("Review issue", { githubAutoJackRequest: { targetNumber: 4, targetType: "issue",
    targetUrl: "https://github.com/example/repo/issues/4", repo: "example/repo" } });
  assert.equal(issue.number, null);
  assert.equal(issue.state, "unknown");
  assert.equal(inferPr("", { pr: { ...pr, state: "merged" } }).state, "merged");
  assert.equal(inferPr("Unrelated old PR #4", { finalization: { status: "not_needed" } }).state, "none");
  const receipt = inferPr("", { finalization: { status: "ready", terminalLabel: "babysit:ready",
    pullRequestNumber: 4, pullRequestUrl: pr.url, branchHeadSha: "reviewed-head" } });
  assert.equal(receipt.number, 4);
  assert.equal(receipt.reviewedHeadSha, "reviewed-head");
  assert.equal(receipt.headSha, "");
});
