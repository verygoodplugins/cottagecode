/**
 * Agents that share an absolute worktreePath share one cottage plot.
 * Decorative roommate sprites only — each agent remains selectable.
 */

import { isAbsolutePath } from "./occupancy.mjs";

export function roommateKey(agent) {
  const path = typeof agent?.worktreePath === "string" ? agent.worktreePath.trim() : "";
  return isAbsolutePath(path) ? path : "";
}

/** Stable plot anchor: earliest id. Status and children must not move the cottage. */
function preferHost(a, b) {
  const left = String(a?.id || "");
  const right = String(b?.id || "");
  return left <= right ? a : b;
}

/**
 * Cottage-plot agents only (not shed kids). Shared checkouts collapse to one
 * host with a `roommates` array of the other agents on that path.
 */
export function plotAgentsForLayout(agents = []) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const ids = new Set(list.map((a) => a.id));
  const candidates = list.filter((a) => !a.parent || !ids.has(a.parent));
  const groups = new Map();
  const result = [];

  for (const agent of candidates) {
    const key = roommateKey(agent);
    if (!key) {
      result.push({ ...agent, roommates: [], plotKey: agent.id });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }

  for (const [key, members] of groups.entries()) {
    if (members.length === 1) {
      result.push({ ...members[0], roommates: [], plotKey: "wt:" + key });
      continue;
    }
    const host = members.reduce(preferHost);
    const roommates = members
      .filter((m) => m.id !== host.id)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // Stable slot identity survives host membership churn.
    result.push({ ...host, roommates, plotKey: "wt:" + key });
  }

  return result;
}

/** Lodger ids that must not receive their own plot. */
export function roommateLodgerIds(agents = []) {
  const ids = new Set();
  for (const host of plotAgentsForLayout(agents)) {
    for (const mate of host.roommates || []) ids.add(mate.id);
  }
  return ids;
}

/** Plot host id for an agent that may be a roommate. */
export function plotHostId(agents, agentId) {
  if (!agentId) return "";
  for (const host of plotAgentsForLayout(agents)) {
    if (host.id === agentId) return host.id;
    if ((host.roommates || []).some((mate) => mate.id === agentId)) return host.id;
  }
  return agentId;
}

/** Household ids on a shared plot (host + roommates). */
export function plotHouseholdIds(host) {
  return new Set([
    host?.id,
    ...((host?.roommates || []).map((mate) => mate.id)),
  ].filter(Boolean));
}

/** True when the host or any roommate is actively working. */
export function householdWorking(agent) {
  if (!agent) return false;
  if (agent.status === "working") return true;
  return (agent.roommates || []).some((mate) => mate.status === "working");
}

/**
 * Prefer a household member whose PR matches `matchPr`, else any outstanding PR.
 * `matchPr` receives an agent and returns true when it should win.
 */
export function householdDispatchAgent(host, matchPr = null) {
  const members = [host, ...(host?.roommates || [])].filter(Boolean);
  if (typeof matchPr === "function") {
    const match = members.find((mate) => matchPr(mate));
    if (match) return match;
  }
  const open = members.find(
    (mate) => mate.pr && mate.pr.state && mate.pr.state !== "none" && mate.pr.state !== "unknown",
  );
  return open || host;
}
