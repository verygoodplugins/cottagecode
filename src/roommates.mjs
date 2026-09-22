/**
 * Agents that share an absolute worktreePath share one cottage plot.
 * Decorative roommate sprites only — each agent remains selectable.
 */

import { isAbsolutePath } from "./occupancy.mjs";

const RANK = { working: 0, blocked: 1, idle: 2, done: 3, offline: 4 };

export function roommateKey(agent) {
  const path = typeof agent?.worktreePath === "string" ? agent.worktreePath.trim() : "";
  return isAbsolutePath(path) ? path : "";
}

function hostScore(agent) {
  const rank = RANK[agent?.status] ?? 5;
  const started = Number(agent?.startedAt) || 0;
  return [rank, -started, String(agent?.id || "")];
}

function preferHost(a, b) {
  const left = hostScore(a), right = hostScore(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] < right[i]) return a;
    if (left[i] > right[i]) return b;
  }
  return a;
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
    const host = members.reduce(preferHost);
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
