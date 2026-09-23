import test from "node:test";
import assert from "node:assert/strict";
import {fullscreenButtonCopy} from "../src/fullscreen.mjs";

test("fullscreen button copy flips with active state", () => {
  assert.deepEqual(fullscreenButtonCopy(false), {
    label: "Fullscreen",
    ariaLabel: "Expand Townmap to fill browser window",
    title: "Fill browser window (F)",
  });
  assert.deepEqual(fullscreenButtonCopy(true), {
    label: "Exit fullscreen",
    ariaLabel: "Restore Townmap to page layout",
    title: "Return to page layout (F or Escape)",
  });
});
