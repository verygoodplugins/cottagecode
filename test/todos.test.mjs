import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TODOS, normalizeTodos, todosFromTool, todosFromEvent, latestTodos } from "../src/todos.mjs";

const now = Date.parse("2026-09-15T10:00:00Z");
const item = (text = "Inspect the handler", status = "pending") => ({ text, status });

test("unknown checklist differs from an explicitly empty one", () => {
  for (const value of [null, undefined, {}, "", "- [ ] Read the code", [{ text: "No explicit status" }], [item("", "pending")], [item("Hidden state", "unknown")]]) assert.equal(normalizeTodos(value), null);
  assert.deepEqual(normalizeTodos([], { source: "fixture", updatedAt: now }), { items: [], source: "fixture", updatedAt: now });
  assert.equal(normalizeTodos({ items: [], updatedAt: "0" }).updatedAt, null);
});

test("TodoWrite, update_plan, and Codex todo_list retain their explicit statuses", () => {
  const claude = todosFromTool("TodoWrite", { todos: [{ content: "Read the handler", activeForm: "Reading the handler", status: "in_progress" }] }, { updatedAt: now });
  assert.equal(claude.items[0].text, "Read the handler");
  assert.equal(claude.items[0].status, "in_progress");
  assert.equal(claude.source, "transcript:TodoWrite");
  assert.equal(claude.updatedAt, now);
  const codex = todosFromTool("functions.update_plan", JSON.stringify({ plan: [{ step: "Run tests", status: "completed" }] }));
  assert.equal(codex.items[0].status, "completed");
  const completed = todosFromEvent({ kind: "todo_list", items: [{ text: "First", completed: true }, { text: "Second", completed: false }], timestamp: now });
  assert.deepEqual(completed.items.map(todo => todo.status), ["completed", "pending"]);
  assert.equal(normalizeTodos({ items: [{ title: "Hub task", status: "done" }] }).items[0].status, "completed");
  assert.equal(normalizeTodos({ items: [item("Cancelled", "cancelled")] }).items[0].status, "cancelled");
});

test("checklist IDs survive status changes and remain unique, with bounded content", () => {
  const pending = normalizeTodos([item("Same text")]);
  const completed = normalizeTodos([item("Same text", "completed")]);
  assert.equal(pending.items[0].id, completed.items[0].id);
  const duplicate = normalizeTodos([item("Same text"), item("Same text")]);
  assert.notEqual(duplicate.items[0].id, duplicate.items[1].id);
  const large = normalizeTodos(Array.from({ length: MAX_TODOS + 10 }, (_, i) => item(`Step ${i} ${"x".repeat(550)}`)));
  assert.equal(large.items.length, MAX_TODOS);
  assert.equal(large.items[0].text.length, 500);
  assert.equal(large.truncated, true);
});

test("prose and private thinking never become checklists", () => {
  assert.equal(todosFromEvent({ kind: "plan", detail: "Read files (pending)\nRun tests (completed)" }), null);
  assert.equal(todosFromTool("Bash", { todos: [item()] }), null);
  assert.equal(todosFromEvent({ kind: "thinking", todos: [item()] }), null);
  assert.equal(todosFromEvent({ kind: "tool_call", tool: "TodoWrite", input_preview: '{"todos":[' }), null);
  assert.equal(todosFromTool("update_plan", { plan: "- [ ] Run tests" }), null);
});

test("later snapshots replace rather than merge and older pages cannot regress a dated list", () => {
  const first = { kind: "plan", items: [item()], timestamp: now };
  const cleared = { kind: "summary", todos: { items: [], source: "tool", updatedAt: now + 1000 } };
  assert.deepEqual(latestTodos([first, cleared]).items, []);
  assert.deepEqual(latestTodos([first], { initial: cleared.todos }).items, []);
  assert.deepEqual(latestTodos([{ kind: "progress", text: "Completed everything" }], { initial: { items: [item()], source: "tool", updatedAt: now } }).items[0].status, "pending");
});
