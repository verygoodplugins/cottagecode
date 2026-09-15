import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timestampMs, normalizeActivityEvent, mergeActivityEvents, pageActivity, createHubTimelineReader } from "../src/activity.mjs";
import { blankSession, applyLine, parseTranscript, createTranscriptReader } from "../src/transcripts.mjs";

const start = Date.parse("2026-09-14T10:00:00Z");
const line = (type, content, index, extra = {}) => ({
  type, timestamp: new Date(start + index * 1000).toISOString(),
  uuid: `record-${index}`, sessionId: "session-one", cwd: "/projects/autohub",
  message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) }, ...extra,
});
const event = index => ({ id: `event-${index}`, timestamp: start + index * 1000, kind: "progress", text: `Step ${index}` });

test("timestamps never turn missing values or zero into an invented start", () => {
  for (const value of [undefined, null, "", 0, "0", "2026", "bad", {}, "2001-01-01T00:00:00Z"]) assert.equal(timestampMs(value), null);
  assert.equal(timestampMs(start), start);
  assert.equal(timestampMs("2026-09-14 10:00:00"), start);
  assert.equal(timestampMs("2026-09-14T12:00:00+02:00"), start);
});

test("original request survives tool replies, assistant progress, and follow-ups", () => {
  const session = parseTranscript([
    line("user", "Injected instructions", 0, { isMeta: true }),
    line("user", [{ type: "tool_result", content: "An earlier command output" }], 1),
    line("user", "Please fix the voice interruption.\nKeep the spoken answer brief.", 2),
    line("assistant", [{ type: "text", text: "Checking the voice handler" }], 3),
    line("user", "Also check the simulator.", 4),
    line("assistant", [{ type: "text", text: "The fix is verified." }], 5),
  ].map(JSON.stringify).join("\n"));
  assert.equal(session.originalAsk, "Please fix the voice interruption.\nKeep the spoken answer brief.");
  assert.equal(session.originalAskSource, "session");
  assert.equal(session.taskId, null);
  assert.equal(session.taskStartedAt, null);
  assert.equal(session.lastText, "The fix is verified.");
  assert.equal(session.firstTs, start);
});

test("a request after a closed system reminder remains the original ask", () => {
  const session = parseTranscript(JSON.stringify(line("user", [
    { type: "text", text: "<system-reminder>\nSession context changed.\n</system-reminder>\n\nPlease repair the reconnect flow." },
  ], 1)));
  assert.equal(session.originalAsk, "Please repair the reconnect flow.");
  assert.deepEqual(session.events.map(entry => entry.text), ["Please repair the reconnect flow."]);
});

test("only explicit task identities create a new task request and timeline", () => {
  const session = blankSession();
  applyLine(session, line("user", "Task one", 1, { taskId: "run-one" }));
  applyLine(session, line("assistant", "Done one", 2, { taskId: "run-one" }));
  assert.equal(session.taskStartedAt, start + 1000);
  applyLine(session, line("user", "Task two", 3, { taskId: "run-two" }));
  assert.equal(session.originalAsk, "Task two");
  assert.equal(session.originalAskSource, "task");
  assert.equal(session.taskStartedAt, start + 3000);
  assert.equal(session.lastText, "");
  assert.deepEqual(session.events.map(entry => entry.text), ["Task two"]);
  const observedMidTask = blankSession();
  applyLine(observedMidTask, line("assistant", "Already working", 2, { taskId: "ongoing" }));
  assert.equal(observedMidTask.taskStartedAt, null);
});

test("pending Claude questions resolve by tool ID without clearing a newer prompt", () => {
  const session = blankSession();
  const ask = (id, prompt) => ({ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: prompt, options: [{ label: "Yes", description: "Use the fixture" }, { label: "No" }] }] } });
  applyLine(session, line("assistant", [ask("toolu_old", "Old question?")], 1));
  assert.equal(session.inputRequest.prompt, "Old question?");
  applyLine(session, line("assistant", [ask("toolu_new", "Current question?")], 2));
  applyLine(session, line("user", [{ type: "tool_result", tool_use_id: "toolu_old", content: "Yes" }], 3));
  assert.equal(session.inputRequest.id, "toolu_new");
  applyLine(session, line("user", [{ type: "tool_result", tool_use_id: "toolu_new", content: "No" }], 4));
  assert.equal(session.inputRequest, null);
  applyLine(session, line("assistant", [ask("toolu_new", "Delayed duplicate question?")], 5));
  assert.equal(session.inputRequest, null);
  applyLine(session, line("assistant", [ask("toolu_next", "One more question?")], 6));
  applyLine(session, line("user", "A new explicit task", 7, { taskId: "new-run" }));
  assert.equal(session.inputRequest, null);
});

test("explicit input clears tombstone the matching request and never clear a newer one", () => {
  const resolvedStates = [{ resolved: true }, { pending: false }, { resolvedAt: start }, { resolved_at: start }];
  for (const resolution of [...resolvedStates, null]) {
    const session = blankSession();
    applyLine(session, { inputRequest: { id: "input-one", prompt: "Which target?" } });
    applyLine(session, { inputRequest: resolution === null ? null : { id: "input-one", ...resolution } });
    assert.equal(session.inputRequest, null);
    assert.equal(session.resolvedInputRequests.has("input-one"), true);
    applyLine(session, { inputRequest: { id: "input-one", prompt: "A streamed revision of the same question?" } });
    assert.equal(session.inputRequest, null);
  }
  for (const resolution of resolvedStates) {
    const session = blankSession();
    applyLine(session, { inputRequest: { id: "input-old", prompt: "Old question?" } });
    applyLine(session, { inputRequest: { id: "input-new", prompt: "New question?" } });
    applyLine(session, { inputRequest: { id: "input-old", ...resolution } });
    assert.equal(session.inputRequest.id, "input-new");
    assert.equal(session.resolvedInputRequests.has("input-old"), true);
    applyLine(session, { inputRequest: { ...resolution } });
    assert.equal(session.inputRequest, null, "an explicit current-request resolution may omit its ID");
    assert.equal(session.resolvedInputRequests.has("input-new"), true);
  }
});

test("questions remain isolated from child work and ordinary tool calls", () => {
  const session = blankSession();
  const ask = { type: "tool_use", id: "child-question", name: "AskUserQuestion", input: { questions: [{ question: "Which child target?" }] } };
  applyLine(session, line("assistant", [ask], 1, { isSidechain: true, uuid: "child-root" }));
  assert.equal(session.inputRequest, null);
  assert.equal(session.sidechains.get("child-root").inputRequest.id, "child-question");
  applyLine(session, line("user", [{ type: "tool_result", tool_use_id: "child-question", content: "Unrelated parent tool result" }], 2));
  assert.equal(session.sidechains.get("child-root").inputRequest.id, "child-question");
  applyLine(session, line("user", [{ type: "tool_result", tool_use_id: "child-question", content: "Local" }], 3, { isSidechain: true, parentUuid: "child-root" }));
  assert.equal(session.sidechains.get("child-root").inputRequest, null);
  applyLine(session, line("assistant", [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { description: "Run tests" } }], 4));
  assert.equal(session.inputRequest, null);
  applyLine(session, { hook_event_name: "PermissionRequest", tool_use_id: "toolu_permission", tool_name: "Bash", tool_input: { description: "Run fixture checks?" }, timestamp: new Date(start + 5000).toISOString() });
  assert.equal(session.inputRequest.kind, "permission");
  assert.equal(session.inputRequest.prompt, "Run fixture checks?");
  applyLine(session, { hook_event_name: "PostToolUse", tool_use_id: "toolu_bash" });
  assert.equal(session.inputRequest.id, "toolu_permission");
  applyLine(session, { hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_permission" });
  assert.equal(session.inputRequest, null);
});

test("explicit Bash permissions include bounded command detail without arbitrary input", () => {
  const session = blankSession();
  const command = "node --test test/fixture.test.mjs";
  applyLine(session, { hook_event_name: "PermissionRequest", tool_use_id: "permission-command", tool_name: "Bash",
    tool_input: { command, environment: { API_KEY: "fixture-private-value" }, unrelated: "never copy this" } });
  assert.equal(session.inputRequest.kind, "permission");
  assert.equal(session.inputRequest.detail, command);
  assert.doesNotMatch(JSON.stringify(session.inputRequest), /fixture-private-value|never copy this|environment/);
  applyLine(session, { hook_event_name: "PermissionRequest", tool_use_id: "permission-bounded", tool_name: "Bash", tool_input: { command: "x".repeat(20000) } });
  assert.equal(session.inputRequest.detail.length, 16000);
  applyLine(session, { hook_event_name: "PermissionRequest", tool_use_id: "permission-other", tool_name: "CustomTool", tool_input: { command: "not a Bash command", unrelated: "never copy this" } });
  assert.equal(session.inputRequest.detail, "");
});

test("Codex request_user_input and app-server responses clear only their matching request", () => {
  const session = blankSession();
  const questions = [{ id: "target", question: "Which target?", options: [{ label: "Local" }, { label: "Staging" }] }];
  applyLine(session, { type: "response_item", timestamp: new Date(start).toISOString(), payload: { type: "function_call", name: "request_user_input", call_id: "call_input", arguments: JSON.stringify({ questions }) } });
  assert.equal(session.inputRequest.id, "call_input");
  applyLine(session, { type: "response_item", payload: { type: "function_call_output", call_id: "call_other", output: "done" } });
  assert.equal(session.inputRequest.id, "call_input");
  applyLine(session, { type: "response_item", payload: { type: "function_call_output", call_id: "call_input", output: JSON.stringify({ answers: { target: { answers: ["Local"] } } }) } });
  assert.equal(session.inputRequest, null);
  applyLine(session, { id: 42, method: "item/tool/requestUserInput", params: { questions } });
  assert.equal(session.inputRequest.id, "42");
  applyLine(session, { id: 41, result: { answers: {} } });
  assert.equal(session.inputRequest.id, "42");
  applyLine(session, { id: 42, result: { answers: { target: { answers: ["Local"] } } } });
  assert.equal(session.inputRequest, null);
});

test("explicit todo snapshots stay isolated by task and child, and empty means cleared", () => {
  const session = blankSession();
  const todo = (content, status = "pending") => ({ type: "tool_use", name: "TodoWrite", input: { todos: [{ content, status }] } });
  applyLine(session, line("assistant", [todo("Parent work", "in_progress")], 1, { taskId: "parent-task" }));
  assert.equal(session.todos.items[0].text, "Parent work");
  assert.equal(session.todos.source, "claude-transcript:TodoWrite");
  assert.equal(session.todos.updatedAt, start + 1000);
  applyLine(session, line("assistant", [todo("Child work")], 2, { isSidechain: true, uuid: "child-todos" }));
  assert.equal(session.sidechains.get("child-todos").todos.items[0].text, "Child work");
  assert.equal(session.todos.items[0].text, "Parent work");
  applyLine(session, line("assistant", [todo("Unidentified child")], 3, { isSidechain: true, uuid: undefined }));
  assert.equal(session.todos.items[0].text, "Parent work");
  applyLine(session, line("assistant", [{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }], 4));
  assert.deepEqual(session.todos.items, []);
  assert.deepEqual(session.events.at(-1).todos.items, []);
  applyLine(session, line("user", "A new explicit task", 5, { taskId: "new-task" }));
  assert.equal(session.todos, null);
  applyLine(session, line("assistant", "- [x] Everything is done", 6));
  assert.equal(session.todos, null);
});

test("Codex update_plan and completed todo_list records preserve structured task state", () => {
  const session = blankSession();
  applyLine(session, { type: "response_item", timestamp: new Date(start).toISOString(), sessionId: "codex-session", payload: {
    type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Inspect the handler", status: "in_progress" }] }),
  } });
  const id = session.todos.items[0].id;
  assert.equal(session.todos.items[0].status, "in_progress");
  applyLine(session, { type: "item.completed", timestamp: new Date(start + 1000).toISOString(), item: {
    id: "todo-update", type: "todo_list", items: [{ text: "Inspect the handler", completed: true }],
  } });
  assert.equal(session.todos.items[0].id, id);
  assert.equal(session.todos.items[0].status, "completed");
  assert.equal(session.todos.source, "codex:todo_list");
});

test("activity preserves structured plan arrays without parsing flattened checklist prose", () => {
  const structured = normalizeActivityEvent({ id: "plan", kind: "plan", items: [{ step: "Run tests", status: "pending" }], ts: start });
  assert.equal(structured.todos.items[0].text, "Run tests");
  assert.equal(structured.timestamp, start);
  assert.equal(normalizeActivityEvent({ id: "preview", kind: "plan", detail: "Run tests (completed)" }).todos, undefined);
  const tool = normalizeActivityEvent({ id: "tool-plan", kind: "tool_call", tool: "TodoWrite", title: "TodoWrite", input_preview: JSON.stringify({ todos: [{ content: "Run tests", status: "completed" }] }), ts: start });
  assert.equal(tool.todos.items[0].status, "completed");
});

test("public activity drops private thought blocks and retains explicit summaries", () => {
  const session = blankSession();
  const record = line("assistant", [
    { type: "thinking", thinking: "PRIVATE REASONING CONTENT" },
    { type: "redacted_thinking", data: "PRIVATE REDACTED CONTENT" },
    { type: "reasoning_summary", text: "The failure is isolated to reconnects." },
    { type: "tool_use", name: "Bash", input: { description: "Run reconnect tests", command: "secret-command" } },
  ], 1);
  applyLine(session, record);
  applyLine(session, record);
  assert.deepEqual(session.events.map(entry => entry.kind), ["summary", "tool"]);
  assert.equal(session.events.length, 2);
  assert.doesNotMatch(JSON.stringify(session.events), /PRIVATE|secret-command/);
  assert.equal(normalizeActivityEvent({ id: "raw", kind: "thinking", detail: "private" }), null);
  assert.equal(normalizeActivityEvent({ id: "raw", kind: "future_private_kind", detail: "private" }), null);
});

test("only explicit handoff events retain a validated pair of town names", () => {
  const raw = { id: "handoff-1", kind: "handoff", text: "Send the API contract", from: " HubTown ", to: "AppTown" };
  assert.deepEqual(normalizeActivityEvent(raw), {
    id: "handoff-1", timestamp: null, kind: "handoff", text: "Send the API contract", from: "HubTown", to: "AppTown",
  });
  for (const invalid of ["", "   ", "A".repeat(81), "Hub\nTown", "Hub\u007fTown", 42, {}, null]) {
    for (const key of ["from", "to"]) {
      const event = normalizeActivityEvent({ ...raw, [key]: invalid });
      assert.equal(event.from, undefined);
      assert.equal(event.to, undefined);
    }
  }
  const progress = normalizeActivityEvent({ ...raw, kind: "progress" });
  assert.equal(progress.from, undefined);
  assert.equal(progress.to, undefined);
  assert.equal(normalizeActivityEvent({ ...raw, to: undefined }).from, undefined);
});

test("sidechain assignments and results remain in the child's journal", () => {
  const session = blankSession();
  applyLine(session, line("user", "Parent request", 1));
  applyLine(session, line("user", "Child assignment", 2, { isSidechain: true, uuid: "child-root" }));
  applyLine(session, line("assistant", "Child report", 3, { isSidechain: true, parentUuid: "child-root" }));
  assert.equal(session.originalAsk, "Parent request");
  assert.deepEqual(session.events.map(entry => entry.text), ["Parent request"]);
  const child = session.sidechains.get("child-root");
  assert.equal(child.originalAsk, "Child assignment");
  assert.deepEqual(child.events.map(entry => entry.text), ["Child assignment", "Child report"]);
});

test("incremental reads preserve partial lines, UTF-8, and reset on truncation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cottage-transcript-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  const reader = createTranscriptReader();
  const first = Buffer.from(`${JSON.stringify(line("user", "Feed the 🦆 ducks", 1))}\n`);
  const split = first.indexOf(Buffer.from("🦆")) + 2;
  await writeFile(path, first.subarray(0, split));
  assert.equal((await reader.read(path)).originalAsk, "");
  await appendFile(path, first.subarray(split));
  const parsed = await reader.read(path);
  assert.equal(parsed.originalAsk, "Feed the 🦆 ducks");
  assert.equal((await reader.read(path)).events.length, 1);
  await appendFile(path, `${JSON.stringify(line("assistant", "Ducks fed", 2))}\n`);
  assert.equal((await reader.read(path)).events.length, 2);
  await writeFile(path, `${JSON.stringify({ type: "user", sessionId: "new", message: { content: "New" } })}\n`);
  const reset = await reader.read(path);
  assert.equal(reset.id, "new");
  assert.equal(reset.originalAsk, "New");
  assert.equal(reset.firstTs, null);
  assert.equal(reset.events.length, 1);
});

test("bounded chronological pages deduplicate and recover from evicted cursors", () => {
  const events = mergeActivityEvents([event(3), event(1)], [event(2), event(3), event(4)], 4);
  assert.deepEqual(events.map(item => item.id), [1, 2, 3, 4].map(n => `event-${n}`));
  const latest = pageActivity(events, { limit: 2, source: "fixture" });
  assert.deepEqual(latest.events.map(item => item.id), ["event-3", "event-4"]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.cursor, "event-4");
  const older = pageActivity(events, { before: "event-3", limit: 2 });
  assert.deepEqual(older.events.map(item => item.id), ["event-1", "event-2"]);
  assert.equal(older.hasMore, false);
  const forward = pageActivity(events, { after: "event-1", limit: 2 });
  assert.deepEqual(forward.events.map(item => item.id), ["event-2", "event-3"]);
  assert.equal(forward.hasMore, true);
  assert.equal(pageActivity(events, { after: "event-4" }).cursor, "event-4");
  assert.equal(pageActivity(events, { after: "evicted" }).cursorReset, true);
  assert.equal(pageActivity(events, { before: "evicted" }).events.length, 0);
  const undated = { ...event(2), timestamp: null };
  const mixed = mergeActivityEvents([event(1), undated], [event(3)]);
  assert.deepEqual(pageActivity(mixed, { after: undated.id }).events.map(item => item.id), ["event-3"]);
});

test("Hub backwards pages preserve chronology even when timestamps are absent", async () => {
  const timeline = createHubTimelineReader({
    baseUrl: "http://hub.local", now: () => start,
    fetchFn: async url => ({ ok: true, json: async () => ({ source: "codex", has_more: !url.searchParams.has("before"), events:
      (url.searchParams.has("before") ? [1, 2] : [3, 4]).map(number => ({ id: `codex-${number}`, kind: "assistant_message", detail: `Message ${number}` })),
    }) }),
  });
  const latest = await timeline.read("one");
  const previous = await timeline.read("one", { before: latest.events[0].id });
  assert.deepEqual(previous.events.map(item => item.id), ["codex-1", "codex-2"]);
  assert.equal(previous.hasMore, false);
});

test("Hub timeline forwards only safe records, supports increments, and retains stale events", async () => {
  let clock = start;
  let fail = false;
  let calls = 0;
  const timeline = createHubTimelineReader({
    baseUrl: "http://hub.local/v1", token: "server-only-test-token", now: () => clock,
    fetchFn: async (url, options) => {
      if (url.pathname.endsWith("/todo")) return { ok: true, json: async () => ({ list: null }) };
      calls++;
      assert.equal(url.pathname, "/v1/tasks/agent-one/timeline");
      assert.equal(options.headers.authorization, "Bearer server-only-test-token");
      assert.equal(options.redirect, "error");
      if (fail) throw new Error("server-only-test-token must never reach the browser");
      return { ok: true, json: async () => ({ source: "claude-transcript", has_more: false, events: [
        { id: "private", ts: start, kind: "thinking", detail: "Raw internal thought" },
        { id: "public", ts: start, kind: "assistant_message", detail: "Investigating the interruption" },
        ...(calls > 1 ? [{ id: "new", ts: start + 1000, kind: "tool_result", output_preview: "Tests pass" }] : []),
      ] }) };
    },
  });
  const first = await timeline.read("agent-one");
  assert.equal(first.source, "hub:claude-transcript");
  assert.deepEqual(first.events.map(entry => entry.id), ["public"]);
  clock += 2000;
  const increment = await timeline.read("agent-one", { after: first.cursor });
  assert.deepEqual(increment.events.map(entry => entry.id), ["new"]);
  clock += 2000;
  fail = true;
  const failed = await timeline.read("agent-one");
  assert.equal(failed.stale, true);
  assert.equal(failed.events.length, 2);
  assert.doesNotMatch(JSON.stringify(failed), /server-only-test-token|internal thought/);
});

test("Hub structured plan snapshots remain available when an incremental page has no new events", async () => {
  const timeline = createHubTimelineReader({ baseUrl: "http://hub.local", now: () => start,
    fetchFn: async url => ({ ok: true, json: async () => url.pathname.endsWith("/todo") ? { list: null } : {
      source: "codex", events: [{ id: "plan-one", kind: "plan", items: [{ step: "Run regression tests", status: "in_progress" }], ts: start }], has_more: false,
    } }),
  });
  const first = await timeline.read("one");
  assert.equal(first.todos.items[0].status, "in_progress");
  assert.equal(first.todos.source, "hub:codex");
  const after = await timeline.read("one", { after: first.cursor });
  assert.deepEqual(after.events, []);
  assert.equal(after.todos.items[0].text, "Run regression tests");
});

test("Hub dedicated todo snapshots preserve source time, explicit empty, and stale fallback", async () => {
  let clock = start;
  let state = "populated";
  const timeline = createHubTimelineReader({ baseUrl: "http://hub.local", now: () => clock,
    fetchFn: async url => {
      if (url.pathname.endsWith("/todo")) {
        if (state === "error") throw new Error("temporary failure");
        return { ok: true, json: async () => ({ list: { items: state === "empty" ? [] : [{ id: "one", title: "Check audio", status: "done" }], updatedAt: start - 5000 }, createdAt: clock }) };
      }
      return { ok: true, json: async () => ({ source: "codex", events: [{ id: "flat-plan", kind: "plan", detail: "Old flattened plan (pending)", ts: start - 10000 }], has_more: false }) };
    },
  });
  const first = await timeline.read("one");
  assert.equal(first.todos.source, "hub:todo");
  assert.equal(first.todos.updatedAt, start);
  assert.equal(first.todos.items[0].status, "completed");
  clock += 2000; state = "error";
  const stale = await timeline.read("one");
  assert.equal(stale.todos.stale, true);
  assert.equal(stale.todos.updatedAt, start);
  assert.equal(stale.stale, undefined, "an optional todo failure does not mark a healthy activity stream stale");
  clock += 2000; state = "empty";
  const cleared = await timeline.read("one");
  assert.deepEqual(cleared.todos.items, []);
  assert.equal(cleared.todos.updatedAt, clock);
  assert.equal(cleared.todos.stale, undefined);
});

test("dedicated Hub todo reads are independently cached and never fetch a timeline", async () => {
  let clock = start;
  let state = "populated";
  const calls = [];
  const timeline = createHubTimelineReader({ baseUrl: "http://hub.local/v1", token: "test-server-token", now: () => clock,
    fetchFn: async (url, options) => {
      calls.push(url.pathname);
      assert.equal(options.headers.authorization, "Bearer test-server-token");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, undefined, "the dedicated read uses GET");
      if (state === "error") throw new Error("test-server-token must stay private");
      return { ok: true, json: async () => ({ list: { items: state === "empty" ? [] : [{ title: "Check the work", status: "pending" }] }, createdAt: clock }) };
    },
  });
  const [first, concurrent] = await Promise.all([timeline.readTodos("one"), timeline.readTodos("one")]);
  assert.deepEqual(concurrent, first);
  assert.equal(first.source, "hub:todo");
  assert.equal(first.updatedAt, start);
  assert.deepEqual(calls, ["/v1/tasks/one/todo"]);
  await timeline.readTodos("one");
  assert.equal(calls.length, 1);
  clock += 2000; state = "error";
  const stale = await timeline.readTodos("one");
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, start);
  assert.doesNotMatch(JSON.stringify(stale), /test-server-token/);
  assert.equal(await timeline.readTodos("two"), null, "another task cannot inherit the cached checklist");
  clock += 2000; state = "empty";
  const cleared = await timeline.readTodos("one");
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.stale, undefined);
  assert.equal(cleared.updatedAt, clock);
  const count = calls.length;
  for (const taskId of [undefined, null, "", " ", "..", ".", 42, {}, "bad\nidentity"])
    assert.equal(await timeline.readTodos(taskId), null);
  assert.equal(calls.length, count);
  assert.equal(await createHubTimelineReader({ baseUrl: "", fetchFn: () => assert.fail("Unconfigured reads cannot fetch") }).readTodos("one"), null);
});

test("unconfigured and unsupported Hub timelines have explicit unavailable results", async () => {
  const missing = await createHubTimelineReader({ baseUrl: "" }).read("one");
  assert.equal(missing.source, "none");
  assert.equal(missing.unavailable, true);
  const unsupported = await createHubTimelineReader({ baseUrl: "http://hub.local", fetchFn: async () => ({ ok: false, status: 404 }) }).read("one");
  assert.equal(unsupported.stale, true);
  assert.deepEqual(unsupported.events, []);
});
