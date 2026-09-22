/**
 * Townmap fullscreen helpers. Prefer the Fullscreen API on the stage;
 * fall back to a CSS body class when the API is missing or denied.
 */

export function isMapFullscreen({
  fullscreenElement = null,
  cssFallback = false,
} = {}) {
  return Boolean(fullscreenElement) || Boolean(cssFallback);
}

export function fullscreenButtonCopy(active) {
  return {
    label: active ? "Exit fullscreen" : "Fullscreen",
    ariaLabel: active
      ? "Exit fullscreen townmap"
      : "Enter fullscreen townmap",
  };
}

/** Pure decision for the next toggle action. */
export function nextFullscreenAction({
  fullscreenElement = null,
  cssFallback = false,
  canRequest = true,
} = {}) {
  if (fullscreenElement) return "exit-api";
  if (cssFallback) return "exit-css";
  return canRequest ? "enter-api" : "enter-css";
}
