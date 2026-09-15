/**
 * Optional readonly sqlite adapter. Reads an agent_runs table (same shape
 * Autohub's hub-unified.db uses). Set AGENT_DB_PATH, or leave unset and
 * this no-ops. The browser never talks to the database.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { townName, worktreeOf } from "./towns.mjs";
import { timestampMs } from "./activity.mjs";
import { normalizeTodos } from "./todos.mjs";
import { inputRequestFromHub } from "./input-request.mjs";
import {
  classifyOccupancy,
  inferPr,
  isAbsolutePath,
  isEmptyResult,
  isGenericName,
  isWorktreeSlug,
  pickHandoffUrl,
  shortenFront,
  shortenName,
} from "./occupancy.mjs";

const STALE_MS = Number(process.env.AGENT_STALE_THRESHOLD_MS || 15 * 60 * 1000);
const DONE_AGE_MS = 30 * 60 * 1000;

export function hubDbPath() {
  const raw = process.env.AGENT_DB_PATH;
  if (!raw) return null;
  return existsSync(raw) ? raw : null;
}

function parseDbTimestampMs(value) {
  return timestampMs(value) ?? NaN;
}

function parseContext(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return !Array.isArray(raw) ? raw : {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectFrom(row, ctx) {
  return (
    ctx.projectPath ||
    ctx.agentKernel?.route?.workspace?.root ||
    ctx.agentKernel?.route?.workspace?.id ||
    (ctx.githubAutoJackRequest?.repo || "").split("/").pop() ||
    (row.platform && row.platform !== "claude-code" ? "autohub" : "") ||
    "autohub"
  );
}

export function shortModel(m) {
  const s = String(m || "").toLowerCase();
  if (!s) return "sonnet";
  if (s.includes("opus")) return "opus";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("gpt") || s.includes("openai")) return "gpt";
  if (s.includes("mlx")) return "mlx";
  if (
    s.includes("local") ||
    s.includes("ollama") ||
    s.includes("lmstudio") ||
    s.includes("llama")
  ) {
    return "local";
  }
  return s.split(/[^a-z0-9]+/).filter(Boolean)[0] || "sonnet";
}

function attentionResolved(row) {
  return Boolean(row.attention_resolved_at || row.attentionResolvedAt ||
    String(row.attention_response ?? row.attentionResponse ?? "").trim());
}

export function mapHubStatus(row, now = Date.now()) {
  if (row.archived) return "offline";
  const status = String(row.status || "").toLowerCase();
  const updated = parseDbTimestampMs(row.updated_at);
  const completed = parseDbTimestampMs(row.completed_at);
  const aged = (t) => Number.isFinite(t) && now - t > DONE_AGE_MS;
  const stale = Number.isFinite(updated) && now - updated > STALE_MS;

  if (status === "running") return stale ? "offline" : "working";
  if (status === "pending" || status === "queued") return "idle";
  if (
    status === "awaiting_input" ||
    status === "needs_input" ||
    status === "awaiting_review"
  ) {
    if (attentionResolved(row)) return "idle";
    return "blocked";
  }
  if (status === "completed") {
    return aged(completed || updated) ? "offline" : "done";
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    if (!attentionResolved(row) && (row.attention_type || row.attention_message)) return "blocked";
    return aged(updated) ? "offline" : "done";
  }
  if (status === "stale") return "offline";
  return "idle";
}

function pickWorktreePath(ctx) {
  const cands = [
    ctx.lifecycle?.recovery?.babysitHandoff?.worktreePath,
    ctx.workFolder,
    ctx.cwd,
    ctx.projectPath,
    ctx.agentKernel?.route?.workspace?.root,
  ].filter(isAbsolutePath);
  return cands.find((p) => /worktrees?/i.test(p)) || cands[0] || "";
}

function pickWorktree(row, ctx) {
  return worktreeOf(pickWorktreePath(ctx));
}

function pickTask(row, ctx, worktree) {
  const gh = ctx.githubAutoJackRequest || {};
  if (gh.targetTitle) return String(gh.targetTitle).replace(/\s+/g, " ").trim().slice(0, 150);
  const cr = ctx.customerRequest;
  if (typeof cr === "string" && cr.trim() && !isEmptyResult(cr)) {
    return cr.replace(/\s+/g, " ").trim().slice(0, 150);
  }
  if (cr?.text && !isEmptyResult(cr.text)) {
    return String(cr.text).replace(/\s+/g, " ").trim().slice(0, 150);
  }
  const raw = row.task ? String(row.task).replace(/\s+/g, " ").trim() : "";
  if (
    raw &&
    !isEmptyResult(raw) &&
    !isWorktreeSlug(raw) &&
    !/^AutoJack was explicitly requested/i.test(raw)
  ) {
    return raw.slice(0, 150);
  }
  if (worktree) return `in ${worktree}`;
  return raw.slice(0, 150) || "-";
}

function pickName(row, ctx, worktree, pr, task) {
  if (ctx.agentName && !isGenericName(ctx.agentName)) return shortenName(ctx.agentName);
  if (worktree) return shortenName(worktree);
  if (pr.number) return `#${pr.number}`;
  const branch = String(ctx.gitBranch || ctx.branch || "").split("/").pop();
  if (branch && branch !== "main") return shortenName(branch);
  if (row.agent && !isGenericName(row.agent)) return shortenName(row.agent);
  if (task && !isWorktreeSlug(task) && !isEmptyResult(task)) {
    const bits = shortenFront(task);
    if (bits) return bits;
  }
  return shortenName(worktree || String(row.id || "").slice(-8) || "cottage");
}

function pickResult(row, ctx) {
  const presented = ctx.lifecycle?.execution?.presentedResult?.summary;
  const raw = row.result_summary || presented || row.error || "";
  if (isEmptyResult(raw)) return "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 240);
}

function inputResolutionFrom(row, ctx) {
  const resolved = row.attentionResolvedAt ?? row.attention_resolved_at;
  const response = row.attentionResponse ?? row.attention_response;
  if (!resolved && !(typeof response === "string" && response.trim())) return null;
  const request = inputRequestFromHub({ ...row, attentionResolvedAt: null, attention_resolved_at: null,
    attentionResponse: null, attention_response: null });
  const round = ctx.orchestrator?.currentQuestionRound;
  const explicitId = [ctx.attention?.requestId, ctx.integration?.requestId,
    ctx.orchestrator?.pendingQuestion?.id, ctx.lifecycle?.execution?.pendingQuestion?.id, ctx.pendingQuestion?.id]
    .find(value => (typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value)));
  const id = Number.isFinite(round) && round > 0 ? `hub:${row.id}:question:${round}` : request?.id ||
    (explicitId !== undefined ? String(explicitId).trim().slice(0, 400) : null);
  return { id, resolvedAt: timestampMs(resolved) || timestampMs(row.updatedAt ?? row.updated_at), source: "hub:attention" };
}

function pickLastLine(row, ctx, result, task) {
  if (row.attention_message) {
    return String(row.attention_message).replace(/\s+/g, " ").trim().slice(0, 240);
  }
  if (result) return result;
  if (task && !isEmptyResult(task) && !isWorktreeSlug(task)) return task;
  return "";
}

export function hubDedupKeys(row, ctx) {
  const keys = new Set([row.id, row.session_id].filter(Boolean));
  const tp = ctx.lifecycle?.transcriptPath || ctx.transcriptPath || "";
  const m = String(tp).match(/([0-9a-f-]{8,})\.jsonl$/i);
  if (m) keys.add(m[1]);
  if (row.session_id) keys.add(row.session_id);
  return keys;
}

function saneTime(ms, fallback = 0) {
  if (!Number.isFinite(ms) || ms < Date.parse("2020-01-01")) return fallback;
  return ms;
}

export function toCottage(row, now = Date.now()) {
  const ctx = { ...parseContext(row.context) };
  const durableResult = parseContext(row.result);
  const receipt = durableResult.finalization || ctx.finalization;
  // Only carry PR evidence; never serialize the execution context or credentials.
  if (receipt && typeof receipt === "object") {
    ctx.finalization = Object.fromEntries([
      "status", "pullRequestNumber", "pullRequestUrl", "branchHeadSha", "terminalLabel",
    ].filter(key => typeof receipt[key] === "string" || typeof receipt[key] === "number").map(key => [key, receipt[key]]));
    ctx.finalization.checkedAt = timestampMs(receipt.checkedAt) || timestampMs(row.completed_at);
  }
  if (durableResult.pullRequest && typeof durableResult.pullRequest === "object") ctx.pullRequest = durableResult.pullRequest;
  const project = projectFrom(row, ctx);
  const town = townName(project);
  const worktreePath = pickWorktreePath(ctx);
  const worktree = pickWorktree(row, ctx);
  const result = pickResult(row, ctx);
  const pr = inferPr(`${result} ${row.task || ""}`, ctx);
  const task = pickTask(row, ctx, worktree);
  const externalSession = row.record_kind === "external_session" ||
    (!row.record_kind && /external_agent_status|claude_hook|claude_code_status|codex_status/.test(ctx.source || ""));
  const requestSpec = parseContext(row.request_spec);
  const explicitRequest = ctx.originalAsk || requestSpec.request || ctx.customerRequest?.text || ctx.customerRequest || ctx.originalTask;
  const original = typeof explicitRequest === "string" ? explicitRequest.trim() : !externalSession ? String(row.task || "").trim() : "";
  const originalAsk = original && !isEmptyResult(original) && !isWorktreeSlug(original) ? original.slice(0, 32768) : "";
  const suppliedTodos = normalizeTodos(ctx.todos ?? ctx.cottage?.todos ?? durableResult.todos, { source: "hub:context", updatedAt: ctx.todosUpdatedAt });
  const checkpointTodos = normalizeTodos(row.todo_snapshot, { source: "hub:checkpoint", updatedAt: row.todo_updated_at });
  const checkpointWins = checkpointTodos && (!suppliedTodos || (
    checkpointTodos.updatedAt !== null
      ? suppliedTodos.updatedAt === null || checkpointTodos.updatedAt >= suppliedTodos.updatedAt
      : suppliedTodos.updatedAt === null
  ));
  const todos = checkpointWins ? checkpointTodos : suppliedTodos;
  const execution = ctx.lifecycle?.execution || {};
  const inputRequest = inputRequestFromHub(row);
  const mappedStatus = mapHubStatus(row, now);
  const attentionText = inputRequest?.prompt || (mappedStatus === "blocked" ? row.attention_message || row.attentionMessage : "");
  const attention = attentionText
    ? String(attentionText).replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  const tokens =
    (row.input_tokens || 0) +
    (row.output_tokens || 0) +
    (row.cache_write_tokens || 0) +
    (row.cache_read_tokens || 0);
  const started = saneTime(
    parseDbTimestampMs(row.started_at) || parseDbTimestampMs(row.queued_at),
    0
  );
  const ended = saneTime(
    parseDbTimestampMs(row.completed_at) || parseDbTimestampMs(row.updated_at),
    0
  );
  const updatedAt = saneTime(parseDbTimestampMs(row.updated_at), ended || started);
  const cottage = {
    id: row.id,
    name: pickName(row, ctx, worktree, pr, task),
    town,
    role: town,
    status: inputRequest ? "blocked" : mappedStatus,
    task,
    taskId: externalSession ? null : row.id,
    originalAsk,
    originalAskSource: externalSession ? "session" : "task",
    originalAskTruncated: original.length > 32768,
    taskStartedAt: externalSession ? null : timestampMs(row.started_at),
    sessionStartedAt: timestampMs(ctx.sessionStartedAt || ctx.lifecycle?.sessionStartedAt) || (externalSession ? started || null : null),
    activityUrl: `/agents/${encodeURIComponent(row.id)}/activity`,
    todos,
    inputRequest,
    inputRequestResolution: inputResolutionFrom(row, ctx),
    conversationTarget: {
      taskId: row.id,
      taskStatus: String(row.status || "unknown"),
      recordKind: ["logical_task", "external_session"].includes(row.record_kind) ? row.record_kind : "unknown",
      transport: ["tmux", "direct"].includes(execution.sessionMode) ? execution.sessionMode : "unknown",
      supportsRedirection: typeof execution.supportsRedirection === "boolean" ? execution.supportsRedirection : null,
    },
    repo: [ctx.githubAutoJackRequest?.repo, ctx.repo, ctx.repository].find(value => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value)) || "",
    defaultBranch: typeof ctx.defaultBranch === "string" ? ctx.defaultBranch : "",
    worktree,
    worktreePath,
    result,
    pr,
    attention,
    handoffUrl: pickHandoffUrl(ctx),
    activity: attention
      ? attention.slice(0, 80)
      : row.platform || "",
    model: shortModel(row.model || ctx.agentKernel?.route?.model),
    branch: ctx.gitBranch || ctx.branch || ctx.lifecycle?.recovery?.babysitHandoff?.baseBranch || "",
    parent: row.parent_id || null,
    dispatchedBy: row.platform || row.user || "hub",
    startedAt: started,
    endedAt: ended,
    updatedAt,
    tokens,
    cost: Number(row.total_cost || 0),
    lastLine: pickLastLine({ ...row, attention_message: attention }, ctx, result, task),
    sessionId: row.session_id || null,
    source: "hub",
  };
  cottage.occupancy = classifyOccupancy(cottage, now);
  return cottage;
}

export function readHubAgents({ limit = 80, dbPath = process.env.AGENT_DB_PATH || null } = {}) {
  if (!dbPath) return { ok: true, missing: true, agents: [], keys: new Set() };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const columns = new Set(db.prepare("PRAGMA table_info(agent_runs)").all().map(column => column.name));
    const optional = ["record_kind", "request_spec", "result", "attention_options", "attention_questions", "attention_detail", "attention_plan", "attention_response", "attention_resolved_at"].map(name => columns.has(name) ? name : `NULL AS ${name}`).join(", ");
    const cap = Math.min(Math.max(limit, 1), 500);
    const rows = db
      .prepare(
        `SELECT
           id, agent, status, task, user, platform, model, parent_id, session_id,
           context, queued_at, started_at, completed_at, updated_at, archived,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
           total_cost, error, result_summary, attention_type, attention_message,
           ${optional}
         FROM agent_runs
         WHERE updated_at > datetime('now', '-24 hours')
            OR status IN ('running', 'awaiting_input', 'awaiting_review', 'needs_input', 'pending', 'queued')
            OR context LIKE '%"pullRequest"%'
            OR (json_valid(context) AND (
              lower(json_extract(context, '$.githubAutoJackRequest.targetType')) IN ('pull_request', 'pr', 'pull-request')
              OR json_extract(context, '$.githubAutoJackRequest.targetUrl') LIKE '%/pull/%'
              -- Keep completed tasks whose durable context identifies a PR. These
              -- forms are intentionally aligned with inferPr()/toCottage().
              OR json_extract(context, '$.finalization.pullRequestNumber') IS NOT NULL
              OR json_extract(context, '$.finalization.pullRequestUrl') IS NOT NULL
              OR json_extract(context, '$.pr.number') IS NOT NULL
              OR json_extract(context, '$.pr.url') IS NOT NULL
              -- inferPr() accepts an explicit open state even before an
              -- identity is available; hasOutstandingPr() keeps it visible.
              OR lower(json_extract(context, '$.pr.state')) = 'open'
              OR json_extract(context, '$.pr.finalization.pullRequestNumber') IS NOT NULL
              OR json_extract(context, '$.pr.finalization.pullRequestUrl') IS NOT NULL
            ))
            OR context LIKE '%"babysitHandoff"%'
            ${columns.has("result") ? `OR CASE WHEN json_valid(result) THEN
              json_extract(result, '$.pullRequest') IS NOT NULL
              OR json_extract(result, '$.finalization.pullRequestNumber') IS NOT NULL
              OR json_extract(result, '$.finalization.pullRequestUrl') IS NOT NULL
            ELSE 0 END` : ""}
         ORDER BY
           CASE
             WHEN status IN ('running', 'awaiting_input', 'needs_input', 'pending', 'queued', 'awaiting_review') THEN 0
             ELSE 1
           END,
           updated_at DESC
         LIMIT ?`
      )
      .all(cap);

    const now = Date.now();
    const keys = new Set();
    const links = new Map();
    const checkpointColumns = new Set(db.prepare("PRAGMA table_info(agent_checkpoints)").all().map(column => column.name));
    const todoQuery = ["run_id", "kind", "data", "created_at"].every(name => checkpointColumns.has(name))
      ? db.prepare("SELECT data, created_at FROM agent_checkpoints WHERE run_id = ? AND kind = 'todo' ORDER BY created_at DESC LIMIT 1")
      : null;
    const agents = rows.map((row) => {
      const ctx = parseContext(row.context);
      const related = hubDedupKeys(row, ctx);
      links.set(row.id, related);
      for (const k of related) keys.add(k);
      const checkpoint = todoQuery?.get(row.id);
      if (checkpoint) {
        const data = parseContext(checkpoint.data);
        row.todo_snapshot = data.todos ?? data.list;
        row.todo_updated_at = checkpoint.created_at;
      }
      return toCottage(row, now);
    });
    return { ok: true, dbPath, agents, keys, links };
  } catch (err) {
    return { ok: false, error: err.message, agents: [], keys: new Set() };
  } finally {
    if (db) db.close();
  }
}
