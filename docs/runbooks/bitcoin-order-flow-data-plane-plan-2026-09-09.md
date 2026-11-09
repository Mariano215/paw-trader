# Bitcoin order-flow research data plane — 2026-09-09

## Goal

Begin durable, forward-only BTC-USD market-microstructure collection without
creating a signal, executable strategy, paper cohort, or live-capital path.

## Architecture

- The ClaudePaw bot opens one public Coinbase Advanced Trade WebSocket at the
  fixed market-data endpoint and subscribes to `heartbeats`, `market_trades`,
  and `level2` for `BTC-USD` only.
- High-volume research observations live in `store/trader-research.db`, not the
  operational bot DB or dashboard replica. The research DB uses WAL, batched
  transactions, input bounds, indexes matching time-range queries, and triggers
  that reject updates and deletes.
- Raw normalized trade and L2-update rows are the replayable source of truth.
  Finalized 15-minute feature bars are separate append-only derived records.
- The current collection summary is a mutable `kv_settings` projection in the
  main bot DB. Collection lifecycle, quality, and bar-completion facts are also
  appended to the operational ledger and reach authenticated dashboard clients
  through the existing sync/WebSocket path.
- No Coinbase credential is used. Third-party payloads are parsed as untrusted
  data, bounded, allowlisted, parameterized, and never passed to an LLM.

## Raw-storage partitioning — 2026-09-10

Observed production volume is approximately 1.56 million L2 rows per hour.
Keeping the 180-day forward sample in one indexed SQLite file would create a
multi-billion-row operational bottleneck even though the volume has enough free
disk space.

- Preserve `store/trader-research.db` in place. Existing raw rows remain
  immutable; completed bars remain the small research catalog used for progress.
- After the next collector restart, write raw trades and L2 updates to UTC-day
  SQLite shards under `store/trader-research-raw/YYYY-MM-DD.db`.
- Every shard retains the same constraints, query indexes, WAL durability, and
  update/delete rejection triggers as the original raw tables.
- Partition selection uses trusted local receive time. A batch is fully
  validated before any shard is written. The collector flushes the prior day
  before accepting the first new-day observation, and the writer rejects any
  cross-day batch so a retry cannot duplicate already-committed L2 rows.
- Collector restart warms the bounded trade-ID dedupe set from immutable recent
  rows in the legacy DB and newest shards before accepting feed messages.
- No migration, rewrite, compaction, or deletion of already-collected evidence
  is authorized. Replays must read the legacy catalog DB plus ordered shards.

This changes physical storage only. Frozen predictors, timestamps, eligibility,
evaluation boundaries, and the no-execution rule are unchanged.

## Frozen v1 calculations

- Maker side from Coinbase is inverted to obtain aggressor side.
- Fifteen-minute trade imbalance is `(buy volume - sell volume) / total volume`.
- Sixty-minute imbalance aggregates the current bar and three prior completed
  bars.
- Depth imbalance is `(top-five bid size - top-five ask size) / total top-five
  size`, time-weighted between L2 events.
- Depletion and replenishment are summed absolute quantity changes at updated
  price levels and expressed per observed second.
- Spread median and p95 use post-update top-of-book samples.
- Sixty-minute realized volatility is the square root of summed squared log
  returns over one-minute last-trade prices.
- Unique trades are source-time ordered behind a fixed 60-second watermark
  driven by local receive time; later unique trades trigger the clock-reversal
  quality gate. Repeated Coinbase trade IDs are removed before derivation as
  well as by the raw-store uniqueness constraint. L2 state transitions follow
  socket receive/sequence order because Coinbase L2 `event_time` can lag or
  reverse independently of authoritative delivery order. Raw event and receive
  timestamps are never rewritten, and the independent Coinbase envelope clock
  does not advance bars. Finalized bars are therefore emitted one minute after
  the quarter-hour.
- A bar is ineligible when collection began mid-bar, any sequence gap/reconnect
  occurred, the book crossed, either side had fewer than five levels, timestamps
  reversed, or observed feed downtime exceeded 5% of the bar.

## Files changed

- `src/trader/bitcoin-order-flow-store.ts`: research DB schema and append/query API.
- `src/trader/bitcoin-order-flow-bars.ts`: book state and completed-bar derivation.
- `src/trader/bitcoin-order-flow-collector.ts`: Coinbase WS lifecycle, validation,
  batching, reconnect, watchdog, and main-DB status projection.
- `src/index.ts`: start/stop lifecycle wiring.
- `src/trader/operational-events.ts` and server sync validation: research events.
- `server/src/trader-routes/status.ts` and `server/public/app.js`: truthful research
  state projection.
- Tests beside each module plus dashboard/server route assertions.
- `CHANGELOG.md`: unreleased behavior summary.

## Tasks

1. Add append-only research schema and deterministic store tests.
2. Add strict Coinbase message parsing, sequence/reconnect detection, and tests.
3. Add book reconstruction and finalized 15-minute bar calculations with tests.
4. Wire collector start/stop and operational health events.
5. Expose lightweight collection status and fix Bitcoin lane semantics.
6. Run targeted tests, full typecheck/build, server tests/build, dependency audit,
   graph refresh, and browser verification.
7. Bound 180-day raw-storage operations with UTC-day append-only shards and
   restart-safe trade-ID deduplication.

## Commands and expected results

```bash
npx vitest run src/trader/bitcoin-order-flow-*.test.ts src/trader/schema.test.ts
npm run typecheck
npm run build
cd server && npm test -- --run && npm run build
```

All tests and builds must exit zero. A production restart should create the
research DB, connect without credentials, append BTC-USD observations, emit a
healthy collector ledger event, and keep every Bitcoin strategy paused.

## Acceptance criteria

- Restart-safe public collection reconnects with bounded exponential backoff.
- Only BTC-USD public trades, L2 updates, and heartbeats are accepted.
- Source and receive timestamps plus sequence/gap/reconnect evidence persist.
- Research source rows and finalized bars reject update/delete operations.
- Completed bars expose every frozen feature and an explicit eligibility reason.
- Operational ledger reports connect, disconnect, rejected input, watchdog, and
  bar completion without storing raw third-party text.
- Dashboard says `RESEARCH PAUSED`; it does not imply the predeclared family was
  itself invalidated.
- No strategy status becomes active; no cohort, signal, decision, or order is made.
