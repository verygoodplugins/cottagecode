/** Public pending-input records. Only explicit source fields become questions. */
const KINDS = new Set(["question", "permission", "plan", "attention"]);
const WAITING = new Set(["awaiting_input", "needs_input", "awaiting_review"]);
const TERMINAL = new Set(["completed", "done", "cancelled", "interrupted", "failed", "offline"]);
const text = (value, max = 6000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const identifier = value => typeof value === "number" && Number.isFinite(value) ? String(value) : text(value, 400);
function parsed(value) {
  if (typeof value === "string" && value.length <= 128 * 1024) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}
function object(value) {
  const raw = parsed(value);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function array(value) { const raw = parsed(value); return Array.isArray(raw) ? raw : []; }
function timestamp(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value))) return null;
  const n = typeof value === "number" ? value : Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/, "$1T$2Z"));
  return Number.isFinite(n) && n >= 1577836800000 ? n : null;
}
function hash(value) {
  let n = 2166136261;
  for (const char of value) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  return (n >>> 0).toString(36);
}
function optionsOf(value) {
  return array(value).slice(0, 20).map(value => {
    const option = typeof value === "string" ? { label: value } : object(value);
    const label = text(option.label ?? option.text ?? option.value, 500);
    return label ? { label, description: text(option.description, 1200) } : null;
  }).filter(Boolean);
}
const choices = value => value.options ?? value.choices ?? value.suggestedReplies ?? value.suggested_replies;
const inactive = value => value.pending === false || value.resolved === true || Boolean(value.resolvedAt || value.resolved_at);

/** null means no actual prompt was supplied, not a fabricated generic question. */
export function normalizeInputRequest(value, { source = "", updatedAt = null, id = "" } = {}) {
  const raw = typeof value === "string" ? { prompt: value } : object(value);
  if (inactive(raw)) return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : "question";
  const questions = array(raw.questions ?? raw.attentionQuestions ?? raw.attention_questions).slice(0, 8).map((value, index) => {
    const item = typeof value === "string" ? { question: value } : object(value);
    const prompt = text(item.prompt ?? item.question ?? item.text);
    return prompt ? { id: identifier(item.id) || `question-${index + 1}`, header: text(item.header, 120), prompt,
      options: optionsOf(choices(item)), multiSelect: item.multiSelect === true || item.multi_select === true } : null;
  }).filter(Boolean);
  const prompt = text(raw.prompt ?? raw.question ?? raw.text ?? raw.attentionMessage ?? raw.attention_message) ||
    questions.map(question => question.prompt).join("\n\n").slice(0, 6000);
  const detail = text(raw.detail ?? raw.attentionDetail ?? raw.attention_detail, 16000);
  if (!prompt && !detail) return null;
  if (!questions.length && prompt) questions.push({ id: "question-1", header: text(raw.header, 120), prompt,
    options: optionsOf(choices(raw) ?? raw.attentionOptions ?? raw.attention_options), multiSelect: raw.multiSelect === true || raw.multi_select === true });
  const identity = identifier(id) || identifier(raw.id ?? raw.requestId ?? raw.request_id) ||
    `input-${hash(JSON.stringify([kind, prompt, detail, questions]))}`;
  return { id: identity, kind, prompt: prompt || detail.slice(0, 6000), detail, questions,
    source: text(source || raw.source, 100) || "feed", updatedAt: timestamp(updatedAt) ?? timestamp(raw.updatedAt ?? raw.timestamp),
    ...(raw.stale === true ? { stale: true } : {}) };
}

/** Content revision for stale-draft checks, not an authentication token. */
export function inputRequestVersion(value) {
  const request = normalizeInputRequest(value);
  if (!request) return null;
  const bytes = new TextEncoder().encode(JSON.stringify([request.id, request.kind, request.prompt, request.detail, request.questions]));
  let version = 14695981039346656037n;
  for (const byte of bytes) version = BigInt.asUintN(64, (version ^ BigInt(byte)) * 1099511628211n);
  return version.toString(16).padStart(16, "0");
}

/** DB rows and GET /v1/tasks/:id detail objects share this extraction path. */
export function inputRequestFromHub(row) {
  if (!row || typeof row !== "object") return null;
  const context = object(row.context);
  const attention = object(context.attention);
  const status = text(row.status, 80).toLowerCase();
  const resolvedAt = row.attentionResolvedAt ?? row.attention_resolved_at;
  const response = row.attentionResponse ?? row.attention_response;
  if (TERMINAL.has(status) || row.archived || resolvedAt || (typeof response === "string" && response.trim())) return null;
  const headline = text(row.attentionMessage ?? row.attention_message ?? row.question);
  const type = text(row.attentionType ?? row.attention_type ?? attention.kind, 80).toLowerCase();
  if (!WAITING.has(status) && (status !== "running" || (!headline && !type))) return null;
  const candidates = [context.orchestrator?.pendingQuestion, context.lifecycle?.execution?.pendingQuestion, context.pendingQuestion];
  const pending = candidates.map(object).find(item => item.blocking !== false && !inactive(item) &&
    (text(item.question ?? item.prompt ?? item.text) || array(item.questions).length)) || {};
  // A new row-level headline must not borrow options from an older context question.
  const pendingMatches = !headline || !text(pending.question ?? pending.prompt ?? pending.text) ||
    headline === text(pending.question ?? pending.prompt ?? pending.text);
  const activePending = pendingMatches ? pending : {};
  const plan = object(row.attentionPlan ?? row.attention_plan ?? attention.plan ?? activePending.plan);
  const raw = {
    kind: KINDS.has(type) ? type : KINDS.has(activePending.kind) ? activePending.kind : "attention",
    prompt: headline || text(activePending.question ?? activePending.prompt ?? activePending.text) || text(plan.summary),
    detail: row.attentionDetail ?? row.attention_detail ?? attention.detail ?? plan.markdown ?? activePending.context,
    questions: row.attentionQuestions ?? row.attention_questions ?? attention.questions ?? activePending.questions,
    options: row.attentionOptions ?? row.attention_options ?? choices(activePending),
    stale: row.isStale === true || row.stale === true,
  };
  const questionRound = context.orchestrator?.currentQuestionRound;
  const roundId = !inactive(object(context.orchestrator?.pendingQuestion)) && pendingMatches && Number.isFinite(questionRound) && questionRound > 0
    ? `hub:${identifier(row.id)}:question:${questionRound}` : "";
  const action = object(row.attentionAction ?? row.attention_action ?? context.lifecycle?.attentionAction ?? attention.action);
  const id = roundId || identifier(attention.requestId ?? context.integration?.requestId ?? activePending.id ?? activePending.requestId ?? action.toolUseId ?? action.tool_use_id);
  return normalizeInputRequest(raw, { id, source: "hub:attention",
    updatedAt: activePending.createdAt ?? activePending.askedAt ?? row.updatedAt ?? row.updated_at });
}

/** Actual Claude and Codex blocking tool inputs; ordinary tools never imply permission. */
export function inputRequestFromTool(name, input, { id, source = "transcript", updatedAt = null } = {}) {
  if (!identifier(id)) return null;
  const tool = text(name, 200).split(/__|[.:/]/).at(-1)?.toLowerCase();
  const args = object(input);
  if (["askuserquestion", "request_user_input"].includes(tool))
    return normalizeInputRequest({ ...args, kind: "question" }, { id, source, updatedAt });
  if (tool === "exitplanmode" && text(args.plan, 16000))
    return normalizeInputRequest({ kind: "plan", prompt: text(args.plan).split(/\r?\n/).find(Boolean), detail: text(args.plan, 16000) }, { id, source, updatedAt });
  return null;
}
