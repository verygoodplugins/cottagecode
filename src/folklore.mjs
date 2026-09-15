/**
 * Village folklore: decorative readings of occupancy, branches, PRs, and letters.
 * Never changes feed status, occupancy, or input/PR access.
 */

import { hasOutstandingPr, normalizePr, prCi, prStage } from "./pr.mjs";

export const HAUNT_IVY_MS = 6 * 60 * 60 * 1000;
export const HAUNT_RUINS_MS = 24 * 60 * 60 * 1000;
export const PARCEL_FRESH_MS = 2 * 60 * 60 * 1000;
export const PARCEL_MOSS_MS = 2 * 60 * 60 * 1000;
export const PARCEL_NEST_MS = 12 * 60 * 60 * 1000;
export const PARCEL_SHRINE_MS = 48 * 60 * 60 * 1000;
export const LETTER_CROWS_MS = 2 * 60 * 60 * 1000;

const DEFAULT_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "development",
]);

function clock(...values) {
  for (const value of values) {
    const n = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function ageMs(agent, now, ...prefer) {
  const t = clock(...prefer, agent?.endedAt, agent?.updatedAt);
  return t == null ? null : Math.max(0, now - t);
}

/** Settled cottages cobweb; long-offline ones grow ivy and ruins. */
export function hauntStage(agent, now = Date.now()) {
  if (!agent || agent.occupancy !== "settled") return "none";
  if (agent.status !== "offline") return "cobweb";
  const age = ageMs(agent, now);
  if (age == null) return "cobweb";
  if (age >= HAUNT_RUINS_MS) return "ruins";
  if (age >= HAUNT_IVY_MS) return "ivy";
  return "cobweb";
}

/** Intra-town spur scenery. Never invents town-to-town roads. */
export function branchLane(agent = {}) {
  const branch = typeof agent.branch === "string" ? agent.branch.trim() : "";
  if (!branch) return { kind: "unknown", weeds: false };
  const def =
    typeof agent.defaultBranch === "string" ? agent.defaultBranch.trim() : "";
  const kind =
    (def && branch === def) || DEFAULT_BRANCHES.has(branch)
      ? "default"
      : "feature";
  return { kind, weeds: kind === "feature" && agent.occupancy === "settled" };
}

/**
 * Outstanding PR parcels only. Missing / unknown identity stays none so the
 * lawn does not celebrate an unverified absence.
 */
export function parcelReclaim(agent, now = Date.now()) {
  if (!hasOutstandingPr(agent, now)) return "none";
  const pr = normalizePr(agent?.pr, now);
  const age = ageMs(agent, now, pr.openedAt, agent?.pr?.openedAt);
  if (age == null) return "fresh";
  if (age >= PARCEL_SHRINE_MS) return "shrine";
  if (age >= PARCEL_NEST_MS) return "nest";
  if (age >= PARCEL_MOSS_MS) return "moss";
  return "fresh";
}

/** Blocked live letters only. Settled ghosts are not mail. */
export function letterNeglect(agent, now = Date.now()) {
  if (!agent || agent.occupancy === "settled") return "none";
  const blocked =
    agent.status === "blocked" || prStage(agent.pr, now) === "blocked";
  if (!blocked) return "none";
  const age = ageMs(
    agent,
    now,
    agent?.inputRequest?.updatedAt,
    agent?.inputRequest?.createdAt,
  );
  if (age != null && age >= LETTER_CROWS_MS) return "crows";
  return "pile";
}

export function checkWeather(agent) {
  const ci = prCi(agent?.pr);
  if (ci.state === "failing") return "storm";
  if (ci.state === "unavailable") return "unknown";
  return "clear";
}

/** Pixel accents for a house already drawn by town.mjs. */
export function paintHauntExtras(px, x, y, houseW, houseH, stage) {
  if (!px || stage === "none") return;
  const ink = "#2b2118",
    web = "#d8d2c4",
    ivy = "#3f6b45",
    ivyDk = "#2d4f34";
  // Cobwebs in the eaves and a corner.
  px(x + 8, y + 34, 1, 1, web);
  px(x + 9, y + 35, 2, 1, web);
  px(x + 11, y + 36, 1, 1, web);
  px(x + houseW - 12, y + 34, 1, 1, web);
  px(x + houseW - 13, y + 35, 2, 1, web);
  if (stage === "cobweb") return;

  // Ivy climbing the left wall; ruins thicken it.
  const climb = stage === "ruins" ? 18 : 12;
  for (let i = 0; i < climb; i++) {
    px(x + 5 + (i % 3), y + houseH - 6 - i, 2, 1, i % 2 ? ivyDk : ivy);
    if (i % 4 === 0) px(x + 7, y + houseH - 6 - i, 1, 1, ivy);
  }
  // Crooked chimney lean.
  px(x + 44, y + 6, 1, 10, ink);
  px(x + 45, y + 5, 1, 4, "#5a636b");
  if (stage === "ruins") {
    px(x + 14, y + 40, 3, 1, "#6a737a");
    px(x + 30, y + 42, 4, 1, "#6a737a");
    px(x + 18, y + 22, 2, 2, ivyDk);
  }
}

/** Pale night ghost behind dark glass — never a warm working pane. */
export function paintHauntGhost(px, wx, wy, nightness) {
  if (!px || !(nightness > 0.2)) return;
  const a = Math.min(0.55, nightness * 0.45);
  const ghost = (r, g, b) => `rgba(${r},${g},${b},${a})`;
  px(wx + 2, wy + 2, 2, 4, ghost(210, 220, 230));
  px(wx + 1, wy + 3, 4, 2, ghost(190, 205, 220));
  px(wx + 2, wy + 1, 2, 1, ghost(230, 235, 240));
}

/** Weeds along the door-to-lane yard path for feature branches. */
export function paintBranchWeeds(px, x, y, houseW, houseH, lane) {
  if (!px || !lane || lane.kind !== "feature") return;
  const tip = lane.weeds ? "#355c32" : "#4a7a42";
  const blade = lane.weeds ? 7 : 3;
  const pathX = x + Math.floor(houseW / 2) - 1;
  for (let i = 0; i < blade; i++) {
    const gy = y + houseH + 2 + i * 2;
    px(pathX - 3 + (i % 3), gy, 1, 2, tip);
    px(pathX + 2 + ((i + 1) % 3), gy + 1, 1, 2, tip);
  }
  if (lane.weeds) {
    px(pathX - 5, y + houseH + 8, 2, 1, "#2f4f2c");
    px(pathX + 4, y + houseH + 10, 2, 1, "#2f4f2c");
  }
}

/** Moss / nest / shrine beside an existing parcel dispatch stand. */
export function paintParcelReclaim(px, x, y, stage) {
  if (!px || !stage || stage === "none" || stage === "fresh") return;
  if (stage === "moss" || stage === "nest" || stage === "shrine") {
    px(x - 1, y + 12, 14, 2, "#3f6b45");
    px(x + 2, y + 11, 8, 1, "#2d4f34");
  }
  if (stage === "nest" || stage === "shrine") {
    px(x + 14, y + 8, 6, 4, "#6b4a2e");
    px(x + 15, y + 7, 4, 2, "#8a6238");
    px(x + 16, y + 9, 2, 1, "#c9a066");
  }
  if (stage === "shrine") {
    px(x - 4, y - 2, 3, 8, "#8d959b");
    px(x - 5, y - 3, 5, 2, "#aab2b8");
    px(x - 3, y - 5, 1, 2, "#e8c15a");
  }
}

/** Crow accents for neglected mail. */
export function paintLetterCrows(px, x, y, stage) {
  if (!px || stage !== "crows") return;
  px(x + 20, y - 2, 3, 2, "#1a1f24");
  px(x + 22, y - 3, 2, 1, "#1a1f24");
  px(x + 19, y, 1, 1, "#1a1f24");
  px(x + 26, y + 1, 3, 2, "#1a1f24");
  px(x + 28, y, 2, 1, "#1a1f24");
}

/** Pocket storm over a roof when CI is failing. */
export function paintCheckStorm(px, x, y, weather) {
  if (!px || weather !== "storm") return;
  px(x + 10, y - 6, 18, 4, "#4a5560");
  px(x + 14, y - 8, 12, 3, "#5c6772");
  px(x + 18, y - 3, 1, 4, "#ffd166");
  px(x + 22, y - 2, 1, 3, "#ffd166");
}

/** Soft dust and cobwebs inside a settled / haunted room. */
export function paintRoomDust(px, room, stage) {
  if (!px || !room || stage === "none") return;
  const web = "#d8d2c488";
  px(18, 14, 1, 1, web);
  px(19, 15, 2, 1, web);
  px(210, 16, 1, 1, web);
  px(208, 17, 3, 1, web);
  if (stage === "cobweb") return;
  px(30, 70, 4, 1, "#c4b89a55");
  px(120, 110, 5, 1, "#c4b89a44");
  px(180, 80, 3, 1, "#c4b89a55");
  if (stage === "ruins") {
    px(40, 50, 6, 1, "#6a737a66");
    px(160, 130, 8, 1, "#6a737a55");
  }
}
