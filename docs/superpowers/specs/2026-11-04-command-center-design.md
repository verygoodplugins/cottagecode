# CottageCode command center exploration

Date: 2026-11-04. Status: experimental, locally runnable; not a production replacement.

Jack explicitly authorized autonomous design choices, prototypes, browser experiments and worktrees. That authorization supersedes the brainstorming skill's repeated approval pauses for this exploration. Existing town on port 8787 stays available. Build one coherent experimental application on port 8790 with three inspectable perspectives, rather than three incompatible data models.

## Direction

The village is a memorable place to recognize work. Add an attention desk that makes the next human action obvious, and an evidence drawer that explains whether work can ship. Preserve charm through pixel cottages, quiet motion, warm window light, carefully composed night colours and little arrival/focus feedback. Use clean readable typography for work, not pixel text for paragraphs.

Three perspectives share search, project filter, task selection, evidence drawer and keyboard commands:

1. **Townwatch**: spatial project districts, stable cottage positions, compact task titles. Attention/Time/Delivery/Owner lenses alter labels and emphasis, never task placement. No need to walk to do operational work.
2. **Dispatch**: a fast operational list with independently readable execution, pending input, task/session age, last observation, PR state and ownership. Filters for Attention, Working, Quiet, Ready and All. Ready counts unique PR identities, not cottages.
3. **Threads**: explicit issue → task → PR relationships, selected-path emphasis, shared PR objects and dependency reasons. No guessed lines from prose/title similarity. Missing issue instrumentation is an honest empty state in live mode.

Default to the live local feed. A conspicuous **Illustrative scenario** switch exercises the richer design: actual multi-provider names, progress clocks, structured issue links, shared PR, dependency wait, exact question and a simulated reply. Every illustrative view is marked; scenario replies remain local. Live mode never falls back to invented data.

## What we learned

The initial feed snapshot has 216 records, 37 current/recent, 179 settled, nine recorded pending inputs and one supported reply route. The red mailbox means a blocked task or blocked PR; it does not detect inactivity. Some recorded inputs are terminal blocker reports rather than questions. All six working external sessions lack explicit task starts. updatedAt can reflect inventory observation, not meaningful progress. Full harness/model identity and issue edges are missing from most live records.

GitHub confirms the November 3 Todoist board PRs #2393–2395 merged. Todoist owns intentionally tracked planning; non-board Hub dispatches are intentionally not mirrored. CottageCode adds oversight, not another backlog. Pulse's November 3 dataset includes 2,576 commit records across 25 repositories over its trailing 30 days; these are bounded artifact counts, not effort or outcomes. Recurring nightly runs should eventually collapse under a stable workflow identity supplied upstream.

Anthropic's session filters and verbosity levels, cmux's attention lifecycle and jump-to-source, and Conductor's separation of agent workspaces from shared PRs inform this design. Reddit showcases support exact-question triage as a useful qualitative idea, not proven popularity.

## Data and safety constraints

- Zero dependencies. Reuse existing PR interpretation, input normalization/version and conversation-capability validation.
- Task start and session start are separate. Missing values remain unavailable. Task age includes waiting; do not call it compute time. Ended work uses endedAt/duration rather than a growing clock.
- updatedAt is an observation signal. Quiet is only a labelled heuristic from an explicit lastProgressAt/telemetry.progressAt, never from a heartbeat. Never claim a detected stall.
- Keep execution, input, review and feed freshness as separate states. Raw babysit labels do not override Hub authority or head validation.
- Stable cottage identity and coordinates across filter/lens/selection changes. Shared PR counts deduplicate canonical URL identity.
- Use only explicit relationships. Show unknown harness separately from model family; source Hub is not proof of Claude/Codex ownership.
- Live content is text, not executable HTML. Safe URL schemes only. No private thinking.
- Replies require explicit user Send and a current supported capability. Recheck exact task, question content version and route before sending. Preserve upstream durable receipt handling, locally lock uncertain sends across reload, never retry automatically. Test only stubbed transports or the illustrative scenario.
- A local development server proxies only known /agents read/activity/message routes to fixed 127.0.0.1:8787. It binds loopback, checks Origin for messages and forwards to the existing server, which remains responsible for authoritative validation and durable delivery receipts. It never exposes arbitrary proxy targets.
- No automatic messaging, merge, restart, approval, task creation or remote changes. Opening links and copying context are direct user gestures.
- No audio by default. Respect prefers-reduced-motion. Mouse, keyboard and narrow layouts must expose the same evidence.

## Interaction

The header carries live/scenario provenance and last successful refresh. A summary strip offers attention, working and ready filters. A left project rail makes the current scope explicit. Main view holds Townwatch/Dispatch/Threads; a right drawer shows selected title, exact public activity, two clocks, original request, source capability, pending input, PR checks/head/reason and recorded relationships.

PR badges open a rich preview on focus/click; hover may enhance it but is never the only route. Command/search palette via Cmd/Ctrl+K, perspectives via 1/2/3, j/k to move selection, Escape to dismiss. Do not intercept typing. Readiness is inspectable and links to the source PR; no merge button in this prototype.

For unavailable messaging show the exact supplied reason and available source links. A question is not an actionable approval simply because it is red. When no route exists, do not render an enabled composer.

## Verification and scope

Baseline: 348 Node tests passing. Add focused tests for truthful timestamps, quiet eligibility, canonical PR preservation and deduplication, explicit graph edges, proxy restrictions and reply identity/uncertainty handling. Verify all three perspectives, live/scenario switching, filters/search, PR preview, keyboard and narrow viewport in real browser. No real test messages.

This prototype demonstrates information architecture and interactions. Upstream work still needed: full harness/provider/controller identity, last meaningful progress, tool wait/heartbeat health, issue and PR-stack edges, workflow grouping and verified provider deep links. Display current gaps instead of pretending the browser can recover absent telemetry.

## Sources

- https://claude.com/resources/articles/claude-code-desktop-redesign
- https://cmux.com/docs/notifications
- https://github.com/manaflow-ai/cmux/issues/4506
- https://www.conductor.build/docs/concepts/workflow
- https://www.reddit.com/r/ClaudeCode/comments/1ww6hvj/i_run_15_claude_code_sessions_in_parallel_and/
- https://code.claude.com/docs/en/hooks
- https://pulse.automem.ai/activity-data.json
- https://github.com/verygoodplugins/autohub/pull/2393
- https://github.com/verygoodplugins/autohub/pull/2394
- https://github.com/verygoodplugins/autohub/pull/2395
- https://github.com/verygoodplugins/AutoApp/issues/320
