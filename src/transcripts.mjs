/** Incremental Claude transcript adapter. Requests and public progress stay separate. */
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { normalizeActivityEvent, timestampMs } from "./activity.mjs";
import { normalizeTodos, todosFromTool } from "./todos.mjs";

// Existing estimated prices; these are not a billing source of truth.
const PRICE = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};
const MAX_LINE = 2 * 1024 * 1024;

export function blankSession(path = "") {
  return {
    path, id: "", slug: "", cwd: "", branch: "", model: "", version: "", entrypoint: "",
    firstTs: null, lastTs: null, taskId: null, taskStartedAt: null,
    originalAsk: "", originalAskSource: "session", originalAskTruncated: false,
    pr: null, finalization: null, todos: null,
    tokens: 0, cost: 0, lastText: "", lastTool: "", lastSkill: "",
    turnOpen: false, endedAt: null, events: [], eventMap: new Map(),
    sidechains: new Map(), uuidRoot: new Map(), seen: new Set(), usageByMessage: new Map(),
  };
}

export function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n").trim();
}

function blocksOf(content) {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}

function withoutLeadingSystemReminders(text) {
  let request = text;
  let match;
  while ((match = /^\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/i.exec(request))) request = request.slice(match[0].length);
  return request.trim();
}

export function genuineRequest(line) {
  if (line.type !== "user" || line.isMeta || line.isCompactSummary) return "";
  const blocks = blocksOf(line.message?.content);
  // A tool reply sometimes has text siblings carrying runtime annotations.
  if (blocks.some(block => block?.type === "tool_result")) return "";
  const text = withoutLeadingSystemReminders(textOf(blocks));
  if (!text || /^\s*(?:<local-command-(?:caveat|stdout)|<command-name>|<system-reminder>|\[Request interrupted|This session is being continued from a previous conversation)/i.test(text)) return "";
  return text;
}

export function toolLabel(block) {
  const input = block.input || {};
  // A description/path is useful without dumping arguments, environment, or secrets.
  const hint = input.description || input.file_path || input.path || input.pattern || "";
  const detail = typeof hint === "string" ? hint.replace(/\s+/g, " ").trim().slice(0, 180) : "";
  const name = typeof block.name === "string" ? block.name : "Tool";
  return detail ? `${name}: ${detail}` : name;
}

function eventBase(line) {
  return String(line.uuid || line.message?.id || createHash("sha256").update(JSON.stringify(line)).digest("hex").slice(0, 24));
}

function addEvents(target, line, ts) {
  if (line.isMeta || line.isCompactSummary) return;
  const incoming = [];
  const base = eventBase(line);
  const blocks = blocksOf(line.message?.content);
  const suppliedTodos = normalizeTodos(line.todos, { source: "transcript:todos", updatedAt: ts });
  if (suppliedTodos) incoming.push({ id: `${base}:todos`, timestamp: ts, kind: "summary", text: "Task checklist updated", todos: suppliedTodos });
  const codexCall = line.type === "response_item" && line.payload?.type === "function_call" ? line.payload : null;
  if (codexCall) {
    const todos = todosFromTool(codexCall.name, codexCall.arguments, { source: "codex:update_plan", updatedAt: ts });
    if (todos) incoming.push({ id: `${base}:plan`, timestamp: ts, kind: "tool", text: "Update plan", todos });
  }
  const codexItem = line.item || line.params?.item;
  if (["item.completed", "item/completed"].includes(line.type || line.method) && codexItem?.type === "todo_list") {
    const todos = normalizeTodos(codexItem.items ?? codexItem.todos, { source: "codex:todo_list", updatedAt: ts });
    if (todos) incoming.push({ id: `${base}:plan`, timestamp: ts, kind: "summary", text: "Task checklist updated", todos });
  }
  const request = genuineRequest(line);
  if (request) incoming.push({ id: `${base}:request`, timestamp: ts, kind: "request", text: request });
  blocks.forEach((block, index) => {
    if (!block || typeof block !== "object") return;
    const event = { id: `${base}:${index}`, timestamp: ts };
    if (line.type === "assistant" && block.type === "text" && typeof block.text === "string") {
      incoming.push({ ...event, kind: "progress", text: block.text });
    } else if (line.type === "assistant" && ["summary", "reasoning_summary"].includes(block.type)) {
      incoming.push({ ...event, kind: "summary", text: block.text || block.summary || "" });
    } else if (line.type === "assistant" && block.type === "tool_use") {
      const todos = todosFromTool(block.name, block.input, { source: `claude-transcript:${block.name}`, updatedAt: ts });
      incoming.push({ ...event, kind: "tool", text: toolLabel(block), ...(todos ? { todos } : {}) });
    } else if (line.type === "user" && block.type === "tool_result") {
      const result = textOf(block.content);
      incoming.push({ ...event, kind: "result", text: `${block.is_error ? "Tool failed" : "Tool result"}${result ? `: ${result}` : ""}` });
    }
    // `thinking` / `redacted_thinking` are intentionally never read or emitted.
  });
  for (const raw of incoming) {
    const event = normalizeActivityEvent(raw);
    if (!event) continue;
    if (event.todos && (!target.todos?.updatedAt || !event.todos.updatedAt || event.todos.updatedAt >= target.todos.updatedAt)) target.todos = event.todos;
    const old = target.eventMap.get(event.id);
    if (old) Object.assign(old, event);
    else { target.events.push(event); target.eventMap.set(event.id, event); }
    if (target.events.length > 2000) target.eventMap.delete(target.events.shift().id);
  }
}

function trackUsage(target, line) {
  const message = line.message;
  const raw = message.usage || {};
  const usage = {
    input: Number(raw.input_tokens) || 0,
    output: Number(raw.output_tokens) || 0,
    cacheRead: Number(raw.cache_read_input_tokens) || 0,
    cacheWrite: Number(raw.cache_creation_input_tokens) || 0,
  };
  const model = String(message.model || line.advisorModel || "");
  const prices = PRICE[Object.keys(PRICE).find(name => model.includes(name))] || PRICE.sonnet;
  const tokens = Object.values(usage).reduce((a, b) => a + b, 0);
  const cost = Object.entries(usage).reduce((total, [key, amount]) => total + amount * prices[key] / 1e6, 0);
  const key = message.id || line.uuid || eventBase(line);
  const previous = target.usageByMessage.get(key) || { tokens: 0, cost: 0 };
  target.tokens += Math.max(0, tokens - previous.tokens);
  target.cost += Math.max(0, cost - previous.cost);
  target.usageByMessage.set(key, { tokens: Math.max(tokens, previous.tokens), cost: Math.max(cost, previous.cost) });
  if (target.usageByMessage.size > 5000) target.usageByMessage.delete(target.usageByMessage.keys().next().value);
}

function trackPrMetadata(target, line) {
  const supplied = line.pr || line.pullRequest || line.result?.pullRequest;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
    const pr = { source: "transcript-metadata" };
    for (const key of ["number", "url", "title", "state", "headSha", "reviewedHeadSha", "checkedAt", "reviewState", "repo"])
      if (["string", "number"].includes(typeof supplied[key])) pr[key] = supplied[key];
    if (Array.isArray(supplied.labels)) pr.labels = supplied.labels.map(label => typeof label === "string" ? label : label?.name).filter(label => typeof label === "string");
    if (typeof supplied.stale === "boolean") pr.stale = supplied.stale;
    target.pr = pr;
  }
  const receipt = line.finalization || line.result?.finalization || supplied?.finalization;
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
    target.finalization = Object.fromEntries([
      "status", "pullRequestNumber", "pullRequestUrl", "branchHeadSha", "terminalLabel", "checkedAt",
    ].filter(key => ["string", "number"].includes(typeof receipt[key])).map(key => [key, receipt[key]]));
  }
}

export function applyLine(session, line) {
  if (!line || typeof line !== "object") return;
  if (line.isSidechain && !line.uuid) return;
  // Only exact record duplicates are skipped; streamed revisions may share message ids.
  const fingerprint = createHash("sha256").update(JSON.stringify(line)).digest("hex");
  if (session.seen.has(fingerprint)) return;
  session.seen.add(fingerprint);
  if (session.seen.size > 5000) session.seen.delete(session.seen.values().next().value);
  const ts = timestampMs(line.timestamp);
  if (ts) {
    session.lastTs = Math.max(session.lastTs || ts, ts);
    session.firstTs = Math.min(session.firstTs || ts, ts);
  }
  for (const [key, source] of [["id", "sessionId"], ["slug", "slug"], ["cwd", "cwd"], ["branch", "gitBranch"], ["version", "version"], ["entrypoint", "entrypoint"], ["lastSkill", "attributionSkill"]]) {
    if (typeof line[source] === "string" && line[source]) session[key] = line[source];
  }

  let target = session;
  if (line.isSidechain && line.uuid) {
    const root = session.uuidRoot.get(line.parentUuid) || line.uuid;
    session.uuidRoot.set(line.uuid, root);
    if (!session.sidechains.has(root)) {
      session.sidechains.set(root, { ...blankSession(), root, startTs: ts, open: true });
    }
    target = session.sidechains.get(root);
    target.lastTs = ts ? Math.max(target.lastTs || ts, ts) : target.lastTs;
  }

  const explicitTask = typeof line.taskId === "string" ? line.taskId : typeof line.runId === "string" ? line.runId : "";
  if (explicitTask && explicitTask !== target.taskId) {
    target.taskId = explicitTask;
    target.taskStartedAt = timestampMs(line.taskStartedAt) || (["task_start", "run_start"].includes(line.type) ? ts : null);
    target.originalAsk = "";
    target.originalAskTruncated = false;
    target.originalAskSource = "task";
    target.events = [];
    target.eventMap.clear();
    target.lastText = "";
    target.lastTool = "";
    target.endedAt = null;
    target.pr = null;
    target.finalization = null;
    target.todos = null;
    target.tokens = 0;
    target.cost = 0;
    target.usageByMessage.clear();
  }
  trackPrMetadata(target, line);
  if (target.taskId && timestampMs(line.taskStartedAt)) target.taskStartedAt = timestampMs(line.taskStartedAt);
  const request = genuineRequest(line);
  if (request && !target.originalAsk) {
    target.originalAsk = request.slice(0, 32768);
    target.originalAskTruncated = request.length > 32768;
    if (target.taskId && !target.taskStartedAt) target.taskStartedAt = ts;
  }
  addEvents(target, line, ts);

  if (line.type === "assistant" && line.message) {
    trackUsage(target, line);
    if (line.message.model) target.model = line.message.model;
    const text = textOf(line.message.content);
    if (text) target.lastText = text.replace(/\s+/g, " ").slice(0, 240);
    const tools = blocksOf(line.message.content).filter(block => block?.type === "tool_use");
    if (tools.length) target.lastTool = toolLabel(tools.at(-1));
    else if (text) target.lastTool = "";
    const running = !["end_turn", "stop_sequence"].includes(line.message.stop_reason);
    if (target === session) target.turnOpen = running;
    else target.open = running;
    if (!running) target.endedAt = ts;
  }
  if (line.type === "user" && !line.isMeta) {
    if (target === session) target.turnOpen = true;
    else target.open = true;
    target.endedAt = null;
  }
  if (line.type === "attachment" && line.attachment?.hookEvent === "Stop") {
    if (target === session) target.turnOpen = false;
    else target.open = false;
    target.endedAt = ts;
  }
}

export function parseTranscript(text, path = "") {
  const session = blankSession(path);
  for (const raw of String(text).split(/\r?\n/)) {
    try { if (raw.trim()) applyLine(session, JSON.parse(raw)); } catch { /* Partial or invalid records have no meaning. */ }
  }
  return session;
}

export function createTranscriptReader() {
  const files = new Map();
  return {
    files,
    async read(path) {
      const info = await stat(path);
      let file = files.get(path);
      if (!file || info.size < file.offset || (file.ino && file.ino !== info.ino)) {
        file = { offset: 0, tail: "", decoder: new StringDecoder("utf8"), session: blankSession(path), ino: info.ino };
        files.set(path, file);
      }
      if (file.offset === info.size) return file.session;
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(256 * 1024);
        while (file.offset < info.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - file.offset), file.offset);
          if (!bytesRead) break;
          file.offset += bytesRead;
          const lines = (file.tail + file.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
          file.tail = lines.pop() || "";
          if (file.tail.length > MAX_LINE) file.tail = "";
          for (const raw of lines) {
            if (!raw.trim() || raw.length > MAX_LINE) continue;
            try { applyLine(file.session, JSON.parse(raw)); } catch { /* Skip malformed JSON only. */ }
          }
        }
      } finally { await handle.close(); }
      file.session.mtime = info.mtimeMs;
      return file.session;
    },
  };
}
