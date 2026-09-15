import test from "node:test";
import assert from "node:assert/strict";
import { createGithubEnricher, createGithubQuery, githubTarget } from "../src/github.mjs";

const start = Date.parse("2026-09-14T12:00:00Z");
const agent = { id: "a", pr: { url: "https://github.com/example/repo/pull/7" } };
const rawPr = { number: 7, url: agent.pr.url, state: "OPEN", headRefOid: "head-a", labels: [{ name: "babysit:ready" }] };

test("feed polls resolve without waiting for GitHub and reuse the cache", async () => {
  let release;
  let calls = 0;
  const enrich = createGithubEnricher({ now: () => start, query: () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  } });
  const initial = await enrich([agent, { ...agent, id: "b" }]);
  assert.equal(initial[0].pr.stage, "unknown");
  assert.equal(calls, 1);
  assert.equal(enrich.stats().active, 1);
  release(rawPr);
  await enrich.flush();
  const cached = await enrich([agent]);
  assert.equal(cached[0].pr.stage, "ready");
  assert.equal(cached[0].pr.source, "github");
  assert.equal(cached[0].pr.reviewedHeadSha, "");
  assert.equal(calls, 1);
});

test("concurrency is bounded across independent PRs", async () => {
  const releases = [];
  const enrich = createGithubEnricher({ concurrency: 2, now: () => start,
    query: () => new Promise((resolve) => releases.push(resolve)) });
  await enrich([7, 8, 9].map((number) => ({ pr: { url: `https://github.com/example/repo/pull/${number}` } })));
  assert.equal(releases.length, 2);
  assert.equal(enrich.stats().active, 2);
  releases[0](rawPr);
  releases[1](rawPr);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 3);
  releases[2](rawPr);
  await enrich.flush();
  assert.equal(enrich.stats().pending, 0);
});

test("failed refreshes preserve identity, remove readiness, and back off", async () => {
  let time = start;
  let calls = 0;
  const enrich = createGithubEnricher({ now: () => time, query: async () => {
    calls++;
    if (calls > 1) throw new Error("upstream failed");
    return rawPr;
  } });
  await enrich([agent]); await enrich.flush();
  time += 30_000;
  await enrich([agent]); await enrich.flush();
  const failed = (await enrich([agent]))[0].pr;
  assert.equal(failed.stage, "unknown");
  assert.equal(failed.state, "open");
  assert.equal(failed.url, agent.pr.url);
  assert.equal(failed.stale, true);
  assert.equal(failed.checkedAt, start);
  assert.equal(calls, 2);
  time += 29_999;
  await enrich([agent]);
  assert.equal(calls, 2);
  time += 1;
  await enrich([agent]); await enrich.flush();
  assert.equal(calls, 3);
  time += 30_000;
  await enrich([agent]);
  assert.equal(calls, 3); // second failure doubles the delay
});

test("a head change under an unchanged ready label stays uncertain until new evidence", async () => {
  let time = start;
  let current = rawPr;
  const enrich = createGithubEnricher({ now: () => time, query: async () => current });
  async function refresh() {
    await enrich([agent]); await enrich.flush();
    return (await enrich([agent]))[0].pr;
  }
  assert.equal((await refresh()).stage, "ready");
  time += 30_000; current = { ...rawPr, headRefOid: "head-b" };
  assert.equal((await refresh()).stage, "unknown");
  time += 30_000;
  assert.equal((await refresh()).stage, "unknown");
  const proof = { ...agent, pr: { ...agent.pr, finalization: { status: "ready", terminalLabel: "babysit:ready",
    branchHeadSha: "head-b", checkedAt: time, pullRequestUrl: agent.pr.url, pullRequestNumber: 7 } } };
  assert.equal((await enrich([proof]))[0].pr.stage, "ready");
  time += 30_000; current = { ...current, labels: ["babysit:active"] };
  assert.equal((await refresh()).stage, "active");
  time += 30_000; current = { ...current, labels: ["babysit:ready"] };
  assert.equal((await refresh()).stage, "ready");
});

test("only explicit identity or repository/non-default branch can trigger lookups", () => {
  assert.equal(githubTarget({ town: "HubTown", branch: "fix/thing" }), null);
  assert.equal(githubTarget({ repo: "example/repo", branch: "main" }), null);
  assert.equal(githubTarget({ repo: "example/repo", branch: "production", defaultBranch: "production" }), null);
  assert.equal(githubTarget({ repo: "example/repo", branch: "--delete" }), null);
  assert.equal(githubTarget({ pr: { url: "https://other.invalid/example/repo/pull/7" } }), null);
  assert.equal(githubTarget({ pr: { url: agent.pr.url, number: 8 } }), null);
  assert.equal(githubTarget({ repo: "example/repo", branch: "fix/thing" }).kind, "branch");
});

test("GitHub PR queries request the status check rollup", async () => {
  let command;
  const query = createGithubQuery({ run: async (file, args) => {
    command = { file, args };
    return { stdout: JSON.stringify(rawPr) };
  } });
  await query(githubTarget(agent));
  assert.equal(command.file, "gh");
  assert.equal(command.args[0], "pr");
  assert.match(command.args.at(-1), /statusCheckRollup/);
  assert.match(command.args.at(-1), /createdAt/);
});

test("GitHub enrichment maps createdAt to openedAt and keeps a feed open clock", async () => {
  const enrich = createGithubEnricher({
    now: () => start,
    query: async () => ({ ...rawPr, createdAt: "2026-09-01T00:00:00Z" }),
  });
  await enrich([agent]);
  await enrich.flush();
  const withGithubClock = (await enrich([agent]))[0].pr;
  assert.equal(withGithubClock.openedAt, "2026-09-01T00:00:00Z");

  const feedOpened = Date.parse("2026-08-01T00:00:00Z");
  const enrichKeep = createGithubEnricher({
    now: () => start,
    query: async () => ({ ...rawPr }),
  });
  const seeded = { ...agent, pr: { ...agent.pr, openedAt: feedOpened } };
  await enrichKeep([seeded]);
  await enrichKeep.flush();
  const kept = (await enrichKeep([seeded]))[0].pr;
  assert.equal(kept.openedAt, feedOpened);
});

test("branch discovery checks the actual default branch and accepts only an unambiguous exact match", async () => {
  const commands = [];
  let rows = [{ ...rawPr, headRefName: "fix/thing", isCrossRepository: false }];
  const query = createGithubQuery({ run: async (file, args, options) => {
    commands.push({ file, args, options });
    return { stdout: JSON.stringify(args[0] === "repo" ? { defaultBranchRef: { name: "production" } } : rows) };
  } });
  const target = githubTarget({ repo: "example/repo", branch: "fix/thing" });
  assert.equal((await query(target)).number, 7);
  assert.equal(commands[0].args[0], "repo");
  assert.deepEqual(commands[1].args.slice(0, 6), ["pr", "list", "--repo", "example/repo", "--head", "fix/thing"]);
  assert.ok(commands.every((c) => c.file === "gh" && !c.options.shell));
  assert.equal((await query({ ...target, branch: "production" })).state, "unknown");
  assert.equal(commands.length, 2);
  rows = [...rows, { ...rows[0], number: 8 }];
  assert.equal((await query(target)).state, "unknown");
  rows = [];
  assert.equal((await query(target)).state, "none");
  rows = [{ ...rawPr, headRefName: "fix/other", isCrossRepository: false }];
  assert.equal((await query(target)).state, "unknown");
});

test("terminal and missing CLI responses remain explicit without failing the feed", async () => {
  const merged = createGithubEnricher({ now: () => start, query: async () => ({ ...rawPr, state: "MERGED" }) });
  await merged([agent]); await merged.flush();
  assert.equal((await merged([agent]))[0].pr.stage, "merged");
  const unavailable = createGithubEnricher({ now: () => start, query: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  await unavailable([agent]); await unavailable.flush();
  const p = (await unavailable([agent]))[0].pr;
  assert.equal(p.stage, "unknown");
  assert.match(p.reason, /CLI is unavailable/);
});
