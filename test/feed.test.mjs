import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { parseTranscript } from "../src/transcripts.mjs";
import { toCottage, readHubAgents } from "../src/hub.mjs";
import { toAgents, createFeed, createFeedServer, createClaudeScanner, repoFromRemote, createRepoResolver } from "../src/feed.mjs";

const now = Date.parse("2026-09-14T11:00:00Z");
const sampleSession = () => parseTranscript([
  { type: "user", uuid: "request", sessionId: "session-1", cwd: "/projects/autoapp", timestamp: new Date(now - 10000).toISOString(), message: { content: "Fix the voice reconnect" } },
  { type: "assistant", uuid: "update", sessionId: "session-1", timestamp: new Date(now).toISOString(), message: { content: [{ type: "text", text: "Running reconnect tests" }], stop_reason: "tool_use" } },
].map(JSON.stringify).join("\n"));
const emptyHub = () => ({ ok: true, agents: [], keys: new Set(), links: new Map() });
const identity = async value => value;
const feedOptions = { readHub: emptyHub, enrich: identity, resolveRepos: identity, now: () => now };

test("feed cottage request and task/session clocks remain distinct", () => {
  const [agent] = toAgents([sampleSession()], { now });
  assert.equal(agent.originalAsk, "Fix the voice reconnect");
  assert.equal(agent.task, "Fix the voice reconnect");
  assert.equal(agent.activity, "Running reconnect tests");
  assert.equal(agent.taskId, null);
  assert.equal(agent.taskStartedAt, null);
  assert.equal(agent.sessionStartedAt, now - 10000);
  assert.equal(agent.activityUrl, "/agents/session-1/activity");
  assert.equal(agent.result, "");
  const [unknown] = toAgents([parseTranscript(JSON.stringify({ type: "user", sessionId: "missing-time", message: { content: "Do a thing" } }))], { now });
  assert.equal(unknown.startedAt, 0);
  assert.equal(unknown.sessionStartedAt, null);
  assert.equal(unknown.status, "offline");
});

test("feed and incremental activity expose the same explicit latest todo snapshot", async () => {
  const session = parseTranscript(JSON.stringify({ type: "assistant", sessionId: "todo-session", timestamp: new Date(now).toISOString(), message: {
    content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Run tests", status: "in_progress" }] } }],
  } }));
  let failed = false;
  const feed = createFeed({ ...feedOptions, scanClaude: async () => {
    if (failed) throw new Error("Temporary scan failure");
    return { ok: true, agents: toAgents([session], { now }), sessions: [session] };
  } });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Run tests");
  const journal = await feed.getActivity("todo-session");
  const incremental = await feed.getActivity("todo-session", { after: journal.cursor });
  assert.deepEqual(incremental.events, []);
  assert.deepEqual(incremental.todos, feed.snapshot().agents[0].todos);
  failed = true;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.stale, true);
  failed = false;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.stale, undefined);
});

test("transcript PRs remain unknown until explicit identity or absence evidence is available", () => {
  const [unknown] = toAgents([sampleSession()], { now });
  assert.equal(unknown.pr.state, "unknown");
  assert.equal(unknown.pr.source, "unavailable");
  const sessionWithText = text => parseTranscript(JSON.stringify({ type: "assistant", sessionId: "pr-session", timestamp: new Date(now).toISOString(), message: { content: text } }));
  const [noProseInference] = toAgents([sessionWithText("No PR exists yet; this is ready to merge.")], { now });
  assert.equal(noProseInference.pr.state, "unknown");
  const [identified] = toAgents([sessionWithText("Review https://github.com/owner/project/pull/17")], { now });
  assert.equal(identified.pr.number, 17);
  assert.equal(identified.pr.url, "https://github.com/owner/project/pull/17");
  assert.equal(identified.pr.state, "unknown", "a link establishes identity, not current PR state");
  const [ambiguous] = toAgents([sessionWithText("https://github.com/owner/project/pull/17 and https://github.com/owner/project/pull/18")], { now });
  assert.equal(ambiguous.pr.number, null);
  assert.equal(ambiguous.pr.state, "unknown");
  const structured = parseTranscript(JSON.stringify({ type: "metadata", sessionId: "structured", pr: { number: 19, url: "https://github.com/owner/project/pull/19", state: "open" } }));
  assert.equal(toAgents([structured], { now })[0].pr.state, "open");
  const absent = parseTranscript(JSON.stringify({ type: "metadata", sessionId: "absent", finalization: { status: "not_needed", checkedAt: now } }));
  assert.equal(toAgents([absent], { now })[0].pr.state, "none");
});

test("unavailable GitHub enrichment cannot turn an unverified backend PR into none", async () => {
  const session = sampleSession();
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    enrich: async () => { throw new Error("GitHub unavailable"); },
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].pr.state, "unknown");
  assert.equal(feed.snapshot().stale, true);
  assert.equal(toCottage({ id: "hub-unknown", task: "No PR created", context: {}, status: "working" }, now).pr.state, "unknown");
  assert.equal(toCottage({ id: "hub-absent", context: { finalization: { status: "not_needed", checkedAt: now } }, status: "done" }, now).pr.state, "none");
});

test("Hub logical tasks expose genuine original requests and durable PR receipts", () => {
  const context = { customerRequest: "Original request", repo: "owner/project", lifecycle: { execution: { presentedResult: { summary: "Latest assistant response" } } } };
  const row = {
    id: "task-1", record_kind: "logical_task", task: "Short label", context,
    started_at: "2026-09-14 10:00:00", updated_at: "2026-09-14 11:00:00", completed_at: "2026-09-14 11:00:00",
    result: JSON.stringify({ pullRequest: { number: 7, url: "https://github.com/owner/project/pull/7" }, finalization: { status: "ready", branchHeadSha: "abc123", terminalLabel: "babysit:ready" } }),
    status: "completed",
  };
  const agent = toCottage(row, now);
  assert.equal(agent.originalAsk, "Original request");
  assert.equal(agent.taskId, "task-1");
  assert.equal(agent.taskStartedAt, now - 3600000);
  assert.equal(agent.sessionStartedAt, null);
  assert.equal(agent.repo, "owner/project");
  assert.equal(agent.pr.number, 7);
  assert.equal(agent.pr.reviewedHeadSha, "abc123");
  assert.notEqual(agent.pr.headSha, "abc123");
  assert.equal(context.finalization, undefined, "mapping must not mutate the supplied context");
});

test("Hub external sessions never treat an assistant status label as the original ask", () => {
  const agent = toCottage({ id: "observed", record_kind: "external_session", task: "Latest assistant response", started_at: "2026-09-14 10:00:00", context: {}, status: "running" }, now);
  assert.equal(agent.originalAsk, "");
  assert.equal(agent.taskId, null);
  assert.equal(agent.taskStartedAt, null);
  assert.equal(agent.sessionStartedAt, now - 3600000);
  const missing = toCottage({ id: "missing", record_kind: "logical_task", context: {}, started_at: "0", queued_at: 0, status: "pending" }, now);
  assert.equal(missing.startedAt, 0);
  assert.equal(missing.taskStartedAt, null);
});

test("Hub conversation targets expose factual identity and transport without inventing support", () => {
  const base = { id: "hub-run", record_kind: "logical_task", status: "running", context: { lifecycle: { execution: { sessionMode: "tmux", supportsRedirection: true, tmuxSession: "private-runtime-session" } } } };
  assert.deepEqual(toCottage(base, now).conversationTarget, { taskId: "hub-run", taskStatus: "running", recordKind: "logical_task", transport: "tmux", supportsRedirection: true });
  const direct = toCottage({ ...base, context: { lifecycle: { execution: { sessionMode: "direct", supportsRedirection: false } } } }, now);
  assert.equal(direct.conversationTarget.transport, "direct");
  assert.equal(direct.conversationTarget.supportsRedirection, false);
  const unknown = toCottage({ id: "observed-session", status: "completed", context: {} }, now);
  assert.deepEqual(unknown.conversationTarget, { taskId: "observed-session", taskStatus: "completed", recordKind: "unknown", transport: "unknown", supportsRedirection: null });
});

test("local session todos from a previous logical task do not leak into a newer Hub task", async () => {
  const local = { ...sampleSession(), todos: { items: [{ id: "old", text: "Previous task", status: "completed" }], source: "fixture", updatedAt: now - 3600000 } };
  const hubAgent = toCottage({ id: "new-run", record_kind: "logical_task", session_id: "session-1", started_at: now - 1000, status: "running", task: "New task", context: {} }, now);
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([local], { now }), sessions: [local] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["new-run", new Set(["session-1"])]]) }),
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos, null);
});

test("a mismatched explicit local task ID cannot donate todos by timestamp", async () => {
  const local = { ...sampleSession(), taskId: "local-run", todos: { items: [{ id: "wrong-task", text: "Do not show this", status: "pending" }], source: "fixture", updatedAt: now } };
  const hubAgent = toCottage({ id: "hub-run", record_kind: "logical_task", session_id: "session-1", started_at: now - 1000, status: "running", task: "Current Hub task", context: {} }, now);
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([local], { now }), sessions: [local] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-run", new Set(["session-1"])]] ) }),
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos, null);
});

test("a dated Hub todo snapshot remains preferred over an undated matching local snapshot", async () => {
  const local = {
    ...sampleSession(), taskId: "hub-run",
    todos: { items: [{ id: "local", text: "Undated local checklist", status: "pending" }], source: "fixture" },
  };
  const hubAgent = toCottage({
    id: "hub-run", record_kind: "logical_task", session_id: "session-1", started_at: now - 1_000,
    status: "running", task: "Current Hub task", context: {},
    todo_snapshot: JSON.stringify({ items: [{ id: "hub", text: "Dated Hub checklist", status: "in_progress" }] }),
    todo_updated_at: new Date(now).toISOString(),
  }, now);
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([local], { now }), sessions: [local] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-run", new Set(["session-1"])]] ) }),
  });

  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Dated Hub checklist");
});

test("scan failures retain the last live snapshot and mark it stale, then recover", async () => {
  let failing = false;
  const session = sampleSession();
  const feed = createFeed({ ...feedOptions, scanClaude: async () => {
    if (failing) throw new Error("Cannot read transcripts");
    return { ok: true, agents: toAgents([session], { now }), sessions: [session] };
  } });
  await feed.scan();
  assert.equal(feed.snapshot().stale, false);
  failing = true;
  await feed.scan();
  assert.equal(feed.snapshot().agents.length, 1);
  assert.equal(feed.snapshot().agents[0].originalAsk, "Fix the voice reconnect");
  assert.equal(feed.snapshot().stale, true);
  assert.equal(feed.snapshot().checkedAt, now);
  assert.equal((await feed.getActivity("session-1")).stale, true);
  failing = false;
  await feed.scan();
  assert.equal(feed.snapshot().stale, false);
});

test("polls share an in-flight scan instead of overlapping", async () => {
  let release;
  let calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const feed = createFeed({ ...feedOptions, scanClaude: async () => { calls++; await wait; return { ok: true, agents: [], sessions: [] }; } });
  const first = feed.scan();
  const second = feed.scan();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await first;
});

test("explicit Hub session links deduplicate cottages while preserving transcript diagnostics", async () => {
  const session = sampleSession();
  const hubAgent = toCottage({ id: "hub-1", record_kind: "external_session", session_id: "session-1", status: "running", context: {}, task: "Latest response" }, now);
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    readHub: () => ({ ok: true, agents: [hubAgent], keys: new Set(["hub-1", "session-1"]), links: new Map([["hub-1", new Set(["hub-1", "session-1"])]]) }),
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents.length, 1);
  assert.equal(feed.snapshot().agents[0].originalAsk, "Fix the voice reconnect");
  assert.equal(feed.snapshot().agents[0].sessionStartedAt, now - 10000);
  const journal = await feed.getActivity("hub-1");
  assert.deepEqual(journal.events.map(event => event.kind), ["request", "progress"]);
  const update = await feed.getActivity("hub-1", { after: journal.events[0].id });
  assert.equal(update.events.length, 1);
});

test("outstanding PR cottages survive source windows and leave after a confirmed terminal state", async () => {
  let available = true;
  let merged = false;
  const original = { ...toAgents([sampleSession()], { now })[0], status: "done", pr: { number: 12, url: "https://github.com/owner/repo/pull/12", state: "open" } };
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: available ? [original] : [], sessions: [] }),
    enrich: async agents => agents.map(agent => merged ? { ...agent, pr: { ...agent.pr, state: "merged" } } : agent),
  });
  await feed.scan();
  available = false;
  await feed.scan();
  assert.equal(feed.snapshot().agents.length, 1);
  assert.equal(feed.snapshot().agents[0].occupancy, "live");
  merged = true;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].pr.state, "merged");
  await feed.scan();
  assert.equal(feed.snapshot().agents.length, 0);
});

test("configured Hub timeline is used when a local transcript is unavailable", async () => {
  const calls = [];
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [], sessions: [] }),
    readHub: () => ({ ...emptyHub(), agents: [{ id: "hub-run", name: "Hub", source: "hub", status: "working" }] }),
    timeline: { configured: true, read: async (id, options) => { calls.push({ id, options }); return { events: [], source: "hub:codex", hasMore: false, cursor: null }; } },
  });
  await feed.scan();
  assert.equal((await feed.getActivity("hub-run", { after: "previous" })).source, "hub:codex");
  assert.deepEqual(calls, [{ id: "hub-run", options: { after: "previous" } }]);
  assert.equal(await feed.getActivity("missing"), null);
});

test("remote todo observations survive subsequent feed polls and explicit clearing", async () => {
  let items = [{ id: "one", text: "Inspect results", status: "pending" }];
  let clock = now;
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [], sessions: [] }),
    readHub: () => ({ ...emptyHub(), agents: [{ id: "hub-run", taskId: "hub-run", name: "Hub", source: "hub", status: "working", todos: null }] }),
    timeline: { configured: true, read: async () => ({ events: [], source: "hub:codex", todos: { items, source: "hub:todo", updatedAt: clock }, hasMore: false, cursor: null }) },
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos, null);
  await feed.getActivity("hub-run");
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Inspect results");
  items = []; clock++;
  await feed.getActivity("hub-run");
  await feed.scan();
  assert.deepEqual(feed.snapshot().agents[0].todos.items, []);
});

test("dated remote todo observations survive an undated Hub scan", async () => {
  const dated = { items: [{ id: "dated", text: "Dated remote checklist", status: "in_progress" }], source: "hub:todo", updatedAt: now };
  let supplied = null;
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [], sessions: [] }),
    readHub: () => ({ ...emptyHub(), agents: [{ id: "hub-run", taskId: "hub-run", name: "Hub", source: "hub", status: "working", todos: supplied }] }),
    timeline: { configured: true, read: async () => ({ events: [], source: "hub:codex", todos: dated, hasMore: false, cursor: null }) },
  });

  await feed.scan();
  await feed.getActivity("hub-run");
  supplied = { items: [{ id: "undated", text: "Undated Hub checklist", status: "pending" }], source: "hub:context" };
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Dated remote checklist");

  supplied = { items: [], source: "hub:context", updatedAt: now + 1_000 };
  await feed.scan();
  assert.deepEqual(feed.snapshot().agents[0].todos.items, [], "a newer explicit empty snapshot remains a valid clear");
});

test("undated activity todos cannot replace a dated cottage checklist", async () => {
  const dated = { items: [{ id: "dated", text: "Dated cottage checklist", status: "in_progress" }], source: "hub:context", updatedAt: now };
  let incoming = { items: [{ id: "undated", text: "Undated activity checklist", status: "pending" }], source: "hub:todo" };
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [], sessions: [] }),
    readHub: () => ({ ...emptyHub(), agents: [{ id: "hub-run", taskId: "hub-run", name: "Hub", source: "hub", status: "working", todos: dated }] }),
    timeline: { configured: true, read: async () => ({ events: [], source: "hub:codex", todos: incoming, hasMore: false, cursor: null }) },
  });

  await feed.scan();
  const first = await feed.getActivity("hub-run");
  assert.equal(first.todos.items[0].text, "Dated cottage checklist");
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Dated cottage checklist");

  incoming = { items: [], source: "hub:todo", updatedAt: now + 1_000 };
  const cleared = await feed.getActivity("hub-run");
  assert.deepEqual(cleared.todos.items, [], "a newer explicit empty activity result clears the checklist");
  assert.deepEqual(feed.snapshot().agents[0].todos.items, []);
});

test("Hub cottages with local journals refresh dedicated todos without reading the remote timeline", async () => {
  const session = { ...sampleSession(), taskId: "hub-run", taskStartedAt: now - 20_000 };
  const hubAgent = toCottage({ id: "hub-run", record_kind: "logical_task", session_id: "session-1", started_at: now - 20000, status: "running", task: "Current task", context: {} }, now);
  let todos = { items: [{ id: "one", text: "Inspect results", status: "pending" }], source: "hub:todo", updatedAt: now };
  const calls = [];
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-run", new Set(["session-1"])]]) }),
    timeline: { configured: true, read: () => assert.fail("Local journals must not fetch a full remote timeline"), readTodos: async id => { calls.push(id); return todos; } },
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos, null);
  const journal = await feed.getActivity("hub-run");
  assert.equal(journal.source, "claude-transcript");
  assert.deepEqual(journal.events.map(event => event.kind), ["request", "progress"]);
  assert.equal(journal.todos.items[0].text, "Inspect results");
  assert.deepEqual(feed.snapshot().agents[0].todos, journal.todos);
  await feed.scan();
  assert.deepEqual(feed.snapshot().agents[0].todos, journal.todos);
  todos = { ...todos, stale: true };
  const staleChecklist = await feed.getActivity("hub-run", { after: journal.cursor });
  assert.deepEqual(staleChecklist.events, []);
  assert.equal(staleChecklist.todos.stale, true);
  assert.equal(staleChecklist.stale, undefined, "todo failures do not mark the local journal stale");
  todos = { items: [], source: "hub:todo", updatedAt: now + 1000 };
  const cleared = await feed.getActivity("hub-run", { after: journal.cursor });
  assert.deepEqual(cleared.todos.items, []);
  assert.equal(cleared.todos.stale, undefined);
  await feed.scan();
  assert.deepEqual(feed.snapshot().agents[0].todos.items, []);
  todos = { items: [{ id: "old", text: "Earlier work", status: "pending" }], source: "hub:todo", updatedAt: now - 1000 };
  assert.deepEqual((await feed.getActivity("hub-run")).todos.items, [], "older remote snapshots cannot undo a later clear");
  assert.deepEqual(calls, ["hub-run", "hub-run", "hub-run", "hub-run"]);
});

test("pending todo reads only update the matching cottage task and session identity", async () => {
  const session = { ...sampleSession(), taskId: "hub-run", taskStartedAt: now - 20_000 };
  let hubAgent = toCottage({ id: "hub-run", record_kind: "logical_task", session_id: "session-1", started_at: now - 20000, status: "running", task: "Current task", context: {} }, now);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-run", new Set(["session-1"])]]) }),
    timeline: { configured: true, read: () => assert.fail("Local journals have priority"), readTodos: async () => pending },
  });
  await feed.scan();
  const request = feed.getActivity("hub-run");
  await feed.scan();
  release({ items: [{ text: "Task one work", status: "pending" }], source: "hub:todo", updatedAt: now });
  await request;
  assert.equal(feed.snapshot().agents[0].todos.items[0].text, "Task one work", "a scan during the read must not lose the current snapshot update");
  hubAgent = { ...hubAgent, taskId: "task-two", sessionId: "session-two" };
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].todos, null, "the persisted snapshot cannot cross task/session identities");
});

test("remote repository lookup is exact, read-only, and cached", async () => {
  assert.equal(repoFromRemote("git@github.com:owner/project.git"), "owner/project");
  assert.equal(repoFromRemote("https://github.com/owner/project.git"), "owner/project");
  assert.equal(repoFromRemote("https://github.com.evil/owner/project.git"), "");
  assert.equal(repoFromRemote("https://token@github.com/owner/project"), "");
  let calls = 0;
  const resolver = createRepoResolver({ now: () => now, run: async (command, args) => {
    calls++;
    assert.equal(command, "git");
    assert.deepEqual(args, ["-C", "/projects/project", "remote", "get-url", "origin"]);
    return { stdout: "git@github.com:owner/project.git\n" };
  } });
  const input = [{ id: "one", worktreePath: "/projects/project" }, { id: "two", worktreePath: "/projects/project" }];
  assert.equal((await resolver(input))[0].repo, "owner/project");
  await resolver(input);
  assert.equal(calls, 1);
  assert.equal(input[0].repo, undefined);
});

test("remote repository lookup retains the last identity after a refresh failure", async () => {
  let clock = now, calls = 0;
  const resolver = createRepoResolver({ now: () => clock, run: async () => {
    calls++;
    if (calls === 1) return { stdout: "git@github.com:owner/project.git\n" };
    throw new Error("temporary checkout failure");
  } });
  const input = [{ id: "one", worktreePath: "/projects/project" }];
  assert.equal((await resolver(input))[0].repo, "owner/project");
  clock += 300001;
  assert.equal((await resolver(input))[0].repo, "owner/project");
});

test("one-shot callers can wait for queued GitHub enrichment", async () => {
  let flushed = false;
  const enrich = async agents => agents.map(agent => ({ ...agent, enrichment: flushed ? "fresh" : "queued" }));
  enrich.flush = async () => { flushed = true; };
  const feed = createFeed({ ...feedOptions, enrich,
    scanClaude: async () => ({ ok: true, agents: toAgents([sampleSession()], { now }), sessions: [sampleSession()] }),
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].enrichment, "queued");
  await feed.flushEnrichment();
  assert.equal(feed.snapshot().agents[0].enrichment, "fresh");
});

test("HTTP serves modules and incremental activity while refusing writes and traversal", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const web = join(directory, "web");
  await mkdir(web);
  await writeFile(join(web, "town.html"), "<!doctype html><title>CottageCode</title>");
  await writeFile(join(web, "scene.mjs"), "export const ready = true;");
  await writeFile(join(directory, "outside.mjs"), "secret outside source");
  await symlink(join(directory, "outside.mjs"), join(web, "escape.mjs"));
  const session = sampleSession();
  const feed = createFeed({ ...feedOptions, scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }) });
  await feed.scan();
  const server = createFeedServer(feed, { directory: web }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/agents`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await response.json()).agents.length, 1);
  const module = await fetch(`${base}/modules/scene.mjs`);
  assert.match(module.headers.get("content-type"), /javascript/);
  assert.equal(await module.text(), "export const ready = true;");
  assert.equal((await fetch(`${base}/modules/escape.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/modules/%2e%2e%2foutside.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/agents`, { method: "POST" })).status, 405);
  const page = await (await fetch(`${base}/agents/session-1/activity?limit=1`)).json();
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal((await fetch(`${base}/agents/session-1/activity?after=a&before=b`)).status, 400);
  assert.equal((await fetch(`${base}/agents/missing/activity`)).status, 404);
});

test("missing optional transcript directory is empty; a vanished configured directory is a scan error", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectsDir = join(directory, "projects");
  const scanner = createClaudeScanner({ projectsDir });
  assert.equal((await scanner()).missing, true);
  await mkdir(projectsDir);
  assert.equal((await scanner()).agents.length, 0);
  await rm(projectsDir, { recursive: true });
  await assert.rejects(scanner);
});

test("Hub database adapter accepts older schemas without optional task columns", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-hub-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_runs (
    id TEXT, agent TEXT, status TEXT, task TEXT, user TEXT, platform TEXT, model TEXT, parent_id TEXT, session_id TEXT,
    context TEXT, queued_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, archived INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
    total_cost REAL, error TEXT, result_summary TEXT, attention_type TEXT, attention_message TEXT
  )`);
  db.prepare("INSERT INTO agent_runs(id, agent, status, task, context) VALUES (?, ?, ?, ?, ?)").run("old-task", "Resident", "running", "Original request", "{}");
  db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "historic-pr", "Resident", "completed", "Historic PR work",
    JSON.stringify({ githubAutoJackRequest: { repo: "owner/repo", targetType: "pull_request", targetNumber: 72 } }),
    "2000-01-01 00:00:00", "2000-01-01 00:00:00",
  );
  db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "historic-issue", "Resident", "completed", "Historic issue work",
    JSON.stringify({ githubAutoJackRequest: { repo: "owner/repo", targetType: "issue", targetNumber: 73 } }),
    "2000-01-01 00:00:00", "2000-01-01 00:00:00",
  );
  db.close();
  const result = readHubAgents({ dbPath: path });
  assert.equal(result.ok, true);
  assert.equal(result.agents[0].originalAsk, "Original request");
  assert.equal(result.agents[0].taskStartedAt, null);
  assert.equal(result.links.get("old-task").has("old-task"), true);
  const writable = new DatabaseSync(path);
  writable.exec("CREATE TABLE agent_checkpoints (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, data TEXT, created_at TEXT)");
  writable.prepare("INSERT INTO agent_checkpoints(run_id,kind,data,created_at) VALUES (?,?,?,?)").run("old-task", "todo", JSON.stringify({ list: { items: [{ id: "todo-1", title: "Check the result", status: "done" }], updatedAt: now - 10000 } }), new Date(now).toISOString());
  writable.close();
  const withTodos = readHubAgents({ dbPath: path }).agents[0].todos;
  assert.equal(withTodos.items[0].status, "completed");
  assert.equal(withTodos.source, "hub:checkpoint");
  assert.equal(withTodos.updatedAt, now);
  const retainedPr = result.agents.find(agent => agent.id === "historic-pr");
  assert.equal(retainedPr.pr.number, 72);
  assert.equal(retainedPr.pr.url, "https://github.com/owner/repo/pull/72");
  assert.equal(retainedPr.occupancy, "live", "an identifiable old PR remains visible after restart");
  assert.equal(result.agents.some(agent => agent.id === "historic-issue"), false);
  assert.equal(readHubAgents({ dbPath: join(directory, "missing.db") }).ok, false);
});

test("Hub logical tasks do not inherit diagnostics from a different local task", async () => {
  const local = {
    id: "session-1", source: "claude", taskId: "local-task", taskStartedAt: now - 10_000,
    sessionStartedAt: now - 20_000, originalAsk: "Local task request", originalAskSource: "task",
    activity: "Local diagnostic", lastLine: "Local diagnostic", status: "working",
  };
  const hubAgent = {
    id: "hub-task", source: "hub", taskId: "hub-task", taskStartedAt: now - 5_000,
    sessionStartedAt: null, originalAsk: "Hub task request", originalAskSource: "task",
    activity: "Hub diagnostic", lastLine: "Hub diagnostic", status: "working",
  };
  const localEvents = [{ id: "local-progress", kind: "progress", text: "Local progress", timestamp: now - 2_000 }];
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [local], sessions: [{ id: "session-1", events: localEvents, sidechains: new Map() }] }),
    readHub: () => ({ ok: true, agents: [hubAgent], keys: new Set(["hub-task", "session-1"]), links: new Map([["hub-task", new Set(["hub-task", "session-1"])]]) }),
  });

  await feed.scan();
  const [agent] = feed.snapshot().agents;
  assert.equal(agent.originalAsk, "Hub task request");
  assert.equal(agent.activity, "Hub diagnostic");
  assert.equal(agent.lastLine, "Hub diagnostic");
  assert.equal(agent.sessionStartedAt, now - 20_000, "session timing is safe to retain");
  assert.deepEqual((await feed.getActivity("hub-task")).events, []);
});

test("Hub logical tasks do not inherit diagnostics from an unscoped local transcript", async () => {
  const local = {
    id: "session-1", source: "claude", taskId: null, taskStartedAt: null,
    sessionStartedAt: now - 20_000, originalAsk: "Local session request", originalAskSource: "session",
    activity: "Local diagnostic", lastLine: "Local diagnostic", status: "working",
  };
  const hubAgent = {
    id: "hub-task", source: "hub", taskId: "hub-task", taskStartedAt: now - 5_000,
    sessionStartedAt: null, originalAsk: "Hub task request", originalAskSource: "task",
    activity: "Hub diagnostic", lastLine: "Hub diagnostic", status: "working",
  };
  const localEvents = [{ id: "local-progress", kind: "progress", text: "Local progress", timestamp: now - 2_000 }];
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [local], sessions: [{ id: "session-1", events: localEvents, sidechains: new Map() }] }),
    readHub: () => ({ ok: true, agents: [hubAgent], keys: new Set(["hub-task", "session-1"]), links: new Map([["hub-task", new Set(["hub-task", "session-1"])]]) }),
  });

  await feed.scan();
  const [agent] = feed.snapshot().agents;
  assert.equal(agent.originalAsk, "Hub task request");
  assert.equal(agent.activity, "Hub diagnostic");
  assert.equal(agent.lastLine, "Hub diagnostic");
  assert.equal(agent.sessionStartedAt, now - 20_000, "session timing is safe to retain");
  assert.deepEqual((await feed.getActivity("hub-task")).events, []);
});
