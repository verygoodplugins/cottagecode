/** Cached, read-only GitHub observations. No network work blocks a feed poll. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePr, parsePrUrl, prKey } from "./pr.mjs";

const execFileAsync = promisify(execFile);
const FIELDS = "number,url,title,state,labels,headRefOid,headRefName,isCrossRepository,isDraft,mergedAt,closedAt";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_NAMES = new Set(["main", "master", "trunk"]);

function exactRepo(value) {
  if (typeof value === "object" && value) value = value.nameWithOwner || value.url;
  if (typeof value !== "string") return "";
  const repo = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/, "");
  return REPO_RE.test(repo) ? repo : "";
}

export function githubTarget(agent) {
  const pr = agent?.pr || {};
  const parsed = parsePrUrl(pr.url || pr.finalization?.pullRequestUrl);
  if (parsed) {
    if (parsed.host !== "github.com" || (pr.number && Number(pr.number) !== parsed.number)) return null;
    return { kind: "pr", ...parsed, key: `pr:${parsed.repo.toLowerCase()}#${parsed.number}` };
  }
  const repo = exactRepo(pr.repo || agent?.repo || agent?.repository);
  if (!repo) return null;
  const number = Number(pr.number || pr.finalization?.pullRequestNumber);
  if (Number.isSafeInteger(number) && number > 0)
    return { kind: "pr", repo, number, url: `https://github.com/${repo}/pull/${number}`, key: `pr:${repo.toLowerCase()}#${number}` };
  const branch = typeof agent.branch === "string" ? agent.branch.trim() : "";
  const defaultBranch = typeof agent.defaultBranch === "string" ? agent.defaultBranch : "";
  if (!branch || branch.startsWith("-") || branch.includes("\0") || DEFAULT_NAMES.has(branch) || branch === defaultBranch) return null;
  return { kind: "branch", repo, branch, defaultBranch, key: `branch:${repo.toLowerCase()}:${branch}` };
}

/**
 * Factory for an injectable command adapter. Only the three read-only commands
 * below are available. CLI stderr is deliberately never exposed to the feed.
 */
export function createGithubQuery({ run = execFileAsync, timeout = 8000 } = {}) {
  const defaultBranches = new Map();
  async function gh(args) {
    const { stdout } = await run("gh", args, {
      timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    });
    return JSON.parse(String(stdout));
  }
  return async function query(target) {
    if (target.kind === "pr")
      return gh(["pr", "view", target.url, "--json", FIELDS]);
    let defaultBranch = target.defaultBranch || defaultBranches.get(target.repo.toLowerCase());
    if (!defaultBranch) {
      const repo = await gh(["repo", "view", target.repo, "--json", "defaultBranchRef"]);
      defaultBranch = repo.defaultBranchRef?.name;
      if (!defaultBranch) throw new Error("default_branch_unavailable");
      defaultBranches.set(target.repo.toLowerCase(), defaultBranch);
    }
    if (target.branch === defaultBranch)
      return { state: "unknown", repo: target.repo, reason: "Default branches are not used to infer a task's PR." };
    const prs = await gh(["pr", "list", "--repo", target.repo, "--head", target.branch,
      "--state", "all", "--limit", "100", "--json", FIELDS]);
    if (!Array.isArray(prs)) throw new Error("invalid_pr_response");
    const matches = prs.filter((pr) => pr.headRefName === target.branch && pr.isCrossRepository === false);
    if (matches.length === 1 && prs.length < 100) return matches[0];
    if (!matches.length && !prs.length)
      return { state: "none", repo: target.repo, reason: "No PR exists for this repository and branch." };
    return { state: "unknown", repo: target.repo, reason: "This repository and branch do not identify one unambiguous PR." };
  };
}

const defaultQuery = createGithubQuery();
function readyLabel(pr) {
  const labels = (Array.isArray(pr?.labels) ? pr.labels : [])
    .map((l) => typeof l === "string" ? l : l?.name).filter((l) => l?.startsWith("babysit:"));
  return labels.length === 1 && labels[0] === "babysit:ready";
}

/**
 * query(target) resolves to a gh-shaped PR or a {state,reason} lookup result.
 * The returned async enrich(agents) resolves using cached data immediately.
 * enrich.flush() waits for queued queries for tests/explicit initial warmup.
 */
export function createGithubEnricher({
  query = defaultQuery, now = Date.now, refreshMs = 30_000,
  concurrency = 3, backoffMs = 30_000, maxBackoffMs = 5 * 60_000,
  enabled = process.env.COTTAGE_GITHUB !== "0", maxEntries = 1000,
} = {}) {
  const cache = new Map();
  const queue = [];
  const running = new Set();
  const limit = Math.max(1, Math.min(6, Math.floor(concurrency) || 1));
  let active = 0;

  function pump() {
    while (active < limit && queue.length) {
      const { target, entry } = queue.shift();
      active++;
      const work = Promise.resolve().then(() => query(target)).then((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_pr_response");
        const value = {
          ...raw, repo: target.repo, headSha: raw.headSha || raw.headRefOid || "",
          source: "github", checkedAt: now(), stale: false, reviewUncertain: false,
          // A new GitHub observation supersedes a derived review state.
          reviewState: undefined,
        };
        if (readyLabel(value)) {
          // Remember the head when this ready-label period was first observed.
          // Never manufacture a reviewedHeadSha from a label.
          value.observedReadyHeadSha = readyLabel(entry.value)
            ? entry.value.observedReadyHeadSha || entry.value.headSha
            : value.headSha;
        }
        entry.value = value;
        entry.error = "";
        entry.failures = 0;
        entry.nextAt = now() + refreshMs;
      }).catch((error) => {
        entry.failures++;
        entry.error = error?.code === "ENOENT"
          ? "GitHub CLI is unavailable; PR status could not be refreshed."
          : "GitHub metadata is unavailable; the last observation is retained.";
        entry.nextAt = now() + Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(entry.failures - 1, 10));
      }).finally(() => {
        entry.pending = false;
        active--;
        running.delete(work);
        pump();
      });
      running.add(work);
    }
  }

  function schedule(target) {
    let entry = cache.get(target.key);
    if (!entry) {
      entry = { value: null, error: "", failures: 0, nextAt: 0, pending: false, touchedAt: now() };
      cache.set(target.key, entry);
    }
    entry.touchedAt = now();
    if (!entry.pending && now() >= entry.nextAt) {
      entry.pending = true;
      queue.push({ target, entry });
      pump();
    }
    if (cache.size > maxEntries) {
      const removable = [...cache.entries()].filter(([, e]) => !e.pending)
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      for (const [key] of removable) {
        if (cache.size <= maxEntries) break;
        if (key !== target.key) cache.delete(key);
      }
    }
    return entry;
  }

  async function enrich(agents = []) {
    const time = now();
    return agents.map((agent) => {
      const initial = normalizePr(agent.pr, time);
      const target = enabled ? githubTarget({ ...agent, pr: initial }) : null;
      if (!target) return { ...agent, pr: initial };
      const entry = schedule(target);
      if (!entry.value) return { ...agent, pr: normalizePr({ ...initial,
        ...(entry.error ? { stale: true, reason: entry.error } : {}),
      }, time) };
      const samePr = !prKey(initial) || prKey(initial) === prKey(entry.value);
      const observation = {
        ...entry.value,
        ...(samePr && initial.finalization ? { finalization: initial.finalization } : {}),
        ...(samePr && initial.reviewedHeadSha ? { reviewedHeadSha: initial.reviewedHeadSha } : {}),
        stale: Boolean(entry.error),
        reason: entry.error || entry.value.reason || "",
      };
      return { ...agent, pr: normalizePr(observation, time) };
    });
  }
  enrich.flush = async () => {
    while (running.size || queue.length) await Promise.all([...running]);
  };
  enrich.stats = () => ({ cached: cache.size, pending: queue.length + active, active });
  return enrich;
}

export const enrichAgents = createGithubEnricher();
