# Town trades art

Implemented `src/trade-art.mjs` with pure `drawTradeLife(ctx, options)` and shared `tradeSites(options)` geometry. No state, dependencies, polling, world mutation or invented routes.

- Miners use exact resident, roommate or child IDs and occupy the household side yard. One compact site per household avoids overlapping miners. A small timber mine, visible ore, helmet lamp and timed pick sparks make the read/search role legible.
- Roadmenders prefer a visible recorded destination, then the recorded source. They occupy the nearest supplied road rectangle; no street rectangle means no roadmender. Paving, a low striped barrier, stacked stone and a lifting mallet remain inside the existing road.
- Garden work yards fit the lower district margin and avoid cottages/branch signs. They include a potting bench, up to six seedlings, a wheelbarrow and gardener. Growing gardens gently haul; growth spurts pause with a hand at the brow. The visual seedling cap does not change actual arrival data.
- Every site returns `{role, taskId, town, x, y, w, h, evidence, clip}`. Roles are `miner`, `road`, `gardener`. The host can use actual painted bounds and direct evidence for explanatory click targets. Garden task IDs are limited to visible recorded households.
- Site clipping and outer/per-site `save`/`restore` protect the host canvas, including exceptions. Reduced motion and stale force identical paint calls across clocks. Town filtering and supplied visible plots control scope.

Verification: `node --test test/trade-art.test.mjs` — seven tests pass. Tests cover exact household attribution, existing-road geometry, town and visible-plot scope, garden margin fit, bounded seedlings, time-invariant stillness, active animation, input nonmutation, clipping and canvas restoration on paint failure. Parent owns integrated browser verification and the full suite.
