/** Shared, read-only PR interpretation for the feed and browser. */
export const PR_FRESH_MS = 2 * 60 * 1000;
export const PR_STAGES = Object.freeze([
  "none", "open", "active", "waiting-codex", "waiting-ci", "blocked", "ready",
  "merged", "closed", "unknown",
]);
const STATES = new Set(["none", "open", "merged", "closed", "unknown"]);
const REVIEWS = new Set(["active", "waiting-codex", "waiting-ci", "blocked", "ready"]);

function str(value) { return typeof value === "string" ? value.trim() : ""; }
function timestamp(value) {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function labelNames(labels) {
  return [...new Set((Array.isArray(labels) ? labels : [])
    .map((l) => str(typeof l === "object" ? l?.name : l)).filter(Boolean))];
}
function reviewName(value) {
  const name = str(value).toLowerCase().replace(/^babysit:/, "");
  return REVIEWS.has(name) ? name : null;
}
function positiveNumber(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function safeCheckUrl(value) {
  try {
    const url = new URL(str(value));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
function checkName(value) { return str(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160); }
function checkWord(value) { return str(value).toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 40); }
function normalizeChecks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    let status = checkWord(entry?.status);
    let conclusion = checkWord(entry?.conclusion);
    const state = checkWord(entry?.state);
    // StatusContext has `state` instead of CheckRun's `status`/`conclusion`.
    if (!status && !conclusion && state) {
      if (["SUCCESS", "FAILURE", "ERROR"].includes(state)) {
        status = "COMPLETED";
        conclusion = state;
      } else status = state;
    }
    return {
      name: checkName(entry?.name || entry?.context), status, conclusion,
      url: safeCheckUrl(entry?.url || entry?.detailsUrl || entry?.targetUrl),
    };
  }).filter(entry => entry.name || entry.status || entry.conclusion);
}

/** A concise, factual rollup for presentation. It never determines merge readiness. */
export function prCi(pr) {
  const source = Array.isArray(pr?.checks) && pr.checks.length ? pr.checks : pr?.statusCheckRollup;
  const checks = normalizeChecks(source);
  if (!checks.length) return { state: "unavailable", total: 0, passed: 0, failed: 0, pending: 0, url: "" };
  const failed = checks.filter(check => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(check.conclusion));
  const pending = checks.filter(check => check.status !== "COMPLETED" || !check.conclusion).filter(check => !failed.includes(check));
  const passed = checks.filter(check => !failed.includes(check) && !pending.includes(check));
  const state = failed.length ? "failing" : pending.length ? "pending" : "passing";
  const preferred = (state === "failing" ? failed : state === "pending" ? pending : passed).find(check => check.url) || checks.find(check => check.url);
  return { state, total: checks.length, passed: passed.length, failed: failed.length, pending: pending.length, url: preferred?.url || "" };
}

/** Recognize an explicit PR link, without guessing a repository from its title. */
export function parsePrUrl(value) {
  try {
    const url = new URL(str(value));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!m || !positiveNumber(m[3])) return null;
    return {
      host: url.hostname.toLowerCase(), repo: `${m[1]}/${m[2]}`,
      number: Number(m[3]), url: `${url.origin}/${m[1]}/${m[2]}/pull/${Number(m[3])}`,
    };
  } catch { return null; }
}

/**
 * Preserve observations and attach an honest effective stage. A fresh exclusive
 * GitHub label is a state observation, not a claim that we ourselves ran review.
 * A known head change, conflicting evidence, or stale observation vetoes ready.
 */
export function normalizePr(value, now = Date.now()) {
  const p = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const receipt = p.finalization && typeof p.finalization === "object" ? p.finalization : null;
  const liveUrl = parsePrUrl(p.url);
  const receiptUrl = parsePrUrl(receipt?.pullRequestUrl);
  const liveNumber = positiveNumber(p.number);
  const receiptNumber = positiveNumber(receipt?.pullRequestNumber);
  const parsed = liveUrl || receiptUrl;
  const number = liveNumber || liveUrl?.number || receiptNumber || receiptUrl?.number || null;
  const labels = labelNames(p.labels);
  const checks = normalizeChecks(p.checks || p.statusCheckRollup);
  const checkedAt = timestamp(p.checkedAt) || timestamp(receipt?.checkedAt);
  const stale = p.stale === true || !checkedAt || now - checkedAt > PR_FRESH_MS || checkedAt > now + 60_000;
  const headSha = str(p.headSha || p.headRefOid);
  const reviewedHeadSha = str(p.reviewedHeadSha || receipt?.branchHeadSha);
  const source = str(p.source) || (receipt ? "finalization" : value ? "feed" : "unavailable");
  const rawState = str(p.state).toLowerCase();
  let state = STATES.has(rawState) ? rawState : "unknown";
  let reason = str(p.reason);
  let uncertain = p.reviewUncertain === true;
  const hasIdentity = Boolean(number || parsed);
  if (!rawState && receipt) {
    if (receipt.status === "not_needed" && !hasIdentity) state = "none";
    else if (["ready", "blocked"].includes(receipt.status) && hasIdentity) state = "open";
  }
  if (state === "none" && hasIdentity) {
    state = "unknown";
    reason = "PR identity conflicts with the reported absence of a PR.";
  }
  const sameIdentity = (left, right) => left && right &&
    left.host === right.host && left.repo.toLowerCase() === right.repo.toLowerCase() && left.number === right.number;
  const liveIdentityNumber = liveNumber || liveUrl?.number;
  const receiptIdentityNumber = receiptNumber || receiptUrl?.number;
  if (liveUrl && liveNumber && liveNumber !== liveUrl.number) {
    state = "unknown";
    uncertain = true;
    reason = "PR number and URL identify different pull requests.";
  } else if (receiptUrl && receiptNumber && receiptNumber !== receiptUrl.number) {
    state = "unknown";
    uncertain = true;
    reason = "Finalization receipt number and URL identify different pull requests.";
  } else if (liveIdentityNumber && receiptIdentityNumber && liveIdentityNumber !== receiptIdentityNumber) {
    state = "unknown";
    uncertain = true;
    reason = "Live PR identity and the finalization receipt identify different pull requests.";
  } else if (liveUrl && receiptUrl && !sameIdentity(liveUrl, receiptUrl)) {
    state = "unknown";
    uncertain = true;
    reason = "Live PR identity and the finalization receipt identify different pull requests.";
  }
  const liveLabels = source === "github" && Array.isArray(p.labels);
  const babysitLabels = labels.filter((l) => l.toLowerCase().startsWith("babysit:"));
  const labelReview = babysitLabels.length === 1 ? reviewName(babysitLabels[0]) : null;
  const directReview = reviewName(p.reviewState);
  const receiptReview = reviewName(receipt?.terminalLabel) || reviewName(receipt?.status);
  let reviewState = labelReview || (!liveLabels ? directReview || receiptReview : null) || "unknown";

  if (babysitLabels.length > 1 || (babysitLabels.length === 1 && !labelReview)) {
    uncertain = true;
    reason = "Conflicting or unrecognized babysit labels; review state is uncertain.";
  } else if (labelReview && directReview && labelReview !== directReview) {
    uncertain = true;
    reason = "PR labels and the supplied review state disagree.";
  }
  const receiptTime = timestamp(receipt?.checkedAt);
  if (labelReview && receiptReview && labelReview !== receiptReview &&
      (!checkedAt || !receiptTime || receiptTime >= checkedAt)) {
    uncertain = true;
    reason = "PR labels and the finalization receipt disagree.";
  }
  if (receipt && reviewName(receipt.status) && reviewName(receipt.terminalLabel) &&
      reviewName(receipt.status) !== reviewName(receipt.terminalLabel)) {
    uncertain = true;
    reason = "Finalization status and terminal label disagree.";
  }

  if (reviewState === "ready") {
    if (stale) {
      uncertain = true;
      reason = "Readiness observation is stale or has no verification time.";
    } else if (!headSha) {
      uncertain = true;
      reason = "The current PR head has not been verified.";
    } else if (reviewedHeadSha && reviewedHeadSha !== headSha) {
      uncertain = true;
      reason = "The PR head changed after the recorded review.";
    } else if (p.observedReadyHeadSha && p.observedReadyHeadSha !== headSha && reviewedHeadSha !== headSha) {
      uncertain = true;
      reason = "The PR head changed while its ready label remained present.";
    } else if (!labelReview && reviewedHeadSha !== headSha) {
      uncertain = true;
      reason = "Readiness has no matching head in its finalization record.";
    } else if (p.isDraft === true) {
      uncertain = true;
      reason = "A draft PR cannot be ready to merge.";
    }
  }
  if (uncertain) reviewState = "unknown";
  let stage = state;
  if (state === "open") stage = uncertain ? "unknown" : REVIEWS.has(reviewState) ? reviewState : "open";
  if (state === "unknown" && !reason) reason = hasIdentity ? "PR state has not been verified." : "PR metadata was not supplied.";
  const result = {
    number, url: parsed?.url || "", title: str(p.title), state, reviewState,
    labels, checks, headSha, reviewedHeadSha, source, checkedAt, stale, reason,
    stage, reviewUncertain: uncertain,
  };
  for (const key of ["repo", "host", "observedReadyHeadSha", "isDraft", "mergedAt", "closedAt"])
    if (p[key] !== undefined) result[key] = p[key];
  if (receipt) result.finalization = { ...receipt };
  return result;
}

export function prStage(pr, now = Date.now()) { return normalizePr(pr, now).stage; }

/** Empty means no reliable cross-cottage identity; number alone is insufficient. */
export function prKey(pr) {
  if (!pr || typeof pr !== "object") return "";
  const parsed = parsePrUrl(pr.url || pr.finalization?.pullRequestUrl);
  if (parsed) return `${parsed.host}/${parsed.repo.toLowerCase()}#${parsed.number}`;
  const number = positiveNumber(pr.number || pr.finalization?.pullRequestNumber);
  const repo = str(pr.repo).replace(/\.git$/, "");
  if (number && /^[\w.-]+\/[\w.-]+$/.test(repo))
    return `${str(pr.host).toLowerCase() || "github.com"}/${repo.toLowerCase()}#${number}`;
  return "";
}

/** Keep unresolved known PRs visible even when execution is over. */
export function hasOutstandingPr(agent, now = Date.now()) {
  const p = normalizePr(agent?.pr, now);
  return p.state === "open" || (p.state === "unknown" && Boolean(p.number || p.url));
}

/**
 * total counts identifiable PRs. none/unknown also count cottages whose PR
 * identity is unavailable. Shared PRs use the newest observation; conflicting
 * observations from the same instant count once as unknown, never as ready.
 */
export function prCounts(agents = [], now = Date.now()) {
  const counts = Object.fromEntries(["total", ...PR_STAGES].map((key) => [key, 0]));
  const groups = new Map();
  for (const [index, agent] of agents.entries()) {
    const pr = normalizePr(agent?.pr, now);
    const key = prKey(pr);
    const groupKey = key || `cottage:${agent?.id || index}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { identified: Boolean(key), prs: [] });
    groups.get(groupKey).prs.push(pr);
  }
  for (const group of groups.values()) {
    const latest = Math.max(...group.prs.map((p) => p.checkedAt || 0));
    const current = group.prs.filter((p) => (p.checkedAt || 0) === latest);
    const stages = new Set(current.map((p) => p.stage));
    const heads = new Set(current.map((p) => p.headSha).filter(Boolean));
    const stage = stages.size === 1 && heads.size <= 1 ? current[0].stage : "unknown";
    counts[stage]++;
    if (group.identified && stage !== "none") counts.total++;
  }
  return counts;
}
