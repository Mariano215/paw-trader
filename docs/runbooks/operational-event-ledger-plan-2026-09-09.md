# PawTrader operational event ledger + authenticated updates — 2026-09-09

## Goal

Persist and display real PawTrader operations as an immutable event stream,
with authenticated project-scoped WebSocket catch-up, while predeclaring a new
Bitcoin research family without enabling any current or new Bitcoin candidate.

## Architecture

The bot DB is the source of operational truth. Domain writers append sanitized
events to `trader_operational_events`. The table has a stable UUID for
cross-process deduplication and a local monotonic sequence for REST cursors.
SQLite triggers reject updates and deletes.

After each scheduler tick, the existing authenticated bot sync sends the next
ordered event batch after its last acknowledged local sequence. The cursor
advances only on an HTTP success, so failed syncs replay safely without gaps.
The sync endpoint uses `INSERT OR IGNORE` for the append-only table. Only after
the sync transaction commits does the server send
a project-scoped `trader-update` notification through the existing
ticket-authenticated WebSocket. The notification contains no event payload; it
causes the browser to fetch committed rows after its last sequence cursor.

The browser loads an initial page over authenticated REST, then merges cursor
pages received after WebSocket notifications. It deduplicates by event UUID.
Only a newly received UUID may pulse a pipeline stage, once, for three seconds.
Initial history and duplicate delivery never animate. Disconnect freezes all
motion and leaves the durable text history visible.

Event metadata is a typed runtime allowlist. Credentials, raw broker responses,
URLs, prompts, transcripts, stack traces, and arbitrary exception text are not
accepted. Correlation IDs are dedicated columns: strategy, signal, decision,
cohort, and order.

## Event coverage

- scheduler tick start, overlap skip, and completion;
- each candidate strategy evaluation and candidate filter/dedup result;
- every persisted signal suppression;
- committed committee approve/abstain transcript result;
- entry and exit order submissions;
- newly observed or increased broker fills;
- reconcile completion/failure summaries;
- exit submissions;
- verdict writes and ungraded closures;
- cohort lifecycle transitions;
- trader Paw/watchdog collector checks.

## Bitcoin research declaration

Predeclare `bitcoin-order-flow-imbalance-v1`, a distinct microstructure family
using public Coinbase trades and level-2 book deltas to predict short-horizon
BTC/USD direction. It is forward-collection-first because the current five-year
OHLCV export cannot represent order flow. The declaration freezes source fields,
feature formulas, chronological evaluation, costs, sensitivity checks, and the
single holdout rule before data is inspected.

The family is seeded as `paused` and `research_status=predeclared`; it is not an
executable engine candidate and receives no cohort. Existing Bitcoin momentum,
hourly pullback, and four-hour trend strategies are also seeded paused. Their
invalidated cohorts remain unchanged.

## Files changed

- `src/trader/schema.ts`, `server/src/trader-schema.gen.ts`: additive ledger
  migration, indexes, append-only triggers, schema assertion.
- `src/trader/operational-events.ts`: typed append API and metadata allowlist.
- Trader scheduler/domain writers: append events at committed operation points.
- `src/trader/server-sync.ts`, `server/src/trader-routes/sync.ts`: event sync and
  post-commit notification.
- `server/src/trader-routes/operational-events.ts`: authenticated cursor API.
- `server/src/ws.ts`, `server/public/app.js`, `server/public/style.css`: scoped
  update notification, durable tape, deduplication, bounded motion.
- `src/trader/strategy-manager.ts` and Bitcoin family doc: paused research
  declaration.
- Focused tests plus `CHANGELOG.md`.

## Tasks

1. Add migration 10 and append API; test immutability, allowlisting, ordering,
   and idempotent event IDs.
2. Instrument operational commit points with no raw error/prompt payloads.
3. Sync events with insert-only semantics; broadcast only after commit.
4. Add project-authorized cursor route and WebSocket fanout tests.
5. Replace synthesized activity tape with ledger state and one-shot pulses.
6. Predeclare the new Bitcoin family as paused; keep old candidates paused.
7. Regenerate the server schema copy and graph, then verify.

## Verification commands and expected results

```bash
npx vitest run src/trader/operational-events.test.ts src/trader/schema.test.ts \
  src/trader/schema-gen-drift.test.ts src/trader/signal-poller.test.ts \
  src/trader/order-reconciler.test.ts src/trader/exit-evaluator.test.ts \
  src/trader/close-out-watcher.test.ts src/trader/trader-scheduler.test.ts

cd server && npx vitest run src/trader-routes/operational-events.test.ts \
  src/trader-routes/sync.test.ts src/ws.test.ts

npm run typecheck
cd server && npx tsc --noEmit
node --check server/public/app.js
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

Expected: all focused tests and both typechecks pass; browser JS parses; graph
rebuild completes or reports only the already-known unavailable semantic
backend while code extraction succeeds.

## Acceptance criteria

- Update/delete attempts on an operational event fail in SQLite.
- Metadata outside the allowlist never reaches the DB or API.
- Event retry/sync cannot create duplicate UUIDs or replay UI motion.
- REST rejects users without Paw Trader project access.
- WebSocket delivery uses the existing authenticated registration and project
  membership filter.
- Broadcast occurs after event insert transaction commit.
- Idle or disconnected UI has no continuing operational animation.
- Scheduler, strategies, suppressions, committee, submissions, fills, exits,
  reconciles, verdicts, cohorts, and watchdogs appear from real event rows.
- All old Bitcoin candidates and the new research family are paused; no new
  Bitcoin cohort is created or activated.
