# PawTrader execution reliability repair — 2026-09-09

## Goal

Restore trustworthy paper execution for stocks and Bitcoin without enabling
live money. New entries must match the engine contract, unexpected short
positions must block new exposure, and cumulative broker fills must remain one
canonical quantity per order.

## Root causes

- Auto-dispatch hardcodes `entry_type: market`; engine revision `4656022`
  requires `limit` for every buy.
- The brain treats cumulative order snapshots as immutable fill events. A later
  partial-fill update can either be missed after the order leaves the 100-row
  API window or be appended and double-counted.
- A negative broker quantity is treated as an ordinary position. The long-only
  exit path then attempts another sell and labels the engine's `no_position`
  rejection as a harmless bracket close.
- Engine `/orders` exposes only 100 rows, preventing complete ledger catch-up.
- Trader cost-control endpoint failures return the generic fail-open response,
  allowing committee spend while its caps are unknown.

## Architecture

1. Use one typed buy contract: limit order plus the resolved reference price.
2. Treat any negative broker quantity as a safety invariant violation. Block
   entries, retain normal long-exit processing, and notify once per changed
   short-position set.
3. Store one cumulative fill snapshot per broker order. Replace an older,
   smaller snapshot when the engine reports a higher final quantity.
4. Add paginated order history to the engine contract. New brain clients read
   every page for accounting and archival while retaining recent-order reads
   for hot-path reconciliation.
5. Keep live mode blocked. This repair creates reliable paper evidence; it does
   not change the go-live gate or strategy parameters.
6. Fail closed only for trader committee runs when either cost-control endpoint
   is unavailable. Other ClaudePaw projects retain the existing outage policy.
7. Make paper cleanup autonomous. Targeted broker lookup resolves local orders
   that aged out of rolling history. The engine cancels stale engine-owned
   orders and exposes an idempotent paper-only short-cover endpoint. The brain
   invokes it during equity market hours while keeping all entries blocked.

## Files

- `src/trader/decision-dispatcher.ts`: send limit entries; fail closed on an
  unavailable or negative position snapshot.
- `src/trader/position-safety.ts`: shared negative-position detection and
  deduplicated operator alert state.
- `src/trader/trader-scheduler.ts`: enforce the short-position entry block on
  every healthy tick.
- `src/trader/exit-evaluator.ts`: never send a sell for a negative holding.
- `src/trader/audit-log.ts`: canonical cumulative-order fill upsert.
- `src/trader/order-reconciler.ts`: keep partially filled entries under
  reconciliation and update their cumulative snapshot.
- `src/trader/engine-client.ts`: paginated full-order reader with compatibility
  fallback for older engines.
- `src/trader/trader-scheduler.ts`: request paper-only short cleanup during
  market hours; continue blocking entries until broker quantity reaches zero.
- Focused tests for every changed contract and safety invariant.
- `CHANGELOG.md`: user-facing reliability fixes.

Companion engine patch:

- `src/trader_engine/api/routes/orders.py`: bounded `limit` and `offset` query
  parameters with deterministic ordering.
- `src/trader_engine/execution/alpaca_adapter.py`: use GTC for equity brackets
  so native child protection survives across sessions.
- `src/trader_engine/execution/order_reconciler.py`: cancel completely unfilled
  entries and sell remainders after 30 minutes, and resolve every stale local
  order through broker lookup. Partially filled buy brackets remain untouched.
- `src/trader_engine/api/routes/positions.py`: authenticated, paper-only,
  idempotent short-cover endpoint with a persisted intent before submission.

## Tasks

1. Add failing regressions for auto-dispatch limit entries, negative positions,
   cumulative fill replacement, and paginated order reads.
2. Implement the smallest brain changes that make those tests pass.
3. Add the engine order-history contract and tests if the companion repo is
   writable; otherwise produce an exact patch artifact in this repo.
4. Repair the existing paper ledger only from full engine/broker history. Never
   invent missing fills or mutate the account DB from inferred quantities.
5. Rebuild Graphify, run focused suites, then run the full trader suite and
   TypeScript check.
6. Verify running service logs after restart/deploy. Confirm no new
   `positive_limit_entry_required` or repeated short-position sell attempts.

## Commands and expected results

```sh
LOG_LEVEL=silent npx --no-install vitest run \
  src/trader/decision-dispatcher.test.ts \
  src/trader/position-safety.test.ts \
  src/trader/exit-evaluator.test.ts \
  src/trader/audit-log.test.ts \
  src/trader/order-reconciler.test.ts \
  src/trader/engine-client.test.ts

LOG_LEVEL=silent npx --no-install vitest run src/trader --reporter=dot
npm run typecheck
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

Expected: all tests and type checks pass; graph code index refreshes.

Companion engine:

```sh
.venv/bin/pytest -q \
  tests/test_api_endpoints.py \
  tests/test_alpaca_adapter.py \
  tests/test_order_reconciler.py
```

Expected: pagination is deterministic; native bracket protection is GTC; stale
unfilled equity entries are canceled; partial fills retain broker protection.

## Acceptance criteria

- Auto-approved stock and BTC buys reach the engine as limit orders.
- A negative broker position blocks all new entries before committee cost or
  broker submission; normal long exits remain available.
- Repeated cumulative snapshots for one broker order produce one fill quantity,
  never their sum.
- Full order history can repopulate archived fills after the recent-order
  window rolls over.
- Filled equity brackets retain native stop/target protection across sessions;
  completely unfilled entries cannot remain live past 30 minutes.
- Unexpected paper stock shorts are covered once during market hours. Duplicate
  requests return the existing repair order instead of adding exposure.
- Existing paper account history exposes any broker-equity discrepancy before
  the profitability or go-live gates can pass.
- No strategy resumes or live-money setting changes as part of this repair.

## Deployment verification

Verified against the running paper account on 2026-09-09:

- One idempotent repair order covered the unexpected IWM short: buy 3 shares,
  filled at $293.97. Broker and engine position quantity then converged to zero.
- Repeated cleanup checks returned `already_flat`; no duplicate cover was sent.
- Stable broker lookup closed all 12 legacy live-status rows and recovered their
  cumulative fills. The engine now reports zero orders in live/open statuses.
- Latest position reconciliation is clean with no trading halt. Remaining
  holdings are AAPL 12, EEM 58, and GLD 4.
- Corrected internal accounting is $-1,002.07 realized plus $51.42 open, or
  $-950.65 net. Broker equity is $99,036.24 against a $100,000 start, a
  $-963.76 result. The remaining $13.11 difference is within the known
  incomplete fee/slippage accounting warning but still requires cost closure.
- Corrected FIFO attribution is momentum stocks $-1,031.09, mean reversion
  $31.72, and unattributed legacy fills $-2.69. Every strategy remains paused.
