# Runbook: NAV Drop Halt

_Last updated: 2026-04-19 (Phase 5 Task 2 Dispatch C)_

The NAV drop monitor is the last line of defence against a runaway drawdown.
When it fires, the engine is halted automatically and a plain-text Telegram
goes to the operator.

## What triggers the alert

On every 5-minute scheduler tick the brain pulls the most recent NAV
snapshots via `GET /nav/snapshots?limit=10` and compares the current
snapshot against the **oldest snapshot inside a 7-day window**. Fire
conditions:

- The drop crosses `TRADER_NAV_DROP_PCT` (default `0.05` = 5%).
- The last fire was more than 24 hours ago (24h dedup, so a sustained
  drawdown does not page you every 5 minutes).

On fire, the scheduler does three things in order:

1. Sends a Telegram alert via the operator channel.
2. Writes `trader_alert_state.nav_drop_alert.last_alerted_at = now_ms`.
3. Calls `POST /risk/halt` on the engine with the alert message as the
   reason.

If the halt POST itself throws, a follow-up Telegram fires: `"NAV drop
detected but engine halt call failed. Investigate immediately."` The
dedup row is still written -- we do not retry the halt every tick.

## What the engine halt does

`POST /risk/halt` trips the `kill_switch` circuit breaker:

- New orders stop reconciling out of the engine queue.
- Position + order sync with the broker keeps running.
- `/health` flips `reconciler_halted: true` with the reason string.

The halt is idempotent; calling it twice sticks on the first trip.

## First 5 minutes after the alert

1. Read the Telegram. Exact shape:

   `NAV drop halt: $10000.00 -> $9400.00 (-6.0%, threshold -5.0%) over 7 days. Engine halted via /risk/halt.`

   Both NAV values are day-open snapshots. The threshold annotation is
   your live `TRADER_NAV_DROP_PCT` (or 5% if unset).

2. Confirm the halt. There is no dedicated halt-status route; halt
   state is surfaced on `/health`:

   ```bash
   curl -sS -H "X-Engine-Token: $ENGINE_TOKEN" "$ENGINE_URL/health" \
     | python3 -m json.tool
   ```

   Expect `reconciler_halted: true` and a NAV-drop reason. The
   circuit-breaker view is at `/risk/state`; expect
   `"tripped": ["kill_switch"]`.

3. Open the dashboard NAV chart at
   `http://localhost:3000/#trader/nav` to see whether it is a
   single bad day or a slow leak across the week.

4. Cross-reference `docs/trader/runbook-autonomy.md`. The ladder may
   already have tier-0ed strategies before the halt; the halt is a
   second-layer stop, not the first one.

## Manual clear procedure

Only clear after you have confirmed the drop is a known event (paper
drift, a specific bad trade, a funding event) and not an active bug.

```bash
# Clear the circuit breaker.
curl -sS -X POST -H "X-Engine-Token: $ENGINE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rule": "kill_switch"}' \
  "$ENGINE_URL/risk/clear"

# If the in-memory trading_halted flag is also set, clear it too.
curl -sS -X POST -H "X-Engine-Token: $ENGINE_TOKEN" \
  "$ENGINE_URL/risk/clear-halt"
```

Verify:

```bash
curl -sS -H "X-Engine-Token: $ENGINE_TOKEN" "$ENGINE_URL/health" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('halted:', d['reconciler_halted'])"
```

Expect `halted: False`. The brain-side dedup row is intentionally left
in place so the monitor does not immediately re-halt if NAV is still
depressed. After 24 hours the dedup window expires; if NAV has not
recovered, the monitor will halt again.

## Tuning the threshold

Set `TRADER_NAV_DROP_PCT` as a decimal, positive fraction down from
the comparison:

| Value | Meaning                   | When to use                              |
|-------|---------------------------|------------------------------------------|
| 0.03  | 3% -- aggressive          | Small book, tight risk, regime fear      |
| 0.05  | 5% -- default             | Normal operating posture                 |
| 0.10  | 10% -- very permissive    | Paper trading, shadow-mode tuning        |

Two places to set it:

- **Bot host (MacBook Pro)**: edit launchd plist env or `~/.zshrc`,
  then `npm run restart` from `/Volumes/T7/Projects/ClaudePaw`.
- **Engine host**: edit `/etc/trader-engine.env`,
  `systemctl restart trader-engine`.

The monitor reads the env on every call. A malformed value (e.g.
`TRADER_NAV_DROP_PCT=banana`) falls back silently to 5% and the brain
logs a warning.

## Verification

**Replay the check in isolation**:

```bash
cd /Volumes/T7/Projects/ClaudePaw
node -e "
const Database = require('better-sqlite3');
const { evaluateAndRecordNavDrop } = require('./dist/trader/monitor.js');
const { EngineClient } = require('./dist/trader/engine-client.js');
const db = new Database('./store/claudepaw.db');
const client = new EngineClient({ baseUrl: process.env.ENGINE_URL, token: process.env.ENGINE_TOKEN });
(async () => {
  const r = await evaluateAndRecordNavDrop(db, Date.now(), () => client.getNavSnapshots(10));
  console.log(JSON.stringify(r, null, 2));
})();
"
```

A healthy system prints `{"fire": false, "halt": false}`.

**Inspect the dedup row**:

```bash
sqlite3 /Volumes/T7/Projects/ClaudePaw/store/claudepaw.db \
  "SELECT alert_id, last_alerted_at, datetime(last_alerted_at/1000, 'unixepoch') AS iso_time FROM trader_alert_state WHERE alert_id='nav_drop_alert';"
```

A row means a halt fired in the last 24 hours. Empty means no recent
halt.

## Related source files

- `src/trader/monitor.ts` -- `evaluateAndRecordNavDrop`, `NAV_DROP_*` constants
- `src/trader/trader-scheduler.ts` -- phase 6 wire-in, halt call, follow-up notice
- `src/trader/engine-client.ts` -- `getNavSnapshots(limit)`, `haltEngine(reason)`
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/api/routes/risk.py` -- `/risk/halt`, `/risk/clear`, `/risk/clear-halt`
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/api/routes/nav.py` -- `/nav/snapshots`
