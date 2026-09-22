import test from "node:test";
import assert from "node:assert/strict";
import {
  isMapFullscreen,
  fullscreenButtonCopy,
  nextFullscreenAction,
} from "../src/fullscreen.mjs";

test("isMapFullscreen is true for API or CSS fallback", () => {
  assert.equal(isMapFullscreen({}), false);
  assert.equal(isMapFullscreen({ fullscreenElement: {} }), true);
  assert.equal(isMapFullscreen({ cssFallback: true }), true);
});

test("fullscreen button copy flips with active state", () => {
  assert.deepEqual(fullscreenButtonCopy(false), {
    label: "Fullscreen",
    ariaLabel: "Enter fullscreen townmap",
  });
  assert.deepEqual(fullscreenButtonCopy(true), {
    label: "Exit fullscreen",
    ariaLabel: "Exit fullscreen townmap",
  });
});

test("nextFullscreenAction prefers exiting the active mode", () => {
  assert.equal(
    nextFullscreenAction({ fullscreenElement: {} }),
    "exit-api",
  );
  assert.equal(nextFullscreenAction({ cssFallback: true }), "exit-css");
  assert.equal(nextFullscreenAction({ canRequest: true }), "enter-api");
  assert.equal(nextFullscreenAction({ canRequest: false }), "enter-css");
});
