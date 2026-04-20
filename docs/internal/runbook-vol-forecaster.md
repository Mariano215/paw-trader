# Runbook: EWMA Volatility Forecaster

The volatility forecaster provides a single-number, forward-looking estimate of an
asset's annualised volatility. It is consumed as a background signal by the trading
system and is available to any component that wants to condition on current vol
regime without repeating the computation.

## How it works

The forecaster uses the RiskMetrics EWMA (exponentially weighted moving average)
model with lambda = 0.94:

```
sigma_t^2 = 0.94 * sigma_{t-1}^2 + 0.06 * r_{t-1}^2
```

Where `r` is the daily log return. The variance is seeded from the sample variance
of the first 10 observations, then the recursion runs forward over all available
returns.

The resulting daily variance is annualised: `vol = sqrt(daily_variance) * sqrt(252)`.

**Key parameters:**

| Parameter | Value | Meaning |
|-----------|-------|---------|
| lambda | 0.94 | RiskMetrics standard; higher = slower decay, more weight to old data |
| min observations | 30 | Returns `null` / 404 below this threshold |
| annualisation factor | sqrt(252) | Equity market convention |

**Crypto note:** The endpoint always uses sqrt(252). For crypto assets the caller
should rescale: `vol_crypto = vol_equity * sqrt(365 / 252)` to get a 365-day
annualised figure.

## Interpreting the output

The endpoint returns `annualized_vol` as a decimal. Typical ranges:

| Value | Interpretation |
|-------|---------------|
| < 0.15 | Low vol. Calm trend conditions. Consistent with `bull-trend` regime. |
| 0.15 - 0.25 | Normal. Most trending strategies operate here. |
| 0.25 - 0.35 | Elevated. Regime classifier may label this `choppy`. |
| > 0.35 | High vol. Regime likely `high-vol`. Consider reducing size. |

The regime classifier uses a separate threshold of `spy_20d_vol > 0.30` (annualised)
to assign `high-vol`. The vol forecaster uses the same annualisation convention so
the two can be directly compared.

## Trust thresholds

The EWMA lambda of 0.94 means recent returns dominate quickly. A single large day
(e.g. +/-3% SPY move) will materially raise the forecast for several subsequent days,
then decay. This is intentional for short-horizon use (intraday to multi-day).

For weekly and monthly horizons the EWMA forecast can be noisy. If you are using it
to set longer-term position limits, consider averaging the last 5 trading days of
forecasts rather than a point-in-time value.

Do not use this forecast in isolation as a trade filter. It is an input signal, not
a decision gate.

## Endpoint reference

```
GET /signals/volatility?asset=SPY
```

Served by the trader engine at port 8200 (default). Requires `Authorization: Bearer <ENGINE_AUTH_TOKEN>`.

**Success response (200):**

```json
{
  "asset": "SPY",
  "annualized_vol": 0.187,
  "as_of_ms": 1745333333333
}
```

**Error responses:**

- `404 {"detail": "no data"}`: fewer than 30 daily bars available for this asset,
  or Alpaca returned no data
- `503 {"detail": "data client not ready"}`: engine data client not yet initialised
  (startup lag or Alpaca auth failure)

## Tuning

The lambda value lives in `volatility.py`:

```python
EWMA_LAMBDA = 0.94
```

For faster-reacting vol (useful in high-frequency regimes), lower lambda toward
0.90. For smoother estimates, raise toward 0.97. Standard RiskMetrics for equities
is 0.94. Any change should be validated against historical back-tests before
deploying to production.

The `MIN_OBS = 30` constant controls the warm-up gate. Lowering it will return
estimates sooner but with higher estimation error during the warm-up window.

## Verification

**Live spot check from the engine host:**

```bash
curl -s -H "Authorization: Bearer $ENGINE_AUTH_TOKEN" \
  "http://localhost:8200/signals/volatility?asset=SPY" | python3 -m json.tool
```

Expected: `annualized_vol` between 0.10 and 0.50 on a normal market day.

**Check multiple assets:**

```bash
for ASSET in SPY QQQ AAPL BTC-USD; do
  curl -s -H "Authorization: Bearer $ENGINE_AUTH_TOKEN" \
    "http://localhost:8200/signals/volatility?asset=$ASSET" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('asset','?'), d.get('annualized_vol','ERR'))"
done
```

**Check engine logs for warm-up failures** (asset has fewer than 30 bars):

```bash
journalctl -u trader-engine --since "today" | grep "volatility.insufficient_data"
```

## Related source files

- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/signals/volatility.py` -- EWMA implementation
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/api/routes/volatility.py` -- FastAPI endpoint
- `/Volumes/T7/Projects/Tech/trader-engine/src/trader_engine/signals/regime.py` -- regime classifier that uses `spy_20d_vol` (same annualisation convention)
