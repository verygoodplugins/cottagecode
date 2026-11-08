# Village activity panel

Added `src/trade-panel.mjs`, integrated into `src/command-center.mjs`, and styled in `src/command-styles.mjs`.

The compact, collapsed-by-default Village activity ribbon counts miners, explicit road crews and actual arrivals in the selected town. Expanding exposes keyboard-accessible evidence buttons and a selected story. The story renders current recorded title/reason/time and offers Inspect cottage only for an exact supported task ID. All source strings and attributes are escaped.

The host passes `options.trades` to each command-center update and may call `commandCenter.inspectTrade(site)` for a painted trade. Supported roles are `miner`, `road`, `gardener`; matching uses current story role/town/task identity (or exact event ID). Missing matches open the ribbon without inventing an explanation. Expired/out-of-scope stories close automatically on update. Source changes clear selection and discard previous trades if no replacement was supplied.

`onRehearseGrowth` is a new createCommandCenter callback. The Rehearse growth button appears only when builtInDemo/publicDemo is true, and the click handler rechecks that flag. Field guide text explains real read/search tools, unknown missing evidence, new explicit links, first observed arrivals over ten minutes, and the gardener pause's growth meaning.

Verification: five new pure helper tests pass, plus 42 existing command-center/model/workbench tests. No browser run in this slice; parent owns host integration and browser verification.
