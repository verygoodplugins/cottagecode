/**
 * Readonly Autohub snapshot. Reads hub-unified.db the same way
 * agent_status_query does. The browser never talks to Autohub.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { townName, worktreeOf } from "./towns.mjs";
import {
  classifyOccupancy,
  inferPr,
  isEmptyResult,
  isGenericName,
  isWorktreeSlug,
  shortenName,
} from "./occupancy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STALE_MS = Number(process.env.AGENT_STALE_THRESHOLD_MS || 15 * 60 * 1000);
const DONE_AGE_MS = 30 * 60 * 1000;

const SQLITE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export function hubDbPath() {
  const candidates = [
    process.env.AGENT_DB_PATH,
    join(HERE, "..", "..", "autohub", "data", "hub-unified.db"),
    join(homedir(), "Projects", "OpenAI", "autohub", "data", "hub-unified.db"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

function parseDbTimestampMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return value;
  const str = String(value).trim();
  const sqliteMatch = str.match(SQLITE_TIMESTAMP_RE);
  if (sqliteMatch) {
    return new Date(`${sqliteMatch[1]}T${sqliteMatch[2]}Z`).getTime();
  }
  return new Date(str).getTime();
}

function parseContext(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
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
    return "blocked";
  }
  if (status === "completed") {
    return aged(completed || updated) ? "offline" : "done";
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    if (row.attention_type || row.attention_message) return "blocked";
    return aged(updated) ? "offline" : "done";
  }
  if (status === "stale") return "offline";
  return "idle";
}

function pickWorktree(row, ctx) {
  const path =
    ctx.projectPath ||
    ctx.workFolder ||
    ctx.cwd ||
    ctx.agentKernel?.route?.workspace?.root ||
    "";
  return worktreeOf(path);
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
  const presented = ctx.lifecycle?.execution?.presentedResult?.summary;
  const raw = row.task ? String(row.task).replace(/\s+/g, " ").trim() : "";
  if (
    raw &&
    !isEmptyResult(raw) &&
    !isWorktreeSlug(raw) &&
    !/^AutoJack was explicitly requested/i.test(raw)
  ) {
    return raw.slice(0, 150);
  }
  if (presented && !isEmptyResult(presented)) {
    return String(presented).replace(/\s+/g, " ").trim().slice(0, 150);
  }
  if (worktree) return `in ${worktree}`;
  return raw.slice(0, 150) || "-";
}

function pickName(row, ctx, worktree, pr) {
  if (ctx.agentName && !isGenericName(ctx.agentName)) return shortenName(ctx.agentName);
  if (worktree) return shortenName(worktree);
  if (pr.number) return `#${pr.number}`;
  const branch = String(ctx.gitBranch || ctx.branch || "").split("/").pop();
  if (branch && branch !== "main") return shortenName(branch);
  if (row.agent && !isGenericName(row.agent)) return shortenName(row.agent);
  return shortenName(worktree || String(row.id || "").slice(-8) || "cottage");
}

function pickResult(row, ctx) {
  const presented = ctx.lifecycle?.execution?.presentedResult?.summary;
  const raw = row.result_summary || presented || row.error || "";
  if (isEmptyResult(raw)) return "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 240);
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

function toCottage(row, now) {
  const ctx = parseContext(row.context);
  const project = projectFrom(row, ctx);
  const town = townName(project);
  const worktree = pickWorktree(row, ctx);
  const result = pickResult(row, ctx);
  const pr = inferPr(`${result} ${row.task || ""}`, ctx);
  const task = pickTask(row, ctx, worktree);
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
    name: pickName(row, ctx, worktree, pr),
    town,
    role: town,
    status: mapHubStatus(row, now),
    task,
    worktree,
    worktreePath: ctx.projectPath || ctx.workFolder || "",
    result,
    pr,
    activity: row.attention_message
      ? String(row.attention_message).slice(0, 80)
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
    lastLine: pickLastLine(row, ctx, result, task),
    sessionId: row.session_id || null,
    source: "hub",
  };
  cottage.occupancy = classifyOccupancy(cottage, now);
  return cottage;
}

export function readHubAgents({ limit = 80 } = {}) {
  const dbPath = hubDbPath();
  if (!dbPath) return { ok: false, missing: true, agents: [], keys: new Set() };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const cap = Math.min(Math.max(limit, 1), 500);
    const rows = db
      .prepare(
        `SELECT
           id, agent, status, task, user, platform, model, parent_id, session_id,
           context, queued_at, started_at, completed_at, updated_at, archived,
           input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
           total_cost, error, result_summary, attention_type, attention_message
         FROM agent_runs
         WHERE updated_at > datetime('now', '-24 hours')
            OR status IN ('running', 'awaiting_input', 'awaiting_review', 'needs_input', 'pending', 'queued')
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
    const agents = rows.map((row) => {
      const ctx = parseContext(row.context);
      for (const k of hubDedupKeys(row, ctx)) keys.add(k);
      return toCottage(row, now);
    });
    return { ok: true, dbPath, agents, keys };
  } catch (err) {
    return { ok: false, error: err.message, agents: [], keys: new Set() };
  } finally {
    if (db) db.close();
  }
}
