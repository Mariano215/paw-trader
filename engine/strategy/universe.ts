// Correlation-cluster universe for the paper trading book.
//
// Rationale: SPY/QQQ/AAPL are ~one tech-beta bet (SPY-QQQ corr ~0.94,
// QQQ ~58-65% tech). We group symbols into low-correlation sleeves so the
// risk sizer can cap concurrent exposure per sleeve instead of stacking
// five correlated longs. NOTE: low correlation is regime-dependent
// (stock-bond corr broke in 2022); this is a static default, retune it
// from realized correlations, do not treat it as fixed.

export type Sleeve =
  | 'us_equity'
  | 'treasuries'
  | 'gold'
  | 'commodities'
  | 'intl_equity'
  | 'crypto'
  | 'unclassified'

/** Default representative symbol per sleeve (the engine must emit these). */
export const SLEEVE_SYMBOLS: Record<Exclude<Sleeve, 'crypto' | 'unclassified'>, string> = {
  us_equity: 'VTI',
  treasuries: 'TLT',
  gold: 'GLD',
  commodities: 'DBC',
  intl_equity: 'VEA',
}

// Explicit membership for symbols we expect to see. Anything tech-beta
// (SPY/QQQ/AAPL/etc.) maps to us_equity on purpose: they are NOT a
// separate sleeve, they are the same bet.
const SYMBOL_TO_SLEEVE: Record<string, Sleeve> = {
  VTI: 'us_equity', SPY: 'us_equity', QQQ: 'us_equity', VOO: 'us_equity',
  IWM: 'us_equity', DIA: 'us_equity', AAPL: 'us_equity', MSFT: 'us_equity',
  NVDA: 'us_equity', GOOGL: 'us_equity', AMZN: 'us_equity',
  TLT: 'treasuries', IEF: 'treasuries', SHY: 'treasuries', GOVT: 'treasuries',
  GLD: 'gold', IAU: 'gold',
  DBC: 'commodities', GSG: 'commodities', USO: 'commodities',
  VEA: 'intl_equity', EFA: 'intl_equity', VWO: 'intl_equity', EEM: 'intl_equity',
}

/**
 * Classify an asset symbol into a correlation sleeve. Crypto pairs
 * (asset contains '/') are their own sleeve. Unknown equities default to
 * us_equity rather than unclassified, because an unknown US-listed name is
 * far more likely correlated to broad equity than truly orthogonal -- we
 * fail toward MORE concentration awareness, not less.
 */
export function classifySleeve(asset: string): Sleeve {
  if (asset.includes('/')) return 'crypto'
  const sym = asset.toUpperCase()
  return SYMBOL_TO_SLEEVE[sym] ?? 'us_equity'
}

/** All sleeves currently represented by a given set of open assets. */
export function sleevesInUse(assets: string[]): Set<Sleeve> {
  return new Set(assets.map(classifySleeve))
}
