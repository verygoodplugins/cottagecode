#!/usr/bin/env node
/**
 * cottagecode feed. Reads Claude Code session transcripts and serves them
 * in the shape the townmap eats. No dependencies, nothing installed.
 *
 *   node src/feed.mjs        →  http://localhost:8787
 *
 * Flags:
 *   --port 8787       what to listen on
 *   --window 12h      how far back to look for sessions (12h, 2d, 90m)
 *   --once            print one snapshot as JSON and exit
 *   --debug           log what each session resolved to, and why
 *
 * Reads ~/.claude/projects jsonl and, when present, Autohub's hub-unified.db
 * (readonly sqlite). The browser talks only to this process.
 */

import { createServer } from "node:http";
import { readdir, stat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoOf, worktreeOf, townName } from "./towns.mjs";
import { readHubAgents, shortModel } from "./hub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");

/* USD per million tokens. THESE ARE PLACEHOLDERS — set them from current
   pricing or every cost in the town is fiction. Cache reads are the cheap
   ones and they dominate long sessions, so getting that number right
   matters more than the others. */
const PRICE = {
  opus:   { in: 15,   out: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  sonnet: { in: 3,    out: 15,   cacheRead: 0.30, cacheWrite: 3.75  },
  haiku:  { in: 0.80, out: 4,    cacheRead: 0.08, cacheWrite: 1.00  }
};

const NEEDS_YOU_MS = 2 * 60 * 1000;   // turn ended this recently → it wants you
const POLL_MS = 2000;

/* ── args ───────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const PORT = Number(flag("--port", 8787));
const ONCE = argv.includes("--once");
const DEBUG = argv.includes("--debug");
const WINDOW = (() => {
  const s = String(flag("--window", "12h"));
  const m = s.match(/^(\d+)\s*([hmd])$/);
  if (!m) return 12 * 3600e3;
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
})();

/* ── per-file parse state, kept between polls ───────────────────────── */
const files = new Map();   // path -> { offset, tail, session }

function priceOf(model, u) {
  const p = PRICE[shortModel(model)] || PRICE.sonnet;
  return (
    ((u.input || 0)      * p.in +
     (u.output || 0)     * p.out +
     (u.cacheRead || 0)  * p.cacheRead +
     (u.cacheWrite || 0) * p.cacheWrite) / 1e6
  );
}

/* ── reading one transcript ─────────────────────────────────────────── */
function blankSession(path) {
  return {
    path,
    id: "", slug: "", cwd: "", branch: "", model: "", version: "",
    entrypoint: "", firstTs: 0, lastTs: 0,
    tokens: 0, cost: 0,
    lastText: "", lastTool: "", lastSkill: "",
    turnOpen: false,          // mid-turn: a tool call is out, or no stop yet
    endedAt: 0,               // when the last turn closed
    sidechains: new Map(),    // rootUuid -> subagent record
    uuidRoot: new Map()       // uuid -> sidechain root, for chain walking
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const t = content.filter(b => b?.type === "text").map(b => b.text).join(" ");
  return t.trim();
}
function toolsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(b => b?.type === "tool_use");
}
function toolLabel(block) {
  const i = block.input || {};
  const hint = i.file_path || i.path || i.command || i.pattern || i.description || i.prompt || "";
  const short = String(hint).replace(/\s+/g, " ").trim().slice(0, 70);
  return short ? `${block.name}: ${short}` : block.name;
}

function applyLine(S, ln) {
  const ts = Date.parse(ln.timestamp || 0) || 0;
  if (ts) { S.lastTs = Math.max(S.lastTs, ts); if (!S.firstTs) S.firstTs = ts; }

  if (ln.sessionId) S.id = ln.sessionId;
  if (ln.slug) S.slug = ln.slug;
  if (ln.cwd) S.cwd = ln.cwd;
  if (ln.gitBranch) S.branch = ln.gitBranch;
  if (ln.version) S.version = ln.version;
  if (ln.entrypoint) S.entrypoint = ln.entrypoint;
  if (ln.attributionSkill) S.lastSkill = ln.attributionSkill;

  // sub-agents live in the same file, flagged and chained by parentUuid
  let sc = null;
  if (ln.isSidechain && ln.uuid) {
    const root = S.uuidRoot.get(ln.parentUuid) || ln.uuid;
    S.uuidRoot.set(ln.uuid, root);
    sc = S.sidechains.get(root);
    if (!sc) {
      sc = { root, startTs: ts, lastTs: ts, tokens: 0, cost: 0, model: "",
             lastText: "", lastTool: "", open: true };
      S.sidechains.set(root, sc);
    }
    sc.lastTs = Math.max(sc.lastTs, ts);
  }

  if (ln.type === "assistant" && ln.message) {
    const m = ln.message;
    const u = m.usage || {};
    const usage = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0
    };
    const n = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    const c = priceOf(m.model || ln.advisorModel, usage);

    const target = sc || S;
    target.tokens += n;
    target.cost += c;
    if (m.model) target.model = m.model;

    const txt = textOf(m.content);
    if (txt) target.lastText = txt.replace(/\s+/g, " ").slice(0, 240);
    const tools = toolsOf(m.content);
    if (tools.length) target.lastTool = toolLabel(tools[tools.length - 1]);

    // stop_reason tells us whether the turn is still open
    const stop = m.stop_reason;
    if (sc) sc.open = !(stop === "end_turn" || stop === "stop_sequence");
    else {
      S.turnOpen = !(stop === "end_turn" || stop === "stop_sequence");
      if (!S.turnOpen) S.endedAt = ts || Date.now();
    }
  }

  if (ln.type === "user") {
    // a tool result coming back means the turn is still running
    if (sc) sc.open = true;
    else { S.turnOpen = true; S.endedAt = 0; }
  }

  if (ln.type === "attachment" && ln.attachment) {
    // the Stop hook firing is an explicit "this turn is over" signal
    if (ln.attachment.hookEvent === "Stop") {
      S.turnOpen = false;
      S.endedAt = ts || Date.now();
    }
  }
}

async function readIncrement(path) {
  const st = await stat(path);
  let f = files.get(path);
  if (!f) { f = { offset: 0, tail: "", session: blankSession(path) }; files.set(path, f); }
  if (st.size < f.offset) { f.offset = 0; f.tail = ""; f.session = blankSession(path); }
  if (st.size === f.offset) return f.session;

  const fh = await open(path, "r");
  try {
    const len = st.size - f.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, f.offset);
    f.offset = st.size;
    const chunk = f.tail + buf.toString("utf8");
    const lines = chunk.split("\n");
    f.tail = lines.pop() ?? "";          // hold back a partial trailing line
    for (const line of lines) {
      if (!line.trim()) continue;
      try { applyLine(f.session, JSON.parse(line)); } catch { /* skip junk */ }
    }
  } finally {
    await fh.close();
  }
  f.session.mtime = st.mtimeMs;
  return f.session;
}

/* ── snapshot ───────────────────────────────────────────────────────── */
function statusOf(S, now) {
  if (now - S.lastTs > WINDOW) return "offline";
  if (S.turnOpen) return "working";
  if (S.endedAt && now - S.endedAt < NEEDS_YOU_MS) return "blocked";  // just handed back
  return "idle";
}

function toAgents(sessions) {
  const now = Date.now();
  const out = [];
  const nameCount = new Map();

  for (const S of sessions) {
    if (!S.id) continue;
    const repo = repoOf(S.cwd);
    const wt = worktreeOf(S.cwd);
    const town = townName(S.cwd);
    // Slugs read like "can-you-look-at-replicated-perlis" — the front is
    // filler, the tail is the distinctive bit. Take words off the end while
    // they still fit on a nameplate.
    let name = S.slug || S.id.slice(0, 8);
    const words = name.split("-").filter(Boolean);
    let picked = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const next = [words[i], ...picked];
      if (next.join("-").length > 14 && picked.length) break;
      picked = next;
    }
    name = picked.join("-") || name.slice(0, 14);
    const n = (nameCount.get(name) || 0) + 1;
    nameCount.set(name, n);
    if (n > 1) name = `${name}-${n}`;

    out.push({
      id: S.id,
      name,
      town,
      role: town,
      status: statusOf(S, now),
      task: `${repo}${wt ? ` · ${wt}` : ""}`,
      activity: S.lastTool || (S.turnOpen ? "thinking" : "idle"),
      model: shortModel(S.model),
      branch: S.branch,
      parent: null,
      dispatchedBy: S.entrypoint === "claude-desktop" ? "you (desktop)" : "you",
      startedAt: S.firstTs || now,
      tokens: S.tokens,
      cost: S.cost,
      lastLine: S.lastTool || S.lastText || ""
    });

    let i = 0;
    for (const sc of S.sidechains.values()) {
      i++;
      const stale = now - sc.lastTs > 5 * 60e3;
      out.push({
        id: `${S.id}:${sc.root.slice(0, 8)}`,
        name: `${name}-${i}`,
        town,
        role: town,
        status: sc.open && !stale ? "working" : (stale ? "done" : "idle"),
        task: `subagent of ${name}`,
        activity: sc.lastTool || "thinking",
        model: shortModel(sc.model || S.model),
        branch: S.branch,
        parent: S.id,
        dispatchedBy: name,
        startedAt: sc.startTs,
        tokens: sc.tokens,
        cost: sc.cost,
        lastLine: sc.lastTool || sc.lastText || ""
      });
    }
  }
  return out;
}

/* ── the scan ───────────────────────────────────────────────────────── */
let cache = [];
let source = "none";
let hubLabel = "none";

function sortCottages(list) {
  return list.sort((a, b) => {
    if (a.town === "HubTown" && b.town !== "HubTown") return -1;
    if (b.town === "HubTown" && a.town !== "HubTown") return 1;
    return String(a.town).localeCompare(b.town) || String(a.name).localeCompare(b.name);
  });
}

async function scanClaude() {
  const now = Date.now();
  let dirs = [];
  try { dirs = await readdir(PROJECTS, { withFileTypes: true }); }
  catch (e) {
    console.error(`can't read ${PROJECTS}: ${e.message}`);
    return [];
  }

  const sessions = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS, d.name);
    let entries = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs > WINDOW && !files.has(path)) continue;
        sessions.push(await readIncrement(path));
      } catch { /* file vanished mid-scan */ }
    }
  }
  return toAgents(sessions);
}

async function scan() {
  const claude = await scanClaude();
  const hub = readHubAgents();
  if (hub.error) console.error(`hub db: ${hub.error}`);
  hubLabel = hub.ok ? hub.dbPath : (hub.missing ? "none" : (hub.error || "error"));

  if (hub.ok && hub.agents.length) {
    const extra = claude.filter((a) => !hub.keys.has(a.id));
    cache = sortCottages([...hub.agents, ...extra]);
    source = extra.length ? "hub+claude" : "hub";
  } else {
    cache = sortCottages(claude);
    source = claude.length ? "claude" : "none";
  }

  if (DEBUG) {
    console.log(`\n[${new Date().toLocaleTimeString()}] ${cache.length} cottages  source=${source}`);
    for (const a of cache) {
      console.log(`  ${a.name.padEnd(22)} ${a.status.padEnd(8)} ${String(a.town).padEnd(14)} ` +
                  `${a.model.padEnd(7)} ${String(a.branch).slice(0,24).padEnd(26)} ` +
                  `$${a.cost.toFixed(3).padStart(8)}  ${a.lastLine.slice(0, 40)}`);
    }
  }
}

/* ── go ─────────────────────────────────────────────────────────────── */
await scan();

if (ONCE) {
  console.log(JSON.stringify(cache, null, 2));
  process.exit(0);
}

setInterval(scan, POLL_MS);

createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*" };
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/agents") {
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    return res.end(JSON.stringify({ agents: cache, source }));
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(await readFile(join(HERE, "town.html")));
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Put town.html next to this script.");
    }
  }
  res.writeHead(404, cors).end("not found");
}).listen(PORT, () => {
  console.log(`\n  CottageCode  →  http://localhost:${PORT}`);
  console.log(`  hub db       →  ${hubLabel}`);
  console.log(`  claude       →  ${PROJECTS}`);
  console.log(`  source       →  ${source}  (${cache.length} cottages)`);
  console.log(`  window       →  last ${Math.round(WINDOW / 3600e3)}h\n`);
});
