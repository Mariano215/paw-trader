# Deprecation Timeline: PHASE1_* Aliases

This document tracked the removal plan for the `PHASE1_*` constant aliases
introduced during Phase 1 and retained through Phase 4 as a compatibility
shim. As of Phase 5 the aliases are gone.

## Background

Phase 1 established position sizing constants under the `PHASE1_` prefix. Phase 3
Task 6 renamed these constants to drop the phase prefix, reflecting that they are
now permanent system parameters rather than temporary scaffolding. The renamed
constants went live in both the brain (TypeScript) and the engine (Python). The
old names were kept as aliased exports tagged `@deprecated` to allow a safe
transition window through Phase 4.

## REMOVED in Phase 5 (2026-04-19)

All PHASE1_* aliases have been removed. This is a breaking change.

### Brain: `src/trader/approval-manager.ts`

| Removed alias | Canonical name | Value |
|---------------|----------------|-------|
| `PHASE1_DEFAULT_SIZE_USD` | `DEFAULT_SIZE_USD` | 200 |
| `PHASE1_BIGGER_SIZE_USD` | `BIGGER_SIZE_USD` | 250 |

### Brain: `src/trader/approval-sender.ts`

| Removed name | Replacement | Value |
|--------------|-------------|-------|
| `PHASE1_TRADE_COUNT_TARGET` | `TIER1_TRADE_COUNT_TARGET` (renamed in place; module-internal) | 30 |

The trade-count target was a local module constant rather than an exported
alias, so renaming it in place was the cleanest move. The accompanying
comment block explaining the link to `autonomy-ladder.ts:COLD_START_TRADES`
was preserved.

### Engine: `src/trader_engine/risk/position_sizer.py`

| Removed alias | Canonical name | Value |
|---------------|----------------|-------|
| `PHASE1_MAX_USD` | `DEFAULT_SIZE_USD` | 200.0 |

The corresponding equality test (`test_default_size_alias_matches_phase1_max`)
in `tests/test_position_sizer.py` was removed alongside the alias. Engine
test count dropped from 264 to 263 as a result.

### Test files updated

- `src/trader/approval-manager.test.ts` -- import + two assertions migrated to canonical names.
- `src/trader/telegram-reply-handler.test.ts` -- import + one assertion migrated to canonical names.

Brain test count remains 1255 (the swap was import-only, no tests were added
or removed).

## BREAKING CHANGE

```
BREAKING CHANGE: As of Phase 5, any external scripts, patches, or
tooling that imported PHASE1_DEFAULT_SIZE_USD, PHASE1_BIGGER_SIZE_USD,
or PHASE1_TRADE_COUNT_TARGET from src/trader/approval-manager.ts or
src/trader/approval-sender.ts will break. Migrate to the canonical
names:
- PHASE1_DEFAULT_SIZE_USD -> DEFAULT_SIZE_USD
- PHASE1_BIGGER_SIZE_USD -> BIGGER_SIZE_USD
- PHASE1_TRADE_COUNT_TARGET -> TIER1_TRADE_COUNT_TARGET (or inlined as 30)
```

The same applies to any external Python code that imported `PHASE1_MAX_USD`
from `trader_engine.risk.position_sizer`. Migrate to `DEFAULT_SIZE_USD`.

### Environment variables

There are no `PHASE1_*` environment variable names. The env var surface was
always `DEFAULT_SIZE_USD` (as a compile-time constant, not a runtime var). No
`.env` changes were required as part of this removal.

## Verification

After the Phase 5 removal both repos return zero matches:

```bash
# Brain: confirm no PHASE1_ references remain
grep -rn "PHASE1_" /Volumes/T7/Projects/ClaudePaw/src
# Expected: zero matches

# Engine: confirm no PHASE1_ references remain
grep -rn "PHASE1_" /Volumes/T7/Projects/Tech/trader-engine/src \
  /Volumes/T7/Projects/Tech/trader-engine/tests
# Expected: zero matches

# Run full test suites
cd /Volumes/T7/Projects/ClaudePaw && npm test
cd /Volumes/T7/Projects/Tech/trader-engine && pytest
```

## Timeline summary

| Phase | Action |
|-------|--------|
| Phase 1 | `PHASE1_*` constants introduced |
| Phase 3 Task 6 | Constants renamed; `PHASE1_*` aliases added with `@deprecated` |
| Phase 4 | Aliases documented; no production callers confirmed |
| Phase 5 (2026-04-19) | Aliases REMOVED from both repos; test files migrated to new names |

## Related source files

- `src/trader/approval-manager.ts` -- canonical brain-side constants (`DEFAULT_SIZE_USD`, `BIGGER_SIZE_USD`)
- `src/trader/approval-sender.ts` -- `TIER1_TRADE_COUNT_TARGET` (renamed module-internal const)
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/risk/position_sizer.py` -- canonical engine-side constant (`DEFAULT_SIZE_USD`)
- `src/trader/approval-manager.test.ts` -- migrated to canonical names
- `src/trader/telegram-reply-handler.test.ts` -- migrated to canonical names
- `/Volumes/T7/Projects/Tech/trader-engine/tests/test_position_sizer.py` -- alias-equality test removed
