# A command center that still feels like CottageCode

2026-11-04 · local exploration · branch `feat/command-center-lab`

## Recommendation

Keep the town. Give it a working attention desk and an evidence ledger. Three perspectives should be three ways of looking at the same work, with selection preserved: Townwatch for recognition, Dispatch for deciding, Threads for understanding relationships. A person should be able to answer a current question or inspect a PR without walking anywhere.

The first production increment should be the attention strip, readable task titles, independent task/session clocks, and the selected-cottage evidence drawer. Fold the useful parts of these prototypes into the existing renderer. Keep the original village interactions, rather than replacing the whole product with a table.

## What belongs in sight

| Question | At a glance | On focus or click |
| --- | --- | --- |
| What needs me? | Unanswered-input count, precise attention symbol | Exact source question, age, choices, owner and supported reply route |
| What can ship? | Unique ready PR count | Source state, current/reviewed head, CI, review, remaining manual verification and dependency evidence |
| Is anything stuck? | Explicit blocked state; separately a quiet-progress hint | Last real progress, active tool/wait, heartbeat health, expected next event; unknown when not instrumented |
| What is it doing? | Short meaningful task title and latest public action | Original ask, public journal, structured checklist |
| How long? | Time lens | Separate task age, session age, recorded duration and observation freshness |
| Who owns this? | Harness name/mark when supplied | Controller/orchestrator, full provider/model, parent and exact source destination |
| What work is this part of? | Selected connections | Issue, planned work item, attempts, related PR stack and required landing order |
| What changed while I was away? | Locally observed transition count | Bounded since-last-visit digest; never invented historical progress |

Counts are scoped and labelled. PR counts deduplicate shared identities. Current execution, pending input, PR readiness and telemetry freshness remain independent: an agent can be idle while its PR waits on CI; a working agent can have a question on a separate attempt; a finished response does not make an issue complete.

## A visual language with one job per signal

- Windows and smoke indicate working execution. Night scenery never changes source state.
- A letter/diamond identifies a recorded input or attention report. Reading it is not resolving it.
- A parcel/PR badge shows delivery state independently of execution. Mint means canonical ready; coral means blocked; lavender means review; a hollow shape means unknown.
- Harness is a neutral monogram/wordmark. Do not consume the warning colours to distinguish models.
- Time appears on demand. Separate “task 42m”, “session 2h”, “observed 8s ago” and “progress 6m ago”. An observation heartbeat cannot reset the progress clock.
- Motion celebrates actual transitions and helps locate selection. Polling is silent. No persistent flashing, no racing timer labels, and reduced-motion users get the same information.
- Connections appear only around the selected work, and only for recorded relationships. Town positions stay stable across lens changes.

## Your actual workflow changes the design

The merged AutoHub Todoist work explicitly keeps intentionally planned tasks on the AutoJack Tasks board and non-board dispatches in mission control. CottageCode should join their evidence when a relationship exists. It should not manufacture a Todoist task for every cottage or become a second planning backlog. Sources: [#2393](https://github.com/verygoodplugins/autohub/pull/2393), [#2394](https://github.com/verygoodplugins/autohub/pull/2394), [#2395](https://github.com/verygoodplugins/autohub/pull/2395).

The November 3 [Pulse dataset](https://pulse.automem.ai/activity-data.json) records 2,576 commits over 25 repositories in its trailing 30-day window, versus 72 over six in its last seven days. This is a bounded set of local repos and selected authors, and commits are not outcomes. The product implication is to reduce context-switch cost across a bursty portfolio, not reward more movement with a productivity score.

Your actual issue graph already crosses task and repository boundaries. [AutoApp #320](https://github.com/verygoodplugins/AutoApp/issues/320) has a [foundation PR](https://github.com/verygoodplugins/AutoApp/pull/464) and a [dependent fix](https://github.com/verygoodplugins/AutoApp/pull/465); the foundation alone does not resolve the issue. [AutoMem evals #78](https://github.com/verygoodplugins/automem-evals/pull/78) verifies [AutoMem #273](https://github.com/verygoodplugins/automem/pull/273). These are reasons to model explicit edges, rather than drawing attractive but guessed lines between cottages.

Recent chat summaries also include repeated nightly runs, decision holds and physical-device verification. Eventually the feed should supply a durable workflow/work-item id so repeated runs can expand beneath one objective. Grouping by similar titles would hide distinct work and is not a valid substitute.

## What the current feed can and cannot promise

The initial live capture had 216 records: 37 current/recent and 179 settled. Nine records carried input requests, but only one exposed a supported response route. Some “questions” were blocker reports. The UI must show the actual text and capability reason instead of inventing a question or an enabled Answer button.

All six working records in that capture were external sessions with no explicit task start. They did have session time. Their updatedAt observations were near the latest feed refresh, so this timestamp cannot prove meaningful progress. A running timer derived from the wrong field would look reassuring while being false.

The existing model flag and red attention signal are also overloaded visually: roof pennants represent normalized model family; the raised red mailbox means a blocked task or blocked PR; the red exclamation marks have task/parcel-specific meanings. They do not detect stalls. Tooltips and explicit labels fix the immediate ambiguity, while independent state channels improve the larger system.

## Upstream additions that unlock the full experience

These are proposed additive fields, not existing capabilities:

```json
{
  "workItem": {"id": "stable-source-id", "url": "https://tracker.example/task/42", "source": "todoist"},
  "attemptId": "attempt-3",
  "harness": {"name": "codex", "provider": "openai", "model": "full-model-id", "controller": "autohub"},
  "telemetry": {
    "progressAt": "2026-11-04T10:00:00Z",
    "observedAt": "2026-11-04T10:01:00Z",
    "heartbeatAt": "2026-11-04T10:00:55Z",
    "waitingFor": {"kind": "ci", "since": "2026-11-04T09:58:00Z", "nextCheckAt": "2026-11-04T10:03:00Z"}
  },
  "sourceLinks": [{"kind": "session", "url": "https://supported-source.example/sessions/known-id"}],
  "issues": [{"url": "https://github.com/example/project/issues/42", "title": "Explicitly linked outcome"}]
}
```

Add typed relationships such as `implements`, `depends_on`, `reviews`, `verifies`, `attempt_of` and `handoff`. The producer supplies canonical source identity and provenance; the browser does not mine prose for these. A real stall classification requires source health, expected waits and meaningful-progress telemetry. No universal “15 minutes = stalled” rule is credible across coding, CI, music generation and device checks.

The reply path also needs a producer-owned contract: current question revision, supported actions, exact destination and durable receipt. The prototype retains the existing CottageCode/Hub mechanism. Native provider permissions should route to the native interface unless the provider explicitly supports remote authorization.

## What to borrow

[Anthropic's April 14 desktop redesign](https://claude.com/resources/articles/claude-code-desktop-redesign) emphasizes status/project/environment filtering, session navigation, PR lifecycle and adjustable verbosity. Borrow progressive detail, not a permanent wall of transcripts.

[cmux notifications](https://cmux.com/docs/notifications) offer persistent attention and direct navigation. Keep “seen” separate from “resolved”. Its [generic-waiting issue](https://github.com/manaflow-ai/cmux/issues/4506) captures the precise failure to avoid: an alert without identity, reason or actual question.

[Conductor's workflow](https://www.conductor.build/docs/concepts/workflow) separates workspace execution from PR integration. Treat a PR as a shared object, not property duplicated into five independent green counts.

The [Reddit Brain showcase](https://www.reddit.com/r/ClaudeCode/comments/1ww6hvj/i_run_15_claude_code_sessions_in_parallel_and/) makes oldest-wait-first triage and exact questions compelling. This is a builder's anecdote, not evidence of widespread adoption. The [official Claude hook reference](https://code.claude.com/docs/en/hooks) reinforces the important distinction: a finished response or idle notification does not establish a genuine human-input requirement.

## Deliberately outside this experiment

No automatic merges, retries, restarts, approvals or dispatches. No universal chat transport invented for providers that only expose observation. No new planning backlog. No productivity leaderboard. No inference that green CI, a closed agent turn or lively animation means an outcome safely shipped.

## Implemented exploration and acceptance

The isolated lab runs at `http://127.0.0.1:8790/`. It defaults to the existing live feed; `?view=townwatch|dispatch|threads&scenario=1` selects the visibly fictional scenario. The original app on port 8787 and its production source files are unchanged. Start commands and interaction details are in [the lab README](../experiments/command-center/README.md).

The final core suite passed 382 tests. Independent task reviews and a whole-branch Astra review completed; their findings were fixed and re-reviewed. Browser acceptance covered all three views, fixed cottage coordinates across lens changes, keyboard search and selection, PR focus previews, shared-PR counts, exact-question choices and local-only reply receipts, narrow layouts without horizontal overflow, both directions of the dependency trace, live/scenario switching, and live ready-PR filtering. Stopping and restarting only the lab server verified last-snapshot retention, an explicit outage banner, paused messaging and recovery. A temporary unsent draft survived live polling and was cleared. No live messages were sent.

Live verification exposed two lifecycle distinctions now handled explicitly: a resumed task can retain a historical end timestamp, and Hub's recorded execution duration excludes subsequent waiting. Current nonterminal state controls the live clock and reply eligibility; task age comes from the explicit task start, while recorded execution has its own drawer label. For example, the observed AutoHub #2384 task was about six days old with 22m 14s of recorded execution.

Remaining prototype limits: public journals render supplied inline events but do not yet lazily fetch the existing activity endpoint; drafts survive polling and view changes but not page reload; the responsive district grid guarantees stable lens positions and ordering, rather than the original renderer's fixed world coordinates across every viewport. The live feed currently lacks structured harness and issue relationships for these records. Those omissions remain visible instead of being inferred from model names or prose.

## Original-town integration

The next approved iteration brings attention, lenses, Dispatch and Threads into
`src/town.html` and the original canvas. The integrated preview is at
`http://127.0.0.1:8791/` (`?demo=1` for fictional data). The original process on
8787 remains running from its separate checkout. The standalone lab is retained
as design history, not the replacement home.

The shared inspector now separates the task being read from the cottage being
visited. It keeps the existing paginated journal, room objects and local demo
responses. View changes suspend movement without reseeding rooms or moving plots;
explicit spatial actions return to Townmap. Keyboard search includes names and
recorded issue links. Threads allocates only populated lanes and uses a vertical
trace where a fleet graph would be too crowded.

Verification covers actual WASD doorway entry/exit, E addressing the physical
host after inspecting another task, an approached duck swimming to its pond,
room/position preservation, suspended movement, local practice replies, live
unsent draft continuity, source-change clearing, stale messaging suppression and
recovery, PR previews, fullscreen drawer space and narrow layouts. No messages
were sent to real agents. The live feed still omits structured harness names and
issue links; the interface displays that absence.

Final integrated validation: 414 Node tests pass, including static public-demo
bundling and network restrictions. Independent task reviews and the final Astra
review are clean. Browser checks also confirmed paused-feed clock agreement,
stable native lens selectors, PR previews surviving updates, and a single
recorded PR state across map markers, lenses, lists and the drawer.
