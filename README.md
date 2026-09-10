# 🏘️ CottageCode · v0.1.0

> **A pixel town for your agents.** Each cottage is one agent. Chimney smoke means it's working. Sheds are the ones it spawned.

CottageCode is the product. **Townmap** is the atlas view, not a second logo. Autohub saved projects land as towns: HubTown, MemTown, FusionTown, AppTown, VaultTown. Unknown repos take `{Stem}Town` from the folder name. We do not dump strangers into four fake role lanes.

This started as a ~1500-line HTML sketch. The pixel renderer stays. No React rewrite on day one.

## 🏃 Quick Start

Node 22.13+ (uses `node:sqlite` when Autohub's db is around). Zero npm deps.

```bash
git clone https://github.com/verygoodplugins/cottagecode.git
cd cottagecode
npm start
```

Open http://localhost:8787

That's it.

## 🔌 Feeds

The page boots on a demo town so you can poke cottages without a hub. `npm start` also serves `/agents`. Connect the box to that URL (default) and the feed process will try, in order:

1. Autohub `hub-unified.db` (readonly sqlite, local process, no browser CORS / API_KEYS dance)
2. Claude Code session jsonl under `~/.claude/projects`
3. Demo town if both are empty or missing

Pause, wake, and shut down are **simulator-only**. They do not touch live Autohub agents.

## Status

Hub status maps onto the town like this.

| Hub | Townmap |
|---|---|
| running | working (smoke) |
| pending, queued | idle |
| awaiting_input, needs_input, awaiting_review | blocked (`!`) |
| completed | done, then ages to offline |
| failed / cancelled / interrupted | blocked if it needs you, else done |
| stale, archived, old completed | offline |

Roof flags start at opus / sonnet / haiku and grow when gpt, local, or mlx show up.

## License

MIT. Jack Arturo / Very Good Plugins.
