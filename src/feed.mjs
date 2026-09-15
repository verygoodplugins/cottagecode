#!/usr/bin/env node
/** Zero-dependency CottageCode feed: local transcripts, optional Hub DB, read-only PRs. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repoOf, worktreeOf, townName } from "./towns.mjs";
import { readHubAgents, shortModel } from "./hub.mjs";
import { classifyOccupancy, inferPr, lettersOf, liveCostOf, stampOccupancy } from "./occupancy.mjs";
import { createTranscriptReader } from "./transcripts.mjs";
import { createHubTimelineReader, pageActivity, mergeActivityEvents } from "./activity.mjs";
import { enrichAgents } from "./github.mjs";
import { hasOutstandingPr } from "./pr.mjs";
import { normalizeTodos } from "./todos.mjs";
import { normalizeInputRequest } from "./input-request.mjs";
import { createHubMessenger, acceptsMessageOrigin } from "./messages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
const POLL_MS = 2000;
const execFileAsync = promisify(execFile);

function statusOf(session, now, windowMs) {
  if (!session.lastTs || now - session.lastTs > windowMs) return "offline";
  if (session.inputRequest) return "blocked";
  if (session.turnOpen) return "working";
  return "idle";
}

function transcriptPr(session) {
  const text = [session.originalAsk, session.lastText, ...session.events.map(event => event.text)].join("\n");
  return inferPr(text, { pr: session.pr, finalization: session.finalization });
}

export function toAgents(sessions, { now = Date.now(), windowMs = 12 * 3600e3 } = {}) {
  const agents = [];
  const nameCount = new Map();
  for (const session of sessions) {
    if (!session.id) continue;
    const repo = repoOf(session.cwd);
    const worktree = worktreeOf(session.cwd);
    const town = townName(session.cwd);
    let name = session.slug || session.id.slice(0, 8);
    const words = name.split("-").filter(Boolean);
    let picked = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const next = [words[i], ...picked];
      if (next.join("-").length > 14 && picked.length) break;
      picked = next;
    }
    name = picked.join("-") || name.slice(0, 14);
    const count = (nameCount.get(name) || 0) + 1;
    nameCount.set(name, count);
    if (count > 1) name = `${name}-${count}`;
    const agent = {
      id: session.id,
      name: worktree ? (worktree.length <= 14 ? worktree : name) : name,
      town, role: town,
      status: statusOf(session, now, windowMs),
      task: session.originalAsk.replace(/\s+/g, " ").slice(0, 150) || (worktree ? `in ${worktree}` : repo),
      taskId: session.taskId,
      originalAsk: session.originalAsk,
      originalAskSource: session.originalAskSource,
      originalAskTruncated: session.originalAskTruncated,
      taskStartedAt: session.taskStartedAt,
      sessionStartedAt: session.firstTs,
      activityUrl: `/agents/${encodeURIComponent(session.id)}/activity`,
      todos: normalizeTodos(session.todos),
      inputRequest: normalizeInputRequest(session.inputRequest),
      worktree, worktreePath: session.cwd || "",
      result: !session.turnOpen ? session.lastText : "",
      pr: transcriptPr(session),
      attention: session.inputRequest?.prompt || "", handoffUrl: "",
      activity: session.lastTool || session.lastText || (session.turnOpen ? "Working" : "Idle"),
      model: shortModel(session.model), branch: session.branch, parent: null,
      dispatchedBy: session.entrypoint === "claude-desktop" ? "you (desktop)" : "you",
      startedAt: session.taskStartedAt || session.firstTs || 0,
      endedAt: session.endedAt || 0,
      updatedAt: session.lastTs || 0,
      tokens: session.tokens, cost: session.cost,
      lastLine: session.events.filter(event => event.kind !== "request").at(-1)?.text || session.lastTool || session.lastText || "",
      sessionId: session.id, source: "claude",
    };
    agent.occupancy = classifyOccupancy(agent, now);
    agents.push(agent);
    let index = 0;
    for (const child of session.sidechains.values()) {
      index++;
      const stale = !child.lastTs || now - child.lastTs > 5 * 60e3;
      const id = `${session.id}:${child.root.slice(0, 8)}`;
      const cottage = {
        ...agent,
        id, name: `${name}-${index}`, parent: session.id, dispatchedBy: name,
        status: stale ? "done" : child.inputRequest ? "blocked" : child.open ? "working" : "idle",
        task: child.originalAsk.replace(/\s+/g, " ").slice(0, 150) || `shed of ${name}`,
        taskId: child.taskId,
        originalAsk: child.originalAsk, originalAskSource: child.originalAskSource,
        originalAskTruncated: child.originalAskTruncated,
        taskStartedAt: child.taskStartedAt, sessionStartedAt: child.startTs,
        activityUrl: `/agents/${encodeURIComponent(id)}/activity`,
        todos: normalizeTodos(child.todos),
        inputRequest: normalizeInputRequest(child.inputRequest),
        attention: child.inputRequest?.prompt || "",
        activity: child.lastTool || child.lastText || "Working",
        model: shortModel(child.model || session.model),
        result: !child.open ? child.lastText : "",
        pr: transcriptPr(child),
        startedAt: child.taskStartedAt || child.startTs || 0,
        endedAt: child.endedAt || 0, updatedAt: child.lastTs || 0,
        tokens: child.tokens, cost: child.cost,
        lastLine: child.events.filter(event => event.kind !== "request").at(-1)?.text || child.lastText || "",
      };
      cottage.occupancy = classifyOccupancy(cottage, now);
      agents.push(cottage);
    }
  }
  return agents;
}

export function createClaudeScanner({ projectsDir = PROJECTS, windowMs = 12 * 3600e3, now = Date.now } = {}) {
  const reader = createTranscriptReader();
  let everRead = false;
  return async function scanClaude() {
    let dirs;
    try { dirs = await readdir(projectsDir, { withFileTypes: true }); everRead = true; }
    catch (error) {
      if (error.code === "ENOENT" && !everRead) return { ok: true, missing: true, agents: [], sessions: [] };
      throw error;
    }
    const sessions = [];
    const errors = [];
    for (const directory of dirs) {
      if (!directory.isDirectory()) continue;
      const path = join(projectsDir, directory.name);
      let entries;
      try { entries = await readdir(path); }
      catch (error) {
        if (error.code !== "ENOENT") {
          errors.push("A transcript directory could not be read");
          for (const [filePath, state] of reader.files) if (dirname(filePath) === path) sessions.push(state.session);
        }
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = join(path, name);
        try {
          const info = await stat(filePath);
          if (now() - info.mtimeMs > windowMs && !reader.files.has(filePath)) continue;
          sessions.push(await reader.read(filePath));
        } catch (error) {
          if (error.code !== "ENOENT") {
            errors.push("A transcript could not be read");
            const old = reader.files.get(filePath)?.session;
            if (old) sessions.push(old);
          }
        }
      }
    }
    return { ok: true, agents: toAgents(sessions, { now: now(), windowMs }), sessions, ...(errors.length ? { stale: true, error: errors[0] } : {}) };
  };
}

export function repoFromRemote(value) {
  const remote = String(value || "").trim();
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return match?.[1] || "";
}

export function createRepoResolver({ run = execFileAsync, now = Date.now } = {}) {
  const cache = new Map();
  return async function resolveRepos(agents) {
    const result = agents.map(agent => ({ ...agent }));
    const paths = [...new Set(result.filter(agent => !agent.repo && agent.worktreePath).map(agent => agent.worktreePath))];
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (index < paths.length) {
        const path = paths[index++];
        const previous = cache.get(path);
        if (previous && now() - previous.checkedAt < 300000) continue;
        let repo = "", resolved = false;
        try {
          const { stdout } = await run("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 2000, maxBuffer: 16384 });
          repo = repoFromRemote(stdout);
          resolved = true;
        } catch { /* Not a repository, no origin, or unavailable checkout. */ }
        cache.set(path, { repo: resolved ? repo : previous?.repo || "", checkedAt: now() });
      }
    }));
    for (const agent of result) if (!agent.repo) agent.repo = cache.get(agent.worktreePath)?.repo || "";
    return result;
  };
}

function sortCottages(list) {
  return list.sort((a, b) => {
    if (a.town === "HubTown" && b.town !== "HubTown") return -1;
    if (b.town === "HubTown" && a.town !== "HubTown") return 1;
    return String(a.town).localeCompare(b.town) || String(a.name).localeCompare(b.name);
  });
}

export function createFeed({
  scanClaude = createClaudeScanner(), readHub = readHubAgents, enrich = enrichAgents,
  resolveRepos = createRepoResolver(), timeline = createHubTimelineReader(), now = Date.now,
} = {}) {
  let cache = [];
  let claude = { agents: [], sessions: [] };
  let hub = { agents: [], keys: new Set(), links: new Map() };
  let activity = new Map();
  const remoteTodos = new Map();
  let lastSuccessAt = null;
  let source = "none";
  let stale = false;
  let errors = [];
  let scanning = null;

  async function doScan() {
    const nextErrors = [];
    const results = await Promise.allSettled([Promise.resolve().then(scanClaude), Promise.resolve().then(readHub)]);
    if (results[0].status === "fulfilled" && results[0].value.ok !== false) {
      claude = results[0].value;
      if (claude.stale) nextErrors.push(claude.error || "Some transcripts are temporarily unavailable");
    } else nextErrors.push("Local transcripts are temporarily unavailable");
    if (results[1].status === "fulfilled" && results[1].value.ok !== false) hub = results[1].value;
    else nextErrors.push("Hub database is temporarily unavailable");

    const localById = new Map(claude.agents.map(agent => [agent.id, agent]));
    const previousById = new Map(cache.map(agent => [agent.id, agent]));
    const nextActivity = new Map();
    const inputStates = new Map();
    for (const session of claude.sessions || []) {
      nextActivity.set(session.id, session.events);
      inputStates.set(session.id, session);
      for (const child of session.sidechains.values()) {
        const id = `${session.id}:${child.root.slice(0, 8)}`;
        nextActivity.set(id, child.events);
        inputStates.set(id, child);
      }
    }
    const combined = hub.agents.map(agent => {
      const previous = previousById.get(agent.id);
      const hubInput = normalizeInputRequest(agent.inputRequest);
      // Keep an observed resolution across the Hub's later field cleanup while
      // a linked transcript may still contain the unanswered tool-use record.
      const inputRequestResolution = agent.inputRequestResolution || (!hubInput &&
        previous?.taskId === agent.taskId && previous?.sessionId === agent.sessionId ? previous?.inputRequestResolution : null) || null;
      const keys = hub.links?.get(agent.id) || new Set([agent.id, agent.sessionId].filter(Boolean));
      const local = [...keys].map(key => localById.get(key)).find(Boolean);
      if (!local) return { ...agent, inputRequestResolution };
      const hubHasExplicitTask = Boolean(agent.taskId);
      const sameExplicitTask = hubHasExplicitTask && Boolean(local.taskId) &&
        String(agent.taskId) === String(local.taskId);
      if (hubHasExplicitTask && !sameExplicitTask) {
        // A transcript can be the same session but a different or unscoped
        // logical task. Its timing is session-scoped; its request, activity,
        // and journal are not safe to attribute to the Hub task.
        nextActivity.set(agent.id, []);
        return { ...agent, inputRequestResolution, sessionStartedAt: local.sessionStartedAt || agent.sessionStartedAt };
      }
      const events = [...keys].flatMap(key => nextActivity.get(key) || []).filter(event =>
        !agent.taskId || !agent.taskStartedAt || event.timestamp === null || event.timestamp >= agent.taskStartedAt);
      const localTodos = normalizeTodos(local.todos);
      const localTaskId = typeof local.taskId === "string" && local.taskId.trim();
      const currentTaskTodos = localTodos && (!agent.taskId ||
        (localTaskId ? localTaskId === agent.taskId : agent.taskStartedAt && localTodos.updatedAt && localTodos.updatedAt >= agent.taskStartedAt)) ? localTodos : null;
      const hubTodos = normalizeTodos(agent.todos);
      const localTodosAreCurrent = currentTaskTodos && (!hubTodos ||
        (currentTaskTodos.updatedAt !== null && (hubTodos.updatedAt === null || currentTaskTodos.updatedAt >= hubTodos.updatedAt)) ||
        (currentTaskTodos.updatedAt === null && hubTodos.updatedAt === null));
      const todos = localTodosAreCurrent ? currentTaskTodos : hubTodos;
      const localInput = normalizeInputRequest(local.inputRequest);
      const inputInTask = localInput && (!agent.taskId || local.taskId === agent.taskId ||
        (!local.taskId && agent.taskStartedAt && localInput.updatedAt && localInput.updatedAt >= agent.taskStartedAt));
      const inputAfterResolution = !inputRequestResolution || (localInput &&
        localInput.id !== inputRequestResolution.id && inputRequestResolution.resolvedAt &&
        localInput.updatedAt && localInput.updatedAt > inputRequestResolution.resolvedAt);
      const resolvedLocally = hubInput && [...keys].some(key => inputStates.get(key)?.resolvedInputRequests?.has(hubInput.id));
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(agent.conversationTarget?.taskStatus);
      const localReplacement = inputInTask && localInput &&
        (!hubInput || localInput.id !== hubInput.id) && inputAfterResolution ? localInput : null;
      const inputRequest = terminal ? null : !resolvedLocally && hubInput ? hubInput : localReplacement;
      nextActivity.set(agent.id, mergeActivityEvents([], events));
      return {
        ...agent,
        originalAsk: agent.originalAsk || local.originalAsk,
        originalAskSource: agent.originalAsk ? agent.originalAskSource : local.originalAskSource,
        originalAskTruncated: agent.originalAsk ? agent.originalAskTruncated : local.originalAskTruncated,
        sessionStartedAt: local.sessionStartedAt || agent.sessionStartedAt,
        activity: local.activity || agent.activity,
        lastLine: local.lastLine || agent.lastLine,
        todos,
        inputRequest,
        inputRequestResolution,
        ...(inputRequest ? { status: "blocked", attention: inputRequest.prompt } :
          resolvedLocally ? { status: local.status, attention: "" } : {}),
      };
    });
    for (const agent of claude.agents) if (!hub.keys?.has(agent.id)) combined.push({ ...agent });
    const seen = new Set(combined.map(agent => agent.id));
    // A live PR outlives a transcript window or DB scan window.
    for (const old of cache) if (!seen.has(old.id) && hasOutstandingPr(old, now())) combined.push({ ...old, status: "offline" });
    for (const agent of combined) {
      const stored = remoteTodos.get(`${agent.id}\n${agent.taskId || ""}\n${agent.sessionId || ""}`);
      const supplied = normalizeTodos(agent.todos);
      agent.todos = stored && (!supplied || (stored.updatedAt && supplied.updatedAt && stored.updatedAt > supplied.updatedAt)) ? stored : supplied;
      if (agent.todos && nextErrors.length) agent.todos = { ...agent.todos, stale: true };
      agent.inputRequest = normalizeInputRequest(agent.inputRequest);
      if (agent.inputRequest && nextErrors.length) agent.inputRequest = { ...agent.inputRequest, stale: true };
    }
    let enriched = combined;
    try { enriched = await enrich(await resolveRepos(combined)); }
    catch { nextErrors.push("PR metadata is temporarily unavailable"); }
    cache = stampOccupancy(sortCottages(enriched), now());
    // Retain activity for retained PR cottages; discard unrelated old sessions.
    activity = new Map(cache.map(agent => [agent.id, nextActivity.get(agent.id) || activity.get(agent.id) || []]));
    const hasHub = cache.some(agent => agent.source === "hub");
    const hasClaude = cache.some(agent => agent.source === "claude");
    source = hasHub && hasClaude ? "hub+claude" : hasHub ? "hub" : hasClaude ? "claude" : "none";
    errors = nextErrors;
    stale = errors.length > 0;
    if (!stale) lastSuccessAt = now();
    return snapshot();
  }

  function snapshot() {
    return {
      agents: cache, source, stale, checkedAt: lastSuccessAt,
      ...(errors.length ? { errors } : {}),
      live: cache.filter(agent => agent.occupancy !== "settled").length,
      settled: cache.filter(agent => agent.occupancy === "settled").length,
      letters: lettersOf(cache).length, liveCost: liveCostOf(cache),
    };
  }

  function rememberActivityTodos(agent, value) {
    const identity = cottage => `${cottage.id}\n${cottage.taskId || ""}\n${cottage.sessionId || ""}`;
    const key = identity(agent);
    // A scan may replace the cached object while the read is in flight. Apply
    // the result to the current object only when its task/session still match.
    const currentAgent = cache.find(cottage => identity(cottage) === key) || agent;
    const incoming = normalizeTodos(value);
    const current = normalizeTodos(currentAgent.todos);
    const todos = incoming && (!current?.updatedAt || !incoming.updatedAt || incoming.updatedAt >= current.updatedAt) ? incoming : current;
    if (todos) {
      agent.todos = currentAgent.todos = todos;
      remoteTodos.set(key, todos);
      if (remoteTodos.size > 200) remoteTodos.delete(remoteTodos.keys().next().value);
    }
    return todos;
  }

  function currentInputRequest(agent) {
    const current = cache.find(cottage => cottage.id === agent.id &&
      cottage.taskId === agent.taskId && cottage.sessionId === agent.sessionId);
    return normalizeInputRequest(current?.inputRequest);
  }

  return {
    snapshot,
    scan() {
      if (!scanning) scanning = doScan().finally(() => { scanning = null; });
      return scanning;
    },
    async flushEnrichment() {
      if (typeof enrich.flush !== "function") return snapshot();
      await enrich.flush();
      return doScan();
    },
    async getActivity(id, options = {}) {
      const agent = cache.find(cottage => cottage.id === id);
      if (!agent) return null;
      const local = activity.get(id) || [];
      if (local.length) {
        const todos = agent.source === "hub" && timeline.configured && typeof timeline.readTodos === "function"
          ? rememberActivityTodos(agent, await timeline.readTodos(agent.id))
          : normalizeTodos(agent.todos);
        return { ...pageActivity(mergeActivityEvents([], local), { ...options, source: "claude-transcript" }), todos, inputRequest: currentInputRequest(agent), ...(stale ? { stale: true } : {}) };
      }
      if (agent.source === "hub" && timeline.configured) {
        const result = await timeline.read(agent.id, options);
        const todos = rememberActivityTodos(agent, result.todos);
        return { ...result, todos, inputRequest: currentInputRequest(agent) };
      }
      return { ...pageActivity([], options), todos: normalizeTodos(agent.todos), inputRequest: currentInputRequest(agent), unavailable: true };
    },
  };
}

export function createFeedServer(feed, { directory = HERE, messages = createHubMessenger() } = {}) {
  return createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    const json = (status, body) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, OPTIONS" }); return res.end(); }
      const url = new URL(req.url, "http://localhost");
      const messageRoute = url.pathname.match(/^\/agents\/([^/]+)\/messages$/);
      if (req.method === "POST" && messageRoute) {
        if (!acceptsMessageOrigin(req)) return json(403, { error: "Messages require a local connection from this CottageCode origin.", delivery: "not_sent" });
        if (Number(req.headers["content-length"]) > 65536) { req.resume(); return json(413, { error: "Message too large", delivery: "not_sent" }); }
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 65536) return json(413, { error: "Message too large", delivery: "not_sent" }); chunks.push(chunk); }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(400, { error: "Invalid message JSON", delivery: "not_sent" }); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json(400, { error: "Invalid message", delivery: "not_sent" });
        if (feed.scan) await feed.scan();
        const snapshot = feed.snapshot(), agent = snapshot.agents.find(agent => agent.id === decodeURIComponent(messageRoute[1]));
        if (!agent) return json(404, { error: "Cottage not found", delivery: "not_sent" });
        const sent = await messages.send(agent, payload, { stale: !!snapshot.stale, checkedAt: snapshot.checkedAt });
        return json(sent.status, sent.body);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "Read-only endpoint" });
      if (url.pathname === "/agents") {
        const snapshot = feed.snapshot();
        return json(200, { ...snapshot, agents: snapshot.agents.map(agent => ({ ...agent, conversation: messages.capability(agent, { stale: !!snapshot.stale, checkedAt: snapshot.checkedAt }) })) });
      }
      const match = url.pathname.match(/^\/agents\/([^/]+)\/activity$/);
      if (match) {
        const after = url.searchParams.get("after") || "";
        const before = url.searchParams.get("before") || "";
        if (after && before) return json(400, { error: "Use after or before, not both" });
        const result = await feed.getActivity(decodeURIComponent(match[1]), { after, before, limit: url.searchParams.get("limit") });
        return json(result ? 200 : 404, result || { error: "Cottage not found" });
      }
      let filename = "";
      let contentType = "";
      if (["/", "/index.html"].includes(url.pathname)) { filename = "town.html"; contentType = "text/html; charset=utf-8"; }
      else if (/^\/modules\/[a-z][a-z0-9-]*\.mjs$/.test(url.pathname)) { filename = url.pathname.slice("/modules/".length); contentType = "text/javascript; charset=utf-8"; }
      else if (/^\/modules\/audio\/[a-z][a-z0-9-]*\.mp3$/.test(url.pathname)) { filename = url.pathname.slice("/modules/".length); contentType = "audio/mpeg"; }
      if (filename) {
        const root = await realpath(directory);
        const path = await realpath(join(root, filename));
        if (!path.startsWith(root + sep)) return json(404, { error: "Not found" });
        const body = await readFile(path);
        const headers = { ...cors, "content-type": contentType, "content-length": body.length };
        if (contentType === "audio/mpeg") {
          // Tracks can change under a stable path, so retain their cached body
          // but revalidate it before media loops select it again.
          const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
          headers["cache-control"] = "public, max-age=0, must-revalidate";
          headers["accept-ranges"] = "bytes";
          headers.etag = etag;
          if (req.headers["if-none-match"]?.split(",").some(value => [etag, "*"].includes(value.trim()))) {
            const notModified = { ...headers };
            delete notModified["content-length"];
            res.writeHead(304, notModified);
            return res.end();
          }
          // A single byte range supports native media seeking and loop overlap.
          // HEAD describes the full resource and ignores Range per HTTP semantics.
          if (req.method === "GET" && req.headers.range) {
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            const start = range?.[1] ? Number(range[1]) : Math.max(0, body.length - Number(range?.[2]));
            const end = range?.[1] && range[2] ? Math.min(body.length - 1, Number(range[2])) : body.length - 1;
            if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= body.length || start > end) {
              res.writeHead(416, { ...headers, "content-length": 0, "content-range": `bytes */${body.length}` }); return res.end();
            }
            res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${body.length}` });
            return res.end(body.subarray(start, end + 1));
          }
        }
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : body);
      }
      return json(404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) json(error.code === "ENOENT" ? 404 : error instanceof URIError ? 400 : 500, { error: error.code === "ENOENT" ? "Not found" : "Request unavailable" });
      else res.end();
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const index = argv.indexOf(name); return index < 0 ? fallback : argv[index + 1]; };
  const port = Number(flag("--port", 8787));
  const host = flag("--host", "127.0.0.1");
  const match = String(flag("--window", "12h")).match(/^(\d+)\s*([hmd])$/);
  const windowMs = match ? Number(match[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[match[2]] : 12 * 3600e3;
  const feed = createFeed({ scanClaude: createClaudeScanner({ windowMs }) });
  await feed.scan();
  if (argv.includes("--once")) { await feed.flushEnrichment(); console.log(JSON.stringify(feed.snapshot().agents, null, 2)); return; }
  const timer = setInterval(() => feed.scan().catch(() => console.error("Snapshot refresh failed; retaining the previous snapshot")), POLL_MS);
  const server = createFeedServer(feed);
  server.on("close", () => clearInterval(timer));
  server.on("error", error => { clearInterval(timer); console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`CottageCode → http://${host}:${port}`);
    console.log(`Feed: ${feed.snapshot().source} (${feed.snapshot().agents.length} cottages); window ${Math.round(windowMs / 3600e3)}h`);
    if (argv.includes("--debug")) console.log(JSON.stringify(feed.snapshot(), null, 2));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
