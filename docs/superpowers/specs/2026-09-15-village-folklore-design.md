# CottageCode: village folklore gags

Approved for implementation 2026-09-15. Real fleet state, read as village scenery. Decorative only: never change occupancy, feed status, or hide Talk / review desk / PR access (same rule as bedtime).

## Chosen gags

1. **Haunted cottages** — settled (and especially long-offline) houses go feral.
2. **Branch lanes** — yard dirt and weeds on the existing spur; not a second path system and never town↔town roads.
3. **Nature reclaims the queue** — neglected parcels and letters attract moss, nests, shrines, and crows; failing checks get a pocket storm.

## Classifiers (`src/folklore.mjs`)

Pure functions over observed feed fields. Missing data stays none / unknown.

| Helper | Stages / values | Signal |
|---|---|---|
| `hauntStage(agent, now)` | `none` → `cobweb` → `ivy` → `ruins` | `occupancy === "settled"` immediately cobwebs; `status === "offline"` and age ≥ 6h → ivy; age ≥ 24h → ruins. Age from `endedAt` or `updatedAt`. |
| `branchLane(agent)` | `{ kind: "unknown"\|"default"\|"feature", weeds: boolean }` | `defaultBranch` or common defaults (`main`/`master`/`trunk`/`develop`) → default lane; other non-empty branch → feature. Weeds when feature and settled. |
| `parcelReclaim(agent, now)` | `none` → `fresh` → `moss` → `nest` → `shrine` | Only when `hasOutstandingPr`. Wait age from earliest trustworthy clock: `pr.openedAt`, else `endedAt`, else `updatedAt`. Thresholds: fresh &lt; 2h, moss &lt; 12h, nest &lt; 48h, else shrine. Unknown / missing PR → `none` (lawn stays clean). Stale GitHub evidence must not look merged. |
| `letterNeglect(agent, now)` | `none` → `pile` → `crows` | Letter cottages only (`occupancy !== "settled"` and blocked task or blocked PR). Age ≥ 2h → crows. |
| `checkWeather(agent)` | `clear` → `storm` → `unknown` | `prCi` failing → storm; unavailable → unknown; else clear. |

## Painting

- **House:** cobwebs in corners; ivy + slightly crooked chimney at ivy+; ruins deepen ivy and dim further. Pale window ghost only at night when haunt ≥ cobweb and status is not working — never a warm working pane.
- **Interior:** light dust / cobweb accents in `paintRoomAtmosphere` when haunt ≥ cobweb; request board and review desk stay reachable.
- **Branch lane:** tiny weeds along the door-to-lane path for feature branches; denser when `weeds`. No regrouping of cottages by ref. Relationship paths unchanged.
- **Parcel stand:** moss tint, nest beside post, then tiny shrine; stand remains the same PR hit target.
- **Mailbox / Jack stoop:** overflow stack already exists; crows perch when any letter is at `crows`. Letter counts unchanged.
- **Storm:** small cloud over the roof when checks are failing only.

## Demo fixtures

Demo seed includes at least: one long-offline settled cottage (ruins-ready), one feature-branch settled cottage with weeds, one long-outstanding open PR parcel (moss+), one long-blocked letter (crows), and one failing-checks cottage (storm). Toggle settled to tour haunted houses.

## Verification

Unit tests for every classifier edge (missing clocks, unknown PR, default branch, non-letter). Browser smoke: `/?demo=1`, show settled, confirm scenery without blocked Talk/PR.