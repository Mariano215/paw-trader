# Legacy ungraded-closure quarantine

## Goal

Keep 149 pre-cohort verdict-less closures for audit while preventing them from being reported as failures of the active stock and Bitcoin paper cohorts.

## Architecture

`trader_decisions.cohort_id IS NULL` is the existing authoritative legacy boundary. Monitoring will expose two counts:

- `closed_without_verdict`: actionable cohort-linked closures only.
- `legacy_closed_without_verdict`: retained pre-cohort closures, informational only.

Weekly reporting will apply the same boundary. No decisions, fills, P&L, or verdicts are deleted or invented.

## Files

- `src/paws/collectors/trader-pipeline-health.ts`: split actionable and legacy counts.
- `src/paws/trader-pipeline-watchdog.ts`: state the cohort-only invariant.
- `src/trader/weekly-report.ts`: split active all-time and quarantined legacy totals.
- Relevant tests.

## Tasks

1. Back up and audit the DB population.
2. Implement cohort-aware counts.
3. Add tests proving legacy rows do not trigger current failures and cohort rows do.
4. Run focused tests, build, update Graphify, and restart the local bot.
5. Force-run the watchdog and verify the actionable count is zero while the legacy count is 149.

## Commands and expected results

- Focused Vitest suites: pass.
- `npm run build` and `npm --prefix server run build`: pass.
- Forced watchdog cycle: `closed_without_verdict=0`, `legacy_closed_without_verdict=149`.

## Acceptance criteria

- Both paper cohorts remain running.
- No historical row is deleted or assigned a fabricated verdict.
- New cohort-linked verdict-less closures remain severity-3 alerts.
- Live trading remains blocked.
