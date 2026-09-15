import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInputRequest, inputRequestFromHub, inputRequestFromTool, inputRequestVersion } from "../src/input-request.mjs";

const now = Date.parse("2026-09-15T10:00:00Z");
const question = { id: "target", header: "Target", question: "Which environment?", multi_select: true,
  options: [{ label: "Staging", description: "Check the preview" }, { label: "Local" }] };

test("input requests preserve explicit questions, choices, identity and provenance only", () => {
  const request = normalizeInputRequest({ id: "toolu_fixture", questions: [question], privateContext: "never exported" }, { source: "fixture", updatedAt: now });
  assert.equal(request.prompt, "Which environment?");
  assert.equal(request.questions[0].multiSelect, true);
  assert.deepEqual(request.questions[0].options[0], { label: "Staging", description: "Check the preview" });
  assert.equal(request.id, "toolu_fixture");
  assert.equal(request.updatedAt, now);
  assert.equal(request.source, "fixture");
  assert.doesNotMatch(JSON.stringify(request), /never exported|privateContext/);
  assert.deepEqual(normalizeInputRequest(request), request);
  assert.equal(normalizeInputRequest({ attention_message: "Please choose", suggested_replies: ["Yes", "No"] }).questions[0].options[1].label, "No");
  const fallback = normalizeInputRequest({ prompt: "Please choose", options: ["One"] }, { updatedAt: now });
  assert.equal(normalizeInputRequest({ prompt: "Please choose", options: ["One"] }, { updatedAt: now + 1000 }).id, fallback.id);
  assert.notEqual(normalizeInputRequest({ prompt: "Please choose", options: ["Two"] }).id, fallback.id);
  for (const raw of [null, {}, { text: "" }, { prompt: "Already answered", resolved: true }, { prompt: "Old", pending: false }]) assert.equal(normalizeInputRequest(raw), null);
});

test("input request versions bind content revisions while ignoring freshness and source", () => {
  const value = { id: "same-request", kind: "question", prompt: "Which target?", detail: "Choose a fixture 🦆", questions: [question] };
  const version = inputRequestVersion(value);
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(inputRequestVersion(normalizeInputRequest(value)), version);
  assert.equal(inputRequestVersion({ ...value, source: "new-source", updatedAt: now, stale: true }), version);
  assert.notEqual(inputRequestVersion({ ...value, prompt: "Choose 😀" }), inputRequestVersion({ ...value, prompt: "Choose 😁" }));
  for (const revision of [
    { id: "another-request" }, { kind: "permission" }, { prompt: "Which release?" }, { detail: "A different fixture" },
    { questions: [{ ...question, options: [{ label: "Different target" }] }] },
    { questions: [{ ...question, options: [{ label: "Staging", description: "A changed consequence" }] }] },
  ]) assert.notEqual(inputRequestVersion({ ...value, ...revision }), version);
  for (const absent of [null, undefined, {}, { ...value, resolved: true }, { ...value, pending: false }]) assert.equal(inputRequestVersion(absent), null);
});

test("Hub row and raw GET detail aliases produce the same pending question identity", () => {
  const context = { orchestrator: { currentQuestionRound: now, pendingQuestion: { question: "Which environment?", options: ["Staging", "Local"], blocking: true } }, lifecycle: { execution: { pendingQuestion: { question: "Which environment?" } } } };
  const row = { id: "hub-run", status: "awaiting_input", attention_type: "question", attention_message: "Which environment?", attention_options: '["Staging","Local"]', updated_at: now, context: JSON.stringify(context) };
  const detail = { id: "hub-run", status: "awaiting_input", attentionType: "question", attentionMessage: "Which environment?", attentionOptions: '["Staging","Local"]', updatedAt: new Date(now).toISOString(), context };
  assert.deepEqual(inputRequestFromHub(row), inputRequestFromHub(detail));
  const first = inputRequestFromHub(row);
  assert.equal(first.id, `hub:hub-run:question:${now}`);
  assert.equal(first.questions[0].options[0].label, "Staging");
  assert.equal(inputRequestFromHub({ ...row, updated_at: now + 10000 }).id, first.id, "heartbeats do not change the question identity");
  context.orchestrator.currentQuestionRound++;
  assert.notEqual(inputRequestFromHub({ ...row, context }).id, first.id, "a later identical question receives its recorded round identity");
});

test("Hub rich attention and legacy pending question aliases retain readable details", () => {
  const rich = inputRequestFromHub({ id: "hub-rich", status: "needs_input", attention_message: "Which environment?", context: { attention: { requestId: "toolu_rich", questions: [question], detail: "The test server is available." } } });
  assert.equal(rich.id, "toolu_rich");
  assert.equal(rich.questions[0].id, "target");
  assert.equal(rich.detail, "The test server is available.");
  const permission = inputRequestFromHub({ id: "permission", status: "awaiting_input", attentionType: "permission", attentionMessage: "Run the local checks?", attentionDetail: "The check only reads fixture data.", context: { integration: { requestId: "rpc-1" } } });
  assert.equal(permission.id, "rpc-1");
  assert.equal(permission.kind, "permission");
  for (const context of [{ pendingQuestion: { question: "Which mode?", options: ["Quiet"] } }, { lifecycle: { execution: { pendingQuestion: { question: "Which mode?", options: ["Quiet"] } } } }]) {
    const legacy = inputRequestFromHub({ id: "legacy", status: "awaiting_input", context });
    assert.equal(legacy.prompt, "Which mode?");
    assert.equal(legacy.questions[0].options[0].label, "Quiet");
  }
  const changed = inputRequestFromHub({ status: "awaiting_input", attention_message: "A newer question?", context: { pendingQuestion: { question: "Old question?", options: ["Old choice"] } } });
  assert.deepEqual(changed.questions[0].options, []);
});

test("resolved, accepted, terminal and stale context-only questions never resurface", () => {
  const row = { status: "awaiting_input", attention_message: "Choose a target", context: { pendingQuestion: { question: "Choose a target" } } };
  for (const extra of [{ attention_resolved_at: now }, { attentionResolvedAt: new Date(now).toISOString() }, { attention_response: "Staging" }, { attentionResponse: "Staging" }, { status: "completed" }, { status: "cancelled" }, { status: "queued" }, { status: "stale" }, { archived: 1 }])
    assert.equal(inputRequestFromHub({ ...row, ...extra }), null);
  assert.equal(inputRequestFromHub({ status: "running", context: row.context }), null);
  assert.equal(inputRequestFromHub({ status: "awaiting_input", context: { pendingQuestion: { question: "Nonblocking note", blocking: false } } }), null);
  const stale = inputRequestFromHub({ ...row, isStale: true });
  assert.equal(stale.stale, true);
});

test("inactive Hub pending-question candidates cannot contribute prompts or options", () => {
  const inactiveStates = [{ resolved: true }, { pending: false }, { resolvedAt: now }, { resolved_at: now }];
  for (const inactive of inactiveStates) {
    const old = { id: "question-old", question: "Old question?", options: ["Old option"], ...inactive };
    for (const context of [{ orchestrator: { pendingQuestion: old } }, { lifecycle: { execution: { pendingQuestion: old } } }, { pendingQuestion: old }])
      assert.equal(inputRequestFromHub({ status: "awaiting_input", context }), null);
    const context = { orchestrator: { pendingQuestion: old, currentQuestionRound: 123 }, lifecycle: { execution: { pendingQuestion: { id: "question-current", question: "Current question?", options: ["Current option"] } } } };
    const current = inputRequestFromHub({ id: "task", status: "awaiting_input", context });
    assert.equal(current.id, "question-current");
    assert.equal(current.prompt, "Current question?");
    assert.equal(current.questions[0].options[0].label, "Current option");
    const headline = inputRequestFromHub({ status: "awaiting_input", attentionMessage: "Current headline?", context: { pendingQuestion: old } });
    assert.equal(headline.prompt, "Current headline?");
    assert.deepEqual(headline.questions[0].options, []);
  }
});

test("blocking tools require real IDs and ordinary tools never imply input", () => {
  assert.equal(inputRequestFromTool("AskUserQuestion", { questions: [question] }), null);
  assert.equal(inputRequestFromTool("Bash", { command: "npm test" }, { id: "toolu_running" }), null);
  assert.equal(inputRequestFromTool("functions.request_user_input", JSON.stringify({ questions: [question] }), { id: "call_1" }).questions[0].id, "target");
  assert.equal(inputRequestFromTool("ExitPlanMode", { plan: "Review this plan\n\nRun fixture checks." }, { id: "toolu_plan" }).detail, "Review this plan\n\nRun fixture checks.");
});
