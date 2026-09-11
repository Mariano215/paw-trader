# PawTrader prospective paper cohorts — design and implementation plan

## Goal

Collect trustworthy, separate paper evidence for stock mean reversion and
Bitcoin momentum. A strategy can open a new paper position only while an
immutable matching cohort is running. Historical trades, another asset class,
or a changed configuration cannot authorize live money.

## Architecture

1. `trader_evaluation_cohorts` stores the frozen experiment contract: strategy,
   universe, venues, mode, parameters, cost model, caps, code revisions, and a
   deterministic fingerprint.
2. `trader_decisions.cohort_id` binds every post-activation decision to the
   experiment that permitted it. Historical rows remain null and excluded.
3. `trader_cohort_events` records create/start/invalidate/close/pass actions.
4. The dispatcher checks a running cohort before committee cost or broker
   submission. Missing, stale, mismatched, wrong-universe, or non-paper cohorts
   fail closed and pause the strategy.
5. The local operator CLI checks engine paper mode, broker/data connections,
   crypto enablement, fresh clean reconciliation, open/unknown orders, shorts,
   cohort-universe positions, cohort fingerprint, limits, and legacy quarantine.
   The DB status change and audit event occur in one transaction.
6. Cohort scorecards read only cohort-bound fills/verdicts and apply the frozen
   fee/slippage model. Regimes count only completed round trips. A scorecard
   cannot pass without current paper broker/data health, a clean reconciliation,
   and a fresh positive NAV snapshot. Stock and Bitcoin gates remain independent.
7. Passing a cohort produces a review-ready state. It never flips broker mode.

## Data contract

`trader_evaluation_cohorts`:

- identity: `id`, `strategy_id`, `asset_class`, `status`;
- freeze: `config_json`, `config_fingerprint`, `universe_json`;
- venues: `data_venue`, `execution_venue`, `mode`;
- cost model: `fee_bps_per_side`, `slippage_bps_per_side`, `benchmark_asset`;
- paper controls: `max_position_usd`, `daily_trade_cap`;
- evidence thresholds: `min_closed_trades`, `min_regimes`,
  `max_drawdown_pct`, `min_deflated_sharpe`, `min_backtest_ratio`;
- provenance: `claudepaw_revision`, `engine_revision`, `no_retune`;
- lifecycle timestamps and invalidation reason.

Only one `running` cohort may exist per asset-class sleeve, enforced by both a
partial unique DB index and the activation transaction. Only `draft` can
transition to `running`. Any material fingerprint mismatch transitions
`running` to `invalidated` and pauses the strategy before dispatch.

## Initial frozen cohorts

| Strategy | Universe | Data | Execution | Max position | Daily cohort cap | Cost assumption |
| --- | --- | --- | --- | ---: | ---: | --- |
| `mean-reversion-stocks` | AAPL, MSFT, SPY, QQQ | Alpaca | Alpaca paper | $500 | 5 | recorded fees + 5 bps/side slippage |
| `momentum-crypto` | `BTC/USD` | Coinbase | Alpaca paper | $200 | 5 | 25 bps/side fee + 10 bps/side slippage |

Committee bypass remains false. `momentum-stocks` and
`spy-bollinger-rsi-stocks` remain paused.

## Security and failure behavior

- Activation and invalidation run only through the local filesystem-controlled
  CLI; the browser receives read-only cohort projections.
- Strategy/cohort IDs use strict length and character allowlists.
- Browser never receives engine credentials.
- Engine errors return generic operator messages and log details server-side.
- Unknown health, positions, orders, or reconciliation blocks activation.
- Live engine mode always blocks cohort activation.
- Activation never changes broker credentials or mode.
- Repeating activation is idempotent only for the same already-running cohort.
- Database transaction covers cohort status, strategy status/cap, and event.

## Tasks

1. Add migrations 8-9, schema assertions, and migration tests.
2. Add cohort lifecycle/fingerprint module and focused tests.
3. Bind dispatch decisions and retries to a valid running cohort.
4. Add cohort scorecard and independent readiness evaluation.
5. Add local create/start/invalidate/read controls with engine preflight.
6. Add Mission Control cohort state and scorecards.
7. Add BTC-only engine configuration patch and lifecycle tests.
8. Seed the two draft cohorts, verify, activate in paper, restart services, and
   deploy Mission Control.

## Verification

```bash
LOG_LEVEL=silent npx --no-install vitest run src/trader --reporter=dot
(cd server && npm test -- --run src/trader-routes)
npm run typecheck
npm run build
cd <trader-engine> && .venv/bin/pytest -q
```

## Acceptance criteria

- Every new paper entry has a non-null cohort ID.
- Pre-cohort rows never affect cohort metrics.
- Stock and Bitcoin use separate cohorts and scorecards.
- Config drift invalidates the cohort and pauses its strategy before spend or
  submission.
- Activation fails closed on any unknown operational prerequisite.
- Bitcoin universe is exactly `BTC/USD`.
- Paper cohorts can run autonomously; live mode remains blocked.
