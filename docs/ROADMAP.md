# Roadmap

Paw Trader is being extracted from ClaudePaw in three phases. This is the current plan and its state.

## Phase 1: Public mirror (current)

**Status: in progress.**

Goals:

- Sanitized mirror of the full trader stack pushed to `github.com/Mariano215/paw-trader`
- OSS readers can browse the architecture, understand the model, and open issues
- PRs against this repo are reviewed and applied back to the private ClaudePaw source
- Clear disclaimers in place: not runnable standalone yet, paper-only, no financial advice

What this phase does NOT do:

- Make the repo standalone-runnable
- Publish an npm package
- Document a plugin install path
- Accept direct GitHub merges

## Phase 2: Plugin framework

**Status: planned.**

Build the extension surface inside ClaudePaw that a real plugin needs. Today ClaudePaw's plugin loader is a manifest + prompt stub. Phase 2 extends it with:

- `registerSchema(migrations)` — plugins declare their own SQLite schemas
- `registerRoutes(router)` — plugins mount Express routes under the dashboard API
- `registerScheduler({ tick, intervalMs })` — plugins run their own tick loops
- `registerDashboardPage({ id, html, js, css })` — plugins contribute dashboard UI
- `registerProject({ id, agents })` — plugins declare a project scope + agent roster

Also:

- A public `@claudepaw/core` module that exposes `logger`, `credentials`, `costGate`, `channelManager`, `agentRunner`, and `db`. Plugins import from this surface instead of reaching into ClaudePaw's relative module paths.
- A v2 plugin manifest with a `dependencies` array for core-version compatibility checks.

This phase is done inside ClaudePaw, not in this repo, but it unblocks Phase 3.

## Phase 3: Real extraction

**Status: planned.**

Flip this repo from "code mirror" to "primary dev location" for Paw Trader.

- Rewrite trader imports to use `@claudepaw/core` instead of `../logger.js`, `../agent.js`, etc.
- Move trader tests out of the main ClaudePaw vitest run; run them inside this repo
- Ship as an installable plugin: either `npm install @paw-trader/plugin` inside ClaudePaw, or a git submodule at `plugins/paw-trader/`
- ClaudePaw's plugin loader auto-discovers, calls the registration hooks, and lights up the trader
- ClaudePaw's `sync:oss` stops copying trader code (it lives here now)
- Standalone paper-trading demo harness lands in this repo so contributors can run `npm run demo` against a fake broker without ClaudePaw

When Phase 3 ships, contributions flow normally: open a PR against this repo, merge on approval.

## Beyond Phase 3

Open questions and possible future directions:

- **Second engine backend.** The current engine is a Python service. A TypeScript-native engine could live inside the plugin and eliminate the RPC layer for simpler deploys.
- **Broker adapters.** Alpaca is the default. IBKR, Tradier, and crypto venues are plausible adds.
- **Live-money promotion UX.** A structured workflow for moving a strategy from paper to live with the autonomy ladder + track record gates surfaced in the dashboard.
- **Strategy marketplace.** If a few third parties ship strategies, a "registered strategies" index in the dashboard becomes useful.
- **Cross-strategy portfolio risk.** Today each strategy has its own circuit breakers. A portfolio-wide exposure budget is the next layer.

These are maybe-someday. Phase 3 is the committed work.
