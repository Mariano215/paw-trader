/**
 * trader-attribution-aggregator.ts
 *
 * Shared helper for committee attribution roll-ups.
 *
 * Two routes compute the same shape of per-role tallies from the
 * `agent_attribution_json` column on `trader_verdicts`:
 *
 *   - GET /api/v1/trader/strategies/:id/attribution (Phase 4 Task D)
 *   - GET /api/v1/trader/committee-report          (Phase 4 Task E, global)
 *
 * Both parse the attribution entries produced by
 * `attributeAgents` in src/trader/verdict-engine.ts and aggregate:
 *   - appearances          (total times the role appeared)
 *   - right_count          (data.right === true)
 *   - wrong_count          (data.right === false)
 *   - veto_count           (data.vetoed === true) -> extras when > 0
 *   - confidence_avg       (mean of data.confidence when numeric) -> extras when any present
 *
 * Parse/shape tolerance: malformed JSON rows are skipped rather than
 * throwing so one bad verdict can't take down the whole aggregate. The
 * per-strategy route has relied on this behaviour since Task D shipped.
 */

/**
 * Row shape passed in: each row has a JSON string column named
 * `agent_attribution_json`. The two callers do their own SELECT so this
 * helper stays SQL-agnostic.
 */
export interface AttributionRow {
  agent_attribution_json: string
}

export interface AttributionRoleOutput {
  role: string
  appearances: number
  right_count: number
  wrong_count: number
  extras: Record<string, number>
}

interface RoleAgg {
  role: string
  appearances: number
  right_count: number
  wrong_count: number
  veto_count: number
  confidence_sum: number
  confidence_n: number
}

export function aggregateAttribution(rows: AttributionRow[]): AttributionRoleOutput[] {
  const agg = new Map<string, RoleAgg>()
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.agent_attribution_json)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as { role?: unknown; data?: unknown }
      if (typeof e.role !== 'string' || !e.role) continue
      const data = (e.data && typeof e.data === 'object') ? (e.data as Record<string, unknown>) : {}
      let cur = agg.get(e.role)
      if (!cur) {
        cur = {
          role: e.role,
          appearances: 0,
          right_count: 0,
          wrong_count: 0,
          veto_count: 0,
          confidence_sum: 0,
          confidence_n: 0,
        }
        agg.set(e.role, cur)
      }
      cur.appearances += 1
      if (typeof data.right === 'boolean') {
        if (data.right) cur.right_count += 1
        else cur.wrong_count += 1
      }
      if (data.vetoed === true) cur.veto_count += 1
      const conf = data.confidence
      if (typeof conf === 'number' && Number.isFinite(conf)) {
        cur.confidence_sum += conf
        cur.confidence_n += 1
      }
    }
  }
  return Array.from(agg.values())
    .sort((a, b) => a.role.localeCompare(b.role))
    .map(r => {
      const extras: Record<string, number> = {}
      if (r.veto_count > 0) extras.veto_count = r.veto_count
      if (r.confidence_n > 0) extras.confidence_avg = r.confidence_sum / r.confidence_n
      return {
        role: r.role,
        appearances: r.appearances,
        right_count: r.right_count,
        wrong_count: r.wrong_count,
        extras,
      }
    })
}
