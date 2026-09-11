# PawTrader paper activation handoff — 2026-09-09

## Objective

Run one frozen stock strategy and one frozen Bitcoin strategy autonomously in
paper mode. Collect broker-reconciled, cost-adjusted, prospective evidence.
Keep live money impossible until each asset class independently passes the
precommitted validation gate and an operator deliberately approves a small
live pilot.

Profit is the target, not a promise. Paper performance can reject a strategy;
it cannot guarantee future live returns.

## Plain-English state

### Current state — 2026-09-09 19:15 ET

- Stock cohort `stocks-mean-reversion-paper-20260909-v1` is `RUNNING` with
  0/100 completed round trips and $0 cohort net P&L. It remains the only
  running cohort.
- Bitcoin cohorts v1 through v5 are `INVALIDATED`. Daily momentum, hourly mean
  reversion, and four-hour trend failed the frozen history gates. A later
  cost-aware XGBoost walk-forward candidate also failed cost, seed, quarterly,
  bootstrap, and minimum-trade robustness checks. See
  `docs/trader/bitcoin-research-reset-2026-09-09.md`.
- Bitcoin paper execution is paused. Creating activity with a failed candidate
  would not produce credible ROI evidence. Live trading remains blocked.
- Mission Control truth fixes are locally validated: risk-feed outages render
  unknown, reconcile turns stale after ten minutes, idle flow motion stops,
  active markers age out, broker fill-stream health is exposed, and NAV says
  latest snapshot. Deploy these changes before judging the screen.
- The older implementation and activation narrative below is retained as an
  audit trail. Do not repeat its Bitcoin activation commands.

### Implementation update

- Cohort migration, immutable fingerprints, decision attribution, dispatcher
  enforcement, exit attribution, modeled-cost scorecards, scheduler refresh,
  and independent stock/Bitcoin gate checks are implemented and tested.
- `npm run trader:paper -- ...` is the authoritative local control. It changes
  the Mac brain DB only after checking paper mode, broker/data connectivity,
  crypto enablement, a fresh clean reconciliation, zero open/unknown orders,
  zero shorts, and a flat cohort universe.
- Mission Control reads the synced cohort scorecards and shows actual status,
  closed trades, net P&L after modeled costs, and Deflated Sharpe for each lane.
- Scorecards count regimes only when a cohort trade completed. Passing also
  requires current paper broker/data health, a clean reconciliation, and a
  fresh positive NAV. The DB permits one running cohort per asset-class sleeve.
- A validated engine patch at
  `patches/trader-engine-bitcoin-only-cohort.patch` narrows crypto signal
  generation to BTC/USD. The brain cohort universe also blocks ETH/SOL before
  committee work or broker submission.
- Code is ready for build/restart/deploy. Cohorts are not active until the
  final operational sequence below succeeds. Live capital remains blocked.

- Mission Control is deployed. Deploy `1788967459-99619` completed with a
  unique restart marker and authenticated HTTP 200 health check.
- The dashboard shows near-live operations, NAV, positions, stock/Bitcoin
  lanes, recent activity, open orders, and two-click admin cancellation.
- The ClaudePaw brain and trader engine are launchd services. Both reported
  `state = running` on this review. The engine is listening on
  `127.0.0.1:8200`; its log showed repeated successful health, position,
  order, risk, NAV, and reconcile requests through 2026-09-09 11:29 ET.
- Engine config is `ALPACA_PAPER=True` and `CRYPTO_ENABLED=True`. Coinbase
  credentials are configured. The latest startup logged
  `lifespan.coinbase_ping_ok` and `lifespan.crypto_wired`.
- All strategies are paused. The system is observing and reconciling, but it
  is not opening new paper positions.
- Existing paper holdings from the repaired account are AAPL 12, EEM 58, and
  GLD 4. The engine had zero open orders after repair.
- Broker-backed result at repair time: $99,036.24 NAV from a $100,000 start.
  Corrected internal result: -$1,002.07 realized + $51.42 open = -$950.65.
  The remaining $13.11 difference is within the known incomplete cost ledger.
- Corrected strategy attribution: momentum stocks -$1,031.09; mean reversion
  +$31.72; unattributed legacy fills -$2.69. The materialized strategy table
  currently disagrees and shows momentum stocks positive. Treat that table as
  invalid historical evidence until cohort accounting replaces it.
- Bitcoin has generated 808 historical signals and no verified completed
  paper round trip. Historical crypto decisions include old failed market
  entries. They cannot count toward readiness.

## Deployed reliability work

ClaudePaw now has:

- limit-only entries;
- complete paginated order history;
- cumulative-fill deduplication;
- strategy pause checks on retries;
- short-position detection and paper-only repair;
- durable GTC equity brackets;
- stale-order cancellation;
- broker-backed accounting and fail-closed readiness;
- a live-mode scheduler guard bound to gate version, config fingerprint, age,
  and every required criterion;
- dashboard order review and individual cancellation.

The adjacent trader engine contains applied, uncommitted modifications on base
commit `4656022`. ClaudePaw contains the matching source and patch artifacts on
base commit `3f9b897`. Do not discard either working tree.

## Architecture truth

The current Bitcoin paper path is:

```text
Coinbase market data -> crypto momentum candidate -> ClaudePaw gates/committee
-> Alpaca paper BTC/USD limit order -> engine reconciliation -> software exit
-> canonical fill ledger -> Bitcoin cohort scorecard
```

Coinbase currently provides data and connectivity. The shared execution
adapter sends both equity and crypto paper orders to Alpaca. This must be
visible in the UI and cohort identity. Coinbase Advanced sandbox responses are
static and mocked, so they cannot provide realistic execution evidence. A
future Coinbase live adapter needs its own production-contract validation.

Alpaca supports simulated crypto trading, fractional crypto orders, GTC/IOC,
and market/limit/stop-limit order types. The present code correctly uses a GTC
limit entry for `BTC/USD`. Alpaca has no equity-style crypto bracket in this
path, so the engine/brain software exit loop is safety-critical and must pass a
restart/weekend lifecycle test before the Bitcoin strategy resumes.

## Frozen paper candidates

Run only these two cohorts:

| Sleeve | Strategy | Universe | Data | Paper execution | Initial max |
| --- | --- | --- | --- | --- | --- |
| Stocks | `mean-reversion-stocks` | Existing low-correlation equity universe | Alpaca | Alpaca paper | $500/position |
| Bitcoin | `momentum-crypto` | `BTC/USD` only | Coinbase | Alpaca paper | $200/position |

Keep `momentum-stocks` and `spy-bollinger-rsi-stocks` paused. Historical
momentum losses justify exclusion. Restricting crypto to Bitcoin matches the
requested scope and prevents ETH/SOL observations from contaminating its
scorecard.

Keep committee bypass disabled. Reduce the paper daily new-entry cap from 20
to 5 during cold start. Retain existing circuit breakers, global kill switch,
per-asset exposure limits, and Tier-0 scaling. These are precommitted operating
limits; changing them closes the current cohort and starts a new version.

## Implemented controls

### 1. Immutable evaluation cohorts

`trader_evaluation_cohorts` and the decision-to-cohort link now store:

- cohort ID and start/end timestamps;
- strategy ID and immutable strategy/config hash;
- universe;
- signal, entry, exit, and risk parameters;
- data venue, execution venue, and paper/live mode;
- fee/slippage/spread assumptions;
- code revision for ClaudePaw and trader-engine;
- status: `draft`, `running`, `closed`, `invalidated`, or `passed`;
- invalidation reason and explicit no-retune assertion.

Historical decisions stay available for forensics but never enter a new
cohort. Any relevant config/code change invalidates the running cohort before a
new order can be submitted.

### 2. Cohort-bound broker accounting

Broker orders/fills join to the originating cohort through the durable
decision identity. Results are independent for stocks and Bitcoin and require:

- complete fill history;
- economic round trips;
- realized and open P&L;
- benchmark return over the same timestamps: SPY for stocks, BTC buy-and-hold
  for Bitcoin;
- fees and conservative paper friction;
- trade-linked regimes;
- NAV completeness and reconciliation freshness.

Use Alpaca's lowest-volume crypto schedule as the conservative Bitcoin fee
model: 0.15% maker or 0.25% taker per execution. Until execution liquidity is
classified reliably, charge 0.25% per side. Paper trading omits market impact,
queue position, latency slippage, regulatory fees, and other live effects, so
also record the assumed spread/slippage separately.

### 3. Bitcoin-only engine configuration

The ready-to-apply engine patch freezes signal generation to `BTC/USD`. The
ClaudePaw cohort guard independently rejects other crypto assets before
committee work or broker submission.

### 4. Full Bitcoin lifecycle verification

The automated contracts cover attribution, retries, partial fills, exits,
reconciliation, modeled costs, and scorecard gating. The remaining real-broker
proof is one small Alpaca paper round trip:

```text
candidate -> stored signal -> decision -> GTC limit entry -> partial/full fill
-> position -> stop/target/time exit -> sell -> fill reconciliation -> verdict
-> fee-adjusted cohort P&L
```

Repeat across a process restart and outside equity hours. Prove duplicate
ticks cannot duplicate the entry or exit. Prove engine/broker outage blocks
entries while retaining exit recovery.

### 5. Safe paper activation control

The local-only `trader:paper` CLI refuses activation unless:

- engine reports paper mode;
- broker and reconciliation are healthy;
- no unresolved/unknown orders or unexpected shorts exist;
- open legacy holdings are explicitly quarantined from cohort accounting;
- the cohort is `draft`, its fingerprint matches, and its venue capabilities
  are valid;
- requested max position and daily cap are within hard paper limits.

Activation transaction: mark the cohort `running`, set only its strategy
`active`, persist an audit event, then confirm the next scheduler tick sees the
same cohort/config. Do not use ad hoc SQLite updates for production activation.

### 6. Independent promotion gates

Each cohort must pass independently:

- at least 100 closed round trips;
- at least two trade-linked regimes;
- frozen out-of-sample window with no retuning;
- deflated-Sharpe probability at least 0.95;
- positive net expectancy after modeled costs;
- maximum drawdown no worse than 20%;
- paper Sharpe at least 50% of the matched backtest Sharpe;
- complete/current NAV and reconciliation evidence;
- acceptable execution failure rate;
- positive net P&L and benchmark-relative result.

No automatic paper-to-live switch. A pass creates a review item. The first
live pilot requires a separately approved allocation, broker-native or proven
durable protection, and tighter loss limits.

## Operational activation sequence

### Latest state: corrected Bitcoin candidate gate

The stock cohort is running in paper mode with zero completed cohort trades.
Bitcoin v1, v2, v3, and v4 are all invalidated and their strategies are paused.
No Bitcoin candidate can currently reach paper execution.

Bitcoin daily momentum v3 returned 42 trades, +5.74% after costs, and 56.41%
maximum drawdown over five years. It failed both the 100-trade minimum and 20%
drawdown ceiling. Corrected hourly v4 returned 14 trades and -20.02% after
costs. Both are retained for audit and must not be reactivated.

The next frozen candidate is `bitcoin-4h-trend-paper-20260909-v5`. Its design,
research basis, patch, validation commands, and acceptance criteria are in
`docs/trader/bitcoin-4h-trend-design-2026-09-09.md`. Bootstrap v5 only after
applying `patches/trader-engine-bitcoin-4h-trend.patch`.

`patches/trader-engine-crypto-pagination-and-momentum-backtest.patch` fixes the
pagination termination rule, exposes a cost-adjusted backtest for the deployed
BTC momentum rule, and makes the scheduler score both frozen Bitcoin
candidates. Bootstrap now creates:

- `bitcoin-momentum-paper-20260909-v3`
- `bitcoin-hourly-mean-reversion-paper-20260909-v4`

The cohort guard permits only the selected running strategy to reach
execution. Both use Coinbase data, Alpaca paper execution, a conservative 25
bp fee plus 10 bp slippage per side, a $200 position cap, and five entries per
New York day.

The legacy verdict cleanup is complete. The 149 pre-cohort closes remain as
audit history; the actionable cohort-linked count is zero.

Apply and verify the correction:

```bash
cd <trader-engine>
git apply --check <claudepaw>/patches/trader-engine-crypto-pagination-and-momentum-backtest.patch
git apply <claudepaw>/patches/trader-engine-crypto-pagination-and-momentum-backtest.patch
.venv/bin/pytest -q \
  tests/test_coinbase_data.py \
  tests/test_crypto_momentum.py \
  tests/test_crypto_mean_reversion.py \
  tests/test_scheduler.py \
  tests/test_trade_simulator.py
launchctl kickstart -k gui/$(id -u)/com.pawtrader.engine

cd <claudepaw>
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudepaw.app
mkdir -p store/backups
sqlite3 store/claudepaw.db ".backup 'store/backups/claudepaw-before-btc-candidate-selection-$(date +%Y%m%d-%H%M%S).db'"
npm run trader:paper -- bootstrap
```

The engine patch passed its full local suite: 607 tests. A restart can make
`reconcileFresh` false until the next reconcile. Wait five minutes if needed,
then run both gates:

```bash
cd <claudepaw>
npm run trader:paper -- preflight bitcoin-momentum-paper-20260909-v3
npm run trader:paper -- preflight bitcoin-hourly-mean-reversion-paper-20260909-v4
npm run trader:paper -- record-engine-backtest bitcoin-momentum-paper-20260909-v3
npm run trader:paper -- record-engine-backtest bitcoin-hourly-mean-reversion-paper-20260909-v4
npm run trader:paper -- status
```

Do not activate from the summary line alone. Inspect trade count, expectancy,
total return, Sharpe, drawdown, date range, and warnings. A candidate must have
positive expectancy and total return after modeled costs, positive Sharpe,
drawdown at or below 20%, a current end date, no truncated-history warning,
and enough independent trades to make the result useful. If both qualify,
prefer stability across regimes and time windows. Do not select by headline
Sharpe alone.

After one candidate passes, invalidate stale v1, rerun the selected candidate's
preflight, activate only that candidate, and check status:

```bash
cd <claudepaw>
npm run trader:paper -- invalidate bitcoin-momentum-paper-20260909-v1 \
  --reason "Replaced: frozen metadata did not match the deployed BTC-only 20-day strategy"
npm run trader:paper -- preflight <selected-cohort-id>
npm run trader:paper -- activate <selected-cohort-id> --quarantine-legacy
npm run trader:paper -- status
```

If neither candidate passes, invalidate both drafts with their exact backtest
results and keep Bitcoin paused. Continue walk-forward and cost-sensitivity
research while the stock cohort collects prospective evidence.

### Historical sequence already completed

The earlier BTC-only patch, service restarts, dashboard deployment, DB backup,
legacy flatten, initial preflights, and v1 activations completed successfully.
The hourly v2 experiment and its invalidation remain in the cohort audit log.
Use only the latest correction sequence above for new operational work.

## Verification commands

ClaudePaw:

```bash
cd <claudepaw>
LOG_LEVEL=silent npx --no-install vitest run src/trader --reporter=dot
(cd server && npm test -- --run src/trader-routes)
npm run typecheck
npm run build
npm run trader:pnl
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

Trader engine:

```bash
cd <trader-engine>
.venv/bin/pytest -q
launchctl kickstart -k gui/$(id -u)/com.pawtrader.engine
```

Operational checks:

```bash
cd <claudepaw>
npx tsx scripts/trader-diagnose.ts
launchctl print gui/$(id -u)/com.claudepaw.app | grep -E 'state =|pid =|last exit code'
launchctl print gui/$(id -u)/com.pawtrader.engine | grep -E 'state =|pid =|last exit code'
tail -100 /tmp/claudepaw.log
tail -100 /tmp/pawtrader-engine.log
```

Dashboard deployment:

```bash
cd <claudepaw>
npm run deploy:dashboard
```

Expected ending:

```text
✓ Server rebuilt, restarted, and answering (deploy <id>)
✓ Dashboard deploy complete
```

The local deploy helper now uses no SSH stdin, a separate remote session, SSH
keepalives, a unique ready marker, and authenticated health. Validate that the
next deploy no longer waits for Enter after `remote build OK`.

## Activation and first-lifecycle acceptance checks

- Mission Control says `Paper`, broker connected, reconciliation clean.
- Stocks lane names `mean-reversion-stocks` and shows a new cohort at 0 trades.
- Bitcoin lane names `momentum-crypto`, `BTC/USD`, Coinbase data, and Alpaca
  paper execution; it shows a separate new cohort at 0 trades.
- Old decisions/fills change neither cohort's trade count nor P&L.
- Momentum stocks and SPY Bollinger remain paused.
- One intentionally repeated signal creates at most one broker order.
- Restart tests preserve open-order and exit intent.
- Bitcoin round trip records the fee model and survives an equity-market
  closure.
- Missing health, NAV, fills, costs, or config match displays `blocked` or
  `unknown`, never `passed` or zero.
- Live mode remains blocked.

## Source references

- [Alpaca paper trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [Alpaca crypto orders](https://docs.alpaca.markets/us/docs/crypto-orders)
- [Alpaca crypto fees](https://docs.alpaca.markets/us/docs/crypto-fees)
- [Coinbase Advanced sandbox](https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/sandbox)
- `docs/trader/reliability-repair-2026-09-09.md`
- `docs/trader/mission-control-design-2026-09-09.md`
- `docs/trader/review-2026-09-06.md`

## Paste into the next coding session

```text
Continue PawTrader from docs/trader/paper-activation-handoff-2026-09-09.md and
docs/trader/bitcoin-research-reset-2026-09-09.md. The stock mean-reversion paper
cohort is running at 0/100. Bitcoin candidates v1-v5 and the exploratory XGBoost
candidate failed and must remain inactive. Keep live trading blocked. Deploy
the locally validated truthful Mission Control fixes, observe the first stock
paper lifecycle, and design the append-only operational event ledger from
docs/trader/live-mission-control-design-2026-09-09.md. Start any new Bitcoin
research family with a predeclared protocol; do not reuse the opened holdout or
activate a candidate that fails costs, stability, drawdown, or sample-size
requirements. Report exact cohort status and blockers in plain English.
```
