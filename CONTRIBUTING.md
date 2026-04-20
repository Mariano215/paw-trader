# Contributing to Paw Trader

Thanks for looking. Here's how contributions flow through this repo today.

## Current contribution model (Phase 1)

This repo is a read-only code mirror of the Paw Trader module that lives inside ClaudePaw. Development happens in the private ClaudePaw monorepo, and a sanitized copy is pushed here on each sync. That has a few implications:

- **You can open issues and PRs against the public repo.** Both are welcome and read.
- **PRs are merged via an offline apply step**, not a direct GitHub merge. The maintainer reviews the diff, applies the change inside ClaudePaw private, and the next `sync:paw-trader` push brings the commit back here. Your PR will be marked "merged via sync" with a link to the resulting public commit.
- **This is slower than a normal GitHub merge.** Expect days, not minutes. In exchange, your change lands in the real codebase where it runs today.

Once Phase 3 ships and paw-trader is the primary dev location, this flow switches to a standard PR-merge model.

## What makes a good PR right now

- **Small and focused.** Targeted bug fixes, doc improvements, obvious correctness issues.
- **Tests where it makes sense.** The repo ships vitest test files alongside the engine code. Keep them passing.
- **No new dependencies without discussion.** Open an issue first.
- **No formatting-only PRs.** Style is what it is until Phase 3.
- **No strategy proposals disguised as bug fixes.** Strategy design is a separate conversation; open an issue.

## What's likely to be rejected

- Live-money trading shortcuts. Anything that weakens paper-only defaults, skips the autonomy ladder, or shorts the kill-switch chain is a hard no.
- PRs that introduce broker-specific secrets, tokens, or hardcoded account numbers.
- PRs that broaden the agent prompt surface for prompt injection (adding unfiltered user content into committee inputs, for instance).

## Development basics

The code assumes a TypeScript + Node toolchain. If you want to build or run tests locally:

```bash
# Requires a minimal ClaudePaw-like environment (DB, credentials, engine URL).
# Phase 3 will include a standalone harness; for now, this is reference-only.
npm install
npm run test     # runs vitest against the engine/
npm run build    # type-checks
```

There is no `npm run dev` in the mirror yet. The engine does not boot standalone because it expects the ClaudePaw core services (scheduler, cost gate, Telegram channel, credentials).

## Code style

- No em dashes in prose (house style)
- No AI cliches in comments or doc copy
- TypeScript strict mode where it already applies
- Imports use `.js` suffixes (ESM TypeScript)
- Tests live beside the code they cover (`foo.ts` + `foo.test.ts`)

## Security

Security issues go to `mariano@matteisystems.com`, not a public issue. See `SECURITY.md`.

## Disclaimer

Read `DISCLAIMER.md` before wiring real money to anything here. Paper trading only, at your own risk.
