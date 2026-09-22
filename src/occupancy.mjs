/**
 * Occupancy: a cottage on the default map is actionable or recently
 * alive with something to show. Session-ended ghosts are settled.
 */

import { hasOutstandingPr, normalizePr, parsePrUrl, prKey, prStage } from "./pr.mjs";

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
  const supplied = ctx.pr || ctx.pullRequest || {};
  const finalization = ctx.finalization || supplied.finalization;
  const structuredUrl = supplied.url || finalization?.pullRequestUrl;
  const targetIsPr = ["pull_request", "pr", "pull-request"].includes(gh.targetType) || Boolean(parsePrUrl(gh.targetUrl));
  const targetUrl = targetIsPr ? gh.targetUrl || "" : "";
  const repo = supplied.repo || gh.repo || ctx.repo || "";
  const number = supplied.number || finalization?.pullRequestNumber || (targetIsPr ? gh.targetNumber : null);
  const structured = {
    ...supplied, ...(finalization ? { finalization } : {}), repo,
    number, url: structuredUrl || targetUrl || (number && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pull/${number}` : ""),
    title: supplied.title || (targetIsPr ? gh.targetTitle : "") || "",
    source: supplied.source || (finalization ? "finalization" : "context"),
  };
  if (structured.number || structured.url || supplied.state || finalization?.status === "not_needed")
    return normalizePr(structured);

  // A transcript can establish a possible identity, never its current state.
  // Multiple mentioned PRs may be dependencies rather than this task's result.
  const urls = [...new Set(String(text || "").match(/https?:\/\/[^\s/<>]+\/[^\s/<>]+\/[^\s/<>]+\/pull\/\d+/gi) || [])];
  if (urls.length === 1) return normalizePr({ url: urls[0], source: "transcript" });
  const numbers = [...new Set([...String(text || "").matchAll(/\bPR\s+#(\d+)/gi)].map((m) => Number(m[1])))];
  if (!urls.length && numbers.length === 1) {
    return normalizePr({ number: numbers[0], repo, source: "transcript",
      url: /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pull/${numbers[0]}` : "" });
  }
  return normalizePr({ source: "unavailable", reason: urls.length > 1 || numbers.length > 1
    ? "Multiple PRs were mentioned; this task's PR is not identified." : "PR metadata was not supplied." });
}

export function hasShowableWork(c) {
  if (c.pr && (c.pr.number || c.pr.url)) return true;
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
  if (c.inventoryScope === "history") return "settled";
  if (c.inventoryScope === "dashboard")
    return ["working", "blocked", "idle"].includes(c.status) ? "live" : "recent";
  if (c.status === "working" || c.status === "blocked") return "live";
  if (hasOutstandingPr(c, now)) return "live";
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
export function isLetter(c, now = Date.now()) {
  return Boolean(c && c.occupancy !== "settled" && (c.status === "blocked" || prStage(c.pr, now) === "blocked"));
}

export function lettersOf(list, now = Date.now()) {
  const seen = new Set();
  return (list || []).filter((c) => {
    if (!isLetter(c, now)) return false;
    // A blocked task can have its own question; deduplicate PR-only letters.
    if (c.status === "blocked") return true;
    const key = prKey(c.pr);
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });
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
