# Runbook: Multi-Operator Alert Routing

_Last updated: 2026-04-19 (Phase 6 Task 6)_

The Paw Trader broadcasts every alert, halt notice, timeout notice, and
approval card to a configured list of Telegram chat ids. Any operator on
the list can reply APPROVE, SKIP, PAUSE STRATEGY, or tap an inline button.
First tap wins -- the database claim is race-safe.

This runbook covers the precedence rules, how to add a new operator, and
what "best-effort" means for the broadcast.

## How the list is resolved

On bot start, `src/index.ts` picks the operator list in this order:

1. `OPERATOR_CHAT_IDS` env var (comma-separated) when it parses to at
   least one non-empty entry.
2. The `trader.telegram.allowed_chat_ids` credential (same comma-separated
   format) when the env var is unset or empty after trim.

If both are empty the trader scheduler does not start and the bot logs
`Trader scheduler not started: no trader Telegram chat id configured`.

The env var takes priority so an operator can rotate or extend the list
without touching the credential store. Setting `OPERATOR_CHAT_IDS=,,,`
(set but empty after trim) produces a warn line and falls through to the
credential list.

## Adding a new operator

Pick whichever surface is handier. Both require a bot restart to pick up.

### Option A -- env var override

1. Grab the operator's numeric chat id. They can send `/start` to
   `@userinfobot` on Telegram to look it up.
2. Edit the bot's `.env` file at `/Volumes/T7/Projects/ClaudePaw/.env`:

   ```
   OPERATOR_CHAT_IDS=111111111,222222222,333333333
   ```

3. Restart the bot with `npm run restart` from
   `/Volumes/T7/Projects/ClaudePaw`.
4. Confirm the bot logged the new list:

   ```
   grep "Trader scheduler wired" /tmp/claudepaw-*.log | tail -1
   ```

   Expect `operatorCount: 3, maskedIds: ["***5124","***4321","***6789"]`
   and `source: "OPERATOR_CHAT_IDS"`.

### Option B -- credential edit

Use this when you want the list to persist across env resets, or when
the env var is deliberately unset.

1. Open the credential store for the trader project. The simplest route
   is the dashboard Credentials page, but it can also be edited via the
   `cpaw credentials` CLI.
2. Update the `trader.telegram.allowed_chat_ids` field to the new
   comma-separated list.
3. Restart the bot. Confirm the same `Trader scheduler wired` log line
   with `source: "credential"`.

## Removing an operator

Drop their id from whichever list they appear on and restart. There is
no dashboard toggle for a single operator -- the list is the source of
truth.

## First-tap-wins on approvals

Every operator sees the same approval card with the same callback_data
encoding the `approval_id`. When any one of them taps a button:

1. `handleTraderButtonCallback` runs the claim UPDATE
   `WHERE responded_at IS NULL`.
2. The first tap sets `responded_at` and `response`; subsequent taps
   find zero changed rows and the handler returns null.
3. Only the winning tap fires the downstream dispatch.

This is tested in `src/trader/telegram-reply-handler.test.ts` by the
"returns null when approval already claimed (duplicate tap)" case, which
covers the multi-operator race directly: two calls for the same
approvalId, one wins, one returns null.

The same claim also protects text replies (`tryHandleApprovalReply`) so
a mix of button taps and `APPROVE` replies cannot double-execute.

## Best-effort delivery

The broadcast iterates the operator list serially and calls
`channelManager.send` / `sendWithKeyboard` per id. A single failing send
logs a warn line (`Trader operator broadcast failed for one recipient,
continuing`) and the loop proceeds to the next operator. The returned
promise resolves once every id has been attempted.

Consequences worth naming:

- If operator A's chat is rate-limited but operator B is fine, B still
  receives the alert. A misses it for this broadcast; the next tick
  retries the underlying trigger (halt alert dedup, timeout notice) per
  its own rules.
- If every operator fails (e.g. Telegram API is globally down), the
  scheduler logs N warn lines and continues. No exception propagates up.
- Serial iteration is deliberate. Channel managers already queue per-chat
  sends and sequential fan-out keeps log ordering predictable for audit.
  Operator counts are in the single digits so the wall-time cost is
  trivial.

## Log masking convention

Chat ids are masked to the last four characters in logs, prefixed with
`***`. Example: `531665124` becomes `***5124`. Short ids (four or fewer
chars) are logged unchanged because masking them would still reveal the
whole id. Use the masked forms when grepping live logs; only the bot
owner with DB access can map them back to real ids.

## Related source files

- `src/config.ts` -- `OPERATOR_CHAT_IDS` export (raw string, split by callers)
- `src/index.ts` -- resolution order and scheduler wire-in
- `src/trader/operator-broadcast.ts` -- `parseOperatorChatIds`, `maskChatId`, `makeOperatorSend`
- `src/trader/operator-broadcast.test.ts` -- unit tests for the helper
- `src/trader/telegram-reply-handler.ts` -- first-tap-wins claim logic
- `src/channels/telegram.ts` -- bot-wide allowlist that gates incoming replies
