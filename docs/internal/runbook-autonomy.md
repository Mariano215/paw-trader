# Runbook: Autonomy Ladder

The autonomy ladder gates per-trade position size based on a strategy's live track
record. It prevents a new or struggling strategy from deploying full capital before
it has earned that trust. The committee still sets a `size_usd` recommendation; the
ladder applies a final prudent multiplier before the order reaches the engine.

## How it works

Three tiers are computed per strategy at dispatch time:

| Tier | Condition | Scale |
|------|-----------|-------|
| cold-start | `trade_count < 30` (no track record yet) | 0.25 |
| tier-0 | Past cold-start but any guardrail tripped | 0.50 |
| tier-1 | Past cold-start, all guardrails clear | 1.00 |

**Tier-0 guardrails** (any one trips the strategy to 0.50x):

- `rolling_sharpe <= 0` (per-trade Sharpe, not annualised)
- `max_dd_pct < -0.10` (cumulative net PnL curve declined more than 10% from peak)
- 3 or more of the last 5 thesis grades are C or D

The scale is applied in `decision-dispatcher.ts` as:

```
sizeUsd = round(committeeSize * tier.scale, 2)
```

The engine then re-applies its own hard cap (`DEFAULT_SIZE_USD = $200`) and NAV
cap (20% of NAV), whichever is lower. The ladder scale comes first, so a cold-start
strategy at 0.25x with a $200 committee recommendation results in a $50 order sent
to the engine.

The track record is materialised in `trader_strategy_track_record`. It is recomputed
after every verdict close-out (see `track-record.ts`). The ladder reads the current
row fresh on each dispatch call -- no caching.

## Override procedure

**Halt a strategy immediately** (no new signals dispatched):

```sql
UPDATE trader_strategies
SET status = 'paused', updated_at = unixepoch() * 1000
WHERE id = 'your-strategy-id';
```

The dispatcher checks `trader_approvals -> trader_signals -> strategy_id` and
will still process in-flight approvals that arrived before the pause, but no new
approval cards will be created for that strategy.

To resume:

```sql
UPDATE trader_strategies
SET status = 'active', updated_at = unixepoch() * 1000
WHERE id = 'your-strategy-id';
```

**Force a tier** (operational escape hatch, not recommended for production):

The simplest lever is to directly edit the `trader_strategy_track_record` row.
For example, to manually pin a strategy to tier-0 scale without pausing it:

```sql
UPDATE trader_strategy_track_record
SET rolling_sharpe = -0.01
WHERE strategy_id = 'your-strategy-id';
```

Reverting to the true computed value: run `recomputeAllTrackRecords()` from a
maintenance script or call the track-record module directly:

```bash
cd /Volumes/T7/Projects/ClaudePaw
node -e "
const db = require('better-sqlite3')('./store/claudepaw.db');
const { recomputeAllTrackRecords } = require('./dist/trader/track-record.js');
console.log(recomputeAllTrackRecords(db));
"
```

## Verification

**Check current tier for all strategies:**

```sql
SELECT
  s.id,
  s.status,
  t.trade_count,
  t.rolling_sharpe,
  t.max_dd_pct,
  t.computed_at
FROM trader_strategies s
LEFT JOIN trader_strategy_track_record t ON t.strategy_id = s.id
ORDER BY s.id;
```

**Confirm the ladder fired on a recent decision:**

```bash
# Look for 'Autonomy ladder applied' in the bot log
journalctl -u com.claudepaw.app --since "1 hour ago" | grep "Autonomy ladder"
# or from stdout log:
grep "Autonomy ladder" /tmp/claudepaw-*.log | tail -20
```

Each log line includes: `tier`, `scale`, `rawSize`, `sizeUsd`, `reason`. A cold-start
strategy should show `scale: 0.25`.

**Recent thesis grades for a strategy** (feeds the C/D guardrail):

```sql
SELECT v.thesis_grade, v.closed_at
FROM trader_verdicts v
JOIN trader_decisions d ON d.id = v.decision_id
JOIN trader_signals s ON s.id = d.signal_id
WHERE s.strategy_id = 'your-strategy-id'
ORDER BY v.closed_at DESC
LIMIT 10;
```

Dashboard: `http://localhost:3000/#trader/strategy/:id` shows the track record
card including current tier and scale.

## Related source files

- `src/trader/autonomy-ladder.ts` -- tier logic and constants (`COLD_START_TRADES`, thresholds)
- `src/trader/decision-dispatcher.ts` -- applies the ladder at dispatch time
- `src/trader/track-record.ts` -- materialises `trader_strategy_track_record`
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/risk/position_sizer.py` -- engine-side cold-start rule (must stay in sync with brain constants)
