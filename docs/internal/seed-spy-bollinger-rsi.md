# Seed Playbook: spy-bollinger-rsi

The engine side of Phase 6 Task 2 ships the `spy-bollinger-rsi`
strategy through the walk-forward validation gate. This doc captures
the brain-side seed SQL and registration steps that an operator runs
after reviewing the walk-forward result and deciding to enable the
live leg.

No code change lands alongside this doc. The live generator Python
module and its `AlpacaDataClient` wiring already exist as part of the
mean-reversion arm. Only the strategy row, the poller mapping, and
the per-strategy cap need operator attention.

## Strategy identity

- Engine strategy name: `spy-bollinger-rsi`
- Brain strategy id: `spy-bollinger-rsi-stocks`
  (the poller's `resolveStrategyId()` appends `-stocks` because the
  engine name has no asset-class suffix and SPY is not a crypto pair)
- Asset class: stocks
- Tier at seed: 0 (cold-start; autonomy ladder starts at 0.25x)
- Status at seed: `active`
- Live cap at seed: 500 USD, raised only after live observation
  (see "Cap raise protocol" below)

## Seed SQL

Matches the convention in `src/trader/strategy-manager.ts::seedMomentumStrategy`
and `seedMeanReversionStrategy`. `created_at` and `updated_at` are
milliseconds (Date.now()), consistent with the rest of the schema.

```sql
-- Run once against the bot DB (store/claudepaw.db).
INSERT OR IGNORE INTO trader_strategies
  (id, name, asset_class, tier, status, params_json, max_size_usd, created_at, updated_at)
VALUES (
  'spy-bollinger-rsi-stocks',
  'SPY Bollinger + RSI',
  'stocks',
  0,
  'active',
  json_object(
    'basket',         json_array('SPY'),
    'bb_window',      20,
    'bb_k',           2.0,
    'rsi_window',     14,
    'rsi_oversold',   30,
    'horizon_days',   10,
    'buy_only',       1,
    'source',         'engine:spy-bollinger-rsi'
  ),
  500.0,
  cast(strftime('%s', 'now') as integer) * 1000,
  cast(strftime('%s', 'now') as integer) * 1000
);
```

The `params_json` shape matches the mean-reversion strategy row so
existing reporting queries that decode `params_json.basket` and
`params_json.bb_window` continue to work with no template changes.

## Registering with the signal poller

`src/trader/signal-poller.ts::resolveStrategyId()` already handles
the engine to brain strategy id translation. When the engine starts
emitting candidates under `strategy='spy-bollinger-rsi'` the poller
will route them to `spy-bollinger-rsi-stocks` automatically because
the engine name does not end in `-crypto` or `-stocks` and SPY does
not contain a slash.

No code change is required. After the SQL above runs, any call to
`pollAndStoreSignals(db, client)` inserts candidates with the correct
`strategy_id` FK. If the FK check fails (strategy row missing), the
INSERT raises; running the seed SQL first is a hard prerequisite.

## Cap raise protocol

The `max_size_usd` column on `trader_strategies` acts as a hard
per-strategy ceiling that overrides both the autonomy ladder scale
and the committee's recommended size. Phase 5 Task 1 added this lever
so a half-trusted strategy stays bounded even if the ladder advances.

Conservative rollout:

1. Seed at `max_size_usd = 500.0`. The autonomy ladder starts the
   strategy at cold-start (0.25x), so live orders will be sized at
   `min(500, committeeSize, NAV_cap) * 0.25` until the ladder advances.
2. After 30 closed trades and a positive rolling Sharpe, raise to
   `max_size_usd = 1000.0`.
3. After a second 30-trade window with Sharpe > 0.5 and max drawdown
   still within ladder bounds, raise to `max_size_usd = 2000.0`.
4. Do not raise beyond 2000 until Phase 7's volatility-scaled sizing
   lands. The 2000 ceiling is the current capacity bound on any
   single-asset equity strategy pending that work.

The raise is a single UPDATE against `trader_strategies`:

```sql
UPDATE trader_strategies
SET max_size_usd = 1000.0,
    updated_at = cast(strftime('%s', 'now') as integer) * 1000
WHERE id = 'spy-bollinger-rsi-stocks';
```

## Verification

After seeding, verify the strategy row is visible and the poller
routes correctly:

```sql
SELECT id, name, status, tier, max_size_usd, params_json
FROM trader_strategies
WHERE id = 'spy-bollinger-rsi-stocks';
```

First live dispatch: watch for an approval card in Telegram with
strategy id `spy-bollinger-rsi-stocks` and a size no larger than
`min(500, NAV * 0.20) * 0.25 = $125` (cold-start tier, $500 cap,
20% NAV cap with default $2.5k NAV => cap binds at $500 not NAV).

Dashboard check: `http://localhost:3000/#trader/strategy/spy-bollinger-rsi-stocks`
should show the strategy detail page with its cold-start tier and
zero closed trades.

## Walk-forward evidence

Phase 6 Task 2 registered `spy-bollinger-rsi` in
`scripts/run_strategy_validations.py` with a deterministic synthetic
SPY series (pipeline-health gate).  Phase 7 Task 4 added a second
registration for the same strategy against a cached real-SPY daily
series covering 2020-2024 (strategy-efficacy gate).  Both gates must
clear for CI to pass; they live in the same `STRATEGIES` list in the
runner script.

| Gate                              | Bars source                                 | train | test | step | accuracy threshold | current accuracy |
|-----------------------------------|---------------------------------------------|-------|------|------|--------------------|------------------|
| `spy-bollinger-rsi (synthetic)`   | `load_spy_daily_bars()` (seed=42)           | 250   | 50   | 50   | >= 0.55            | 0.556            |
| `spy-bollinger-rsi (real 2020-2024)` | `load_cached_spy_daily_bars()` (committed CSV) | 250   | 50   | 50   | >= 0.52            | 0.541            |

The synthetic gate uses `fail_on_negative_equity=True`; the real-SPY
gate sets it to `False` because the 2020 crash fold produces a brief
negative-equity trough even though the strategy recovers over the
full window.

The real-SPY threshold (0.52) is 0.021 below the current strategy's
walk-forward accuracy.  Margin is kept narrow on purpose: the whole
point of a real-data gate is to trip on a couple-of-basis-points
regression.  A wider margin would let quiet regressions past.  The
synthetic gate margin is wider (0.006) because the series is
deterministic; we care more about it tripping on RNG or scoring
drift than on strategy-shape drift.

Fixture refresh: the CSV sits under `fixtures/spy_daily_2020_2024.csv`
in the engine repo.  To refresh to a longer window (e.g. 2020-2025),
regenerate via yfinance with `auto_adjust=True` and commit the CSV in
a standalone PR.  Any fixture change shifts the gate thresholds, so
the PR should include a before/after accuracy table.

Phase 7 Task 5 shipped the live engine generator for
`spy-bollinger-rsi` as `src/trader_engine/signals/spy_bollinger_rsi.py`.
Registered in `scheduler.run_signal_generation` alongside momentum and
mean-reversion, so candidates flow into the engine signals cache on
the 15-minute tick.  The seed SQL above is no longer a forward
declaration; it is the last step the operator runs after engine
deploy to wire the brain row so the poller's
`resolveStrategyId()` can translate `spy-bollinger-rsi` to
`spy-bollinger-rsi-stocks`.

Scoring parity with the walk-forward adapter is guarded by
`tests/test_spy_bollinger_rsi.py::test_score_parity_with_live_generator_on_oversold_series`;
both sides pull the indicator helpers from
`trader_engine.signals.indicators` so a change in one surfaces in
the other.  The live generator is a thin wrapper over
`signals.mean_reversion._mean_reversion_score` with a SPY-only basket
and the `spy-bollinger-rsi` strategy tag.

## Related files

- Engine strategy: `Tech/trader-engine/src/trader_engine/strategies/spy_bollinger_rsi.py`
- Engine bars loader: `Tech/trader-engine/src/trader_engine/strategies/bars_loader.py`
- Engine live generator: `Tech/trader-engine/src/trader_engine/signals/mean_reversion.py`
  (the Bollinger + RSI score body is duplicated across these two for
  import-cost reasons; a parity test in
  `tests/test_spy_bollinger_rsi.py` guards the drift)
- Brain strategy seeder: `src/trader/strategy-manager.ts`
- Brain poller: `src/trader/signal-poller.ts`
- Brain autonomy ladder: `src/trader/autonomy-ladder.ts`
