# CottageCode command center lab

Three perspectives on the same observed village: **Townwatch** is a midnight Townmap, **Dispatch** is a working ledger, and **Threads** traces explicit relationships. The evidence drawer preserves the same task identity in every view.

Start the existing feed first (`npm start`, port **8787**), then start this isolated zero-dependency lab:

```sh
node experiments/command-center/server.mjs --port 8790
```

Open [the live village](http://127.0.0.1:8790/). The lab binds to `127.0.0.1`; it does not replace the existing town or expose a general proxy.

- [Townwatch](http://127.0.0.1:8790/?view=townwatch)
- [Dispatch](http://127.0.0.1:8790/?view=dispatch)
- [Threads](http://127.0.0.1:8790/?view=threads)
- [Illustrative scenario](http://127.0.0.1:8790/?view=townwatch&scenario=1)

The conspicuous source strip switches between live and illustrative data. URL parameters preserve the current perspective and source. Live is the default. Live reads `/agents` every five seconds after the prior request completes; failure retains the last observation with a stale banner, disables sending, and never substitutes fictional work. The illustrative scenario freezes its authored observation, never polls, and only produces a local response receipt. A simulated response does not change source status or pretend an agent resumed.

## Reading and navigating

Select a town in the rail (or the compact mobile selector). Townwatch's Attention, Time, Delivery, and Owner lenses change annotations without changing task ordering. The attention strip prioritizes available input, then lets you cycle through other recorded attention. Attention includes blocked deliveries and reports; it is not a count of answerable questions.

Dispatch independently shows execution, public activity, harness/model, task/session clocks, observation, and PR evidence. Filters use shared model semantics. Ready totals count unique PRs, including when several cottages share a shipment. Arrival order remains stable across refreshes.

Threads draws only recorded issue, parent, task, PR and dependency relationships. Shared PRs have one endpoint. The illustrative dependency arrow reads “required by” from upstream PR to dependent PR. On narrow screens, choose a cottage to read a vertical trace, including shared shipments and dependencies. Missing issue links have an explicit explanation.

| Key | Action |
| --- | --- |
| `1`, `2`, `3` | Townwatch, Dispatch, Threads |
| `Cmd/Ctrl+K` | Search all task titles, towns, cottage/task identifiers and PRs |
| `J`, `K` | Inspect next / previous visible cottage (first / last if none selected) |
| `↑`, `↓`, `Enter` in search | Move through matches and inspect the current result |
| `Escape` | Close search or evidence drawer |

Shortcuts do not interfere with editable controls. All actions also have visible controls. PR badges expose a compact accessible evidence preview on hover or focus, without moving focus or selecting the task. Click or Enter opens the full receipt. Escape closes search explicitly, including while its search field has focus. Reduced motion removes ambient smoke movement. There is no sound or native fullscreen request.

## Evidence and responses

The drawer shows public activity, separate task/session/observation/progress clocks, source, recorded input and supplied options, original request, public journal, recorded relationships, and detailed PR evidence. Long text has an exact excerpt with full expansion. Missing fields remain unavailable. Task and session starts do not substitute for each other; observing a task is not evidence of progress. When the source supplies execution duration, the drawer labels it separately as Recorded execution; it never substitutes for wall-clock task age. Quiet requires explicit progress telemetry at least 15 minutes old and is not a stall diagnosis. Unknown harnesses are never inferred from model names or Hub provenance.

Readiness follows the shared PR model: Hub remains authoritative, including its last verified state during a feed outage; stale or conflicting standalone observations cannot become ready. PR evidence separates stage, authority, source, verification time, freshness, checks, current/reviewed heads, reason and labels. Original links accept only safe HTTP/HTTPS URLs. There are no merge controls.

Messages require an explicit **Send message**. The UI retains the task/question snapshot associated with each draft. A changed question locks the preserved draft until the user reviews and explicitly adopts the current input. `createReplyClient` then independently rereads the feed, validates task identity/status, exact question version, current capability and route, and saves a durable receipt reservation before submission. Uncertain delivery remains locked across reloads; there is no automatic retry. Composer eligibility uses the same `isTerminalForMessage` guard as submission: an explicit current `terminal: false` takes precedence over a historical end timestamp; explicit terminal states remain blocked. Visual working windows follow current execution status independently. Source-only tasks show the exact unavailable reason. Draft text is held in page memory; delivery guards use local storage. Closing the drawer or ordinary polling preserves drafts; reloading the page does not preserve draft text.

Tests must never send to real agents. Use the illustrative source to exercise responses, or inject mock transports into the reply-client tests.

## Validation

```sh
node --check experiments/command-center/app.mjs
node --test test/command-center.test.mjs test/command-center-server.test.mjs
npm test
```

Browser acceptance covers all three perspectives at desktop and narrow widths, keyboard navigation, source switching, exact recorded input, PR evidence, a local scenario response, preserved live drafts, stale recovery, and source-only capability reasons. Screenshot artifacts belong outside Git. Public journals currently show inline feed events only; fetching separate `activityUrl` history is a follow-up capability.

## Integrated original town

The approved integration is now in `src/`: the original walking town owns the
camera, rooms, polling, journals and replies, with the command surfaces added.
To run the integrated worktree's feed and telemetry adapter on its own port,
configure its local `.env` as described in the main README, then run:

```sh
npm start -- --port 8791
```

Open [the integrated live town](http://127.0.0.1:8791/) or
[the original sample village with command controls](http://127.0.0.1:8791/?demo=1).
This runs `src/feed.mjs` directly, including the worktree's Hub inventory and
telemetry adapter. No port-8787 upstream is needed. For frontend-only comparisons,
`node experiments/command-center/server.mjs --port 8791 --town` still serves the
production modules through a restricted proxy to port 8787; that mode does not
exercise this worktree's feed adapter. The older port-8790 lab remains an
exploration artifact. Its model and reply helpers re-export the shared modules.

The November 5 refinement keeps the original town visible and walkable while
Dispatch or Threads opens as a workbench beneath it. Drag **More detail / More
town** to change the balance immediately. The neighbourhood heartbeat rail
focuses a single project and its evidence; **All towns** restores the wider
scope. **Read the village** explains the working-ground lights, decorative
tradesfolk, and one-parcel-per-PR shipment/return carts. Carts represent newly
observed merge/close events, not historical backfill or deployment claims.

The live-data refinement keeps every canonical Hub dashboard resident in town,
including settled-looking tasks that still need attention. Project pulses show
attention and ready shipments together. Initial packing uses the available
window width; resizing does not move established cottages. **Visit activity**
returns to the street at normal zoom and visits the best available working or
attention cottage within the selected project.

Expand **Village activity** for recent, older, and unreported tool coverage.
Miners mean observed read/search tools; workshops mean other recent tool use,
including generic shell calls. Neither means the individual call is still
running. Missing telemetry never creates work animations. The freshness label
reports the last successful feed check, separately from tool-event age.
