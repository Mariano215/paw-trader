# PawTrader Mission Control — design and implementation plan

## Goal

Give the operator one truthful, responsive screen for reviewing positions, controlling resting orders, understanding the stock and Bitcoin pipelines, and seeing whether either strategy has earned the right to leave paper trading.

## Product principles

- Profit is an evidence claim, never a UI claim. Show corrected broker-backed P&L, evidence gaps, and blocked gates plainly.
- Control stays narrow. An admin can cancel one resting order after an inline two-step confirmation. The browser never receives engine or broker credentials.
- Empty and unavailable differ. A failed order or position query must render as unknown, not as zero exposure.
- “Live” describes account mode. Dashboard data is a near-live snapshot refreshed every five seconds.
- Stocks and Bitcoin get separate lanes because their market hours, broker readiness, and evidence differ.

## Research translated into design

- Alpaca order APIs expose open/closed filtering, pagination, and nested legs. Its trade update stream reports fills, partial fills, cancellations, and rejections. The first dashboard version uses the engine's durable order ledger on a five-second poll and leaves a clean upgrade path to pushed events.
- Coinbase's authenticated user channel sends an initial open-order snapshot followed by order and position updates. Heartbeats are required to keep subscriptions open. PawTrader will show Coinbase connectivity now, while a future engine-owned stream can replace polling without changing the UI model.
- TradingView puts positions and orders beside account equity and realized/unrealized P&L. PawTrader follows this operational grouping, then adds the controls and proof-of-edge state specific to autonomous trading.
- Grafana-style event annotations make a performance line useful: fills, halts, and deploys should eventually be correlated with the NAV curve. This slice adds the chart structure and baseline; durable event overlay is the next telemetry increment.

## Screen architecture

1. **Command header** — paper/live mode, engine and broker health, snapshot age, halt control.
2. **Money strip** — NAV, corrected net P&L, open P&L, completed round trips, active orders.
3. **Execution flow** — animated Market Data → Strategy → Committee → Risk → Broker → Reconcile stages. Animation indicates a fresh snapshot, not trade activity. Reduced-motion users get a static state.
4. **Performance field** — SVG NAV curve against the $100,000 starting-capital baseline, with explicit profit/loss delta.
5. **Order blotter** — resting orders first, recent terminal orders second, stock/Bitcoin badges, fill progress, and an admin-only two-step cancel control.
6. **Exposure book** — open positions split by stock and crypto, including quantity, average entry, value, and unrealized P&L.
7. **Evidence lanes** — independent Stocks and Bitcoin status. Each says paper/live, paused/running, actual execution count, profitability evidence, and blockers.
8. **Activity rail** — newest signals, decisions, broker orders, and reconcile state; timestamps and source labels expose where work is happening.

## Contracts and security

### Dashboard server

- `GET /api/v1/trader/orders?status=open|closed|all&limit=200&offset=0` proxies bounded, filtered pagination. Mission Control fetches up to 500 open orders independently from the latest 20 terminal orders, so recent history cannot displace resting exposure. Engine/config failures return `503 { error: 'orders unavailable' }`.
- `POST /api/v1/trader/orders/:clientOrderId/cancel` requires `requireAdmin`, validates a 1–128 character client ID, and proxies the cancellation to the engine. Errors are logged server-side and returned generically.

### Trader engine patch

- `POST /orders/{client_order_id}/cancel` loads the durable order by client ID.
- Missing order → 404. Missing broker ID → 409. Terminal order → 200 with `submitted: false`.
- A successful broker request stores `pending_cancel` and commits before returning.
- A broker false result re-reads nothing and returns current status with `submitted: false`; unexpected failures return a generic 502.
- Cancellation routes through the order's source adapter. In the current engine process the shared execution adapter is Alpaca; Bitcoin cancellation remains unavailable until the engine owns a shared Coinbase execution adapter. The UI exposes that limitation rather than routing a crypto order to the wrong broker.

## Files

- `server/src/trader-routes/status.ts` — order read and cancel contracts.
- `server/src/trader-routes/status.test.ts` — proxy, validation, auth-chain, and fail-closed tests.
- `server/public/app.js` — Mission Control state, renderers, polling, cancel interaction.
- `server/public/style.css` — responsive visual system and reduced-motion behavior.
- `CHANGELOG.md` — user-facing behavior.
- `patches/trader-engine-order-control.patch` — engine endpoint and tests for the adjacent repository.

## Build tasks

1. Add server order contract and targeted tests.
2. Build and test the engine cancellation endpoint in a scratch checkout; export an apply-ready patch.
3. Replace the old ticker-first page shell with Mission Control while preserving existing committee/history detail below it.
4. Add semantic status, unavailable states, keyboard-capable two-step cancellation, responsive layout, and reduced-motion CSS.
5. Run server tests, root typecheck/build, relevant trader tests, and the full engine suite in scratch.
6. Start the dashboard locally and verify desktop/mobile screenshots and cancellation unavailable/safe states.
7. Rebuild Graphify after code changes.

## Exact verification commands

```bash
(cd server && npm test -- --run src/trader-routes/status.test.ts)
npm run typecheck
npm run build
npx vitest run src/trader server/src/trader-routes

# In an isolated trader-engine copy with the generated patch applied
.venv/bin/pytest -q tests/test_api_endpoints.py
.venv/bin/pytest -q

python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

Expected: all tests and builds pass; `/orders` failures remain visibly unavailable; only admins reach cancellation; cancel retries never create orders; mobile layout has no horizontal page overflow; reduced-motion disables continuous movement.

## Acceptance criteria

- The operator can see every currently resting engine order and cancel one without leaving PawTrader.
- Cancel needs two deliberate clicks and shows pending/success/failure state.
- Stocks and Bitcoin appear as separate operational and evidence lanes.
- The page never labels a five-second snapshot as streaming market data.
- The current loss and missing prospective evidence remain visible; nothing automatically enables live trading.
- Browser credentials stay limited to the dashboard session; engine and broker secrets remain server-side.
