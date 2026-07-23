// src/trader/plain-english.ts
//
// Turns trader internals into messages a human can act on.
//
// The alerts used to read like this:
//
//   TRADER ALERT: Signal 8951a012-ab40-4d5d-a082-d3b995249b1a (AAPL buy)
//   rejected by engine and will not retry. Error: Engine API error 422 on
//   /decisions/submit :: {"detail":{"blocked_by":["market_closed"]}}
//
// Which says, in full: the stock market is shut. Nothing was wrong, nothing
// was lost, and there was nothing to do. An operator cannot triage a message
// like that, so every alert now answers three questions instead: what
// happened, whether it matters, and whether it needs them.
//
// Rules for anything added here:
//   - no UUIDs, no HTTP status codes, no JSON, no file paths
//   - no internal nouns: "engine", "dispatcher", "reconciler", "signal",
//     "decision", "committee" all have plain equivalents
//   - always state whether action is needed, even when the answer is no
//   - plain text only, per the Telegram rule in CLAUDE.md

/** Severity drives the lead-in word, so scanning a phone tells you enough. */
export type AlertLevel = 'info' | 'attention' | 'urgent'

export interface PlainAlert {
  level: AlertLevel
  /** One-line summary. */
  headline: string
  /** Optional second line explaining it in ordinary words. */
  detail?: string
  /** What the operator should do. Omitted when the answer is "nothing". */
  action?: string
}

/** Render a PlainAlert as the plain-text message sent to Telegram. */
export function renderAlert(a: PlainAlert): string {
  const lead = a.level === 'urgent' ? 'Trader (needs you)' : 'Trader'
  const lines = [`${lead}: ${a.headline}`]
  if (a.detail) lines.push(a.detail)
  lines.push(a.action ? `What to do: ${a.action}` : 'Nothing for you to do.')
  return lines.join('\n')
}

/** How a human would describe each engine refusal reason. */
const BLOCK_REASONS: Record<string, { why: string; level: AlertLevel; action?: string }> = {
  market_closed: {
    why: 'The stock market is closed right now.',
    level: 'info',
  },
  reconcile_drift: {
    why: 'Our record of what we own disagreed with the broker, so trading paused until they match.',
    level: 'info',
  },
  position_sizer: {
    why: 'The order size came out invalid, usually because the account value could not be read.',
    level: 'attention',
  },
  no_position: {
    why: 'It tried to sell something the account does not actually hold.',
    level: 'attention',
  },
  daily_loss_limit: {
    why: "Today's loss limit was already reached, so no more trades are allowed today.",
    level: 'attention',
  },
  max_drawdown: {
    why: 'The account is down far enough that the safety limit stopped new trades.',
    level: 'urgent',
    action: 'Have a look at the account before trading continues.',
  },
  kill_switch: {
    why: 'The manual stop switch is on, so nothing can trade.',
    level: 'attention',
    action: 'Turn the stop switch off when you want trading to resume.',
  },
}

/** Pull the blocked_by reasons out of an engine error string, if present. */
export function parseBlockReasons(errMessage: string): string[] {
  const m = errMessage.match(/"blocked_by"\s*:\s*\[([^\]]*)\]/)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/**
 * Explain why an order could not be placed.
 *
 * `willRetry` matters more to the operator than any error code: it is the
 * difference between "ignore this" and "we lost the trade".
 */
export function explainOrderRefused(
  asset: string,
  side: string,
  errMessage: string,
  willRetry: boolean,
): PlainAlert {
  const verb = side === 'sell' ? 'sell' : 'buy'
  const reasons = parseBlockReasons(errMessage)
  const known = reasons.map((r) => BLOCK_REASONS[r]).filter(Boolean)

  if (known.length > 0) {
    const worst =
      known.find((k) => k.level === 'urgent') ??
      known.find((k) => k.level === 'attention') ??
      known[0]
    return {
      level: willRetry ? 'info' : worst.level,
      headline: `did not ${verb} ${asset}`,
      detail: willRetry
        ? `${worst.why} It will try again automatically.`
        : worst.why,
      action: worst.action,
    }
  }

  // Unrecognised refusal: say so honestly rather than pasting the raw error.
  return {
    level: willRetry ? 'info' : 'attention',
    headline: `did not ${verb} ${asset}`,
    detail: willRetry
      ? 'The trading service turned the order down. It will try again automatically.'
      : 'The trading service turned the order down for a reason I do not have a plain description for yet.',
    action: willRetry ? undefined : 'No rush. Mention it to me if you see it more than once.',
  }
}

/** The trading service stopped responding. */
export function explainServiceDown(minutes: number, restartIssued: boolean): PlainAlert {
  return {
    level: minutes >= 60 ? 'urgent' : 'attention',
    headline: `the trading service stopped responding ${minutes} minutes ago`,
    detail: restartIssued
      ? 'I have restarted it automatically and will confirm shortly.'
      : 'Nothing can be bought or sold until it is back.',
    action: restartIssued
      ? undefined
      : 'If this is still here in an hour, tell me and I will look.',
  }
}

export function explainServiceBack(): PlainAlert {
  return { level: 'info', headline: 'the trading service is back. Trading has resumed.' }
}

/**
 * Our position records disagreed with the broker's.
 *
 * 'checking' is a real and common state, not a failure: the system waits a
 * tick to confirm a disagreement before acting on it, so that a momentary
 * blip is not treated as a lost position. Saying "I could not fix it" during
 * that window would send the operator chasing a problem that is still
 * resolving itself.
 */
export type MismatchState = 'healed' | 'checking' | 'stuck'

export function explainPositionMismatch(assets: string[], state: MismatchState | boolean): PlainAlert {
  const resolved: MismatchState =
    typeof state === 'boolean' ? (state ? 'healed' : 'stuck') : state
  const list = assets.length > 0 ? assets.join(', ') : 'some holdings'

  if (resolved === 'healed') {
    return {
      level: 'info',
      headline: 'fixed a mismatch in our position records',
      detail: `Our records for ${list} disagreed with the broker. I took the broker's numbers as correct and trading continued.`,
    }
  }
  if (resolved === 'checking') {
    return {
      level: 'info',
      headline: 'double-checking a mismatch in our position records',
      detail: `Our records for ${list} disagree with the broker. I am waiting to see the same thing again before changing anything, so a momentary glitch does not get treated as a real problem. Buying and selling is paused meanwhile.`,
    }
  }
  return {
    level: 'urgent',
    headline: 'our position records disagree with the broker and I could not fix it',
    detail: `The disagreement is on ${list}. Trading is paused until it is sorted out, so nothing new will be bought or sold.`,
    action: 'Tell me and I will investigate.',
  }
}

/** An order was sent but the broker has no record of it. */
export function explainLostOrder(asset: string, side: string, hours: number): PlainAlert {
  return {
    level: 'attention',
    headline: `an order to ${side === 'sell' ? 'sell' : 'buy'} ${asset} went missing`,
    detail: `It was sent ${hours} hours ago but the broker has no record of it, so it never reached the market. I have marked it failed and nothing was traded.`,
    action: 'Nothing right now. Tell me if you see this more than once.',
  }
}

/** Something unexpected broke while trying to trade. */
export function explainUnexpectedFailure(asset: string, side: string): PlainAlert {
  return {
    level: 'attention',
    headline: `something went wrong trying to ${side === 'sell' ? 'sell' : 'buy'} ${asset}`,
    detail: 'No order was placed. I have logged the details.',
    action: 'Nothing right now. Tell me if it keeps happening.',
  }
}
