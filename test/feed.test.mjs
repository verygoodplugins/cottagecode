import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { parseTranscript } from "../src/transcripts.mjs";
import { mapHubStatus, toCottage, readHubAgents } from "../src/hub.mjs";
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

test("ordinary completed Claude turns are idle while explicit pending questions are blocked", () => {
  const completed = parseTranscript(JSON.stringify({ type: "assistant", sessionId: "complete", timestamp: new Date(now).toISOString(), message: { content: "All checks pass.", stop_reason: "end_turn" } }));
  assert.equal(toAgents([completed], { now })[0].status, "idle");
  const question = parseTranscript(JSON.stringify({ type: "assistant", sessionId: "question", timestamp: new Date(now).toISOString(), message: { content: [{ type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions: [{ question: "Which target?", options: [{ label: "Local" }, { label: "Staging" }] }] } }], stop_reason: "tool_use" } }));
  const agent = toAgents([question], { now })[0];
  assert.equal(agent.status, "blocked");
  assert.equal(agent.inputRequest.prompt, "Which target?");
  assert.equal(agent.attention, "Which target?");
  assert.equal(agent.inputRequest.questions[0].options[0].label, "Local");
});

test("an unanswered stale sidechain question remains a blocked cottage", () => {
  const session = parseTranscript(JSON.stringify({
    type: "assistant", sessionId: "parent-session", isSidechain: true, uuid: "child-root",
    timestamp: new Date(now - 5 * 60e3 - 1).toISOString(),
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "child-question", name: "AskUserQuestion",
      input: { questions: [{ question: "Which child target?" }] } }] },
  }));
  const child = toAgents([session], { now }).find(agent => agent.parent === "parent-session");
  assert.equal(child.inputRequest.id, "child-question");
  assert.equal(child.status, "blocked");
});

test("Hub input fields and pending transcript questions stay readable and clear on matched replies", async () => {
  const session = sampleSession();
  session.resolvedInputRequests.add("toolu_resolved");
  const hubAgent = toCottage({ id: "hub-question", record_kind: "external_session", session_id: "session-1", status: "awaiting_input", attention_message: "An old question?", attention_type: "question", attention_options: '["Yes","No"]', context: { integration: { requestId: "toolu_resolved" } } }, now);
  assert.equal(hubAgent.inputRequest.questions[0].options[1].label, "No");
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-question", new Set(["session-1"])]]) }),
  });
  await feed.scan();
  const combined = feed.snapshot().agents[0];
  assert.equal(combined.inputRequest, null);
  assert.equal(combined.status, "working");
  assert.equal(combined.attention, "");
  assert.equal((await feed.getActivity(combined.id)).inputRequest, null);
});

test("an answer received during an activity read cannot resurrect the earlier question", async () => {
  const session = { ...sampleSession(), taskId: "hub-question", taskStartedAt: now - 10_000 };
  let answered = false;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const row = { id: "hub-question", record_kind: "logical_task", session_id: "session-1", status: "awaiting_input", attention_message: "Which target?", attention_type: "question", context: { integration: { requestId: "question-one" } } };
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: toAgents([session], { now }), sessions: [session] }),
    readHub: () => ({ ...emptyHub(), agents: [toCottage({ ...row, attention_response: answered ? "Local" : null }, now)], keys: new Set(["session-1"]), links: new Map([["hub-question", new Set(["session-1"])]]) }),
    timeline: { configured: true, readTodos: async () => wait },
  });
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest.id, "question-one");
  const reading = feed.getActivity("hub-question");
  answered = true;
  await feed.scan();
  release(null);
  assert.equal((await reading).inputRequest, null);
  assert.equal(feed.snapshot().agents[0].status, "idle");
});

test("Hub resolution suppresses a lagging local question until a distinct newer request", async () => {
  let questionId = "fixture-question", questionAt = now - 2000;
  let row = { id: "hub-question", record_kind: "logical_task", session_id: "session-1", started_at: now - 10000,
    status: "awaiting_input", attention_message: "Which target?", attention_type: "question", attention_response: "Local",
    attention_resolved_at: now, updated_at: now, context: { integration: { requestId: "fixture-question" } } };
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => {
      const session = parseTranscript(JSON.stringify({ type: "assistant", sessionId: "session-1", taskId: "hub-question", timestamp: new Date(questionAt).toISOString(),
        message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: questionId, name: "AskUserQuestion", input: { questions: [{ question: "Which target?" }] } }] } }));
      assert.ok(session.inputRequest, "the transcript genuinely still has an unanswered tool call");
      return { ok: true, agents: toAgents([session], { now }), sessions: [session] };
    },
    readHub: () => ({ ...emptyHub(), agents: [toCottage(row, now)], keys: new Set(["session-1"]), links: new Map([["hub-question", new Set(["session-1"])]]) }),
  });
  const mapped = toCottage(row, now);
  assert.equal(mapped.inputRequest, null);
  assert.deepEqual(mapped.inputRequestResolution, { id: "fixture-question", resolvedAt: now, source: "hub:attention" });
  assert.equal(mapped.status, "idle");
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest, null);
  assert.equal(feed.snapshot().agents[0].status, "idle");
  assert.equal((await feed.getActivity("hub-question")).inputRequest, null);
  row = { ...row, status: "running", attention_type: null, attention_message: null, attention_response: null, attention_resolved_at: null };
  questionAt = now + 1000;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest, null, "cleared Hub fields and a same-ID streamed revision cannot erase the resolution");
  questionId = "different-old-question"; questionAt = now - 1000;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest, null, "a different ID still needs evidence that it is newer than the answer");
  questionId = "new-question"; questionAt = now + 2000;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest.id, "new-question");
  assert.equal(feed.snapshot().agents[0].status, "blocked");
});

test("a retained Hub resolution suppresses the same lingering raw Hub prompt", async () => {
  let resolved = true;
  let prompt = "Which target?";
  let requestId = "fixture-question";
  let updatedAt = now;
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [], sessions: [] }),
    readHub: () => {
      const row = {
        id: "hub-question", record_kind: "logical_task", session_id: "session-1", status: "awaiting_input",
        attention_message: prompt, attention_type: "question", updated_at: updatedAt,
        context: { integration: { requestId } },
        ...(resolved ? { attention_response: "Local", attention_resolved_at: now } : {}),
      };
      return { ...emptyHub(), agents: [toCottage(row, now)], keys: new Set(["session-1"]), links: new Map() };
    },
  });

  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest, null);
  resolved = false;
  updatedAt = now + 1_000; // A hub heartbeat can update the row without asking again.
  await feed.scan();
  const lingering = feed.snapshot();
  assert.equal(lingering.agents[0].inputRequest, null);
  assert.equal(lingering.agents[0].status, "idle");
  assert.equal(lingering.agents[0].attention, "");
  assert.equal(lingering.letters, 0);

  requestId = "fixture-question-two";
  prompt = "Which release?";
  updatedAt = now + 2_000;
  await feed.scan();
  assert.equal(feed.snapshot().agents[0].inputRequest.id, "fixture-question-two");
  assert.equal(feed.snapshot().agents[0].status, "blocked");
});

test("a retained Hub resolution clears an old prompt after its linked transcript advances tasks", async () => {
  let answered = true;
  let localTaskId = "hub-question";
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => {
      const localInput = { id: "local-question", kind: "question", prompt: "New task question", questions: [], updatedAt: now + 2_000 };
      const local = {
        id: "session-1", source: "claude", taskId: localTaskId, taskStartedAt: now + 1_000,
        sessionStartedAt: now - 10_000, status: "blocked", originalAsk: "The new local task", inputRequest: localInput,
      };
      return { ok: true, agents: [local], sessions: [{ ...local, events: [], sidechains: new Map(), resolvedInputRequests: new Set() }] };
    },
    readHub: () => {
      const row = {
        id: "hub-question", record_kind: "logical_task", session_id: "session-1", status: "awaiting_input",
        task: "The Hub task", attention_message: "Which target?", attention_type: "question", updated_at: now + 1_000,
        context: { integration: { requestId: "hub-question-round" } },
        ...(answered ? { attention_response: "Local", attention_resolved_at: now } : {}),
      };
      return { ...emptyHub(), agents: [toCottage(row, now)], keys: new Set(["session-1"]), links: new Map([["hub-question", new Set(["hub-question", "session-1"])]]) };
    },
  });

  await feed.scan();
  localTaskId = "new-local-task";
  answered = false;
  await feed.scan();

  const snapshot = feed.snapshot();
  const hub = snapshot.agents.find(agent => agent.id === "hub-question");
  const local = snapshot.agents.find(agent => agent.id === "session-1");
  assert.equal(hub.inputRequest, null);
  assert.equal(hub.status, "idle");
  assert.equal(hub.attention, "");
  assert.equal(hub.originalAsk, "The Hub task", "the Hub cottage keeps its own task diagnostics");
  assert.equal((await feed.getActivity(hub.id)).inputRequest, null);
  assert.equal(local.taskId, "new-local-task");
  assert.equal(local.inputRequest.prompt, "New task question", "the distinct transcript task remains separate");
  assert.equal(snapshot.letters, 1, "only the new transcript task contributes an input letter");
});

test("resolved terminal Hub attention does not remain blocked or visible", () => {
  for (const status of ["failed", "cancelled", "interrupted"]) {
    for (const resolution of [{ attention_response: "Continue" }, { attention_resolved_at: now }]) {
      const row = {
        id: `terminal-${status}`,
        record_kind: "logical_task",
        status,
        attention_type: "question",
        attention_message: "Which target?",
        updated_at: now,
        ...resolution,
      };
      const cottage = toCottage(row, now);
      assert.equal(mapHubStatus(row, now), "offline", `${status} remains terminal after attention resolves`);
      assert.equal(cottage.status, "offline");
      assert.equal(cottage.occupancy, "settled");
      assert.equal(cottage.inputRequest, null);
      assert.equal(cottage.attention, "");
    }
  }
});

test("a resolved Hub prompt does not hide a distinct newer local prompt", async () => {
  const hubAgent = toCottage({
    id: "hub-task", record_kind: "logical_task", session_id: "session-1", status: "awaiting_input",
    attention_message: "Old Hub prompt", attention_type: "question", updated_at: now,
    context: { integration: { requestId: "prompt-a" } },
  }, now);
  const localInput = { id: "prompt-b", kind: "question", prompt: "New local prompt", questions: [{ id: "question-1", prompt: "New local prompt", options: [] }], source: "transcript", updatedAt: now + 1 };
  const local = { id: "session-1", source: "claude", taskId: "hub-task", taskStartedAt: now - 1_000,
    sessionStartedAt: now - 2_000, status: "blocked", inputRequest: localInput };
  const localSession = { id: "session-1", events: [], sidechains: new Map(), inputRequest: localInput,
    resolvedInputRequests: new Set(["prompt-a"]) };
  const feed = createFeed({ ...feedOptions,
    scanClaude: async () => ({ ok: true, agents: [local], sessions: [localSession] }),
    readHub: () => ({ ...emptyHub(), agents: [hubAgent], keys: new Set(["session-1"]), links: new Map([["hub-task", new Set(["hub-task", "session-1"])]]) }),
  });

  await feed.scan();
  const [combined] = feed.snapshot().agents;
  assert.equal(combined.inputRequest.id, "prompt-b");
  assert.equal(combined.inputRequest.prompt, "New local prompt");
  assert.equal(combined.status, "blocked");
  assert.equal(combined.attention, "New local prompt");
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

test("Hub task notifications expose their summary instead of raw transport markup", () => {
  const notification = '<task-notification><task-id>buU0py927</task-id><summary>Monitor event: “ci:preflight progress for lane-liveness docs PR”</summary><event>STEP: [ci:preflight] npm run test:agent-kernel:ci</event></task-notification>';
  const agent = toCottage({
    id: "notification", record_kind: "logical_task", status: "running", task: notification,
    context: { customerRequest: notification },
  }, now);
  assert.equal(agent.task, 'Monitor event: “ci:preflight progress for lane-liveness docs PR”');
  assert.equal(agent.originalAsk, 'Monitor event: “ci:preflight progress for lane-liveness docs PR”');
  assert.ok(!agent.task.includes("<task-notification>"));
  assert.ok(!agent.originalAsk.includes("<task-id>"));
});

test("a dated context todo snapshot stays ahead of an undated checkpoint", () => {
  const agent = toCottage({
    id: "hub-run", record_kind: "logical_task", status: "running", task: "Current task",
    context: { todos: { items: [{ id: "context", text: "Dated context checklist", status: "in_progress" }], updatedAt: now } },
    todo_snapshot: JSON.stringify({ items: [{ id: "checkpoint", text: "Undated checkpoint checklist", status: "pending" }] }),
    todo_updated_at: "not a timestamp",
  }, now);

  assert.equal(agent.todos.items[0].text, "Dated context checklist");
  assert.equal(agent.todos.updatedAt, now);

  const undated = toCottage({
    id: "hub-run-undated", record_kind: "logical_task", status: "running", task: "Current task",
    context: { todos: { items: [{ id: "context", text: "Undated context checklist", status: "in_progress" }] } },
    todo_snapshot: JSON.stringify({ items: [{ id: "checkpoint", text: "Undated checkpoint checklist", status: "pending" }] }),
    todo_updated_at: "not a timestamp",
  }, now);
  assert.equal(undated.todos.items[0].text, "Undated checkpoint checklist");
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
  const response = await fetch(`${base}/agents`, { headers: { Origin: base } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null,
    "the local feed does not opt arbitrary pages into reading private agent data");
  assert.equal((await response.json()).agents.length, 1);
  const crossOrigin = await fetch(`${base}/agents`, { headers: { Origin: "https://example.test" } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
  const crossOriginActivity = await fetch(`${base}/agents/session-1/activity`, { headers: { Origin: "https://example.test" } });
  assert.equal(crossOriginActivity.status, 403);
  assert.equal((await fetch(`${base}/agents`)).status, 200, "local command-line reads remain available");
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

test("bundled music supports native ranges, HEAD, and rejects missing or escaping audio", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const web = join(directory, "web");
  await mkdir(join(web, "audio"), { recursive: true });
  const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  await writeFile(join(web, "audio", "day.mp3"), bytes);
  await writeFile(join(directory, "outside.mp3"), "outside audio");
  await symlink(join(directory, "outside.mp3"), join(web, "audio", "escape.mp3"));
  const feed = { snapshot: () => ({ agents: [] }) };
  const server = createFeedServer(feed, { directory: web }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/modules/audio/`;
  const full = await fetch(base + "day.mp3");
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const etag = full.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const cached = await fetch(base + "day.mp3", { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("etag"), etag);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [["bytes=0-9", 0, 9], ["bytes=10-", 10, 35], ["bytes=-3", 33, 35], ["bytes=30-900", 30, 35], ["bytes=-90", 0, 35]]) {
    const response = await fetch(base + "day.mp3", { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/36`);
    assert.equal(Number(response.headers.get("content-length")), end - start + 1);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const currentRange = await fetch(base + "day.mp3", { headers: { range: "bytes=0-9", "if-range": etag } });
  assert.equal(currentRange.status, 206);
  assert.deepEqual(Buffer.from(await currentRange.arrayBuffer()), bytes.subarray(0, 10));
  const staleRange = await fetch(base + "day.mp3", { headers: { range: "bytes=0-9", "if-range": '"stale-version"' } });
  assert.equal(staleRange.status, 200);
  assert.equal(staleRange.headers.get("content-range"), null);
  assert.equal(staleRange.headers.get("content-length"), "36");
  assert.deepEqual(Buffer.from(await staleRange.arrayBuffer()), bytes);
  for (const range of ["bytes=36-", "bytes=9-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "items=0-1", "bytes=999999999999999999999-"]) {
    const response = await fetch(base + "day.mp3", { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */36");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const head = await fetch(base + "day.mp3", { method: "HEAD", headers: { range: "bytes=0-1" } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "36");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const file of ["missing.mp3", "escape.mp3", "%2e%2e%2foutside.mp3"]) assert.equal((await fetch(base + file)).status, 404);
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

test("terminal Hub attention stops the task clock at the recorded end", () => {
  const agent = toCottage({
    id: "needs-decision", status: "failed", attention_message: "Choose the release target",
    started_at: "2026-09-14 10:00:00", completed_at: "2026-09-14 10:05:00", updated_at: "2026-09-14 10:05:00",
    context: {},
  }, now);
  assert.equal(agent.status, "blocked");
  assert.equal(agent.terminal, true);
  assert.equal(agent.endedAt, now - 55 * 60 * 1000);
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
  const questionsDb = new DatabaseSync(path);
  questionsDb.exec("ALTER TABLE agent_runs ADD COLUMN attention_options TEXT; ALTER TABLE agent_runs ADD COLUMN attention_detail TEXT; ALTER TABLE agent_runs ADD COLUMN attention_response TEXT; ALTER TABLE agent_runs ADD COLUMN attention_resolved_at TEXT");
  questionsDb.prepare("UPDATE agent_runs SET status = ?, attention_type = ?, attention_message = ?, attention_options = ?, attention_detail = ?, context = ? WHERE id = ?")
    .run("awaiting_input", "question", "Choose the test target", '["Local","Staging"]', "This task is waiting on its target.", JSON.stringify({ integration: { requestId: "db-question-one" } }), "old-task");
  let asking = readHubAgents({ dbPath: path }).agents[0];
  assert.equal(asking.inputRequest.id, "db-question-one");
  assert.equal(asking.inputRequest.questions[0].options[1].label, "Staging");
  assert.equal(asking.inputRequest.detail, "This task is waiting on its target.");
  assert.equal(asking.status, "blocked");
  questionsDb.prepare("UPDATE agent_runs SET attention_response = ? WHERE id = ?").run("Local", "old-task");
  asking = readHubAgents({ dbPath: path }).agents[0];
  assert.equal(asking.inputRequest, null);
  assert.equal(asking.status, "idle");
  assert.equal(asking.attention, "");
  questionsDb.close();
  const retainedPr = result.agents.find(agent => agent.id === "historic-pr");
  assert.equal(retainedPr.pr.number, 72);
  assert.equal(retainedPr.pr.url, "https://github.com/owner/repo/pull/72");
  assert.equal(retainedPr.occupancy, "live", "an identifiable old PR remains visible after restart");
  assert.equal(result.agents.some(agent => agent.id === "historic-issue"), false);
  assert.equal(readHubAgents({ dbPath: join(directory, "missing.db") }).ok, false);
});

test("Hub retains old finalization-only result receipts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-hub-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_runs (
    id TEXT, agent TEXT, status TEXT, task TEXT, user TEXT, platform TEXT, model TEXT, parent_id TEXT, session_id TEXT,
    context TEXT, queued_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, archived INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
    total_cost REAL, error TEXT, result_summary TEXT, attention_type TEXT, attention_message TEXT, result TEXT
  )`);
  const insert = db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, result, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const finished = "2000-01-01 00:00:00";
  insert.run("receipt-number", "Resident", "completed", "Historic receipt", "{}", JSON.stringify({
    finalization: { status: "ready", pullRequestNumber: 73 },
  }), finished, finished);
  insert.run("receipt-url", "Resident", "completed", "Historic receipt", "{}", JSON.stringify({
    finalization: { status: "ready", pullRequestUrl: "https://github.com/owner/repo/pull/74" },
  }), finished, finished);
  db.close();

  const result = readHubAgents({ dbPath: path });
  assert.equal(result.ok, true);
  assert.equal(result.agents.find(agent => agent.id === "receipt-number")?.pr.number, 73);
  assert.equal(result.agents.find(agent => agent.id === "receipt-url")?.pr.url, "https://github.com/owner/repo/pull/74");
});

test("Hub prioritizes historic PR evidence above the default completed-task cap", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-hub-pr-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_runs (
    id TEXT, agent TEXT, status TEXT, task TEXT, user TEXT, platform TEXT, model TEXT, parent_id TEXT, session_id TEXT,
    context TEXT, queued_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, archived INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
    total_cost REAL, error TEXT, result_summary TEXT, attention_type TEXT, attention_message TEXT
  )`);
  db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "historic-pr", "Resident", "completed", "Keep this receipt", JSON.stringify({
      repo: "owner/repo", finalization: { status: "ready", pullRequestNumber: 91 },
    }), "2000-01-01 00:00:00", "2000-01-01 00:00:00",
  );
  const fresh = db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))");
  for (let index = 0; index < 81; index++) {
    fresh.run(`completed-${index}`, "Resident", "completed", "Recent task", "{}");
  }
  const historic = db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  historic.run("placeholder-open", "Resident", "completed", "Placeholder", JSON.stringify({ pr: { state: "open", number: null } }), "2000-01-01 00:00:00", "2000-01-01 00:00:00");
  historic.run("terminal-pr", "Resident", "completed", "Merged work", JSON.stringify({ repo: "owner/repo", pr: { state: "merged", number: 92 } }), "2000-01-01 00:00:00", "2000-01-01 00:00:00");
  for (let index = 0; index < 161; index++) {
    const timestamp = new Date(Date.parse("2000-01-02T00:00:00Z") + index * 1000).toISOString();
    historic.run(`terminal-candidate-${index}`, "Resident", "completed", "Merged work", JSON.stringify({
      repo: "owner/repo", finalization: { status: "merged", pullRequestNumber: index + 1000 },
    }), timestamp, timestamp);
  }
  db.close();

  const result = readHubAgents({ dbPath: path });
  assert.equal(result.ok, true);
  assert.equal(result.agents.length, 80, "the regular result cap stays bounded");
  assert.equal(result.agents.find(agent => agent.id === "historic-pr")?.pr.number, 91,
    "a completed row retained only for parsed outstanding PR evidence wins a place in the default view");
  assert.equal(result.agents.some(agent => agent.id === "placeholder-open"), false,
    "a null open-state placeholder cannot consume the retention priority");
  assert.equal(result.agents.some(agent => agent.id === "terminal-pr"), false,
    "a merged PR cannot consume the retention priority");
});

test("Hub retains old context-only PR receipts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-hub-context-pr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_runs (
    id TEXT, agent TEXT, status TEXT, task TEXT, user TEXT, platform TEXT, model TEXT, parent_id TEXT, session_id TEXT,
    context TEXT, queued_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, archived INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
    total_cost REAL, error TEXT, result_summary TEXT, attention_type TEXT, attention_message TEXT, result TEXT
  )`);
  const insert = db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const finished = "2000-01-01 00:00:00";
  insert.run("context-finalization", "Resident", "completed", "Historic receipt", JSON.stringify({
    repo: "owner/repo", finalization: { status: "ready", pullRequestNumber: 75 },
  }), finished, finished);
  insert.run("context-pr", "Resident", "completed", "Historic receipt", JSON.stringify({
    repo: "owner/repo", pr: { number: 76, url: "https://github.com/owner/repo/pull/76" },
  }), finished, finished);
  insert.run("context-pr-receipt", "Resident", "completed", "Historic receipt", JSON.stringify({
    repo: "owner/repo", pr: { finalization: { status: "ready", pullRequestNumber: 77 } },
  }), finished, finished);
  db.close();

  const result = readHubAgents({ dbPath: path });
  assert.equal(result.ok, true);
  assert.equal(result.agents.find(agent => agent.id === "context-finalization")?.pr.number, 75);
  assert.equal(result.agents.find(agent => agent.id === "context-pr")?.pr.url, "https://github.com/owner/repo/pull/76");
  assert.equal(result.agents.find(agent => agent.id === "context-pr-receipt")?.pr.number, 77);
});

test("Hub drops old explicit open PR placeholders without an identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-hub-open-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "hub.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agent_runs (
    id TEXT, agent TEXT, status TEXT, task TEXT, user TEXT, platform TEXT, model TEXT, parent_id TEXT, session_id TEXT,
    context TEXT, queued_at TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT, archived INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
    total_cost REAL, error TEXT, result_summary TEXT, attention_type TEXT, attention_message TEXT
  )`);
  db.prepare("INSERT INTO agent_runs(id, agent, status, task, context, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "context-open-state", "Resident", "completed", "Historic receipt", JSON.stringify({ pr: { state: "open" } }),
    "2000-01-01 00:00:00", "2000-01-01 00:00:00",
  );
  db.close();

  const result = readHubAgents({ dbPath: path });
  assert.equal(result.agents.some(agent => agent.id === "context-open-state"), false,
    "an unidentifiable open state is not durable PR evidence");
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
  const cottages = feed.snapshot().agents;
  const agent = cottages.find(cottage => cottage.id === "hub-task");
  assert.deepEqual(cottages.map(cottage => cottage.id).sort(), ["hub-task", "session-1"]);
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
  const cottages = feed.snapshot().agents;
  const agent = cottages.find(cottage => cottage.id === "hub-task");
  assert.deepEqual(cottages.map(cottage => cottage.id).sort(), ["hub-task", "session-1"]);
  assert.equal(agent.originalAsk, "Hub task request");
  assert.equal(agent.activity, "Hub diagnostic");
  assert.equal(agent.lastLine, "Hub diagnostic");
  assert.equal(agent.sessionStartedAt, now - 20_000, "session timing is safe to retain");
  assert.deepEqual((await feed.getActivity("hub-task")).events, []);
});
