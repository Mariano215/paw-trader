# Committee agent prompts

The seven committee personas plus the orchestrator are defined as Markdown prompt files in this directory. Each file is the system prompt for that agent when it's invoked on a signal.

## Roster

| File | Role |
|---|---|
| `committee-coordinator.md` | Runs the rounds, challenges concerns, synthesizes the verdict |
| `committee-quant.md` | Technical read: price action, volume, momentum, volatility |
| `committee-risk-officer.md` | Position sizing, stop/target sanity, portfolio exposure |
| `committee-sentiment.md` | News and social sentiment |
| `committee-macro.md` | Macro regime and cross-asset context |
| `committee-fundamentalist.md` | Fundamentals for single-name signals |
| `committee-trader.md` | Execution plan: entry, stop, target, sizing |
| `orchestrator.md` | Phase 0 health monitor / overall agent |

## What's in this repo

**These prompts are sanitized starter templates**, not the exact prompts running in production. They keep the roles, the expected output format, and the behavioral guardrails, but the specific tuning and any operator-personality details have been stripped.

You should expect to:

- Reword prompts to match your risk tolerance and trading style
- Tighten or loosen the concerns each role focuses on
- Add your own broker-specific or asset-class-specific rules
- Customize the coordinator's synthesis heuristics

## Output format contract

Every committee agent returns a single-line JSON object. The coordinator consumes these and emits the final verdict. If you change a prompt, do not break this contract or the JSON parser in `engine/committee.ts` will reject the response and the decision will fail closed.

Minimal required keys per role:

```jsonc
// Quant, risk-officer, sentiment, macro, fundamentalist, trader
{
  "role": "quant",                    // one of the role slugs
  "opinion": "...",                   // 2-3 sentence read
  "confidence": 0.72,                 // 0..1
  "concerns": ["..."]                 // short, scannable
}

// Coordinator (final verdict)
{
  "role": "coordinator",
  "decision": "approve" | "reject" | "defer",
  "confidence": 0.68,
  "position_size": 0.01,              // fraction of NAV
  "thesis": "...",
  "concerns_addressed": ["..."]
}
```

See `engine/committee.ts` and `engine/types.ts` for the authoritative schemas.

## Security

Treat agent prompts as security surface. Adding unfiltered user content to a committee input is a prompt-injection vector. The coordinator in particular should not blindly trust role outputs; the current logic re-validates JSON shape and applies sanity checks before using the synthesized verdict.
