# Bitcoin order-flow one-shot evaluator plan — 2026-09-10

## Goal

At the predeclared 180-day boundary, produce one reproducible research verdict
without creating any strategy execution path or inspecting the holdout early.

## Architecture

- Extend each future immutable 15-minute feature bar with trade-price OHLC.
  These values are outcome and execution evidence, not predictors. Existing
  rows remain untouched and therefore carry null OHLC.
- Keep the predictor family fixed at the already-declared 24 combinations:
  three trade-imbalance thresholds, two depth-imbalance thresholds, one- or
  two-bar confirmation, and 75th/90th volatility ceilings.
- Compute each volatility ceiling from the trailing 28 calendar days available
  strictly before the decision bar, with at least seven days of observations.
- Enter at the next contiguous eligible bar's first trade. Exit at the first of
  a 1.5% stop, a completed-bar imbalance sign reversal, or 60 minutes. Apply
  35 bp per side at base cost and report 50/75 bp-per-side stress results.
- Split by frozen calendar time: 60% development, 20% validation, 20% holdout.
  Rank only variants positive in development and validation by validation
  expectancy, then return, then stable variant ID. If none qualify, reject
  without opening the holdout.
- If a variant qualifies, open the holdout once. Require 100 non-overlapping
  trades, positive return/expectancy/Sharpe, drawdown at most 20%, two volatility
  regimes, non-negative adjacent-threshold and cost-stress results, bootstrap
  probability of positive mean at least 95%, and non-negative fifth-percentile
  compounded return. Bootstrap uses 10,000 deterministic circular samples with
  eight-trade blocks.
- Persist one append-only run per declaration version with the evaluator
  contract hash, input-data hash, selected variant, phase results, criteria,
  and final verdict. A completed run is never recomputed or overwritten.
- Project only allowlisted verdict facts to Mission Control and append a safe
  operational-ledger event. Passing means research review is permitted only;
  it must not create a cohort, enable an engine candidate, or unpause anything.

## Files

- `src/trader/bitcoin-order-flow-bars.ts`: price OHLC derivation.
- `src/trader/bitcoin-order-flow-store.ts`: immutable OHLC and evaluation-run
  schema.
- `src/trader/bitcoin-order-flow-evaluation.ts`: frozen simulation, selection,
  bootstrap, fingerprints, one-shot persistence.
- `src/trader/bitcoin-order-flow-collector.ts`: maturity trigger and status.
- `src/trader/operational-events.ts`: allowlisted verdict telemetry.
- `server/src/trader-routes/status.ts`, `server/public/app.js`: read-only verdict.
- Corresponding focused tests, `CHANGELOG.md`, and the family declaration doc.

## Tasks

1. Add nullable OHLC migration and immutable writes; verify legacy rows survive.
2. Implement deterministic 24-variant evaluator and fail-closed criteria.
3. Add one-shot append-only run persistence and execution-lock assertions.
4. Trigger only at maturity and expose the result read-only.
5. Verify tests, typecheck, builds, DB integrity, graph refresh, and live restart.

## Commands and expected results

```bash
npx vitest run src/trader/bitcoin-order-flow-*.test.ts
npm run typecheck
npm run build
cd server && npx vitest run src/trader-routes/status.test.ts && npm run build
node --check server/public/app.js
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

All tests and builds exit zero. Before maturity no evaluation row exists. At
maturity exactly one terminal row exists. Every Bitcoin strategy stays paused,
and family cohort/signal/decision/order counts remain zero.

## Acceptance criteria

- Evaluation cannot run before the frozen calendar cutoff.
- Holdout use is zero when selection fails and exactly one otherwise.
- Repeated maturity checks return the existing immutable run.
- Update/delete attempts on evaluation runs fail.
- Contract and input hashes make the verdict reproducible.
- Status/API/UI distinguish `awaiting_collection`, `rejected_pre_holdout`,
  `rejected`, and `passed`.
- No evaluator outcome mutates trading or cohort state.
