// Operator knobs for the trader project. Edited on the dashboard Settings
// page, stored in project_settings.knobs, read per call so a change applies
// on the next tick without a restart. Env vars remain the fallback.
import { getKnob } from '../db.js'

export function traderKnob<T extends string | number | boolean>(key: string, fallback: T): T {
  return getKnob('trader', key, fallback)
}
