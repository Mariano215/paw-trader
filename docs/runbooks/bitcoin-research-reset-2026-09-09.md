# Bitcoin strategy research reset — 2026-09-09

## Root cause

Four candidate cohorts failed the frozen historical gate. Continuing to adjust
one parameter and redeploy would be backtest overfitting. The development
environment also cannot reach Coinbase directly, which delayed economic
feedback until after each engine patch was installed.

## Reset

Export one immutable public five-year BTC/USD hourly OHLCV dataset from the
already authenticated data client. The export contains no secrets, account
state, orders, positions, or personal data.

Use the dataset locally to build a reproducible research harness with:

- chronological development, validation, and untouched holdout windows;
- walk-forward evaluation;
- 25 bp fee plus 10 bp slippage per side;
- completed candles, next-bar execution, and non-overlapping positions;
- candidate-family and parameter-trial accounting;
- minimum 100 out-of-sample trades;
- positive expectancy/return/Sharpe and maximum drawdown at most 20%;
- sensitivity checks around costs and parameters;
- one holdout evaluation after the rule is frozen.

Only a candidate that passes this harness receives production code and a new
paper cohort. All failed candidates stay invalidated. Stocks continue running;
live remains blocked.

## Results

The five-year public export contains 43,788 hourly bars from 2021-09-10 through
2026-09-09, with no duplicate or null rows. A frozen four-hour trend rule looked
positive in development, then lost 8.01% in its one-time final-year holdout.
That rule was rejected.

A separate cost-aware 24-hour XGBoost walk-forward experiment produced 58
non-overlapping trades at the selected threshold. At the original modeled 0.70%
round-trip cost it showed 0.317% mean return per trade, 13.93% compounded return,
and 18.96% maximum drawdown. It failed robustness:

- increasing round-trip cost to 1.00% changed total return to -4.26%;
- a nearby random seed changed the selected-threshold total to -11.09%;
- only 7 of 16 active quarters were profitable;
- bootstrap probability of positive mean return was 71.6%, with a -33.96%
  fifth-percentile compounded result;
- nearby tree-depth and estimator-count choices produced materially different
  signs and drawdowns.

This evidence is exploratory and post-selection because the walk-forward record
was used to choose the candidate. It does not satisfy the frozen minimum of 100
trades or demonstrate a stable after-cost edge. The candidate is rejected and
must not be activated. Bitcoin paper trading remains paused until a new research
family passes a predeclared evaluation.
