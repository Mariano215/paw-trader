# PawTrader truthful live-action design — 2026-09-09

## Goal

Show operational work only when a real broker, engine, or bot event occurred.
An idle system must become visually still. Missing or old safety data must never
look healthy.

## Phase 1: truthful snapshots

The current dashboard polls several real sources. Keep that architecture, but
make the UI accurately represent its limits:

- Return `503` when the engine risk state is unavailable.
- Render unavailable risk as `UNKNOWN`, never `clear`.
- Mark reconcile data stale after ten minutes.
- Animate a pipeline link only while its destination has current work: an open
  order, a recent committee decision, or a reconcile completed in the last 30
  seconds.
- Stop the decorative command-header sweep.
- Label NAV chart data as the latest snapshot and show its source time.
- Age activity markers. Old signals and decisions remain visible without an
  active glow.
- Expose the activity tape as an accessible log.

## Phase 2: event ledger

Add an append-only `trader_operational_events` table with an event ID, source
time, source, stage, event type, state, asset and allowlisted correlation IDs.
Emit events for scheduler ticks, signal decisions, committee transitions,
orders and fills, reconcile runs, exits, verdicts, cohort updates, and watchdog
runs. Sync after commit and broadcast a project-scoped `trader-update` through
the existing authenticated WebSocket.

The browser loads an initial event page and cursor over REST. Each WebSocket
notification fetches events after that cursor. A unique event may animate its
stage once. Duplicate delivery must not replay motion. Disconnect or source
staleness freezes movement and changes the displayed state.

## Security

Event metadata uses an explicit allowlist. Do not store or sync credentials,
raw broker responses, internal URLs, prompts, or stack traces. Preserve the
existing admin-only order cancellation and server-side engine credentials.

## Acceptance criteria

- Idle page has no operational animation after entrance.
- Every moving packet maps to current work or a recent source event.
- Risk outage reads `UNKNOWN`.
- Reconcile older than ten minutes reads `STALE`.
- NAV endpoint labels use the actual snapshot timestamp.
- Reduced-motion users receive the same text state without motion.
- Phase 2 event delivery is authenticated, project-scoped, deduplicated, and
  broadcast only after its DB transaction commits.
