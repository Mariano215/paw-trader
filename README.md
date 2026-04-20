# Paw Trader

An autonomous agentic trading system built on Claude: multi-agent committee review, risk gating, kill switches, Telegram approvals, strategy track records.

## What this repo is (Phase 1 status)

**This is a sanitized code mirror of the Paw Trader module from ClaudePaw. It is not yet runnable on its own.** Phase 3 of the roadmap will make it an installable add-on for any ClaudePaw instance. Until then:

- Read the code
- Read `docs/ARCHITECTURE.md` for how it's put together
- Read `docs/ROADMAP.md` for what's coming
- Open issues with feedback or questions
- Send PRs if you spot bugs or want to propose improvements

PRs against this mirror are reviewed and, if accepted, applied inside the ClaudePaw private repo; the next mirror sync pushes the merged change back here. See `CONTRIBUTING.md`.

## What Paw Trader does

Paw Trader sits between a signal source (a Python engine that runs strategies like SPY Bollinger + RSI) and a broker (Alpaca in paper mode today). For each candidate signal:

1. A committee of specialized agents reviews the trade (quant, risk officer, sentiment, macro, fundamentalist, trader, coordinator)
2. The coordinator synthesizes a decision with a confidence score
3. Above an autonomy threshold the decision executes automatically; below, it sends a Telegram approval card to the operator
4. Approved decisions are dispatched to the engine which places the order
5. A monitor watches NAV, Sharpe, circuit breakers, and a global kill switch. If anything trips, positions close out and new orders halt.
6. A weekly report summarizes the strategy's track record

## Directory layout

```
engine/          Core trading logic: committee, monitor, approval manager,
                 scheduler, verdict engine, reasoning bank, weekly report
server/routes/   HTTP routes that back the dashboard + internal APIs
server/ui/       Dashboard UI code, sliced from the ClaudePaw SPA
agents/          Committee agent prompt templates (sanitized starter versions)
paws/            "Paws" (persistent agent loops) specific to the trader
docs/internal/   Runbooks: autonomy ladder, NAV-drop response, regime handling
scripts/         Backfill + maintenance utilities
```

## Current state

- **Phase 7 shipped** (observability + live paper-trading arm for SPY Bollinger/RSI)
- **Phase 8 in design** (QQQ momentum breakout, live-money promotion procedure, mobile dashboard, hardening)

## License

MIT. See `LICENSE`.

## Disclaimer

Trading carries risk of financial loss. This code is for educational and research use. See `DISCLAIMER.md` before doing anything that touches real money.
