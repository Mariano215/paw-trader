# Fresh epoch runbook (2026-09-18)

Order matters. Each step has a check. Spec: `docs/superpowers/specs/2026-09-18-paw-trader-v2-evidence-machine.md`.

1. the operator: Alpaca dashboard > Paper > Reset. Regenerate the paper API keys (the old ones stop working after a reset).
2. Engine keys: edit `<trader-engine>/.env` (names per `src/trader_engine/config.py`: `alpaca_api_key`, `alpaca_secret_key`). Restart:
   `launchctl kickstart -k gui/$(id -u)/com.pawtrader.engine`
   Check: `/health` shows `alpaca_connected` true, `alpaca_mode` paper; `/positions` is empty.
3. Engine report: `cd <trader-engine> && uv run python scripts/run_backtest_gate.py`
   Check: `models/backtest-gate.json` exists and `GET /backtest/report` returns it.
4. Bot (`cd <claudepaw>`):
   `npm run trader:paper -- invalidate stocks-mean-reversion-paper-20260909-v1 --reason "superseded by the v2 epoch"`
   `npm run trader:paper -- new-epoch --execute`
   Check: prints `EPOCH STARTED <iso>`.
5. Cohorts:
   `npm run trader:paper -- bootstrap`
   `npm run trader:paper -- record-engine-backtest stocks-momentum-paper-20260921-v2`
   `npm run trader:paper -- record-engine-backtest stocks-mean-reversion-paper-20260921-v2`
   `npm run trader:paper -- preflight stocks-momentum-paper-20260921-v2`
   `npm run trader:paper -- activate stocks-momentum-paper-20260921-v2 --quarantine-legacy`
   `npm run trader:paper -- activate stocks-mean-reversion-paper-20260921-v2 --quarantine-legacy`
   Check: `npm run trader:paper -- status` shows both RUNNING; `trader_strategies` has momentum-stocks and mean-reversion-stocks active.
6. Next trading day: the pipeline watchdog (16:15 ET) should report no `no_running_cohort` suppressions, and decisions > 0 once a signal fires.

If preflight fails on `conflictingPositionCount`, the account is not flat yet: wait for the reset to settle. If `record-engine-backtest` fails with `walk-forward evidence incomplete`, the strategy has too few out-of-sample trades to record; do not activate that cohort until the report is rerun with a longer `--days`.
