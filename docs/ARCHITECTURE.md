# Architecture

Paw Trader is a multi-agent trading system that sits between a signal source (a Python engine running strategies) and a broker (Alpaca in paper mode). This doc describes how the pieces fit together.

## High-level flow

```
  ┌────────────────┐
  │  Engine (py)   │  Runs strategies on a cron tick, emits candidate signals
  └───────┬────────┘
          │   GET /signals/pending
          ▼
  ┌────────────────┐
  │ signal-poller  │  Fetches new signals, writes to trader_signals
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │   committee    │  Quant + Risk + Sentiment + Macro + Fundamentalist
  │                │  + Trader + Coordinator (two rounds, JSON on the wire)
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │ decision-dispatcher │  Writes trader_decisions; checks autonomy ladder
  └───────┬──────────────┘
          │          Above threshold? Auto-execute.
          │          Below threshold? Telegram approval card.
          ▼
  ┌────────────────┐
  │ approval-mgr   │  Waits for operator reply / button press / timeout
  └───────┬────────┘
          ▼
  ┌────────────────┐
  │    engine      │  POST /orders (paper or live, depending on config)
  └───────┬────────┘
          ▼
  ┌─────────────────┐
  │ close-out-watcher│  Polls positions; closes on stop / take-profit / halt
  └─────────────────┘
```

Cross-cutting:

- **monitor** — Sharpe, NAV, circuit breakers, health polling. Emits alerts.
- **kill-switch** — global halt. Trips from cost caps, NAV drops, manual operator.
- **reasoning-bank** — records verdicts + outcomes for learning loops (Phase 8).
- **weekly-report** — rolls up per-strategy track record, committee transcripts, PnL.

## Modules (engine/)

| Module | Purpose |
|---|---|
| `engine-client.ts` | HTTP client to the Python engine (health, signals, orders, positions, risk) |
| `signal-poller.ts` | Polls engine for new signals on each tick |
| `committee.ts` | Runs the multi-agent review: two rounds of role prompts, JSON structured outputs, coordinator synthesis |
| `strategy-manager.ts` | Seeds and manages the strategy table; maps signals to strategies |
| `autonomy-ladder.ts` | Thresholds for when the system can act alone vs. need approval |
| `decision-dispatcher.ts` | Turns a committee verdict into an action; writes audit rows; applies kill switch + autonomy gates |
| `approval-manager.ts` | Coordinates Telegram approval cards: state machine, timeouts, replay protection |
| `approval-sender.ts` | Builds the approval card body and inline keyboard |
| `telegram-reply-handler.ts` | Parses "approve" / "skip" / inline-button responses |
| `operator-broadcast.ts` | Fanout to multiple operator chats (for team coverage) |
| `close-out-watcher.ts` | Polls open positions, triggers closes on stop-loss / take-profit / global halt |
| `monitor.ts` | Sharpe + NAV + health check observability; alerts on degradation |
| `verdict-engine.ts` | Records final verdicts for the reasoning bank |
| `reasoning-bank.ts` | Stores committee transcripts + verdicts for replay and learning |
| `track-record.ts` | Per-strategy performance rollup |
| `weekly-report.ts` | Weekly HTML digest delivered to the operator |
| `trader-scheduler.ts` | The 5-minute tick loop; orchestrates all of the above |

## Server routes (server/routes/)

HTTP surface that backs the ClaudePaw dashboard and internal APIs. All routes live under `/api/v1/trader/*` in the parent dashboard.

| File | Purpose |
|---|---|
| `index.ts` | Route registration |
| `shared.ts` | Common helpers: engine fetch proxy, auth, project-scoped DB access |
| `status.ts` | Engine health + position + NAV endpoints |
| `strategies.ts` | List + attribution + track record |
| `committee.ts` | Committee transcripts for a decision |
| `verdicts.ts` | Verdict history, outcomes |
| `audit-log.ts` | Kill-switch audit trail |
| `attribution-aggregator.ts` | Roll-up of PnL attribution by strategy |

## Database tables

Paw Trader owns these tables. In the ClaudePaw monorepo today they share the main SQLite DB. Phase 3 will move them to a dedicated trader DB.

- `trader_strategies` — strategy definitions, live/paper mode, autonomy tier
- `trader_signals` — raw candidates from the engine
- `trader_decisions` — committee-synthesized decisions (approve / reject / size)
- `trader_committee_transcripts` — per-agent opinions and scores
- `trader_approvals` — Telegram approval state
- `trader_verdicts` — post-execution outcome + attribution
- `trader_strategy_track_record` — running performance by strategy
- `trader_circuit_breakers` — tripped / armed / threshold state
- `trader_pnl_snapshots` — rolling NAV + PnL history
- `trader_reasoning_bank` — learning-loop storage

## Integration with ClaudePaw (today)

Paw Trader imports from ClaudePaw core:

- `../logger.js` — Pino logger
- `../config.js` — Env-driven config, operator chat IDs
- `../credentials.js` — AES-256-GCM encrypted credential store for broker + engine tokens
- `../cost/kill-switch-client.js` — Global kill switch with fail-closed cache semantics
- `../agent.js` — `AgentResult` type for committee agent invocations

The ClaudePaw Telegram channel manager delivers approval cards. The ClaudePaw scheduler hosts the trader tick. The ClaudePaw dashboard renders the UI.

Phase 3 replaces these relative imports with a public `@claudepaw/core` plugin API.

## Agents

Seven committee personas plus an orchestrator. Each is a Markdown prompt under `agents/`. The shipped versions in this repo are sanitized starter prompts, not the exact production tuning.

- `committee-coordinator.md` — Synthesizes the round, decides which concerns to challenge, writes the final verdict
- `committee-quant.md` — Technical read: price action, volume, momentum, volatility
- `committee-risk-officer.md` — Position sizing, stop/limit sanity, portfolio exposure
- `committee-sentiment.md` — News/social sentiment (requires a sentiment enrichment in the signal)
- `committee-macro.md` — Macro regime and cross-asset context
- `committee-fundamentalist.md` — Fundamentals for single-name signals
- `committee-trader.md` — Execution plan: entry, stop, target, sizing
- `orchestrator.md` — Phase 0 health monitor / overall agent

## Operational controls

Paw Trader ships with aggressive safety defaults:

- **Paper-only by default.** Live-money promotion is a gated, multi-step operator action.
- **Autonomy ladder.** Each strategy starts at the lowest autonomy tier and earns escalation via track-record gates.
- **Kill switch.** Both per-strategy circuit breakers and a global halt exist. Tripping either stops new orders and (for global) triggers close-outs.
- **NAV drop triggers.** Runbook in `docs/internal/runbook-nav-drop.md` documents the escalation.
- **Approval timeouts.** If the operator doesn't respond to an approval card within the configured window, the signal expires rather than auto-executing.
- **Cost caps.** Above a daily / monthly LLM spend cap, the ClaudePaw cost gate downgrades to a cheaper model then halts entirely.
