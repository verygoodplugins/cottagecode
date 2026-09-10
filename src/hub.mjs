/**
 * Readonly Autohub snapshot. Reads hub-unified.db the same way
 * agent_status_query does. The browser never talks to Autohub.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { townName } from "./towns.mjs";

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

function cottageName(row, ctx) {
  const raw = String(ctx.agentName || row.agent || row.id || "cottage");
  if (raw.length <= 14) return raw;
  const words = raw.split(/[\s/_-]+/).filter(Boolean);
  let picked = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const next = [words[i], ...picked];
    if (next.join("-").length > 14 && picked.length) break;
    picked = next;
  }
  return picked.join("-") || raw.slice(0, 14);
}

function lastLine(row) {
  return (
    row.attention_message ||
    row.result_summary ||
    row.error ||
    row.task ||
    ""
  )
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function hubDedupKeys(row, ctx) {
  const keys = new Set([row.id, row.session_id].filter(Boolean));
  const tp = ctx.lifecycle?.transcriptPath || ctx.transcriptPath || "";
  const m = String(tp).match(/([0-9a-f-]{8,})\.jsonl$/i);
  if (m) keys.add(m[1]);
  if (row.session_id) keys.add(row.session_id);
  return keys;
}

function toCottage(row, now) {
  const ctx = parseContext(row.context);
  const project = projectFrom(row, ctx);
  const town = townName(project);
  const tokens =
    (row.input_tokens || 0) +
    (row.output_tokens || 0) +
    (row.cache_write_tokens || 0) +
    (row.cache_read_tokens || 0);
  const started = parseDbTimestampMs(row.started_at) || parseDbTimestampMs(row.queued_at) || now;
  return {
    id: row.id,
    name: cottageName(row, ctx),
    town,
    role: town,
    status: mapHubStatus(row, now),
    task: row.task ? String(row.task).replace(/\s+/g, " ").slice(0, 150) : "-",
    activity: row.attention_message
      ? String(row.attention_message).slice(0, 80)
      : row.platform || "",
    model: shortModel(row.model || ctx.agentKernel?.route?.model),
    branch: ctx.gitBranch || ctx.branch || "",
    parent: row.parent_id || null,
    dispatchedBy: row.platform || row.user || "hub",
    startedAt: started,
    tokens,
    cost: Number(row.total_cost || 0),
    lastLine: lastLine(row),
    sessionId: row.session_id || null,
    source: "hub",
  };
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
