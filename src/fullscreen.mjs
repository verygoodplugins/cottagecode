/** Fullscreen expands the Townmap inside the browser window, using CSS only. */
export function fullscreenButtonCopy(active) {
  return {
    label: active ? "Exit fullscreen" : "Fullscreen",
    ariaLabel: active
      ? "Restore Townmap to page layout"
      : "Expand Townmap to fill browser window",
    title: active ? "Return to page layout (F or Escape)" : "Fill browser window (F)",
  };
}
