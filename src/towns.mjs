/**
 * Town names. Distinctive stem + "Town". Never hash a repo into four
 * aesthetic lanes.
 *
 * Known stems are locked. Unknown projects take PascalCase(basename) + Town.
 */

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

/** HubTown, MemTown, FusionTown, or {Stem}Town from the repo basename. */
export function townName(cwdOrRepo) {
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
