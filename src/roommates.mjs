/**
 * Agents that share an absolute worktreePath share one cottage plot.
 * Decorative roommate sprites only — each agent remains selectable.
 */

import { isAbsolutePath } from "./occupancy.mjs";

export function roommateKey(agent) {
  const path = typeof agent?.worktreePath === "string" ? agent.worktreePath.trim() : "";
  return isAbsolutePath(path) ? path : "";
}

/**
 * Stable plot anchor: prefer a recorded parent in the group, then earliest id.
 * Status must not move the cottage between feed refreshes.
 */
function preferHost(a, b, parentIds = new Set()) {
  const aParent = parentIds.has(a?.id) ? 0 : 1;
  const bParent = parentIds.has(b?.id) ? 0 : 1;
  if (aParent !== bParent) return aParent < bParent ? a : b;
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
  const parentIds = new Set(list.map((a) => a.parent).filter((id) => id && ids.has(id)));
  const candidates = list.filter((a) => !a.parent || !ids.has(a.parent));
  const groups = new Map();
  const result = [];

  for (const agent of candidates) {
    const key = roommateKey(agent);
    if (!key) {
      result.push({ ...agent, roommates: [] });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }

  for (const members of groups.values()) {
    if (members.length === 1) {
      result.push({ ...members[0], roommates: [] });
      continue;
    }
    const host = members.reduce((best, next) => preferHost(best, next, parentIds));
    const roommates = members
      .filter((m) => m.id !== host.id)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    result.push({ ...host, roommates });
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
