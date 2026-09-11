# Cottage feed (GET /agents)

CottageCode is a viewer. Point the connect box at any URL that returns cottages as JSON. The bundled `npm start` process serves that shape at `/agents`, and also has Optional local adapters (Claude Code transcripts, and a readonly sqlite
`agent_runs` table when `AGENT_DB_PATH` is set). You do not need those adapters. A static JSON file behind a tiny HTTP server is enough.

## Envelope

Either of these works:

```json
{ "agents": [ /* cottages */ ], "source": "my-runner" }
```

```json
[ /* cottages */ ]
```

Optional envelope fields the townmap understands:

| Field | Type | Notes |
|---|---|---|
| `agents` | array | Preferred. Bare array is also fine. |
| `source` | string | Shown in the feed note (`live. 12 cottages (my-runner)`). |
| `live` / `settled` / `letters` / `liveCost` | number | Optional stats. The UI recomputes occupancy if you omit them. |

CORS: the browser fetches the URL you type. Serve `Access-Control-Allow-Origin: *` (or your CottageCode origin) if the feed is on another host.

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
| `occupancy` | string | `live` `recent` `settled`. Hide settled cottages unless the toggle is on. |
| `parent` | string \| null | Id of the parent cottage. Kids render as sheds in the yard. |
| `task` | string | What it's doing. |
| `activity` | string | Short live line under the status chip. |
| `worktree` | string | Short worktree / checkout label. |
| `worktreePath` | string | Absolute path. Enables "open worktree" / copy path. |
| `branch` | string | Shown on the branch post under the house. |
| `result` | string | Final summary when done. |
| `lastLine` | string | Latest log line / thought bubble fodder. |
| `attention` | string | Why it's blocked. Shows up in Jack's letter pile. |
| `handoffUrl` | string | Optional https handoff link. |
| `model` | string | `opus` `sonnet` `haiku` `gpt` `local` `mlx` (or a string containing those). Roof flag color. |
| `dispatchedBy` | string | Who sent it. |
| `startedAt` | number | Epoch ms. |
| `endedAt` | number | Epoch ms. |
| `updatedAt` | number | Epoch ms. |
| `tokens` | number | |
| `cost` | number | USD for this run. |
| `pr` | object | `{ "number", "url", "title", "state" }` where `state` is `none` \| `open` \| `merged`. |

## Status → townmap

| Status | On the map |
|---|---|
| `working` | Chimney smoke. Villager at the bench. |
| `idle` | Quiet cottage. Villager pacing. |
| `blocked` | Red `!`. Counts as a letter if still live. |
| `done` | Green check. Ages toward settled. |
| `offline` | Greyed out. Usually settled / hidden. |

## Towns

Towns are project / workspace labels, not role lanes.

- Known stems in this repo: `autohub` → HubTown, `automem` → MemTown, `wp-fusion` → FusionTown, `autoapp` → AppTown, `autovault` → VaultTown.
- Anything else becomes `{PascalCaseBasename}Town`.
- Homedir-only / username-only paths fold into HubTown so they do not become `JgarturoTown`.

Your feed can set `town` explicitly and skip all of that.

## Tiny example feed

```bash
# serve a static snapshot
python3 -m http.server 9999 --directory .
# open CottageCode, connect http://localhost:9999/agents.json
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

Pause / wake / shut down in the panel are simulator-only. They never write back to your feed.
