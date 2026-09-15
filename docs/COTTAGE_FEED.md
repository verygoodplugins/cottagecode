# Cottage feed (GET /agents)

CottageCode is a viewer. Point the connect box at any URL that returns cottages as JSON. The bundled `npm start` process serves that shape at `/agents`, and also has optional local adapters (Claude Code transcripts, and a readonly sqlite `agent_runs` table when `AGENT_DB_PATH` is set). You do not need those adapters. A static JSON file behind a tiny HTTP server is enough.

## Envelope

Either of these works:

```json
{ "agents": [], "source": "my-runner" }
```

```json
[]
```

Optional envelope fields:

| Field | Type | Notes |
|---|---|---|
| `agents` | array | Preferred. Bare array is also fine. Empty `[]` is a valid live snapshot. |
| `source` | string | Shown in the feed note (`live. 12 cottages (my-runner)`). |
| `stale` | boolean | The producer is retaining old data after an adapter failure. The browser marks the snapshot stale and withholds PR readiness. |
| `checkedAt` | number \| null | Producer's last successful snapshot time, in epoch milliseconds. Optional metadata. |
| `errors` | string[] | Short source errors. Keep credentials and raw connection strings out of them. |
| `relationships` | array | Explicit town-to-town connections. See [Relationships and handoffs](#relationships-and-handoffs). |
| `handoffs` | array | Recorded cross-town handoffs, with stable IDs and timestamps. |
| `live` / `settled` / `letters` / `liveCost` | number | Optional producer hints. The townmap recomputes these from `agents` and does not read the envelope copies. |

An empty custom feed stays empty. The bundled same-origin `/agents` endpoint has an onboarding exception: an empty snapshot with `source: "none"` opens the demo until local agents appear. Demo history uses its own namespace.

The browser polls every 1.5 seconds. HTTP failures keep the last snapshot from the same endpoint, marked stale; they never substitute another feed. The Node adapters refresh every 2 seconds. GitHub enrichment runs on its own slower cache.

CORS: the browser fetches the URL entered in the connect box. Serve `Access-Control-Allow-Origin: *` (or the CottageCode origin) for feeds and activity endpoints on another host. The bundled server defaults to `127.0.0.1:8787` and permits its `/agents` and activity routes only to a Townmap loaded from that same origin; it does not provide CORS access to its local agent data. To use a separately hosted Townmap, point it at a separate feed/activity service that allows the Townmap origin, or host that service and the Townmap together. Message writes require this server's own origin, JSON, and the explicit message header described below.

## Cottage object

Minimum useful cottage:

```json
{
  "id": "bolt-1",
  "name": "Bolt",
  "town": "HubTown",
  "status": "working",
  "task": "bump deps + run suite"
}
```

Full shape (everything else is optional):

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable id. Required in practice. |
| `name` | string | Nameplate on the cottage. |
| `town` | string | District. Prefer `SomethingTown`. Bare stems get `Town` appended. |
| `role` | string | Fallback for `town` if `town` is missing. |
| `status` | string | One of `working` `idle` `blocked` `done` `offline`. |
| `occupancy` | string | `live` `recent` `settled`. Optional. If omitted, the townmap classifies from `status` + timestamps (done ages out after ~2h). |
| `parent` | string \| null | Id of the parent cottage. Kids render as sheds in the yard. |
| `task` | string | Short description of the current work. Separate from the original request. |
| `taskId` | string \| null | Explicit task/run identity. Changes reset the room and activity cache for that cottage. |
| `sessionId` | string \| null | Session identity when available. A session can contain multiple tasks. |
| `originalAsk` | string | Genuine user request, preserved separately from assistant updates. |
| `originalAskSource` | string | `task` for an identified task, or `session` for the first request in a session whose task boundaries are unavailable. |
| `originalAskTruncated` | boolean | The bundled adapters set this when the original request exceeds their 32,768-character limit. |
| `activity` | string | Short live line under the status chip. |
| `activityUrl` | string | Absolute or relative HTTP(S) activity endpoint, resolved against the feed URL. |
| `events` | array | Optional inline activity events. When supplied, including `[]`, this takes precedence over `activityUrl`. |
| `todos` | object \| null | Latest explicit checklist snapshot; null is unavailable, an empty `items` array is known empty. |
| `conversation` | object | Explicit message capability, route, freshness, or an unavailable reason. |
| `activitySource` | string | Source label for inline events. Falls back to the cottage's `source`, then the feed/demo label. |
| `source` | string | Cottage adapter label, such as `claude` or `hub`. |
| `worktree` | string | Short worktree / checkout label. |
| `worktreePath` | string | Absolute path. Enables "open worktree" / copy path. |
| `branch` | string | Shown on the branch post under the house. |
| `repo` | string | Exact GitHub `owner/repo` identity for branch-based PR discovery. Never inferred from a town name. |
| `defaultBranch` | string | Known repository default branch. That branch is excluded from PR discovery. |
| `result` | string | Final summary when done. |
| `artifacts` | array | `{ "url", "title" }` objects for the shelves and scrapbook. URLs must be absolute HTTP(S). |
| `lastLine` | string | Latest log line / thought bubble fodder. |
| `attention` | string | Why it's blocked. Shows up in Jack's letter pile. |
| `handoffUrl` | string | Optional https handoff link. |
| `model` | string | `opus` `sonnet` `haiku` `gpt` `local` `mlx` (or a string containing those). Roof flag color. |
| `dispatchedBy` | string | Who sent it. |
| `taskStartedAt` | number \| null | Start of the identified task, in epoch milliseconds. |
| `sessionStartedAt` | number \| null | Start of the enclosing session, in epoch milliseconds. |
| `startedAt` | number \| null | Legacy start value, still accepted for occupancy. It does not replace the explicit task/session clocks. |
| `endedAt` | number \| null | Known completion time. The task clock uses it to stop elapsed time for terminal tasks. |
| `updatedAt` | number \| null | Time of the last signal. |
| `tokens` | number | |
| `cost` | number | USD for this run. |
| `pr` | object | PR identity, state, and review evidence. See [Pull requests](#pull-requests). |
| `interiorTheme` | string | Optional `hub`, `app`, `memory`, `vault`, or `neutral` furniture theme. `theme` is an accepted alias. |

### Task and session boundaries

Supply `taskId` and `taskStartedAt` only when the source identifies a task. A recent assistant response or file modification is not a new task start. Missing or invalid clocks show **Unavailable**; they are never filled with the current time.

The local transcript adapter preserves the first genuine user request, excluding tool replies, runtime metadata, and compaction summaries. Explicit `taskId`/`runId` records establish task boundaries. Without them, `taskId` and `taskStartedAt` remain null, and `originalAskSource: "session"` labels the pinned note as the first request in that session. Assistant updates populate activity instead of replacing the request.

### Activity

The bundled service exposes:

```text
GET /agents/:id/activity
GET /agents/:id/activity?after=EVENT_ID&limit=100
GET /agents/:id/activity?before=EVENT_ID&limit=100
```

URL-encode the cottage ID and cursor values. A request with both `after` and `before` returns HTTP 400; an unknown cottage returns 404. `limit` defaults to 100 and is capped between 1 and 500.

```json
{
  "events": [
    {
      "id": "run-42:tool:3",
      "timestamp": 1789387200000,
      "kind": "tool",
      "text": "Read: src/feed.mjs"
    },
    {
      "id": "run-42:result:4",
      "timestamp": 1789387202000,
      "kind": "result",
      "text": "The activity tests passed.",
      "url": "https://github.com/example/project/pull/42"
    }
  ],
  "source": "claude-transcript",
  "hasMore": false,
  "cursor": "run-42:result:4"
}
```

Events use stable string `id`, `timestamp` in epoch milliseconds or null, `kind`, and `text`. Optional `url` links to an artifact. Public kinds are `request`, `progress`, `summary`, `tool`, `result`, `status`, and `handoff`. Missing timestamps retain their source-relative position and display as unavailable.

| Request | Page behavior |
|---|---|
| No cursor | Latest events, in chronological/source order. `hasMore` means older entries exist. |
| `after` | Events after that ID, oldest first. Use the returned `cursor` for the next forward poll. `hasMore` means more forward entries exist. |
| `before` | Older entries ending before that ID. Use the first returned event's ID to request the next older page. |

An expired cursor sets `cursorReset: true`. For `after`, the service returns its latest retained page so the client can replace its old stream. An unknown `before` cursor returns an empty page. Sources can also return `stale: true`, an `error` summary, `checkedAt`, or `unavailable: true`. Unavailable activity is distinct from an agent having done no work.

The bundled activity cache retains up to 2,000 events per task, with text previews capped at 1,200 characters. The browser retains up to 1,500 fetched journal entries per task. Inline `events` use the same event shape and should stay bounded.

Send progress or reasoning **summaries that the agent emitted**, tool actions, and results. The bundled adapters exclude raw `thinking` and `redacted_thinking` blocks. Tool labels use the tool name and a short description/path; they do not dump entire argument objects. Public text and result previews still contain source content.

### To-do lists

Supply a full snapshot in cottage `todos`, or as `todos` on an activity response:

```json
{
  "items": [
    { "id": "inspect", "text": "Inspect the current reconnect behavior", "status": "completed" },
    { "id": "verify", "text": "Verify reconnect and failure recovery", "status": "in_progress" }
  ],
  "source": "transcript:TodoWrite",
  "updatedAt": 1789387200000,
  "stale": false
}
```

Statuses are `pending`, `in_progress`, `completed`, or `cancelled`. Stable item IDs are preferred; missing IDs are derived from item text. A snapshot replaces the previous list, including explicit `{ "items": [] }`. Null means the source cannot provide a list. The browser displays the newest dated snapshot from the cottage and activity response. Missing dates remain unavailable. Lists are limited to 100 entries, with 500-character text previews and an optional `truncated` marker.

The bundled parser accepts structured `TodoWrite` and `update_plan` inputs, Codex `todo_list` records, and explicitly supplied plan arrays. AutoHub supplies saved `todo` checkpoints, structured timeline records, or `GET /v1/tasks/:id/todo`. Flattened timeline descriptions and assistant prose are never reconstructed into checklists. `/activity.todos` describes the latest retained snapshot independently of forward or older-event pagination.

### Conversations

E near a resident, clicking the resident, or the **Talk to agent** button opens their recorded activity and message composer. The greeting is locally synthesized nonspeech, enabled only with sound. No response or reasoning is fabricated. Drafts are kept in page memory per feed/cottage/task and preserved during refreshes; they are not saved across page reloads.

Observing an agent does not imply permission or capability to steer it. A message-capable feed explicitly supplies:

```json
{
  "available": true,
  "mode": "redirect",
  "messageUrl": "/agents/bolt-1/messages",
  "source": "autohub",
  "checkedAt": 1789387200000
}
```

`mode` is `redirect` for guidance to a running agent, or `respond` for a task waiting for input. `taskId` is required. Capability checks expire after two minutes; stale feeds disable sending. `messageUrl` resolves against the connected feed URL and must share its origin. Unavailable connections supply `{ "available": false, "reason": "…" }`. Legacy feeds need no changes to remain useful.

Only an explicit form submission sends:

```text
POST /agents/:id/messages
Content-Type: application/json
X-CottageCode-Request: user-message

{"taskId":"task-42","message":"Please explain the API tradeoffs.","requestId":"unique-request-id"}
```

Messages contain 1–8,000 characters. Request IDs contain 8–100 letters, digits, hyphens, or underscores. The browser uses a fresh UUID per message. A successful response is `{ "ok": true, "delivery": "submitted" | "accepted", "requestId": "…" }`; submission to a terminal is distinct from an agent answering. Responses stream through the existing activity source when available. Errors may return `delivery: "not_sent"` for a definite rejection or `"unconfirmed"` when a write may have happened. Neither the browser nor bundled service retries uncertain delivery automatically.

The bundled server derives targets from its own Hub database snapshot, then verifies `GET /v1/tasks/:id` immediately before sending. It uses `/redirect` only for known logical tasks running in a supported tmux transport, and `/respond` only for logical tasks waiting for input. AutoHub retains its authorization checks. The interface does not redirect direct sessions, dispatch new tasks, or resume completed work. A reply may resume the existing waiting task through AutoHub's normal response handler.

Bundled message writes require a loopback socket connection, a matching browser Origin and an IP-address or `localhost` host, plus the JSON/header contract above. Binding the viewer to `0.0.0.0` does not grant remote clients messaging authority. Cross-origin viewing remains supported; sending to the bundled adapter requires opening CottageCode locally at that adapter's origin. Custom remote message routes must provide their own authentication, authorization, idempotency, and CORS policy; the browser sends no cookies or credentials to them. The bundled bearer token stays server-side.

The service appends a durable request reservation before contacting AutoHub. Its local ledger stores a request ID, SHA-256 target/message hash, timestamp, and outcome, without message text or credentials. Reusing a request ID returns the recorded outcome; a reservation with no final outcome is unconfirmed and cannot repeat the write, including after restart. An unreadable ledger fails before sending. The default ledger is private to this local service; do not share it among concurrent service processes.

### Pull requests

Old `{ "number", "url", "title", "state" }` objects continue to work. Omitting `pr` means **unknown**. Explicit `{ "state": "none" }` means a confirmed absence. A PR mentioned in prose provides a possible identity only; even the word "merged" does not establish its state.

| Field | Type | Meaning |
|---|---|---|
| `number` | number \| null | Positive PR number. |
| `url` | string | Absolute HTTP(S) `/owner/repo/pull/number` link. |
| `title` | string | PR title. |
| `state` | string | `none`, `open`, `merged`, `closed`, or `unknown`. |
| `reviewState` | string | `active`, `waiting-codex`, `waiting-ci`, `blocked`, `ready`, or `unknown`. |
| `labels` | array | Real label strings or `{ "name": "babysit:active" }` objects. |
| `headSha` | string | Currently observed PR head. |
| `reviewedHeadSha` | string | Head covered by recorded review/finalization evidence. |
| `source` | string | Evidence source, such as `github`, `finalization`, or the feed's own adapter name. |
| `checkedAt` | number \| null | Time the evidence was actually checked. Refresh it only after a successful check. |
| `stale` | boolean | Evidence is out of date or its source failed. |
| `reason` | string | Short explanation of uncertainty or failure. |
| `isDraft` | boolean | A draft cannot be ready to merge. |
| `repo` | string | Optional `owner/repo` identity when a number is known but no URL is supplied. |
| `finalization` | object | Optional structured receipt, described below. |

The dispatch stand and filters use these stages:

| Stage | Evidence |
|---|---|
| `none` | Explicit absence of a PR |
| `open` | Open PR without a babysit stage |
| `active` | `babysit:active` |
| `waiting-codex` | `babysit:waiting-codex` |
| `waiting-ci` | `babysit:waiting-ci` |
| `blocked` | `babysit:blocked` |
| `ready` | Fresh, consistent readiness evidence for the current head |
| `merged` | Structured or live merged state |
| `closed` | Closed without merging |
| `unknown` | Missing, contradictory, or unverified state |

Exactly one recognized `babysit:*` label may describe the review stage. Multiple or unrecognized babysit labels make that stage unknown. Ready requires a current head and a verification time no more than 2 minutes old. Stale/future evidence, a draft, conflicting fields, or a known head change prevent readiness. Other stale states remain visible with their freshness marked.

A structured `finalization` receipt may provide `status`, `terminalLabel`, `pullRequestNumber`, `pullRequestUrl`, `branchHeadSha`, and `checkedAt`. `branchHeadSha` is review evidence; it must not be copied into the currently observed `headSha`. Receipt-only readiness requires a matching current head. `status: "not_needed"` with no PR identity establishes `none`.

The bundled GitHub adapter reads actual labels and tracks the head across an observed ready-label period. A head change under an unchanged label stays unverified until new evidence resolves it. Cached `observedReadyHeadSha` records that observation, not a review it performed. Normalized output also includes derived `stage` and `reviewUncertain`; producers do not need to supply those fields.

Counts deduplicate canonical repository/PR identity across cottages and sheds. The newest observation wins; equally fresh conflicting observations count once as unknown. A number alone cannot identify a shared PR across repositories. Once observed, open PRs and known PR identities with temporarily unknown state keep their cottages visible after execution ends. Blocked PRs also create letters. Opening a parcel opens its link; the viewer never changes labels or merges.

### Relationships and handoffs

Supply connections explicitly in the envelope:

```json
{
  "relationships": [
    { "id": "hub-app", "from": "HubTown", "to": "AppTown", "label": "Application API" }
  ],
  "handoffs": [
    {
      "id": "handoff-42",
      "from": "HubTown",
      "to": "AppTown",
      "timestamp": 1789387200000,
      "agentId": "bolt-1",
      "text": "The updated API contract is ready for the app.",
      "url": "https://github.com/example/project/pull/42"
    }
  ]
}
```

Relationship `from` and `to` must match town names in the current feed. Self-links, missing towns, and repeated undirected pairs are ignored. `id` and `label` are optional; the pair supplies a stable default ID.

Handoffs require stable `id`, `from`, `to`, and an actual numeric `timestamp`. Optional `agentId`, `name`, `text`, and `url` attach the event to its cottage and artifact. Handoffs first seen within a minute of their recorded time animate a courier when both towns are present. Older events remain scrapbook entries. Activity events with `kind: "handoff"`, `from`, and `to` can also deliver handoffs. Neither roads nor handoffs are guessed from task prose.

### Interiors and browser history

The room and resident seed uses cottage `id` plus explicit `taskId`. Changing activity, cost, or timestamps leaves the room intact. Without task identity, the cottage keeps its seed. Town slots stay stable as feed entries arrive; larger towns gain annexes.

Known themes map HubTown to `hub`, AppTown to `app`, MemTown to `memory`, and VaultTown to `vault`. `interiorTheme` can select one explicitly; unrecognized values use `neutral`. Every layout keeps the request, clock, workbench, review desk, shelves, and exit available through direct controls as well as movement.

Themes decorate the whole room: AppTown has device racks, computers and phones; MemTown fills available wall spans with bookshelves; VaultTown has a collection of clocks, locks and repair tools. These decorations keep the authored walking routes and operational object positions intact.

Walking across a door threshold enters or exits automatically. E talks to a nearby host or inspects an object. The review desk's light, symbol, and label update from the same conservative PR classifier as the outdoor dispatch stand; stale readiness never receives a gold light. These activity changes never reseed the room.

The noticeboard and scrapbook use browser `localStorage`, separated by feed endpoint and demo mode. They retain the latest 1,600 milestones and bounded last-observed task/PR states. A return visit compares the new snapshot to saved observations and timestamps changes when they are observed. First observations do not invent past task completions or review transitions. If storage is unavailable, recording continues in memory for that page.

Replay steps through recorded milestones and highlights their cottages. It does not reconstruct activity from before observation began, beyond retained history, or while the page was absent. Original source timestamps remain available in the activity journal when the source supplies them.

## Bundled service configuration

| Variable | Default | Behavior |
|---|---|---|
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Directory scanned for local session JSONL. |
| `AGENT_DB_PATH` | Unset | Optional readonly SQLite database containing `agent_runs`. |
| `AGENT_STALE_THRESHOLD_MS` | `900000` | Hub running-task inactivity threshold, in milliseconds. |
| `COTTAGE_GITHUB` | Enabled | Set to `0` to disable GitHub enrichment. |
| `COTTAGE_HUB_URL` | Unset | AutoHub API base URL, optionally ending in `/v1`. Reads timelines/checklists and enables supported user-submitted task messages. |
| `COTTAGE_HUB_TOKEN` | Unset | Optional server-side bearer token for Hub requests. Never returned to the browser. |
| `COTTAGE_MESSAGE_LEDGER` | `~/.cottagecode/message-receipts.jsonl` | Private local request hashes and delivery outcomes, used to prevent duplicate writes. |

GitHub enrichment uses the authenticated local `gh` CLI with read-only `pr view`, `pr list`, and `repo view` calls. It accepts an explicit GitHub.com PR link or exact repository/number. Branch discovery requires an exact repository and a non-default branch with one unambiguous same-repository PR match. The local adapter can resolve `owner/repo` from a worktree's GitHub `origin`; town names never supply repository identity.

GitHub requests run in the background, at most 3 at a time, with a 30-second refresh interval and failure backoff from 30 seconds to 5 minutes. Failed refreshes retain old observations marked stale. Cold snapshots can contain unknown PRs while those queries finish. Existing custom JSON feeds provide their own PR metadata; the browser does not run `gh` against them.

The optional Hub reader fetches `GET /v1/tasks/:id/timeline`, converts public event kinds, and maintains a bounded cache for forward polling. Local transcript activity takes precedence. A missing or failed timeline remains explicitly unavailable/stale.

```bash
npm start
node src/feed.mjs --host 127.0.0.1 --port 8787 --window 24h
node src/feed.mjs --once > snapshot.json
npm test
```

`--window` accepts `m`, `h`, or `d` and defaults to `12h`. `--once` prints the initial agents array. `--debug` logs the snapshot at server startup.

## Status → townmap

| Status | On the map |
|---|---|
| `working` | Chimney smoke. Villager at the bench. |
| `idle` | Quiet cottage. Villager pacing. |
| `blocked` | Red `!`. Counts as a letter if still live. |
| `done` | Green check. Ages toward settled unless a PR is outstanding. |
| `offline` | Greyed out. Usually settled / hidden; an outstanding PR retains its cottage. |

## Towns

Towns are project / workspace labels, not role lanes.

- Known stems in this repo: `autohub` → HubTown, `automem` → MemTown, `wp-fusion` → FusionTown, `autoapp` → AppTown, `autovault` → VaultTown.
- Anything else becomes `{PascalCaseBasename}Town`.
- Homedir-only / username-only paths fold into HubTown so they do not become `JgarturoTown`.

Your feed can set `town` explicitly and skip all of that.

## Tiny example feed

Save the JSON below as `agents.json`, then serve it with CORS (Python's
`http.server` will not work cross-origin from `:8787`):

```bash
# from the directory that contains agents.json
npx --yes http-server . -p 9999 --cors
# open CottageCode, connect http://127.0.0.1:9999/agents.json
```

```json
{
  "source": "example",
  "agents": [
    {
      "id": "1",
      "name": "Bolt",
      "town": "HubTown",
      "status": "working",
      "task": "refactor webhook queue",
      "model": "sonnet",
      "branch": "feat/settings",
      "cost": 0.27,
      "tokens": 30935
    },
    {
      "id": "1a",
      "name": "Bolt-1",
      "town": "HubTown",
      "status": "blocked",
      "parent": "1",
      "task": "shed of Bolt",
      "attention": "! rate limited by upstream (429)",
      "model": "haiku"
    }
  ]
}
```

**Pause feed** stops browser refreshes and the demo simulator. It never writes back to the feed or pauses real agents. Walking and direct inspector controls remain available.
