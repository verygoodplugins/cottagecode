# Original-town command center implementation plan

> Use subagent-driven-development with independent file ownership and parent integration. User already authorized execution.

**Goal:** Integrate the lab's visibility into the original playable CottageCode town.
**Architecture:** town.mjs retains polling and canvas; observatory retains room state, inspector, journal and composer; a presentation-only coordinator renders attention, search, Dispatch, Threads and plot lenses. Promote reviewed pure model/reply helpers to src, keeping lab re-exports.
**Tech:** Zero-dependency Node/ESM, canvas, DOM/CSS. Node /Users/jgarturo/.nvm/versions/node/v24.15.0/bin/node.

## Global Constraints
- Original pixel world, WASD/doors/E, residents, wildlife, lighting, optional sound/music remain intact; music and sound start off.
- No view/lens change resets world layout, camera, player, occupied room, visited-room seed or selected task. Explicit Locate/Enter/Leave actions may change world context.
- One poll owner (town.mjs); command coordinator never fetches or sends. One inspector/composer (observatory).
- Keep task/session/execution/observation/progress clocks separate; unknown stays unknown. Harness is explicit, not guessed from model.
- Hub readiness remains canonical during outages; stale standalone cannot be ready. Shared PR counts dedup; edges require explicit evidence.
- Exact input/version/identity/capability/latest preflight and durable uncertainty lock precede explicit live Send. No real agent test messages. Demo answers local.
- Source changes clear old evidence. Public demo bundles only static src modules and denies network connections.
- All dynamic HTML escaped, safe URLs, keyboard parity, reduced motion, responsive layouts. CSS fullscreen only.
- Parent owns integration and final browser/full-suite checks. Workers own disjoint files and do not revert others. No child delegation.

### Task 3: Shared model and host integration (parent)
Ownership: src/command-model.mjs, src/command-replies.mjs, src/town.mjs, src/town.html, src/map-display.mjs, src/feed-client.mjs, experiments/command-center/{model,replies,server}.mjs, test/command-integration.test.mjs, test/public-demo.test.mjs, docs.
- Promote reviewed lab model/replies to src with local relative imports; lab re-exports preserve existing tests and experiment.
- Add commandSnapshot(agents,meta,{stale=false}) to merge accepted raw evidence by id with normalized ids/town/occupancy/PR. Raw unknown terminal stays unknown; exact model/status preserved. Include raw relationships. Never merge mismatched IDs. fleetView option includeSettled makes explicit settled toggle work.
- Preserve checkedAt/timestamp in feedEnvelope.
- Mount DOM #command-bar, #command-attention, #command-view. Wrap existing #map-viewport in #perspective-stage; alternate view absolutely fills wrapper and scrolls independently. Original viewport remains mounted/measurable and becomes inert/visually hidden in alternate modes. Keep the wrapper's original/fullscreen sizing.
- Wire coordinator update after accepted feed updates and original filters; inspect callback invokes new observatory inspectCottage. Locate is explicit focusCottage. getEvidence(id) returns accepted raw/normalized join. setView suspends observatory and calls mapDisplay.syncZoom; selection sync calls coordinator.select(id) without recursion.
- Map draw passes existing plot coordinates to coordinator.drawLens after night treatment; no relayout. Add hover context using existing hit/hover, not new walk physics.
- mapDisplay receives getWorkspaceView and focusWorkspace; close details focuses visible view, zoom keys ignore hidden town. Details can be closed/reopened in normal layout as a real evidence drawer; changing visibility must preserve camera.
- Add --town preview mode to lab server at8791: serve original town.html and src modules/static audio with existing restricted live feed proxy. Keep port8787 unchanged.
- Focused tests cover snapshot exact model/status/terminal, stale authority, settled inclusion, no mismatched evidence; public demo includes new src modules. Full suite after integration.

### Task 4: Shared evidence inspector and suspended walking
Ownership: src/observatory.mjs and test/observatory.test.mjs (may add test/command-observatory.test.mjs). Report .superpowers/sdd/integration-inspector-report.md.
Consumes src/command-model.mjs taskView/durationLabel, src/command-replies.mjs createReplyClient/isTerminalForMessage; parent creates these before implementation. New optional api.getEvidence(id) returns the raw-preserving agent (fallback byId). Existing api.select/showDetails/etc remain.
Produces:
```js
observatory.inspectCottage(id,{tab='overview'}={}); // select/read only; no camera/player/room change
observatory.setSuspended(boolean); // clear keys; gate world input/movement/follow, preserve all physical state
```
- Keep selected evidence target independent from interiorId. All inspector/composer/tab/action handlers operate on the currently inspected task, while physical E/room-object/door interactions explicitly select the physical host. Do not accidentally send to interiorId after a different task was inspected.
- renderPanel must not force room host over requested evidence. Preserve existing draft/focus/activity pagination/room caches. Continue lastFrame update while suspended; do not move or follow camera. Return suspended in state for browser verification.
- Upgrade original overview into legible evidence: task title/public activity, explicit harness and full source model, clocks from taskView including conditional recorded execution, input question excerpt+open Talk, PR stage/reason/checks/head/freshness (existing prSnapshotHtml), original request. Existing tabs/journal/todos/objects stay available. Distinguish observation from progress.
- Promote live Send to ONE createReplyClient per endpoint/source using raw evidence snapshot, latest preflight and persistent state. Preserve request-version draft guard; mapping uncertain -> existing unconfirmed UI must stay locked after reload/source revisit. Demo branch stays local and never instantiates remote write. Inspect existing tests/handlers before patching; do not weaken locks for usability.
- Add focused behavioral tests for pure helpers/eligibility where useful. Parent browser tests actual room/selection/composer journey; don't build mock-only DOM tests that mirror implementation.
- Run focused observatory tests and syntax; commit only owned files, report interfaces and concerns. Do not run entire suite while other workers changing code.

### Task 5: Presentation coordinator, lenses and alternate views
Ownership: src/command-center.mjs, src/command-styles.mjs (CSS string installed by coordinator), optionally src/command-render.mjs and test/command-center-ui.test.mjs. Report .superpowers/sdd/integration-ui-report.md.
Consumes src/command-model.mjs fleetView/taskView/durationLabel/safeUrl. Reference lab app for rendering, not bootstrap or second drawer. Parent supplies DOM ids #command-bar,#command-attention,#command-view, all under #map-shell. #perspective-stage wraps still-mounted #map-viewport. Existing evidence #details-shell/#panel.
Produces:
```js
createCommandCenter({root,onInspect,onLocate,onViewChange,onTownFilter})
// root = #map-shell; callbacks onInspect(id,tab), onLocate(id), onViewChange(view), onTownFilter(town)
// returns:
.update({snapshot,endpoint,sourceKey,builtInDemo,publicDemo,stale,selectedId,townFilter,showSettled})
.select(id) // selection sync; no callback recursion
.setView('town'|'dispatch'|'threads')
.drawLens(ctx,plots,{selectedId,hoverId,townFilter,visible,time,reduce})
.state // serializable view,lens,selectedId,filter,counts,sourceKey
```
- Defaults Townmap, lens Village/off. Toolbar 1 Townmap,2 Dispatch,3 Threads, search. Attention strip exact input excerpt or blocked PR reason, counts scoped; answerable inputs first, next-item cycle; click onInspect(id,'talk' or 'review' or 'overview'). Explain stale/illustrative state in compact copy.
- Lenses Village,Attention,Time,Delivery,Owner annotate EXISTING plot coordinates without changing layout/positions. Canvas text small/simple; focus/hover provides richer readable context. Pixel colors/labels harmonize original warm/night palette. Reduce visual noise with single lens. drawLens restores canvas state and respects town/PR dimming. Parent paints after night palette; marker labels should not blanket sprites. Handle roommates/kids honestly.
- Dispatch compact ledger shows title/activity, independent status/owner/model/time/PR, filters all/attention/working/quiet/ready. Original townFilter and showSettled context apply. OnInspect updates shared inspector, never creates a drawer or sends. One Show in town action on selected work invokes onLocate. SharedPR counts once.
- Threads reuses explicit typed graph contract (task,issue,PR,parent,depends-on) with dedup PR nodes. At narrow width or insufficient graph space, selected-task trace. Same selected task. No issue edges -> useful honest empty note plus known edges. Dependency direction prerequisite -> dependent. Safe links only.
- Hover/focus PR receipt tooltip, click invokes onInspect(id,'review'). Global search Command/Ctrl+K, arrows/Enter/Escape;1/2/3 views;J/K only alternateviews;WASD/E untouched. Ignore shortcuts editing/dialogs; Escape closes search/preview then returns alternate view to town without also leaving a room. Keep game focus when returning. Coordinator never fetch/POST/poll.
- Scope styles to cc classes/root state; don't replace original theme/globalfonts. New view surface gets readable typography, warm paper/brass accents, restrained lines. Mobile drawer original semantics parent handles; alternate table/trace no horizontal overflow. Mount global dialog inside map-shell for fullscreen inert support.
- Preserve focused controls through feed updates, redraw graph on width change, avoid resetting alternate scroll. Source change clears search/selection/lens data as appropriate. No duplicate attention notifications on poll.
- Syntax and focused tests; commit ownedfiles; report. Parent browser verification and independent task review follow.

## Integration verification
- Node full suite, static demo build checks and syntax.
- Real browser at8791/?demo=1: WASD door entry/exit, E conversation and workbench, duck startle; Townmap↔Dispatch↔Threads while inside and outside preserves position/room/camera; lenses preserve plots.
- Inspect different task while in a room; verify drawer identity and supported demo response target, then return to unchanged physical room. Never send live messages.
- PR preview, search, ready unique count, settled/town filters, source/stale recovery, fullscreen/zoom and narrow viewport.
- Independent task reviews and final broad Astra review; fix important findings and scoped re-review. Save screenshots outside git and leave integrated preview running.
