# Bitcoin four-hour trend paper candidate — 2026-09-09

## Goal

Create one new BTC/USD paper candidate that can produce at least 100 historical
round trips, remains positive after conservative costs, and keeps strategy
drawdown at or below 20%. Do not activate it unless the frozen backtest passes.
Keep live trading blocked.

## Evidence and decision

The corrected daily breakout produced 42 trades, +5.74% after costs, and 56.41%
maximum drawdown over five years. The corrected hourly pullback produced 14
trades and lost 20.02% in one year. Both are invalidated.

Research supports three constraints:

- short-horizon crypto signals must clear explicit transaction costs;
- both momentum and reversal are regime-dependent intraday effects;
- a simple four-hour trend rule can be more robust than additional ML layers,
  though published/released results still show material drawdown.

Sources:

- https://arxiv.org/abs/2606.00060
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4080253
- https://github.com/iolufemi/crypto-trend-research/blob/master/paper/PAPER.md

## Frozen rule

Data: completed Coinbase BTC/USD four-hour candles. The current partial
four-hour candle is excluded.

Entry requires all conditions on the completed signal candle:

1. close exceeds the prior 20-candle high;
2. EMA(20) exceeds EMA(100);
3. EMA(100) is above its value six candles earlier;
4. 24-hour return exceeds 1.4%, twice the modeled 70 bp round-trip friction.

The score combines breakout magnitude, EMA spread, and return above the cost
hurdle. No shorting. Entry is the next four-hour open. Existing production exit
semantics remain: conservative stop-before-target ordering, volatility stop,
2R target, and seven-day time stop. Backtest charges 25 bp fee plus 10 bp
slippage on both entry and exit.

## Architecture and files

Trader engine:

- `data/coinbase_data.py`: completed four-hour aggregation.
- `signals/crypto_trend_4h.py`: frozen score and candidate generator.
- `scheduler.py`: score the candidate beside invalidated research strategies;
  ClaudePaw cohort enforcement controls execution.
- `backtest/trade_simulator.py`: production-score trade simulation.
- `api/routes/backtest.py`: authenticated, bounded backtest endpoint.
- matching unit and scheduler tests.

ClaudePaw:

- `strategy-manager.ts`: seed exact paused strategy metadata.
- `engine-client.ts`: typed backtest call.
- `trader-paper-control.ts`: create v5 draft and route engine evidence.

## Tasks

1. Implement completed four-hour bars and signal tests.
2. Add the production signal and scheduler path.
3. Add the exact matched backtest and authenticated endpoint.
4. Add the paused ClaudePaw strategy and v5 cohort draft.
5. Run focused and full engine tests, TypeScript tests/build, and Graphify.
6. Apply the patch, restart services, bootstrap v5, record its backtest, and
   inspect the result before activation.

## Commands and expected result

```bash
cd <trader-engine>
git apply --check <claudepaw>/patches/trader-engine-bitcoin-4h-trend.patch
git apply <claudepaw>/patches/trader-engine-bitcoin-4h-trend.patch
.venv/bin/pytest -q tests/test_coinbase_data.py tests/test_crypto_trend_4h.py tests/test_scheduler.py tests/test_trade_simulator.py
launchctl kickstart -k gui/$(id -u)/com.pawtrader.engine

cd <claudepaw>
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudepaw.app
npm run trader:paper -- bootstrap
npm run trader:paper -- record-engine-backtest bitcoin-4h-trend-paper-20260909-v5
npm run trader:paper -- preflight bitcoin-4h-trend-paper-20260909-v5
npm run trader:paper -- status
```

## Acceptance criteria

- backtest end date is current and warnings are empty;
- at least 100 independent, non-overlapping round trips;
- positive expectancy, total return, and Sharpe after modeled costs;
- maximum drawdown no greater than 20%;
- paper preflight is entirely healthy;
- only then activate v5; otherwise invalidate it with exact evidence;
- stocks continue independently and live mode remains blocked.
