# AGENTS.md

Guide for coding tools in this repo. Humans: start at [README.md](README.md).

CottageCode is a zero-dependency Node townmap for agent fleets. The browser
renders pixel cottages; a tiny local HTTP process serves the page and
`GET /agents`. Autohub is an optional adapter, not the product.

## Commands

```bash
npm start                 # http://127.0.0.1:8787
node src/feed.mjs --once  # print one /agents snapshot as JSON
node src/feed.mjs --host 0.0.0.0 --port 8787
```

Demo town only: open `http://127.0.0.1:8787/?demo=1`.

There is no test suite yet. Smoke check: start the feed, hit `/agents`, open
`/?demo=1`, confirm cottages paint and the connect box still works.

## Architecture

| File | Role |
|---|---|
| `src/town.html` | Townmap UI + demo simulator + feed adapter |
| `src/feed.mjs` | HTTP server, Claude jsonl scan, `/agents` envelope |
| `src/hub.mjs` | Optional readonly sqlite `agent_runs` adapter |
| `src/occupancy.mjs` | live / recent / settled, letters, PR helpers |
| `src/towns.mjs` | `{Stem}Town` naming |

Public contract: [`docs/COTTAGE_FEED.md`](docs/COTTAGE_FEED.md). Prefer documenting
and accepting that JSON shape over teaching callers about Autohub internals.

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
