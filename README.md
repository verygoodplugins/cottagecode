# 🏘️ CottageCode · v0.1.0

> **A pixel town for your agents.** Each cottage is one agent. Chimney smoke means it's working. Sheds are the ones it spawned.

![CottageCode demo townmap with several towns of cottages and Bolt selected as working](docs/img/townmap-overview.png)

CottageCode is a local townmap for agent fleets. Walk up to a cottage, lift its roof, and inspect the work inside. A pinned note holds the original request, the clock separates task and session time, and the workbench shows the agent's activity journal.

Point it at any URL that returns cottages as JSON, or explore the built-in demo. Projects become towns (`HubTown`, `MemTown`, or `{Stem}Town` from a folder name). Townmap is the atlas view.

**[Visit the public sample village](https://autojack.ai/cottagecode/)** — walk,
explore, and try a practice reply with fictional residents. It is a static,
browser-only build: live feeds, task routes, and private local data are
disabled, and practice replies affect only that sample village in your browser.
[Build or publish your own demo](docs/PUBLIC_DEMO.md).

Zero npm dependencies. Pixel canvas, native browser modules, and a small Node server.

<p align="center">
  <img src="docs/img/chimney-smoke.gif" alt="Bolt cottage with chimney smoke while working" width="220" />
</p>

## 🏃 Quick start

Node 22.13+.

```bash
git clone https://github.com/verygoodplugins/cottagecode.git
cd cottagecode
npm start
```

Open [http://localhost:8787](http://localhost:8787). For the built-in demo town only: [http://localhost:8787/?demo=1](http://localhost:8787/?demo=1).

Run the Node suite with `npm test`. The optional real-Chrome journeys need the
Browser Hand CLI and its Chrome extension:

```bash
npm run test:browser   # walking, rooms, PR desk, activity, input, and recovery
npm run test:ambience  # gramophone, light, and locally rendered postcards
npm run test:night     # night palette, bedtime scenery, and visiting a host
```

## 🚪 Visit a cottage

Click the map to give it keyboard focus.

| Control | Action |
|---|---|
| Arrow keys or WASD | Walk around town or inside a cottage |
| Walk into a doorway | Enter the cottage or walk back outside; no interaction key needed |
| E or Enter | Talk to a nearby agent, or use a bench, noticeboard, gramophone, or room object |
| Escape | Leave the cottage or bench while the map has focus |
| Click a cottage or its roster button | Open its inspector without walking there |
| Enter cottage / Leave cottage | Visit or exit using buttons |
| Click a resident / Talk to agent | Open their conversation and recorded activity |
| Click a room object or inspector tab | Read the request, clock, journal, to-do list, PR desk, or shelves |
| Click a parcel | Open its PR when a URL is available |

Rooms and residents are generated from cottage and task identity. Return visits keep the furniture in place. A new explicit task gets a new home. HubTown sets the cozy base with switchboards and pigeonholes. AppTown fills its desks with computers, phones and charging leads. MemTown lines its walls with bookshelves. VaultTown is a clock-and-lock repair shop, with pendulums, key racks and scattered repair tools. Unknown projects get neutral homes.

Walk near a duck and it'll head for the pond. Cats and a goose roam too. **Sound starts off.** Enable it for footsteps, doors, a little wordless murmur when you talk to a resident, and status alerts, with separate ambience and alert switches. Reduced-motion preferences are respected.

The **gramophone** plays seven original, quiet low-bit instrumental pieces made
with ElevenLabs. Music starts off independently of sound effects. It follows
your local clock and Jack's position in the village, with daytime accents for
AppTown, MemTown, and VaultTown. Interiors soften it; conversations hush it;
leaving the tab pauses it. Open **Gramophone & light** to set the volume or
preview morning, day, dusk, and night. Warm windows and fireflies follow the
same clock. No geographic location is requested. [Soundtrack and credits](docs/MUSIC.md).

Dusk and night use a desaturated, Game Boy Color-inspired blue palette. From
18:30, residents gather their recorded child agents and chickens before bed;
nonworking hosts sleep while working hosts remain at the bench. This is visual
scenery only: it never changes task status or prevents you from visiting or
talking to a resident.

**Make a postcard** in any cottage's inspector previews a PNG of its seeded
interior and resident. It starts with no work details. You can choose one
recorded milestone, review the picture, and save it. The image is made locally
in the browser and is never uploaded by CottageCode.

The PR desk has a changing status light, icon, and label. The **To-do** tab displays explicit task checklists when available; it never guesses a plan from progress prose. **Talk to agent** shows emitted updates alongside a message composer. Drafts and journal position survive feed refreshes. Messages require a supported connection and an explicit **Send**; unsupported sessions explain why sending is unavailable.

When an agent needs input, talking reveals the actual question, choices, or
permission details supplied by its source. Choices fill a reply for you to
review and send. New questions get separate drafts, and the service checks the
question is still current before delivering an answer. Transcript-only sessions
show the request but must be answered in their original session; connected
AutoHub tasks use their existing response route. Normal completed turns are idle
and no longer create false input alerts.

Use **Follow from bench** to keep one cottage selected as its work updates. The noticeboard lists changes observed since the previous visit. The scrapbook stores up to 1,600 milestones per feed in this browser, including result snippets and artifact links. Replay steps through that recorded history; it cannot reconstruct unobserved work or expired source logs.

## 🔌 Cottage feed

`npm start` serves the townmap and `GET /agents`. The connect box defaults to that URL. Drop in any other endpoint that speaks the [cottage feed](docs/COTTAGE_FEED.md) shape.

Minimum cottage:

```json
{
  "id": "bolt-1",
  "name": "Bolt",
  "town": "HubTown",
  "status": "working",
  "task": "bump deps + run suite"
}
```

Statuses the map understands: `working` · `idle` · `blocked` · `done` · `offline`.

| Status | On the map |
|---|---|
| working | chimney smoke |
| idle | quiet house |
| blocked | red `!` (and a letter for you) |
| done | green check, then ages out unless a PR is outstanding |
| offline | grey / settled unless a PR is outstanding |

Roof flags: opus · sonnet · haiku · gpt · local · mlx.

Optional fields add task identity, the original request, timestamps, activity, worktrees, PR evidence, cost, tokens, and artifacts. Explicit project relationships draw signed paths. Recorded handoffs send couriers between towns. Full schema and examples: [`docs/COTTAGE_FEED.md`](docs/COTTAGE_FEED.md).

![Jack's letter pile listing blocked cottages](docs/img/letters-queue.png)

**Pause feed** freezes browser refreshes and the demo simulator. It does not pause real agents. PR operations stay in the existing workflow. The only task write is a message you explicitly send through a supported connection.

## 🧰 Bundled adapters

The local process can also populate `/agents` without you writing a server:

1. Readonly SQLite at `AGENT_DB_PATH` (an `agent_runs` table), if set
2. Claude Code session JSONL under `~/.claude/projects` (or `CLAUDE_PROJECTS_DIR`)
3. Cached, read-only GitHub metadata through an authenticated `gh` CLI

The bundled empty feed opens the demo until local cottages appear. `/?demo=1` selects the demo directly. Custom feeds can return an empty array as a valid live snapshot.

Activity comes from local transcripts first. Set `COTTAGE_HUB_URL` to read AutoHub's task timeline when local activity is unavailable, and `COTTAGE_HUB_TOKEN` if that server requires a bearer token. The token stays in the Node process. Journals expose emitted progress summaries, tool labels, and result previews. Raw private thinking blocks are excluded.

With `AGENT_DB_PATH` and `COTTAGE_HUB_URL` configured, supported AutoHub tasks also accept typed guidance while running in tmux, or replies while waiting for input. Each send rechecks the actual task first. Direct sessions do not accept mid-task redirection; transcript-only cottages and completed tasks have no message route. AutoHub may resume an existing waiting task after your reply. Delivery receipts distinguish submission from an agent answer; uncertain sends are never automatically retried. The local receipt ledger stores request hashes and outcomes, without message text or credentials.

GitHub observations refresh in the background every 30 seconds, with bounded concurrency and backoff on failure. PR identity comes from an explicit link or an unambiguous repository and non-default branch. Missing access stays unknown. Set `COTTAGE_GITHUB=0` to disable GitHub queries.

```bash
# bind / port / snapshot
node src/feed.mjs --host 0.0.0.0 --port 8787
node src/feed.mjs --window 24h
node src/feed.mjs --once > snapshot.json
COTTAGE_GITHUB=0 npm start
```

Feed failures retain the last snapshot and mark it stale. Reconnecting restores live observations.

## 🗺️ Legend

| Pixel | Meaning |
|---|---|
| smoke | working |
| `!` | blocked, needs you |
| shed | spawned child agent |
| dispatch stand | PR state, separate from whether the agent is working |
| mail | letters waiting on Jack's stoop |

| PR state | Meaning |
|---|---|
| No PR | Explicitly confirmed absence |
| Opened | Open PR without a babysit stage |
| Babysitting | `babysit:active` |
| Codex review | `babysit:waiting-codex` |
| Waiting CI | `babysit:waiting-ci` |
| Blocked | `babysit:blocked`, with a letter for Jack |
| Ready to merge | Fresh `babysit:ready` evidence for the current head |
| Merged / Closed | Completed merge or closed without merging |
| Unknown | Missing, conflicting, or unverified state |

PR filters count shared pull requests once. The inspector and review desk show the GitHub link, labels, CI rollup, source, verification time, head, and any uncertainty. Its lamp and symbol follow the same evidence as the outdoor parcel. Stale data or a known head change cannot declare a PR ready.

Settled cottages stay hidden until **settled (N)** is enabled. Once observed, cottages with outstanding PRs stay on the map after execution finishes.

## License

MIT. Jack Arturo / [Very Good Plugins](https://github.com/verygoodplugins).

See also [Contributing](CONTRIBUTING.md) and [Security](.github/SECURITY.md).
