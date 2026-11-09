# Hourly Bitcoin paper cohort

## Goal

Collect meaningful prospective Bitcoin ROI evidence without inventing trades, changing live-money controls, or mixing the result with the invalid momentum cohort.

## Architecture

The engine will run one frozen BTC/USD hourly pullback rule every 15 minutes. It reads closed one-hour Coinbase candles, buys only an oversold pullback inside a positive 200-hour trend, rejects 24-hour freefalls, and emits at most one open position through the existing re-entry guard. The brain keeps the existing committee, risk sizing, order reconciliation, cost attribution, one-day time stop, and paper-only broker path.

The new strategy id is `mean-reversion-hourly-crypto`. A new v2 crypto cohort owns that strategy. The mismatched v1 momentum cohort is invalidated with its evidence retained. Stock v1 remains unchanged.

## Frozen rule

- Universe: `BTC/USD` only.
- Bars: closed Coinbase one-hour OHLCV.
- Entry: RSI(14) below 35; close above EMA(200); 24-hour return above -8%.
- Score: `tanh((35 - RSI) / 10)`; engine minimum 0.05 plus existing crypto-regime multiplier.
- Bear regime: suppressed. High volatility: threshold multiplied by 1.5.
- Exit: existing production stop/target calculator plus a one-day time stop.
- Limits: $200 maximum position; 5 entries/day hard cap; existing single-position guard.
- Costs: 25 bp fee and 10 bp slippage per side in the cohort scorecard.

## Files

Trader-engine patch:

- `src/trader_engine/data/coinbase_data.py`: paginated one-hour bars.
- `src/trader_engine/signals/crypto_mean_reversion.py`: frozen BTC-only hourly rule and telemetry.
- `src/trader_engine/scheduler.py`: run the hourly rule with regime gating.
- `src/trader_engine/backtest/trade_simulator.py`: trade-level simulation using the production entry function.
- `src/trader_engine/api/routes/backtest.py`: authenticated backtest endpoint.
- Focused pytest coverage.

ClaudePaw:

- `src/trader/strategy-manager.ts`: exact strategy metadata.
- `scripts/trader-paper-control.ts`: v2 draft bootstrap and activation workflow.
- Relevant Vitest coverage and activation docs.

## Tasks

1. Quarantine legacy verdict-less closures in monitoring.
2. Implement and test the engine patch in a writable scratch copy.
3. Add exact strategy metadata and a v2 cohort draft.
4. Apply the engine patch, restart both services, and verify paper preflight.
5. Invalidate crypto v1, activate crypto v2, and record its backtest artifact.
6. Observe the first signal -> decision -> paper order -> fill -> exit -> verdict lifecycle.

## Commands and expected results

- Focused Pytest and Vitest suites: pass.
- TypeScript builds: pass.
- Crypto preflight: paper mode, both venues connected, clean reconcile, zero open orders, flat BTC/USD.
- Cohort status: stock v1 running; crypto momentum v1 invalidated; hourly crypto v2 running.
- Engine telemetry: `mean-reversion-hourly-crypto` scores every 15 minutes.
- Live mode: still blocked.

## Acceptance criteria

- No forced or synthetic trade enters ROI results.
- Strategy DB metadata equals deployed constants.
- Every new crypto decision carries the v2 cohort id.
- Fees and slippage are included in net ROI.
- A missing signal is reported as a market condition, not a pipeline failure.
- Live-money promotion cannot occur before the cohort evidence gates pass.
