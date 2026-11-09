# PawTrader repair implementation

Goal: protected, recoverable paper execution and consistent, explicitly qualified performance/readiness data, with understandable degraded states.

Design follows review-2026-09-06.md. Keep current paper mode and risk ceilings. Do not activate paused strategies. The original no-deploy implementation boundary was superseded by the authorized rollout below.

## Deployed 2026-09-06

- Private origins pushed: brain/dashboard `5c3143b`, engine `4656022`; final rollout notes/ticker regression follow in a separate commit. No public mirror publication, version bump or tag.
- Stopped brain, then engine; SQLite online backups passed `quick_check`. Applied engine migration 0006 -> 0007. All 5,415 order records and position/fill row counts preserved; new intent columns/index verified; DB integrity passed.
- DB backups: each repo's `store/backups/pawtrader-20260906-1143/`. Dashboard source, public assets, build, env and prior PM2 dump backed up under `/opt/claudepaw-server/backups/pawtrader-20260906-1143/`. Credential-bearing backup files and active dashboard env have mode 600.
- Active engine is this Mac's `com.pawtrader.engine`, not the retired WSL instance. Brain is `com.claudepaw.app`. Both restarted successfully; broker authenticated, paper mode confirmed, reconciler not halted.
- Dashboard proxy still pointed at retired WSL. Installed `<home>/Library/LaunchAgents/com.pawtrader.dashboard-tunnel.plist`: launchd-managed SSH reverse forward `127.0.0.1:18200:127.0.0.1:8200` to the existing dashboard host. Remote listener is loopback-only; existing engine authentication retained. Changed only remote `TRADER_ENGINE_URL` to `http://127.0.0.1:18200`.
- Found competing systemd/PM2 dashboard supervisors after restart (`EADDRINUSE`). Kept the already-enabled `claudepaw-server.service`; stopped duplicate PM2 app and saved its stopped state. Future dashboard restart: `ssh root@localhost 'systemctl restart claudepaw-server'`. Do not run the legacy PM2 restart script against this deployment.
- Authenticated deployed status, positions, overview, gate-progress and broker-P&L endpoints returned 200. Remote engine health confirmed paper. New progress/accounting snapshots persisted automatically and synced after startup, then refreshed on the next five-minute tick. Existing Telegram trader channel has one configured operator.
- First snapshot: 114 completed entries, $219.92 realized P&L using recorded fees only. This is diagnostic paper history, not validated net profitability. Four of eight gate criteria passed; out-of-sample evidence, measured trial variance, degradation and evaluation cohort still block. Complete costs/ledger verification also missing.
- Schedule: every five minutes while the Mac/bot run; daily Telegram summary first tick at/after 17:00 Eastern (first scheduled Sep 6); weekly review Sunday 09:00 Eastern (next Sep 13). Delivery timing/retry/DST covered by tests; first scheduled daily production delivery has not occurred yet. Review progress Sep 13; no date-based or automatic live switch.
- Browser access: choose **Paw Trader** in the project selector, then **Trader**. All Projects intentionally excludes the trading page. Final browser check also caught an empty ticker claiming no positions during an outage; regression now distinguishes unknown holdings from confirmed empty holdings.
- Final verification caught scheduler tests inheriting real dashboard credentials and publishing fixture rows. `syncTraderTablesToServer` now returns before DB reads/network writes when `NODE_ENV=test`, with a dedicated configured-credentials regression. Resynced the authoritative local ledger; full rerun leaves 114 completed entries and eight gate criteria intact. Removed only confirmed fixture IDs and their linked rows from the dashboard mirror (9 signals, 88 decisions, 3 approvals); recoverable in remote `pre-fixture-cleanup.db`. No local trading DB rows removed.
- Final tests: 1,971 bot / 167 files, 588 server / 35 files, 579 engine = 3,138 passed. Bot build and JS syntax passed. Dashboard and forwarded engine reject unauthenticated requests with 401. Tunnel listens only on remote loopback. systemd dashboard is active with zero restarts since supervisor repair. Final graph rebuild: 11,188 nodes / 19,141 edges / 1,544 communities (existing parser/metadata warnings).
- Rollback: stop brain before engine changes. Preserve current DB/intent history; do not restore the pre-rollout DB over newer trading records. Prefer forward repair; migration downgrade is tested only on fixtures. Dashboard assets/source/build can be restored from the scoped backup; restart the systemd service. The tunnel can be stopped with `launchctl bootout gui/501/com.pawtrader.dashboard-tunnel`.

Live-readiness work remains: prospective evaluation/evidence producer, cost/ledger completeness, engine-aware provenance, emergency-exit policy and Bitcoin broker paper end-to-end verification. Crypto strategy remains paused. These checks report blockers; they do not implement missing evidence or guarantee profits.

## Authorized release and monitoring continuation

The operator subsequently authorized commit, push and deployment. Release success:
reviewed commits in both existing origins, migration 0007 applied to the active
local engine with verified backup, paper-mode health confirmed, dashboard and
brain running tested code, and recurring progress checks persisted across restarts.
Do not alter strategy activation, order sizes, live mode or readiness thresholds.

Monitoring design: reuse the five-minute trader scheduler, no additional AI calls.
Persist one read-only readiness snapshot per tick and send a daily summary on the
first tick at/after 17:00 America/New_York. Existing weekly Sunday 09:00 report
remains. Include mode/connectivity, accounting freshness, completed-entry delta,
unknown-order/exit counts, active/paused strategies, gate age and actual blockers.
Never equate a periodic check with new evidence or automatically enable live.
Persist delivery date only after successful send; retry failed delivery next tick.
Guard concurrent delivery in-process and use explicit Eastern calendar dates for DST.

Files: new progress-monitor.ts/tests, trader-scheduler.ts integration, server-sync.ts
snapshot key, index.html cache version, changelog and this runbook. Commands:
`LOG_LEVEL=silent npm test`, `npm run build`, `npm --prefix server test`,
`npm --prefix server run build`, companion `.venv/bin/pytest -q`, targeted Ruff,
`git diff --check`, explicit-file staging and conventional commits, origin pushes.
Inspect existing deploy scripts before execution; avoid their broad staging and
unrelated-process cleanup. Run equivalent scoped deployment steps with health checks.

Acceptance: daily delivery once per Eastern day, catch-up after a missed slot,
failure retries, stale/unknown data visible, no trading mutations from the monitor,
and live readiness still blocked when validation evidence is incomplete.

Release verification (before deployment): 1,968 bot tests / 166 files, 588 server
tests / 35 files, and 579 engine tests passed. Bot/server builds, TypeScript checks,
JS syntax and targeted engine Ruff passed. Two pre-existing server test-fixture
defects were corrected: inherited BOT_API_TOKEN in admin-only tests, and missing
task-audit helper mock in permission tests. No production auth logic changed.
The cold-start report now requires canonical current validation, preventing its
old 30-trade heuristic from independently declaring GO-LIVE READY. Mobile browser
fixture verified the new monitoring schedule and stale-accounting labels.
Code graph rebuilt: 11,186 nodes / 19,138 edges / 1,546 communities, with existing
extraction/metadata and optional SQL-parser warnings. Public mirror sync is excluded
from this release because these review/runbook files contain private trading data.

## Architecture and tasks

- [x] Preserve complete retry intents; expire stale/paused entries and terminate exhausted retries after reconciliation. Files: order-retry.ts and tests.
- [x] Correct single-trial DSR and require measured trial variance for multiple trials; reject invalid NAV. Files: metrics.ts, validation-gate.ts and tests.
- [x] Bind gate validity to age and current strategy/config fingerprint; block local entries when live eligibility is unknown or halt fails. Files: go-live-gate.ts, trader-scheduler.ts and tests.
- [x] Consolidate dashboard accounting on computeBrokerTruth, merge cumulative fills by broker ID, preserve recorded fees, include canceled partial fills, count completed entries once. Persist one snapshot per tick and sync to the server; no generated duplicate module. Files: go-live-gate.ts, server-sync.ts, status.ts and tests.
- [x] Make unknown/offline/stale UI states explicit; move readiness above activity, expose criterion details and cost warnings, distinguish orders from ideas. Files: server/public/app.js and dashboard-state.test.ts.
- [ ] Implement a versioned prospective evaluation registry and evidence producer. Current aggregate is diagnostic only: out-of-sample and evaluation-cohort criteria deliberately block. There is no manual override or fabricated evidence. Must bind strategy/rules/costs/window, collect trial Sharpe variance and trade-linked regimes, and use matched portfolio return conventions. The fingerprint currently covers brain config, not engine code/config.
- [x] Bound overlapping dashboard polling. Stop/time exits skip historical-data enrichment; further enrichment optimization remains optional.
- [x] Refresh momentum from current bars; reject stale position marks for price-based exits. Files: exit-evaluator.ts and tests. This does not replace native live protection.
- [x] Engine: durable idempotent intents, serialized buy/close reservation, unknown-acceptance recovery, Bitcoin paper request/data routing and rejection of unprotected live entries. Migration and deployment completed in the authorized rollout above.
- [x] Run trading tests/typechecks, server HTTP integration tests, engine tests and browser fixture screenshots; update changelog. Graph rebuild result recorded below.

## Second-slice design (full-access continuation)

Goal: one durable broker intent per decision, unknown acceptance never resubmitted, crypto paper requests supported without implying live protection.

- Engine migration 0007 adds nullable request hash and approved size to orders (old rows retained). New client IDs are deterministic; serialize reservation with SQLite BEGIN IMMEDIATE, compare replay payload, reserve pending close quantities, and commit before broker I/O. Identical requests return the original result; changed payloads conflict. Timeout/transient failure remains unknown until broker reconciliation; no automatic replay.
- Paper crypto uses existing Alpaca execution account, simple GTC orders and fractional quantity. Do not route paper requests to production Coinbase. Reject unprotected live entries. Price history routes slash-delimited pairs to the existing crypto data client.
- Tests: duplicate/conflicting requests, timeout/late acceptance, concurrent closes, migration upgrade/downgrade on fixtures, crypto request shape, encoded-slash historical prices. Run engine pytest, 102 previously blocked server integration tests, and existing brain tests. No production DB migration or deployment during coding.
- Brain recovery preserves unknown exit IDs. Partial exits keep their duplicate guard; terminal cancellations retain execution history. Stop/target decisions require positive position marks updated within 5 minutes; momentum uses current 21-bar history with an asset-specific freshness limit. Time exits do not require a price fetch.
- Next: prospective evaluation evidence producer and complete cost/ledger validation. These remain distinct from proving profitable performance.

Commands from ClaudePaw:

```sh
LOG_LEVEL=silent npx --no-install vitest run src/trader
npm run typecheck
npm --prefix server test -- src/trader-routes.test.ts src/trader-routes/
npm --prefix server run build
node --check server/public/app.js
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

Expected: targeted regressions reproduce review findings before fixes and pass afterward; existing relevant suites and typechecks pass. Test all network-dependent behavior with local fixtures. Browser screenshots require available browser permission and a safe preview; no production mutations.

Acceptance: retries keep protective prices; old intents cannot revive; unknown or expired evidence never passes readiness; accounting agrees across consumers; an outage cannot appear as a confirmed paper account or zero holdings. Full completion additionally requires tested engine fixes and end-to-end Bitcoin paper verification. Profitability must be assessed prospectively after those dependencies are satisfied.

## Full-access continuation verification

- Brain: 837 trading tests across 52 files passed; `npm run typecheck` and JS syntax check passed.
- Dashboard server: 102 tests across 5 files passed, including HTTP integration previously blocked by sandbox permissions; TypeScript build passed.
- Engine: `.venv/bin/pytest -q` — 579 passed, one existing `websockets.legacy` deprecation warning. Targeted Ruff checks passed for changed engine source, migration and fresh-price tests.
- Required code graph rebuild completed: 11,169 nodes, 19,089 edges, 1,541 communities. Existing extraction/metadata gaps and missing optional SQL parser remain; semantic labels were not refreshed. No graph query followed the rebuild. Both repo diffs pass `git diff --check`.
- Engine regressions cover identical/conflicting intent replay, concurrent submissions/closes, late acceptance lookup, timeout preservation, stream-fill-before-ACK ordering, pending-buy capacity, canceled partial fills, fresh-price validity, crypto routing and migration rollback.
- Browser: actual dashboard render functions/CSS verified through `node scripts/trader-ui-preview.mjs`, using synthetic paper/offline/stale data and 390px iframe screenshots. Warnings wrap and stale/offline distinctions remain visible. This isolates readiness/KPI changes; it is not a production account or end-to-end broker test.
- Skills used: build-with-goal for phased implementation/acceptance, debug-with-goal for reproduced regressions, graphify for architecture context, document-with-goal for source-aligned API/rollout notes.
- Full filesystem access is now available. No permissions blocker remains. No production DB migration, deployment, strategy activation, risk increase, broker order or live-mode change was performed.
- Rollout dependency: companion engine migration 0007 + code must precede new brain same-ID exit recovery. Deploy brain/dashboard together for the shared accounting snapshot. Engine contract documents the migration/rollback boundary.
- Still required before live readiness: frozen prospective strategy evaluation, engine-aware configuration provenance, complete fee/slippage and ledger validation, emergency-exit design under halted conditions, and authorized broker paper end-to-end verification. No profitability claim or readiness override.

## First-slice verification and deployment boundary

Historical record below: its permission limitations were resolved during the full-access continuation above.

- `LOG_LEVEL=silent npx --no-install vitest run src/trader`: 52 files, 830 tests passed (includes source-executed dashboard state tests).
- `npm run typecheck`, `npm --prefix server run build`, `node --check server/public/app.js`: passed.
- `npm --prefix server test -- src/trader-routes/status.test.ts`: 5 socket-free tests passed.
- HTTP route integration tests could not bind local listeners: `listen EPERM` on 127.0.0.1 / 0.0.0.0. Do not count the 89 skipped tests as passes. Browser dashboard inspection was permission-denied; screenshots/mobile layout remain unverified.
- Auth/project-scoping middleware remains in front of trader routes; snapshot sync remains bot/admin-only. No credentials included in config fingerprints; failed positions/accounting responses disclose only generic errors.
- No deployment, live-mode activation, strategy unpause, risk increase, or broker write performed. Deploy brain and dashboard together: until the first successful tick/sync, the new P&L endpoint deliberately returns unavailable. Do not deploy as a completed go-live solution: evaluation-cohort producer and engine repairs remain outstanding.
- Accounting is more consistent, not proven complete: archival partial-fill catch-up, actual fees, paper spread/slippage, missing opening lots and reconciliation against broker statements still need coverage. Snapshot failure preserves prior timestamp; stale threshold is 15 minutes.
- Companion `<trader-engine>` is read-only in this session. Resume with that directory writable to implement idempotent order intents, crypto-compatible order/data routing, and protected exits. Full access cannot be enabled by the agent itself.
- Required code graph rebuild completed: 11,188 nodes, 19,055 edges, 1,569 communities. Tool reported existing extraction/metadata gaps and missing optional SQL parser; semantic labels were not refreshed. No graph query used afterward.
