# Command center prototype implementation plan

Use subagent-driven-development. User already chose autonomous implementation and local experiments.

**Goal:** A polished, useful, truthful three-perspective command center at http://127.0.0.1:8790, using the existing local feed and a clearly separate illustrative scenario.

**Architecture:** Experimental modules in experiments/command-center, with a tiny Node loopback server. Reuse source contract helpers; keep the original product untouched. One data/policy task, followed by one UI task. Parent integrates and performs browser verification. Each task gets an independent review; whole branch gets an Astra review.

**Tech stack:** Node 24, ES modules, HTML/CSS/SVG, no dependencies. Node executable is /Users/jgarturo/.nvm/versions/node/v24.15.0/bin/node; prefix PATH for npm in this worktree.

## Global Constraints

- Product name CottageCode. Spatial view named Townmap; Townwatch is the perspective, not a replacement logo.
- Zero dependencies; no production-source modifications needed.
- Task and session clocks stay separate; missing stays unavailable; updatedAt is observed, not progress.
- Quiet requires explicit progress telemetry and is not a stall diagnosis.
- Reuse normalizePr/prStage/prCi, inputRequestVersion/normalizeInputRequest and conversationCapability.
- Hub readiness remains authoritative; standalone stale/conflicting evidence cannot be ready.
- Shared PRs count once; only explicit graph edges.
- Live and illustrative data must be visibly separate; no live fallback to fixtures.
- Explicit Send only; latest task/question/capability preflight; uncertain sends persistently locked; no automatic retry; upstream validation retained.
- Tests never send to real agents. Proxy binds loopback and only permits exact known routes to fixed upstream.
- Keep existing town and untracked user .cursor files untouched. Work on feat/command-center-lab in this isolated worktree.
- HTML content escaping, safe URL handling, reduced motion, responsive keyboard/mouse parity.

### Task 1: Truthful data model, scenario and local harness

Files owned: experiments/command-center/model.mjs, scenario.mjs, server.mjs, replies.mjs, test/command-center.test.mjs, test/command-center-server.test.mjs. Implement and commit as one coherent contract. Do not create UI files.

Interfaces:

```js
// model.mjs
export function durationLabel(milliseconds) {} // null -> 'Unavailable'; compact d/h/m/s
export function taskView(agent, {now=Date.now(), stale=false, endpoint='http://127.0.0.1:8790/agents'}={}) {}
export function fleetView(snapshot, options={}) {}
// taskView returns {id, raw, title, project, town, harness, model, status,
// taskAgeMs, sessionAgeMs, observedAgeMs, progressAgeMs, quiet,
// input, capability, pr, prKey, prStage, ci, attention, activity,
// issues, parent, sourceStale}. Raw is retained for existing validators.
// fleetView returns {tasks, projects, prs, edges, counts, stale, checkedAt}
// counts: {tasks, working, attention, answerable, quiet, ready, blockedPr, settled}
// projects: [{id,name,count,working,attention}], prs: [{key,pr,stage,taskIds}]
// edges: [{from,to,kind}] with typed ids task:<id>, issue:<url>, pr:<key>.
// Include non-settled records only. Parent/task/issue/PR edges are explicit.

// scenario.mjs
export function createScenario(now=Date.now()) {} // feed-shaped snapshot, illustrative:true

// server.mjs
export function createLabServer({upstream='http://127.0.0.1:8787', fetchImpl=fetch}={}) {}
// CLI node experiments/command-center/server.mjs --port 8790
// / -> index.html; /model.mjs,/scenario.mjs,/replies.mjs,/app.mjs,/style.css
// /src/<safe-filename>.mjs -> existing src helpers.
// /agents and /agents/:id/activity GET, /agents/:id/messages POST proxy only.
// Fixed upstream constructor injectable for local tests, never from HTTP input.

// replies.mjs
export function createReplyClient({endpoint, fetchImpl=fetch, storage=localStorage, now=Date.now}={}) {}
// returns {state(taskId), send(agent, message)}; state gives phase + notice.
// send fetches latest /agents, compares task and current input id/version, checks
// conversationCapability, persists request id before POST, returns receipt state.
// Transport ambiguous outcome locks retry across reload; do not silently retry.
```

Implement tests before core logic. Cover: missing task start with session time, terminal clocks frozen, observation not quiet, progress heuristic explicit, canonical Hub ready retained through outage, stale standalone ready rejected, shared PR dedup, explicit graph only, unsafe URL rejected, source-specific harness unknown, stale/changed-input send refused, uncertain send survives client recreation. Server tests use ephemeral loopback stub endpoints and reject cross-origin writes, arbitrary proxy paths, methods and oversized payloads. No integration calls to real message endpoints.

Scenario: approximately 12 tasks across HubTown, MemTown, AppTown, FusionTown, VaultTown. Clear fictional issue/PR ids; no actionable live links. Include two exact questions (one answerable, one source-only), working tasks with different harnesses, quiet task with progress timestamp, shared PR, blocked dependent PR, ready PR, unknown evidence, recently ended work. Use concise plausible activities connected to user's actual domains. No copied private live payload in fixtures.

Run focused tests, then commit owned files. Report public interfaces and test evidence to .superpowers/sdd/task-1-report.md.

### Task 2: Three-perspective interface

Files owned: experiments/command-center/index.html, style.css, app.mjs, README.md. Read the spec and Task 1 report before implementation. May request interface changes through parent. Do not alter model/server tests without coordination.

Use taskView/fleetView/createScenario/createReplyClient. Build a complete beautiful application with Townwatch, Dispatch and Threads, a shared detail drawer, global search/project filtering, rich PR preview, attention navigation, explicit live/scenario switch and readable source freshness. Live polls every five seconds, retains last snapshot with stale banner on failure; protects focused draft and selection across polls. Illustrative scenario never polls or sends remotely. Demo Send produces explicit local-only receipt without altering source status as fact.

Townwatch: CSS/SVG pixel cottages in stable district cards, dark desaturated midnight scene, subtle grid/stars/plants/roads, warm windows only for working tasks. Spacious typography, restrained coral/amber/mint/lavender state system with shapes and text. A slim attention strip puts exact next actions within one click. Lenses Attention/Time/Delivery/Owner change labels without repositioning cottages.

Dispatch: compact readable task rows grouped or filtered by useful attention states, independently show state/activity, provider/model, task/session age, observation and PR. Order stable across refresh except explicit resort/filter. Counts dedup PRs via fleet model. Search is typed across title/project/task id/PR. Selected row and drawer remain bound to identity.

Threads: explicit issue/task/PR cards arranged left to right with labelled connectors/relationships and selected-path emphasis. Support shared PR and dependencies. Live missing issue links gets clear explanation, still shows known task/parent/PR edges. No fabricated graph.

Drawer: title and project, exact public activity, task/session/observation/progress clocks, source, pending request with full expandable original and options, current reply capability or exact unavailable reason, request text, PR evidence (stage, source, checks, checkedAt, current/reviewed head, reason, labels), safe original links. Live Send uses createReplyClient only; no automatic messages. Scenario Send is local with explicit label. No merge controls.

Interactions: perspective keys 1/2/3, Cmd/Ctrl+K palette/search, j/k task selection, Escape closes overlay. Ignore shortcuts in editable controls. Buttons remain available. Click/focus PR badges opens preview; hover can use title/preview but must not be essential. At narrow widths collapse rail, use list layout and drawer below/overlay without horizontal overflow. Preserve draft on polling, warn if request changes. Respect reduced motion.

README covers start command, ports, shortcuts, live vs illustrative, data limitations and safety. Verify JS syntax and full npm test; parent does real browser journeys then supplies fixes. Commit owned files and write .superpowers/sdd/task-2-report.md. Browser screenshots go outside git.
