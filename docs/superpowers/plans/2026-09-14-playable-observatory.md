# Playable Observatory Implementation Plan

**Goal:** Implement the approved three-slice design in this task.

**Architecture:** Shared pure modules normalize PR data, generate interiors, and manage stable world/history state. The existing pixel renderer remains the town exterior; native browser modules add the playable scene, journals, sound, and scrapbook. The Node process serves modules and optional incremental activity endpoints.

**Tech stack:** Node >=22.13, native ES modules, Canvas 2D, Web Audio, browser storage, node:test. No runtime dependencies.

## Global constraints

- Product CottageCode; project → town; agent → cottage; smoke → working.
- Read-only external integrations. No GitHub writes, merges, or agent control.
- Explicit task identity seeds variety; missing identity stays stable.
- Missing/stale data stays distinguishable from known operational state.
- Existing JSON feeds and bare arrays remain supported.
- Sound opt-in; reduced motion and direct keyboard/button access.

## Ownership and interfaces

1. Feed worker owns src/feed.mjs, src/hub.mjs, src/transcripts.mjs, src/activity.mjs and their tests. Add originalAsk, taskId, taskStartedAt, sessionStartedAt, activityUrl and stable activity events {id,timestamp,kind,text,url?}. GET /agents/:id/activity supports after and before cursors and returns {events,source,hasMore,cursor}. It imports enrichAgents from src/github.mjs, and serves safe /modules/*.mjs modules.
2. PR worker owns src/pr.mjs, src/github.mjs, src/occupancy.mjs and their tests. Exports normalizePr(pr,now), prStage(pr,now), prKey(pr), prCounts(agents,now), hasOutstandingPr(agent,now); github exports async enrichAgents(agents) and a testable adapter. Output pr fields retain number,url,title,state and add reviewState,labels,headSha,reviewedHeadSha,source,checkedAt,stale,reason.
3. Interior worker owns src/interiors.mjs and test/interiors.test.mjs. Exports createInterior(agent) → {seed,width,height,door,objects,resident,theme}, isWalkable(room,x,y), renderInterior(ctx,room,{time,agent,player,selectedObject,reduce}), renderResident(ctx,x,y,resident,{time,walking,scale}). Coordinates are world pixels within a 240×176 room; objects carry id,label,x,y,w,h,solid. Required ids: request,clock,workbench,review,shelf,exit.
4. Parent owns src/town.html, src/world.mjs, src/history.mjs, src/sound.mjs, browser scene/controller modules, docs, package.json, and integration tests. Imports all interfaces above; no workers change town.html.

## Execution checklist

- [x] Add pure behavior tests and implement feed/PR/interior modules in parallel.
- [x] Integrate the data contract into the current map and demo; preserve last snapshot on error.
- [x] Add stable world positions, movement/collision, roof transition, room interaction, journal, and PR dispatch stands/filtering.
- [x] Add pond/wildlife interaction, opt-in proximity audio, apprenticeship, explicit roads/couriers.
- [x] Add follow bench, since-visit noticeboard, persisted milestone scrapbook and bounded recorded replay.
- [x] Document contract, usage, configuration, controls, and limitations.
- [x] Run node --test, syntax checks, real HTTP smoke and browser journeys on demo and live.
- [x] Inspect responsive/reduced-motion/keyboard paths; resolve failures before completion.

## Verification ledger

| Concern | Evidence required | Owner |
|---|---|---|
| Original ask and clocks | Transcript fixture tests, live feed field inspection | Feed |
| PR certainty and occupancy | State/head/freshness tests; GitHub read-only smoke | PR |
| Procedural reachability | Multi-seed reachability and reproducibility tests | Interior |
| Walking and data refresh | Browser position assertion, enter/exit journey | Parent |
| Wildlife, audio, history | Browser interactions plus pure event tests | Parent |

## Integrated evidence

The optional `npm run test:browser` script uses Browser Hand with real Chrome and a temporary local fixture feed. It verifies walking and direct entry, request inspection, incremental and older journal pages with scroll preservation, shared PR counts, stale snapshots and HTTP failure recovery, task-specific room/journal resets, stable plots on arrivals, apprentice/courier events, duck flight into water, follow benches, opt-in sound, noticeboard/replay, a 390px iframe viewport, and changing feeds while indoors. Its reduced-motion check emulates the preference before scene modules boot; it does not change the operating system's setting.

The live service at `127.0.0.1:8787` was restarted and inspected through HTTP and Chrome. It exposed 13 cottages, 12 original requests, 13 session clocks, incremental transcript activity, and GitHub-backed merged/ready/none/unknown observations. Test fixtures and screenshots contain demo data; raw screenshots are not committed.

The final art pass incorporates Jack's stronger room accents: device-filled AppTown, a library-like MemTown, and a clock-and-lock repair shop in VaultTown. Existing floor plans, task seeds and interaction targets remain stable.

Final verification: 73 Node tests pass, all 15 source modules pass syntax checks, and the complete real-Chrome journey passes after the art changes. AppTown, MemTown and VaultTown were also inspected visually in the running demo. The generated-room checks cover 160 seeds, operational reachability and frozen ambient rendering under reduced motion.
