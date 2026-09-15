import test from "node:test";
import assert from "node:assert/strict";
import {
  HAUNT_IVY_MS,
  HAUNT_RUINS_MS,
  PARCEL_MOSS_MS,
  PARCEL_NEST_MS,
  PARCEL_SHRINE_MS,
  LETTER_CROWS_MS,
  hauntStage,
  branchLane,
  parcelReclaim,
  letterNeglect,
  checkWeather,
} from "../src/folklore.mjs";

const NOW = 1_700_000_000_000;

test("hauntStage stays none for live and recent cottages", () => {
  assert.equal(
    hauntStage({ occupancy: "live", status: "working" }, NOW),
    "none",
  );
  assert.equal(
    hauntStage(
      { occupancy: "recent", status: "done", endedAt: NOW - 60_000 },
      NOW,
    ),
    "none",
  );
});

test("hauntStage cobwebs as soon as a cottage settles", () => {
  assert.equal(
    hauntStage(
      { occupancy: "settled", status: "done", endedAt: NOW - 60_000 },
      NOW,
    ),
    "cobweb",
  );
});

test("hauntStage grows ivy then ruins for long-offline settled cottages", () => {
  assert.equal(
    hauntStage(
      { occupancy: "settled", status: "offline", endedAt: NOW - HAUNT_IVY_MS },
      NOW,
    ),
    "ivy",
  );
  assert.equal(
    hauntStage(
      {
        occupancy: "settled",
        status: "offline",
        endedAt: NOW - HAUNT_RUINS_MS,
      },
      NOW,
    ),
    "ruins",
  );
});

test("hauntStage does not invent age when clocks are missing", () => {
  assert.equal(
    hauntStage({ occupancy: "settled", status: "offline" }, NOW),
    "cobweb",
  );
});

test("branchLane treats default and common defaults as the village green", () => {
  assert.deepEqual(branchLane({ branch: "main" }), {
    kind: "default",
    weeds: false,
  });
  assert.deepEqual(
    branchLane({ branch: "feat/thing", defaultBranch: "feat/thing" }),
    {
      kind: "default",
      weeds: false,
    },
  );
  assert.deepEqual(branchLane({}), { kind: "unknown", weeds: false });
});

test("branchLane weeds only on settled feature branches", () => {
  assert.deepEqual(branchLane({ branch: "feat/thing", occupancy: "live" }), {
    kind: "feature",
    weeds: false,
  });
  assert.deepEqual(branchLane({ branch: "feat/thing", occupancy: "settled" }), {
    kind: "feature",
    weeds: true,
  });
});

test("parcelReclaim stays none without a verified open PR", () => {
  assert.equal(parcelReclaim({ pr: { state: "none" } }, NOW), "none");
  assert.equal(
    parcelReclaim({ pr: { state: "unknown", source: "unavailable" } }, NOW),
    "none",
  );
  assert.equal(
    parcelReclaim({ pr: { state: "merged", number: 1 } }, NOW),
    "none",
  );
  assert.equal(
    parcelReclaim(
      {
        pr: {
          state: "unknown",
          number: 9,
          url: "https://github.com/demo/repo/pull/9",
        },
        endedAt: NOW - PARCEL_SHRINE_MS,
      },
      NOW,
    ),
    "none",
  );
});

test("parcelReclaim preserves openedAt through normalizePr for age", async () => {
  const { normalizePr } = await import("../src/pr.mjs");
  const openedAt = NOW - PARCEL_NEST_MS;
  const pr = normalizePr(
    {
      state: "open",
      number: 12,
      url: "https://github.com/demo/repo/pull/12",
      openedAt,
      checkedAt: NOW,
      headSha: "abc",
    },
    NOW,
  );
  assert.equal(pr.openedAt, openedAt);
  assert.equal(
    parcelReclaim({ pr, occupancy: "live", updatedAt: NOW }, NOW),
    "nest",
  );
});

test("parcelReclaim escalates by wait age for outstanding PRs", () => {
  const open = {
    state: "open",
    number: 12,
    url: "https://github.com/demo/repo/pull/12",
  };
  assert.equal(
    parcelReclaim(
      { pr: { ...open, openedAt: NOW - 60_000 }, occupancy: "live" },
      NOW,
    ),
    "fresh",
  );
  assert.equal(
    parcelReclaim(
      { pr: { ...open, openedAt: NOW - PARCEL_MOSS_MS }, endedAt: NOW },
      NOW,
    ),
    "moss",
  );
  assert.equal(
    parcelReclaim({ pr: open, endedAt: NOW - PARCEL_NEST_MS }, NOW),
    "nest",
  );
  assert.equal(
    parcelReclaim({ pr: open, updatedAt: NOW - PARCEL_SHRINE_MS }, NOW),
    "shrine",
  );
});

test("letterNeglect ignores settled ghosts and escalates blocked letters", () => {
  assert.equal(
    letterNeglect({ occupancy: "settled", status: "blocked" }, NOW),
    "none",
  );
  assert.equal(
    letterNeglect(
      { occupancy: "live", status: "blocked", updatedAt: NOW - 30_000 },
      NOW,
    ),
    "pile",
  );
  assert.equal(
    letterNeglect(
      {
        occupancy: "live",
        status: "blocked",
        updatedAt: NOW - LETTER_CROWS_MS,
      },
      NOW,
    ),
    "crows",
  );
});

test("checkWeather reports storm only for failing checks", () => {
  assert.equal(checkWeather({ pr: { state: "open", checks: [] } }), "unknown");
  assert.equal(
    checkWeather({
      pr: {
        state: "open",
        checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    }),
    "clear",
  );
  assert.equal(
    checkWeather({
      pr: {
        state: "open",
        checks: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
      },
    }),
    "storm",
  );
});
