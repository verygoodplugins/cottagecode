import test from "node:test";
import assert from "node:assert/strict";
import { normalizePr, prStage, prKey, prCounts, hasOutstandingPr, PR_FRESH_MS } from "../src/pr.mjs";

const now = Date.parse("2026-09-14T12:00:00Z");
const base = { number: 12, url: "https://github.com/example/cottage/pull/12", state: "open",
  headSha: "head-a", source: "github", checkedAt: now, labels: [] };

test("missing PR data stays distinct from confirmed absence and terminal states", () => {
  assert.equal(prStage(undefined, now), "unknown");
  assert.equal(prStage({}, now), "unknown");
  assert.equal(prStage({ state: "none" }, now), "none");
  assert.equal(prStage({ ...base, state: "CLOSED" }, now), "closed");
  assert.equal(prStage({ ...base, state: "MERGED" }, now), "merged");
  assert.equal(prStage({ ...base, state: "none" }, now), "unknown");
  assert.equal(prStage({ ...base, state: undefined }, now), "unknown");
});

test("fresh exclusive labels expose all babysit stages independently of execution", () => {
  for (const stage of ["active", "waiting-codex", "waiting-ci", "blocked", "ready"]) {
    const pr = normalizePr({ ...base, labels: [{ name: "feature" }, { name: `babysit:${stage}` }] }, now);
    assert.equal(prStage(pr, now), stage);
    assert.equal(pr.state, "open");
    assert.equal(pr.reviewState, stage);
    assert.equal(hasOutstandingPr({ status: "done", pr }, now), true);
  }
  assert.equal(prStage(base, now), "open");
});

test("readiness fails closed for stale, future, missing, conflicting and draft evidence", () => {
  const ready = { ...base, labels: ["babysit:ready"] };
  for (const patch of [
    { checkedAt: now - PR_FRESH_MS - 1 }, { checkedAt: null }, { checkedAt: now + 120_000 },
    { stale: true }, { labels: ["babysit:ready", "babysit:blocked"] },
    { labels: ["babysit:ready", "babysit:active"] }, { reviewState: "blocked" },
    { reviewedHeadSha: "older-head" }, { headSha: "" }, { isDraft: true },
    { observedReadyHeadSha: "older-head" },
  ]) {
    const pr = normalizePr({ ...ready, ...patch }, now);
    assert.equal(prStage(pr, now), "unknown", JSON.stringify(patch));
    assert.ok(pr.reason);
    assert.equal(pr.state, "open");
  }
  // A newly fetched matching receipt can verify a head that changed.
  assert.equal(prStage({ ...ready, observedReadyHeadSha: "older-head", reviewedHeadSha: "head-a" }, now), "ready");
});

test("structured receipts preserve review heads and require current-head verification", () => {
  const finalization = { status: "ready", terminalLabel: "babysit:ready", pullRequestNumber: 12,
    pullRequestUrl: base.url, branchHeadSha: "head-a", checkedAt: now };
  const unverified = normalizePr({ finalization }, now);
  assert.equal(unverified.headSha, "");
  assert.equal(unverified.reviewedHeadSha, "head-a");
  assert.equal(prStage(unverified, now), "unknown");
  assert.equal(prStage({ finalization, headSha: "head-a" }, now), "ready");
  assert.equal(prStage({ finalization, headSha: "head-b" }, now), "unknown");
  assert.equal(prStage({ finalization: { status: "not_needed" } }, now), "none");
  assert.equal(prStage({ ...base, finalization, labels: ["babysit:blocked"] }, now), "unknown");
  // Current live state supersedes an older receipt when review continues.
  assert.equal(prStage({ ...base, finalization: { ...finalization, checkedAt: now - 1 }, labels: ["babysit:active"] }, now), "active");
  assert.equal(prStage({ ...base, finalization, labels: [] }, now), "open");
});

test("normalization is stable and rejects URL/number identity conflicts", () => {
  const p = normalizePr({ ...base, labels: ["babysit:ready"] }, now);
  assert.deepEqual(normalizePr(p, now), p);
  assert.equal(prStage({ ...base, number: 13 }, now), "unknown");
  assert.equal(normalizePr({ url: "javascript:alert(1)", state: "unknown" }, now).url, "");
  assert.equal(prKey({ number: 12 }), "");
  assert.equal(prKey({ number: 12, repo: "EXAMPLE/Cottage" }), prKey(base));
  assert.equal(prKey({ url: `${base.url}/?a=1#discussion` }), prKey(base));
});

test("counts deduplicate shared PRs, prefer fresh data, and reject equally fresh conflicts", () => {
  const ready = { ...base, labels: ["babysit:ready"] };
  const counts = prCounts([
    { id: "one", pr: ready }, { id: "two", pr: ready },
    { id: "old", pr: { ...base, checkedAt: now - 5000, labels: ["babysit:blocked"] } },
    { id: "absent", pr: { state: "none" } }, { id: "missing" },
    { id: "other-repo", pr: { ...base, url: "https://github.com/elsewhere/project/pull/12" } },
  ], now);
  assert.equal(counts.total, 2);
  assert.equal(counts.ready, 1);
  assert.equal(counts.open, 1);
  assert.equal(counts.none, 1);
  assert.equal(counts.unknown, 1);
  const conflict = prCounts([{ pr: ready }, { pr: { ...base, labels: ["babysit:active"] } }], now);
  assert.equal(conflict.total, 1);
  assert.equal(conflict.ready, 0);
  assert.equal(conflict.unknown, 1);
});

test("outstanding status persists across execution completion and temporary uncertainty", () => {
  assert.equal(hasOutstandingPr({ pr: base, status: "offline" }, now), true);
  assert.equal(hasOutstandingPr({ pr: { ...base, state: "unknown" } }, now), true);
  for (const state of ["none", "merged", "closed"])
    assert.equal(hasOutstandingPr({ pr: { state } }, now), false);
  assert.equal(hasOutstandingPr({}, now), false);
});
