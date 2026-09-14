# CottageCode: a playable observatory

Approved by Jack on 2026-09-14. CottageCode remains a zero-dependency Node viewer and pixel canvas. Each project is a town, each agent a cottage, and smoke means working.

## Visit and understand

The map exposes PR stages independently of agent activity: no PR, opened, babysit active, waiting for Codex, waiting for CI, blocked, ready to merge, merged, closed, and unknown. Dispatch stands and deduplicated counts share one classifier. Open PRs remain visible when an agent finishes. Live labels and structured receipts provide evidence; stale/conflicting evidence cannot declare readiness. This viewer never merges or controls agents.

Arrow keys/WASD move Jack when the map is focused. Walking into doors enters and exits; E talks to nearby agents or inspects objects, and Escape also exits. Clicking and accessible controls provide the same diagnostics. Roofs lift and the camera transitions to cutaway rooms; leaving restores the doorway. Polls preserve cottage positions and interior identity. These door controls follow the user's September 15 refinement.

Every room includes the original request, separate task/session clocks, a live activity workbench, PR review desk, and artifact shelves. Display actual progress summaries, tool activity, and outcomes. Missing data is explicit. Outside bubbles use the same activity.

## Procedural homes

Generate valid walkable room footprints, furniture, plants, rugs, windows, hearths, and resident sprite parts from cottage and explicit task identity. A new task gets a fresh home/resident; revisits retain their layout. Without explicit task identity, keep the cottage identity. Known project accents: HubTown switchboards and pigeonholes; AppTown phones and sketches; MemTown books and index drawers; VaultTown keys and stamped papers. Unknown projects receive neutral homes unless metadata supplies a theme. Ambient steam, light, and pets vary without pretending to represent progress.

Jack's implementation feedback strengthens those accents across the whole room: HubTown supplies the cozy base style; AppTown becomes a device workshop with computers, phones and charging leads; MemTown fills its free walls with bookshelves; VaultTown becomes a clock-and-lock repair shop. These accents must leave the operational objects and walking routes accessible.

## A living village

Ducks react to Jack and flee into a real pond, with splashes and later return. Cats and geese have simple ambient reactions. Opt-in proximity sounds cover steps, doors, wildlife, and important state transitions. Apprentices arrive at sheds. Only explicit project relationships create signed paths; only recorded handoffs create couriers.

## Follow and remember

Benches follow one cottage. A noticeboard summarizes changes since the previous visit and jumps to their cottages. A local scrapbook records observed milestones/artifact links; replay is clearly limited to recorded history.

## Data and verification

Preserve old feed objects and bare arrays. Add optional originalAsk, taskId, taskStartedAt, sessionStartedAt, activity access, relationships, handoffs, and PR review metadata. The Node adapter incrementally reads local transcripts, optionally reads AutoHub timelines, and caches read-only GitHub queries. Feed failures retain stale live state rather than switching to demo.

Validate request/timestamp extraction, incremental events, reconnects, feed compatibility, all PR states, shared PR counts, generated reachability, deterministic layouts, and stable positions. Browser verification includes walking, entering, inspecting, exiting, duck interaction, keyboard/direct access, responsive layout, reduced motion, and journal scroll preservation. Sound defaults off.
