# Bitcoin order-flow imbalance family — predeclared 2026-09-09

## Status

`PREDECLARED / PAUSED / NOT EXECUTABLE`

Strategy registry ID: `order-flow-imbalance-crypto`.

No engine candidate, draft cohort, paper activation, or live path is authorized
by this declaration. Bitcoin momentum, hourly pullback, four-hour trend, and the
exploratory XGBoost candidate remain rejected and inactive.

## Why this is a new family

Prior candidates used candle-level price trend, pullback, or price-derived ML
features. This family tests market microstructure: whether persistent aggressive
trade flow and near-book depletion predict the next hour's BTC/USD direction.
It requires public trade and order-book deltas that do not exist in the opened
five-year OHLCV research export. That old dataset and holdout are out of scope.

## Frozen data contract

Collect forward from the declaration boundary. Normalize the public feed into:

- event time and receive time;
- product (`BTC/USD` only);
- trade price, size, and aggressor side;
- best five bid/ask price levels and sizes;
- sequence/gap marker and reconnect marker.

Reject intervals with sequence gaps, clock reversal, crossed books, missing
levels, or more than 5% feed downtime. Store raw normalized events immutably and
derive 15-minute completed decision bars. Never use account, order, position,
credential, or private user-channel data.

Before evaluating clock reversal, source-time order unique trades behind a
fixed 60-second watermark driven by local receive time. Repeated trade IDs are
removed before feature derivation and again at the raw-store uniqueness
boundary. Apply L2 state transitions in socket receive/sequence order because
Coinbase L2 `event_time` can lag or reverse independently of authoritative
delivery order. Raw event and receive timestamps remain unchanged. A unique
trade arriving behind the watermark still invalidates the interval. Completed
decision bars become available one minute after their quarter-hour boundary.

## Completion and monitoring slice — 2026-09-10

Goal: make the long forward-collection requirement visible without inspecting
the future holdout or creating an execution path.

Architecture:

- The local collector derives a read-only progress snapshot from immutable
  completed bars and the strategy declaration timestamp.
- Progress reports total and eligible bars, completed forward calendar days,
  the earliest permitted final-evaluation date, and whether the 180-day
  collection minimum has matured.
- The existing allowlisted strategy-status projection syncs only those numeric
  and boolean facts. It does not expose the research DB path or raw events.
- Mission Control renders the progress beneath the paused Bitcoin lane.
- Operational-event UI merging stores each UUID once; retry/catch-up delivery
  cannot duplicate a visible row or pulse.

Tasks:

1. Add a regression that locks one visible row per operational-event UUID.
2. Add deterministic research-progress computation and collector projection.
3. Allowlist the projection in the dashboard API and render it read-only.
4. Verify the next post-restart partial bar and first complete bar.
5. Keep the family and all older Bitcoin strategies paused with no family
   cohort, signal, decision, order, or live-capital route.

Acceptance:

- One event UUID produces one visible tape row.
- Research progress survives collector restarts because it is recomputed from
  immutable bars.
- The earliest evaluation date is declaration time plus 180 calendar days.
- `collection_mature=false` before that boundary regardless of bar count.
- No progress state changes strategy/cohort/execution state.

Completion evidence — 2026-09-10:

- All five implementation tasks passed automated verification.
- The first complete post-fix interval (`2026-09-10 12:45–13:00 America/New_York`)
  completed eligible with 4,788 unique trades and no quality reason.
- The family has zero cohorts and zero signals. It and every older Bitcoin
  strategy remain paused; every older Bitcoin cohort remains invalidated.
- Final evaluation remains time-locked until `2027-03-09T00:13:45.290Z` and
  then still requires every frozen statistical gate. This temporal collection
  period is expected ongoing operation, not unfinished implementation.

## Frozen features

Compute using data available at the completed decision bar only:

1. signed trade-volume imbalance over 15 and 60 minutes;
2. top-five depth imbalance, time-weighted over 15 minutes;
3. bid/ask depletion and replenishment rates over 15 minutes;
4. spread median and 95th percentile;
5. realized volatility over 60 minutes;
6. feed completeness and reconnect count as eligibility gates, not predictors.

No additional predictor may be added after collection begins without closing
this family version and predeclaring version 2.

## Frozen rule search

Development may compare at most 24 configurations formed from:

- trade imbalance threshold: 0.15, 0.25, 0.35;
- depth imbalance threshold: 0.10, 0.20;
- confirmation: one or two consecutive decision bars;
- volatility ceiling: 60-minute volatility below the rolling 75th or 90th
  percentile.

Long/flat only. Enter on the next completed 15-minute bar after both imbalance
conditions pass. Exit after 60 minutes, on sign reversal, or at a predeclared
1.5% stop, whichever occurs first. Positions do not overlap.

## Evaluation protocol

- Collect at least 180 calendar days before final evaluation.
- First 60% chronological development; next 20% validation; final 20% untouched
  holdout.
- Walk forward within development/validation. Select once using after-cost
  expectancy, then freeze.
- Charge 25 bp fee plus 10 bp slippage per side. Stress at 50 bp and 75 bp total
  cost per side.
- Require at least 100 non-overlapping out-of-sample trades, positive net return,
  positive expectancy, positive Sharpe, maximum drawdown at most 20%, at least
  two volatility regimes, and no sign flip across adjacent thresholds.
- Bootstrap trade returns in blocks. Require at least 95% probability of
  positive mean after base costs and a non-negative fifth-percentile compounded
  result.
- Open the final holdout once. Any failure rejects version 1. No retuning on the
  opened holdout.

## Automated one-shot evaluator — frozen 2026-09-10

The evaluator contract is implemented before the first full collection day and
does not add predictors. Future immutable bars also record trade-price OHLC as
outcome/execution evidence. Legacy bars stay unchanged with null OHLC.

- volatility ceilings use the preceding 28 calendar days, with at least seven
  days of eligible history;
- entry is the next contiguous eligible bar's first trade;
- sign reversal means either 15-minute trade imbalance or depth imbalance is
  negative; stops crossing the bar open use the worse opening price;
- development and validation must both be positive before holdout is opened;
- ties rank by validation expectancy, validation return, then stable variant ID;
- bootstrap uses 10,000 deterministic circular samples of eight-trade blocks;
- 50 and 75 bp-per-side stress results and adjacent numeric thresholds must not
  flip total return negative.

At maturity the collector checks the execution lock, writes exactly one
append-only verdict for declaration version 1, emits a safe operational event,
and exposes the terminal result read-only. It never creates a cohort or changes
strategy status. See `bitcoin-order-flow-evaluator-plan-2026-09-10.md`.

## Promotion boundary

Passing research permits production implementation review only. After code and
matched-backtest verification, create a new draft cohort with a new immutable
fingerprint. Paper activation still requires the existing preflight, accounting,
reconcile, sample-size, drawdown, DSR, benchmark, and operator gates. Live money
remains a separate manual decision.
