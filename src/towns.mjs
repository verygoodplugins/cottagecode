/**
 * Town names. Distinctive stem + "Town". Never hash a repo into four
 * aesthetic lanes.
 *
 * Known stems are locked. Unknown projects take PascalCase(basename) + Town.
 * Homedir / username-only paths fold into HubTown. They are not towns.
 */

import { homedir } from "node:os";

export const TOWN_STEMS = {
  autohub: "Hub",
  automem: "Mem",
  "wp-fusion": "Fusion",
  wpfusion: "Fusion",
  autoapp: "App",
  autovault: "Vault",
};

export function repoOf(cwd) {
  const raw = String(cwd || "").replace(/\\/g, "/");
  const nested = raw.match(
    /^(.*?)\/(?:\.claude\/|\.codex\/|\.cursor\/)?(?:claude-|codex-|cursor-)?worktrees?\//i
  );
  const base = (nested ? nested[1] : raw).split("/").filter(Boolean).pop() || "";
  return (
    base
      .replace(/--?(claude-|codex-|cursor-)?worktrees?-.*$/i, "")
      .replace(/^-+|-+$/g, "") ||
    base ||
    "unknown"
  );
}

export function worktreeOf(cwd) {
  const m = String(cwd || "").match(/worktrees?[/-](.+)$/i);
  return m ? m[1].replace(/^-+/, "") : "";
}

function pascal(s) {
  return String(s)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function isJunkProject(cwdOrRepo) {
  const raw = String(cwdOrRepo || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!raw) return true;
  const home = homedir().replace(/\\/g, "/");
  if (raw === home) return true;
  const base = repoOf(cwdOrRepo);
  const user = home.split("/").filter(Boolean).pop() || "";
  if (user && base.toLowerCase() === user.toLowerCase()) return true;
  if (["users", "home", "unknown", ""].includes(base.toLowerCase())) return true;
  return false;
}

/** HubTown, MemTown, FusionTown, or {Stem}Town from the repo basename. */
export function townName(cwdOrRepo) {
  if (isJunkProject(cwdOrRepo)) return "HubTown";
  const repo = repoOf(cwdOrRepo);
  const key = String(repo || "").toLowerCase();
  if (TOWN_STEMS[key]) return `${TOWN_STEMS[key]}Town`;
  const stem = pascal(key) || "Wild";
  return `${stem}Town`;
}

export function sortTownKeys(keys) {
  return [...new Set(keys)].sort((a, b) => {
    if (a === "HubTown") return -1;
    if (b === "HubTown") return 1;
    return a.localeCompare(b);
  });
}
