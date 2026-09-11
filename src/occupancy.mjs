/**
 * Occupancy: a cottage on the default map is actionable or recently
 * alive with something to show. Session-ended ghosts are settled.
 */

export const RECENT_MS = 2 * 60 * 60 * 1000;
export const CLAUDE_IDLE_MS = 15 * 60 * 1000;

export function isEmptyResult(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s === "-" || s === "—" || s === "–") return true;
  if (s.includes("session ended")) return true;
  if (s === "external agent session") return true;
  return false;
}

export function isWorktreeSlug(task) {
  const s = String(task || "").trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9]*-[a-z0-9-]+-\d{1,3}$/i.test(s)) return true;
  if (/^[a-z]+-[a-f0-9]{2}$/i.test(s)) return true;
  return false;
}

export function isGenericName(name) {
  return /^(claude code|claude|codex|kernel-worker|autojack-orchestrator|external agent|agent)$/i.test(
    String(name || "").trim()
  );
}

export function inferPr(text, ctx = {}) {
  const gh = ctx.githubAutoJackRequest || {};
  const blob = [text, gh.url, gh.targetUrl, gh.targetTitle].filter(Boolean).join(" ");
  let number = gh.targetNumber || null;
  let url = gh.targetUrl || "";
  let title = gh.targetTitle || "";
  const m =
    blob.match(/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i) ||
    blob.match(/\bPR #(\d+)/i);
  if (!number && m) number = m[1];
  if (number) number = Number(number);
  if (!url && number && gh.repo) url = `https://github.com/${gh.repo}/pull/${number}`;
  let state = "none";
  if (number || url) {
    state = /merged|landed on main|merge complete/i.test(blob) ? "merged" : "open";
  }
  return { number: number || null, url, title, state };
}

export function hasShowableWork(c) {
  if (c.pr && c.pr.state && c.pr.state !== "none") return true;
  if (c.result && !isEmptyResult(c.result)) return true;
  const task = c.task || "";
  if (
    task &&
    !isEmptyResult(task) &&
    !isWorktreeSlug(task) &&
    !/^AutoJack was explicitly requested/i.test(task)
  ) {
    return true;
  }
  return false;
}

export function classifyOccupancy(c, now = Date.now()) {
  if (c.status === "working" || c.status === "blocked") return "live";
  if (c.status === "idle") {
    if (c.source === "claude") {
      const t = Number(c.updatedAt || c.endedAt || c.startedAt || 0);
      if (Number.isFinite(t) && now - t > CLAUDE_IDLE_MS) return "settled";
    }
    return "live";
  }
  const t = Number(c.endedAt || c.updatedAt || 0);
  const age = Number.isFinite(t) && t > 1e12 ? now - t : Infinity;
  if (c.status === "done" && age <= RECENT_MS && hasShowableWork(c)) return "recent";
  return "settled";
}

export function stampOccupancy(list, now = Date.now()) {
  for (const c of list) c.occupancy = classifyOccupancy(c, now);
  return list;
}

export function liveCostOf(list) {
  return list
    .filter((c) => c.occupancy === "live" || c.occupancy === "recent")
    .reduce((n, c) => n + (Number(c.cost) || 0), 0);
}

/** Blocked and still on the default map. Settled ghosts are not mail. */
export function isLetter(c) {
  return Boolean(c && c.status === "blocked" && c.occupancy !== "settled");
}

export function lettersOf(list) {
  return (list || []).filter(isLetter);
}

export function isAbsolutePath(p) {
  return typeof p === "string" && p.startsWith("/") && p.length > 1 && !p.includes("\0");
}

export function cursorFileUrl(p) {
  if (!isAbsolutePath(p)) return "";
  return `cursor://file${p.split("/").map(encodeURIComponent).join("/")}`;
}

export function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

export function pickHandoffUrl(ctx = {}) {
  const handoff = ctx.lifecycle?.recovery?.babysitHandoff || {};
  for (const u of [handoff.url, handoff.href, ctx.babysitUrl, ctx.handoffUrl, ctx.taskUrl]) {
    if (isHttpUrl(u)) return String(u).trim();
  }
  return "";
}

export function shortenName(raw, max = 14) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const words = s.split(/[\s/_-]+/).filter(Boolean);
  let picked = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const next = [words[i], ...picked];
    if (next.join("-").length > max && picked.length) break;
    picked = next;
  }
  return picked.join("-") || s.slice(0, max);
}

export function shortenFront(raw, max = 14) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  const words = s.split(/[\s/_-]+/).filter((w) => w.length > 2);
  let picked = [];
  for (const w of words) {
    const next = [...picked, w];
    if (next.join("-").length > max && picked.length) break;
    picked = next;
  }
  return picked.join("-") || s.slice(0, max);
}
