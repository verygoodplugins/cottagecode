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

test("unconfigured and unsupported Hub timelines have explicit unavailable results", async () => {
  const missing = await createHubTimelineReader({ baseUrl: "" }).read("one");
  assert.equal(missing.source, "none");
  assert.equal(missing.unavailable, true);
  const unsupported = await createHubTimelineReader({ baseUrl: "http://hub.local", fetchFn: async () => ({ ok: false, status: 404 }) }).read("one");
  assert.equal(unsupported.stale, true);
  assert.deepEqual(unsupported.events, []);
});
