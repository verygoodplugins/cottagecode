# AGENTS.md

Guide for coding tools in this repo. Humans: start at [README.md](README.md).

CottageCode is a zero-dependency Node townmap for agent fleets. The browser
renders pixel cottages; a tiny local HTTP process serves the page and
`GET /agents`. Autohub is an optional adapter, not the product.

## Commands

```bash
npm start                 # http://127.0.0.1:8787
npm test                  # Node test runner, no install step
npm run test:browser      # Real Chrome journey; requires Browser Hand
npm run test:ambience     # Music, light, and postcards in real Chrome
node src/feed.mjs --once  # print one /agents snapshot as JSON
node src/feed.mjs --host 0.0.0.0 --port 8787
```

Demo town only: open `http://127.0.0.1:8787/?demo=1`.

Run focused `node --test test/<module>.test.mjs` checks while working, then
`npm test` before completion. Browser smoke: hit `/agents`, open `/?demo=1`,
walk into a cottage, inspect its request/journal/PR desk, exit, and startle a
duck. Check direct inspector controls, the connect box, and stale-feed recovery.

## Architecture

| File | Role |
|---|---|
| `src/town.html` | Page structure and styles |
| `src/town.mjs` | Exterior pixel renderer, demo simulator, feed polling |
| `src/observatory.mjs` | Walking, interiors, inspector, journals, filters, wildlife interactions |
| `src/interiors.mjs` / `src/world.mjs` | Seeded rooms/residents, walkability, stable plots, explicit paths/handoffs |
| `src/feed-client.mjs` | Browser feed normalization and incremental activity merging |
| `src/interaction.mjs` / `src/conversation.mjs` | Door crossings and browser message capability checks |
| `src/feed.mjs` | HTTP server, snapshot cache, adapter integration, activity routes |
| `src/transcripts.mjs` / `src/activity.mjs` | Incremental transcript parsing and public activity; optional Hub timeline |
| `src/hub.mjs` | Optional readonly sqlite `agent_runs` adapter |
| `src/todos.mjs` / `src/messages.mjs` | Explicit checklist snapshots and user-submitted AutoHub messages |
| `src/pr.mjs` / `src/github.mjs` | Shared PR classifier/counts and cached read-only GitHub observations |
| `src/occupancy.mjs` | live / recent / settled, letters, conservative PR identity inference |
| `src/history.mjs` / `src/sound.mjs` | Bounded browser-local milestones/replay and opt-in Web Audio |
| `src/village-extras.mjs` / `src/atmosphere.mjs` | Gramophone controls, local-clock light, fireflies and postcard dialog |
| `src/music.mjs` / `src/music-output.mjs` | Opt-in music lifecycle, crossfades and quiet native media output |
| `src/music-tracks.mjs` / `src/audio/` | Static soundtrack catalog and bundled MP3s |
| `src/postcard.mjs` | Local PNG rendering with one deliberately selected milestone |
| `src/towns.mjs` | `{Stem}Town` naming |

Public contract: [`docs/COTTAGE_FEED.md`](docs/COTTAGE_FEED.md). Prefer documenting
and accepting that JSON shape over teaching callers about Autohub internals.

Keep task identity and task start separate from session identity and session
start. Missing data stays unavailable. Preserve genuine requests separately
from assistant updates; never export raw private thinking blocks. A missing PR
is unknown, not confirmed none. Shared PRs count once, and stale or conflicting
evidence cannot show ready. GitHub and transcript adapters remain read-only.
Task writes require an explicit user Send through a supported messaging route;
never send autonomous test messages to real agents. Recheck identity, status,
and transport before sending. Preserve receipt deduplication across restarts;
uncertain delivery must not be retried automatically. Todo lists come only from
structured snapshots, never prose inference.

Seed interiors from stable cottage/task identity. Feed updates must preserve
visited rooms and cottage positions. Only explicit relationships and recorded
handoffs create paths and couriers. Sound starts off. Scrapbook replay is limited
to locally observed history. Walk into doors to enter/leave; E talks to a nearby
resident or inspects an object. Direct buttons and Escape remain available.

Music is independent of sound effects and starts off on every load. The village
clock uses device-local time; musical location follows Jack, not the selected
inspector. Generation is a manual authoring step, never a browser/build request.
The public sample ships only static assets; keep its live API connections
disabled. Postcards default to scenery, with explicit opt-in for a recorded note.

Naming lock (also in `.cursor/rules/naming.mdc`):

- Product / tab / package: **CottageCode**
- Atlas view: **Townmap** (not a second logo)
- Saved project → town (`HubTown`, `MemTown`, … or `{Stem}Town`)
- Agent → cottage; smoke = working; sheds = spawned kids; `!` = blocked

## Docs screenshots

Keep README images sparse and under ~1MB total. Prefer `docs/img/` optimized
PNGs from the docs-screenshot-packager skill. Demo captures use `/?demo=1` so
live hub data never lands in the README.

## Do not

- Rewrite the pixel renderer in React on day one
- Hash unknown repos into four aesthetic role lanes
- Commit raw/proof screenshots or secrets
- Hand-edit AutoVault-signed skill copies
