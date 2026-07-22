// src/trader/entry-reference-price.ts
//
// Resolves the reference price the exit-calculator needs to size a stop and
// a target.
//
// The dispatcher used to read this from the signal's enrichment blob alone
// and leave it at 0 when the blob was missing or stale. computeExits() maps a
// 0 entry to null exits, so those positions were submitted with no stop and no
// target: 152 of 350 buys over 60 days, 43% of the book, protected only by the
// 20-day time stop. The two stop exits that did fire cut losses at about -6%;
// the naked positions had no such floor.
//
// Enrichment stays the preferred source (it is the price the committee
// actually reasoned about). The engine is the fallback, not the default.

import { logger } from '../logger.js'

export interface EntryRefDeps {
  getPrices(asset: string, fromMs: number, toMs: number): Promise<Array<{ close: number }>>
}

/** Pull price_current out of an enrichment blob. 0 when absent or unusable. */
export function entryRefFromEnrichment(enrichmentJson: string | null | undefined): number {
  if (!enrichmentJson) return 0
  try {
    const e = JSON.parse(enrichmentJson) as { price_current?: number | null }
    if (typeof e.price_current === 'number' && e.price_current > 0) return e.price_current
  } catch {
    // ponytail: malformed enrichment is not worth a throw; caller falls back.
  }
  return 0
}

/**
 * Enrichment price when present, else the latest close the engine has.
 *
 * Returns 0 only when both sources fail, which still yields null exits --
 * but now that is a genuine data outage rather than the normal case.
 */
export async function resolveEntryReferencePrice(
  client: EntryRefDeps,
  asset: string,
  enrichmentJson: string | null | undefined,
  nowMs: number,
): Promise<number> {
  const fromEnrichment = entryRefFromEnrichment(enrichmentJson)
  if (fromEnrichment > 0) return fromEnrichment

  try {
    // Five days back so a long weekend or a holiday still returns a bar.
    const bars = await client.getPrices(asset, nowMs - 5 * 24 * 60 * 60 * 1000, nowMs)
    for (let i = bars.length - 1; i >= 0; i--) {
      const c = bars[i]?.close
      if (typeof c === 'number' && isFinite(c) && c > 0) {
        logger.info(
          { event: 'trader.entry_ref.engine_fallback', asset, price: c },
          'entry reference price taken from engine prices; enrichment had none',
        )
        return c
      }
    }
    logger.warn(
      { event: 'trader.entry_ref.unavailable', asset, bars: bars.length },
      'no entry reference price from enrichment or engine; position will have no stop',
    )
  } catch (err) {
    logger.warn(
      { event: 'trader.entry_ref.fetch_failed', asset, err },
      'engine price fetch failed while resolving entry reference; position will have no stop',
    )
  }
  return 0
}
