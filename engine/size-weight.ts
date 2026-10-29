// Vol-targeting weight carried on a signal by the engine (momentum-vt-crypto).
// It can only shrink a trade: clamped to [0, 1]; missing or non-finite means full size,
// so every strategy that never sends a weight is sized exactly as before.

export function normalizeSizeWeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  return Math.min(1, Math.max(0, raw))
}

export function applySizeWeight(capUsd: number, raw: unknown): number {
  return Math.round(capUsd * normalizeSizeWeight(raw) * 100) / 100
}
