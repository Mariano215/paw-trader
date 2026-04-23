// =============================================================
// Extracted from ClaudePaw server/public/app.js
//
// Phase 1 code mirror: this file is a slice of the dashboard SPA.
// It references helpers defined in app.js (fetchJSON, navigateToPage,
// etc.) and is not runnable standalone. Phase 3 will turn it into a
// proper module loaded via the plugin dashboard-extension hook.
// =============================================================

// -------------------------------------------------------
// Scattered integration points (from app.js outer scope).
// Phase 1: listed for context. Phase 3: registered via
// the plugin dashboard-extension hook instead.
// -------------------------------------------------------

// --- page init dispatcher ---
if (pageId === 'page-trader') initTraderPage();

// --- page id map entry ---
'trader': 'page-trader',

// --- hash router: strategy drill-down ---
// Phase 4 Task D -- trader strategy drill-down: #trader/strategy/:id
    if (hash.startsWith('trader/strategy/')) {
      const strategyId = decodeURIComponent(hash.slice('trader/strategy/'.length));
      if (strategyId) {
        navigateToPage('page-trader', false);
        initStrategyDetail(strategyId);
        return;
      }
    }

// --- hash router: kill-switch audit log ---
// Phase 6 Task 5 -- kill-switch audit log: #trader/kill-switch-log
    if (hash === 'trader/kill-switch-log') {
      navigateToPage('page-trader', false);
      renderKillSwitchLogPage();
      return;
    }

// --- hash router: plain #trader back-nav ---
// Navigating back to plain #trader should dismiss any open drill-down.
    if (hash === 'trader' && typeof closeStrategyDetail === 'function') {
      closeStrategyDetail();
      closeKillSwitchLogPage();
    }

// --- initial-hash: strategy drill-down ---
} else if (initialHash.startsWith('trader/strategy/')) {
    // Phase 4 Task D -- trader strategy drill-down initial load
    const strategyId = decodeURIComponent(initialHash.slice('trader/strategy/'.length));
    navigateToPage('page-trader', false);
    if (strategyId) initStrategyDetail(strategyId);

// --- initial-hash: kill-switch log ---
} else if (initialHash === 'trader/kill-switch-log') {
    // Phase 6 Task 5 -- kill-switch audit log initial load
    navigateToPage('page-trader', false);
    renderKillSwitchLogPage();


// -------------------------------------------------------
// Main trader page body (contiguous block from app.js)
// -------------------------------------------------------

// ============================================================
// TRADER PAGE (Paw Trader Phase 0)
// ============================================================
//
// The engine is a Python service on WSL2. These helpers proxy the dashboard's
// status polling through /api/v1/trader/* server routes (see trader-routes.ts)
// so the engine token never reaches the browser.
//
// Phase 0 ships read-only status. Positions and signals land in Phase 1.

var _traderPollStarted = false;

function ensureTraderPageDOM() {
  if (document.getElementById('page-trader')) return;
  var main = document.querySelector('.main-content');
  if (!main) return;

  var page = document.createElement('section');
  page.id = 'page-trader';
  page.className = 'page';
  page.setAttribute('data-page-title', 'Trader');
  page.setAttribute('aria-label', 'Paw Trader');
  page.hidden = true;

  var heading = document.createElement('div');
  heading.className = 'page-heading-row';

  var h2 = document.createElement('h2');
  h2.className = 'page-heading';
  h2.textContent = 'Paw Trader';
  heading.appendChild(h2);

  var badge = document.createElement('span');
  badge.className = 'sop-task-count';
  badge.textContent = 'Phase 1 - Live';
  heading.appendChild(badge);

  page.appendChild(heading);

  // Phase 7 Task 1 -- NAV equity curve + P/L summary strip.  Sits at the
  // very top of the page so the first thing an operator sees is "is the
  // account growing?" before any text-heavy status card.  Powered by the
  // nav-snapshots engine proxy; renders "no data yet" gracefully when
  // the engine has not recorded enough snapshots for a curve.
  var overviewCard = document.createElement('div');
  overviewCard.id = 'trader-overview';
  overviewCard.className = 'stat-card';
  overviewCard.style.cssText = 'padding:18px;';
  overviewCard.textContent = 'Loading NAV overview...';
  page.appendChild(overviewCard);

  var statusCard = document.createElement('div');
  statusCard.id = 'trader-status';
  statusCard.className = 'stat-card';
  statusCard.style.cssText = 'padding:18px;margin-top:12px;';
  statusCard.textContent = 'Connecting to engine...';
  page.appendChild(statusCard);

  // Positions card
  var posCard = document.createElement('div');
  posCard.id = 'trader-positions';
  posCard.className = 'stat-card';
  posCard.style.cssText = 'padding:18px;margin-top:12px;';
  posCard.textContent = 'Loading positions...';
  page.appendChild(posCard);

  // Risk / circuit breakers card
  var riskCard = document.createElement('div');
  riskCard.id = 'trader-risk';
  riskCard.className = 'stat-card';
  riskCard.style.cssText = 'padding:18px;margin-top:12px;';
  riskCard.textContent = 'Loading risk state...';
  page.appendChild(riskCard);

  // Signal queue card -- pending + recent signal history
  var signalQueueCard = document.createElement('div');
  signalQueueCard.id = 'trader-signal-queue';
  signalQueueCard.className = 'stat-card';
  signalQueueCard.style.cssText = 'padding:18px;margin-top:12px;';
  signalQueueCard.textContent = 'Loading signal queue...';
  page.appendChild(signalQueueCard);

  // Recent decisions card (Phase 2 Task 8)
  var decisionsCard = document.createElement('div');
  decisionsCard.id = 'trader-decisions';
  decisionsCard.className = 'stat-card';
  decisionsCard.style.cssText = 'padding:18px;margin-top:12px;';
  decisionsCard.textContent = 'Loading recent decisions...';
  page.appendChild(decisionsCard);

  // Committee report card (Phase 4 Task E) -- global per-role tallies across
  // every verdict. Placed above Strategy Track Records so the top of the
  // page reads "is the committee any good?" before drilling into
  // strategy-specific performance.
  var committeeCard = document.createElement('div');
  committeeCard.id = 'trader-committee-report';
  committeeCard.className = 'stat-card';
  committeeCard.style.cssText = 'padding:18px;margin-top:12px;';
  committeeCard.textContent = 'Loading committee report...';
  page.appendChild(committeeCard);

  // Strategy track records card (Phase 3 Task 2)
  var trackCard = document.createElement('div');
  trackCard.id = 'trader-track-records';
  trackCard.className = 'stat-card';
  trackCard.style.cssText = 'padding:18px;margin-top:12px;';
  trackCard.textContent = 'Loading strategy track records...';
  page.appendChild(trackCard);

  // Halt button card
  var haltCard = document.createElement('div');
  haltCard.className = 'stat-card';
  haltCard.style.cssText = 'padding:18px;margin-top:12px;';
  var haltBtn = document.createElement('button');
  haltBtn.className = 'trader-btn-danger';
  haltBtn.textContent = 'Halt Engine';
  haltBtn.addEventListener('click', engineKillSwitch);
  haltCard.appendChild(haltBtn);
  page.appendChild(haltCard);

  main.appendChild(page);
}

function initTraderPage() {
  ensureTraderPageDOM();
  // When arriving via the Trader sidebar link, navigateToPage runs with
  // e.preventDefault() so no hashchange fires. Without this, the audit
  // container stays visible and the main cards stay hidden. Mirrors the
  // same dismissal pattern the hashchange handler uses when landing on
  // plain #trader (see lines ~3204-3207).
  closeStrategyDetail();
  closeKillSwitchLogPage();
  refreshTraderOverview();
  refreshTraderStatus();
  refreshTraderPositions();
  refreshTraderRisk();
  refreshTraderSignalQueue();
  refreshTraderDecisions();
  refreshTraderCommitteeReport();
  refreshTraderTrackRecords();
  if (!_traderPollStarted) {
    _traderPollStarted = true;
    addPollingInterval(refreshTraderOverview, 60000);
    addPollingInterval(refreshTraderStatus, 15000);
    addPollingInterval(refreshTraderPositions, 15000);
    addPollingInterval(refreshTraderRisk, 15000);
    addPollingInterval(refreshTraderSignalQueue, 15000);
    addPollingInterval(refreshTraderDecisions, 30000);
    addPollingInterval(refreshTraderCommitteeReport, 60000);
    addPollingInterval(refreshTraderTrackRecords, 60000);
  }
}

// ---------------------------------------------------------------------------
// Phase 7 Task 1 -- shared SVG line chart helper for the trader page.
//
// Four call sites: NAV equity curve, strategy overlay, committee trend,
// and any future trader chart.  Inline SVG only -- we do not want a 100KB
// chart library dependency for a handful of polylines.
//
//   series: Array<{ label?, color?, points: Array<[x, y]> }>
//   opts: { width?, height?, padding?, yFormat?, xFormat?, emptyMessage?,
//           showZeroLine? }
//
// No axis labels on the x-axis except start/end; the trader charts are
// small and the date range is short enough that two labels plus a title
// gives the operator the context they need.  Empty series render a
// centred "no data" label instead of a blank frame.
// ---------------------------------------------------------------------------

var TRADER_CHART_SVG_NS = 'http://www.w3.org/2000/svg';

function renderTraderLineChart(svg, series, opts) {
  var o = opts || {};
  var W = o.width || 640;
  var H = o.height || 200;
  var pad = o.padding || {};
  var PL = pad.left != null ? pad.left : 52;
  var PR = pad.right != null ? pad.right : 12;
  var PT = pad.top != null ? pad.top : 12;
  var PB = pad.bottom != null ? pad.bottom : 24;

  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(H));
  svg.style.cssText = 'background:rgba(255,255,255,0.03);border-radius:6px;';
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  var allX = [], allY = [];
  (series || []).forEach(function(s) {
    (s.points || []).forEach(function(p) {
      if (typeof p[0] === 'number' && typeof p[1] === 'number') {
        allX.push(p[0]); allY.push(p[1]);
      }
    });
  });
  if (allX.length < 2) {
    var txt = document.createElementNS(TRADER_CHART_SVG_NS, 'text');
    txt.setAttribute('x', String(W / 2));
    txt.setAttribute('y', String(H / 2));
    txt.setAttribute('fill', 'rgba(255,255,255,0.5)');
    txt.setAttribute('font-size', '12');
    txt.setAttribute('text-anchor', 'middle');
    txt.textContent = o.emptyMessage || 'Not enough data yet.';
    svg.appendChild(txt);
    return;
  }
  var minX = Math.min.apply(null, allX);
  var maxX = Math.max.apply(null, allX);
  var minY = Math.min.apply(null, allY);
  var maxY = Math.max.apply(null, allY);
  if (minY === maxY) { minY -= 0.5; maxY += 0.5; }
  var xRange = Math.max(maxX - minX, 1);
  var yRange = maxY - minY;

  function xAt(x) { return PL + (x - minX) / xRange * (W - PL - PR); }
  function yAt(y) { return PT + (1 - (y - minY) / yRange) * (H - PT - PB); }

  // Grid + Y labels
  for (var g = 0; g <= 4; g++) {
    var gy = PT + g / 4 * (H - PT - PB);
    var gl = document.createElementNS(TRADER_CHART_SVG_NS, 'line');
    gl.setAttribute('x1', String(PL));
    gl.setAttribute('x2', String(W - PR));
    gl.setAttribute('y1', String(gy));
    gl.setAttribute('y2', String(gy));
    gl.setAttribute('stroke', 'rgba(255,255,255,0.07)');
    svg.appendChild(gl);
    var yVal = maxY - g / 4 * yRange;
    var lab = document.createElementNS(TRADER_CHART_SVG_NS, 'text');
    lab.setAttribute('x', String(PL - 6));
    lab.setAttribute('y', String(gy + 4));
    lab.setAttribute('fill', 'rgba(255,255,255,0.55)');
    lab.setAttribute('font-size', '10');
    lab.setAttribute('text-anchor', 'end');
    lab.textContent = o.yFormat ? o.yFormat(yVal) : yVal.toFixed(2);
    svg.appendChild(lab);
  }

  if (o.showZeroLine && minY < 0 && maxY > 0) {
    var zY = yAt(0);
    var zl = document.createElementNS(TRADER_CHART_SVG_NS, 'line');
    zl.setAttribute('x1', String(PL));
    zl.setAttribute('x2', String(W - PR));
    zl.setAttribute('y1', String(zY));
    zl.setAttribute('y2', String(zY));
    zl.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    zl.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(zl);
  }

  // Start + end x-axis labels
  var sL = document.createElementNS(TRADER_CHART_SVG_NS, 'text');
  sL.setAttribute('x', String(PL));
  sL.setAttribute('y', String(H - 6));
  sL.setAttribute('fill', 'rgba(255,255,255,0.55)');
  sL.setAttribute('font-size', '10');
  sL.textContent = o.xFormat ? o.xFormat(minX) : new Date(minX).toLocaleDateString();
  svg.appendChild(sL);
  var eL = document.createElementNS(TRADER_CHART_SVG_NS, 'text');
  eL.setAttribute('x', String(W - PR));
  eL.setAttribute('y', String(H - 6));
  eL.setAttribute('fill', 'rgba(255,255,255,0.55)');
  eL.setAttribute('font-size', '10');
  eL.setAttribute('text-anchor', 'end');
  eL.textContent = o.xFormat ? o.xFormat(maxX) : new Date(maxX).toLocaleDateString();
  svg.appendChild(eL);

  // Draw each series as a polyline
  (series || []).forEach(function(s) {
    var pts = (s.points || []).filter(function(p) {
      return typeof p[0] === 'number' && typeof p[1] === 'number';
    });
    if (pts.length < 2) return;
    var d = pts.map(function(p) { return xAt(p[0]).toFixed(2) + ',' + yAt(p[1]).toFixed(2); }).join(' ');
    var poly = document.createElementNS(TRADER_CHART_SVG_NS, 'polyline');
    poly.setAttribute('points', d);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', s.color || '#4caf50');
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);
  });
}

// ---------------------------------------------------------------------------
// Phase 7 Task 1 -- NAV equity curve + P/L summary strip.
//
// State: selected window in days.  The chart re-renders on window change
// without a server round-trip -- we fetch the widest window once (365d)
// and slice client-side.  The P/L strip is fully client-computed from
// the same snapshot series (today = last - open, week = last - open-of-
// week-ago, etc.).  The engine records one NAV snapshot per day so the
// series is small (<400 rows); fetching 365 rows is cheap.
// ---------------------------------------------------------------------------

var TRADER_NAV_STATE = { snapshots: [], windowDays: 90 };

async function refreshTraderOverview() {
  var container = document.getElementById('trader-overview');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/nav-snapshots?limit=365');
    if (data === null) return;
    TRADER_NAV_STATE.snapshots = (data && data.snapshots) || [];
    renderTraderOverview(container);
  } catch (e) {
    container.textContent = 'NAV overview unavailable: ' + String(e);
  }
}

function renderTraderOverview(container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;';
  var title = document.createElement('span');
  title.textContent = 'Portfolio NAV';
  heading.appendChild(title);

  // Period selector: 7d / 30d / 90d / all
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;';
  [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: 'All', days: 0 },
  ].forEach(function(p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.style.cssText = 'background:rgba(255,255,255,' +
      (TRADER_NAV_STATE.windowDays === p.days ? '0.18' : '0.05') +
      ');color:inherit;border:1px solid rgba(255,255,255,0.15);padding:3px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem;';
    b.addEventListener('click', function() {
      TRADER_NAV_STATE.windowDays = p.days;
      renderTraderOverview(container);
    });
    btnRow.appendChild(b);
  });
  heading.appendChild(btnRow);
  container.appendChild(heading);

  var snaps = TRADER_NAV_STATE.snapshots;
  if (!Array.isArray(snaps) || snaps.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No NAV snapshots yet. Chart appears after the first daily snapshot.';
    container.appendChild(empty);
    return;
  }

  // Normalise and sort oldest-first; the engine returns newest-first
  var sorted = snaps.slice().sort(function(a, b) {
    return (a.recorded_at || 0) - (b.recorded_at || 0);
  });

  // ---- P/L summary strip (Today / Week / Month) ----
  var strip = document.createElement('div');
  strip.style.cssText = 'display:flex;gap:18px;margin-bottom:12px;flex-wrap:wrap;';
  [
    { label: 'Today', ms: 24 * 60 * 60 * 1000 },
    { label: 'Week',  ms: 7 * 24 * 60 * 60 * 1000 },
    { label: 'Month', ms: 30 * 24 * 60 * 60 * 1000 },
  ].forEach(function(period) {
    var cell = document.createElement('div');
    cell.style.cssText = 'min-width:120px;';
    var lab = document.createElement('div');
    lab.style.cssText = 'opacity:0.6;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;';
    lab.textContent = period.label;
    var val = document.createElement('div');
    val.style.cssText = 'font-size:1.15rem;font-weight:600;margin-top:2px;';
    var pair = _computeNavDelta(sorted, period.ms);
    if (pair == null) {
      val.textContent = '-';
      val.style.opacity = '0.5';
    } else {
      var sign = pair.delta >= 0 ? '+' : '-';
      var abs = Math.abs(pair.delta);
      val.textContent = sign + '$' + abs.toFixed(2) + ' (' + (pair.delta >= 0 ? '+' : '-') +
        Math.abs(pair.pct).toFixed(2) + '%)';
      val.style.color = pair.delta >= 0 ? '#4caf50' : '#f44336';
    }
    cell.appendChild(lab);
    cell.appendChild(val);
    strip.appendChild(cell);
  });
  container.appendChild(strip);

  // ---- Windowed series ----
  var windowDays = TRADER_NAV_STATE.windowDays;
  var filtered = sorted;
  if (windowDays > 0) {
    var cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    filtered = sorted.filter(function(s) { return (s.recorded_at || 0) >= cutoff; });
    if (filtered.length === 0 && sorted.length > 0) {
      // Always show at least the most recent point so an operator can
      // see the latest NAV even when the selected window has no data.
      filtered = [sorted[sorted.length - 1]];
    }
  }

  var svg = document.createElementNS(TRADER_CHART_SVG_NS, 'svg');
  svg.style.marginTop = '4px';
  container.appendChild(svg);

  var points = filtered.map(function(s) {
    return [s.recorded_at || 0, Number(s.nav) || 0];
  });
  var lastNav = points.length > 0 ? points[points.length - 1][1] : null;
  renderTraderLineChart(svg, [{
    label: 'NAV',
    color: lastNav != null && points.length >= 2 && lastNav >= points[0][1] ? '#4caf50' : '#f44336',
    points: points,
  }], {
    width: 640,
    height: 220,
    yFormat: function(v) { return '$' + Math.round(v).toLocaleString(); },
    emptyMessage: 'Need at least 2 NAV snapshots for a chart.',
  });

  var footer = document.createElement('div');
  footer.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-top:6px;';
  if (lastNav != null && sorted.length > 0) {
    var lastSnap = sorted[sorted.length - 1];
    footer.textContent = 'NAV $' + lastNav.toFixed(2) + ' as of ' + (lastSnap.date || new Date(lastSnap.recorded_at).toLocaleDateString()) +
      ' - ' + sorted.length + ' snapshots total';
  } else {
    footer.textContent = 'Waiting for first NAV snapshot.';
  }
  container.appendChild(footer);
}

// Compute { delta, pct } between the most recent snapshot and the one
// closest to N ms ago.  Returns null when the series is too short to
// anchor a baseline.  Baseline is the most recent snapshot whose
// recorded_at is <= (latest - periodMs); if no snapshot predates the
// cutoff, the very first snapshot in the series is used.
function _computeNavDelta(sortedSnaps, periodMs) {
  if (!sortedSnaps || sortedSnaps.length < 2) return null;
  var last = sortedSnaps[sortedSnaps.length - 1];
  var lastNav = Number(last.nav) || 0;
  var lastTs = last.recorded_at || 0;
  var cutoff = lastTs - periodMs;
  var baseline = null;
  for (var i = sortedSnaps.length - 2; i >= 0; i--) {
    if ((sortedSnaps[i].recorded_at || 0) <= cutoff) { baseline = sortedSnaps[i]; break; }
  }
  if (!baseline) baseline = sortedSnaps[0];
  var baseNav = Number(baseline.nav) || 0;
  if (baseNav === 0) return null;
  var delta = lastNav - baseNav;
  var pct = (delta / baseNav) * 100;
  return { delta: delta, pct: pct };
}

async function refreshTraderStatus() {
  var container = document.getElementById('trader-status');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/status');
    if (data === null) return;
    renderTraderStatus(data, container);
  } catch (e) {
    renderTraderStatus({ engine_connected: false, error: String(e) }, container);
  }
}

function renderTraderStatus(data, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!data || !data.engine_connected) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    var dot = document.createElement('span');
    dot.className = 'status-dot error';
    var msg = document.createElement('span');
    msg.textContent = 'Engine offline - ' + ((data && data.error) || 'unreachable');
    row.appendChild(dot);
    row.appendChild(msg);

    var hint = document.createElement('p');
    hint.style.cssText = 'opacity:0.6;font-size:0.85rem;margin-top:8px;';
    hint.textContent = 'Start the engine on WSL2 per docs/trader-setup.md';

    container.appendChild(row);
    container.appendChild(hint);
    return;
  }

  // Phase 5 hardening -- split Alpaca and Coinbase into independent
  // status pills, each with its own dot color.  The earlier single-line
  // banner rendered a green top dot even when Coinbase was in ERROR,
  // lying about overall engine health.  Top dot now degrades to amber
  // when any broker is not connected.  coinbase_connected is null on
  // older engine builds -- the Coinbase pill is hidden entirely in
  // that case instead of rendering a misleading ERROR.
  var alpacaOk = data.alpaca_connected === true;
  var coinbasePresent = data.coinbase_connected != null;
  var coinbaseOk = coinbasePresent && data.coinbase_connected === true;
  var topOk = alpacaOk && (!coinbasePresent || coinbaseOk);

  function addStatusRow(label, ok, detail) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:4px;';
    var d = document.createElement('span');
    d.className = 'status-dot ' + (ok ? 'online' : 'error');
    var msg = document.createElement('span');
    msg.textContent = label + (detail ? ' ' + detail : '');
    row.appendChild(d);
    row.appendChild(msg);
    container.appendChild(row);
  }

  // Top row: overall engine health.  Green only when every broker is OK.
  var topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  var topDot = document.createElement('span');
  // Amber on degraded uses the existing .status-dot.idle class from
  // style.css (amber fill, no pulse) rather than adding a new one.
  topDot.className = 'status-dot ' + (topOk ? 'online' : 'idle');
  var topMsg = document.createElement('span');
  topMsg.textContent = topOk ? 'Engine ok' : 'Engine degraded';
  topRow.appendChild(topDot);
  topRow.appendChild(topMsg);
  container.appendChild(topRow);

  // Alpaca pill (always rendered -- Alpaca is the primary broker).
  addStatusRow('Alpaca (' + (data.alpaca_mode || 'unknown') + ')',
               alpacaOk, alpacaOk ? 'connected' : 'ERROR');

  // Coinbase pill (only when the engine reports the field).
  if (coinbasePresent) {
    addStatusRow('Coinbase', coinbaseOk,
                 coinbaseOk ? 'connected' : 'ERROR');
  }

  var reconcile = data.last_reconcile;
  var reconcileLine;
  if (!reconcile) {
    reconcileLine = 'Reconcile: pending - never';
  } else {
    var drift = reconcile.drift_detected ? 'DRIFT DETECTED' : 'clean';
    reconcileLine = 'Reconcile: ' + drift + ' - ' + timeAgo(reconcile.ran_at);
  }

  var row2 = document.createElement('div');
  row2.style.cssText = 'margin-top:6px;';
  row2.textContent = reconcileLine;
  container.appendChild(row2);
}

// inject trader CSS once
(function(){
  var s = document.createElement('style');
  s.textContent = '.trader-table{width:100%;border-collapse:collapse;font-size:0.9rem}.trader-table th,.trader-table td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,0.1))}.trader-table th{opacity:0.7;font-weight:500}.trader-cb-badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:0.8rem;font-weight:500}.trader-cb-ok{background:rgba(76,175,80,0.15);color:#4caf50}.trader-cb-tripped{background:rgba(244,67,54,0.15);color:#f44336}.trader-btn-danger{background:rgba(244,67,54,0.15);color:#f44336;border:1px solid rgba(244,67,54,0.3);border-radius:6px;padding:8px 16px;cursor:pointer;font-size:0.9rem}.trader-btn-danger:hover{background:rgba(244,67,54,0.25)}';
  document.head.appendChild(s);
})();

async function refreshTraderPositions() {
  var container = document.getElementById('trader-positions');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/positions');
    renderPositions(data || [], container);
  } catch (e) {
    container.textContent = 'Positions unavailable';
  }
}

function renderPositions(positions, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Open Positions (' + positions.length + ')';
  container.appendChild(heading);

  if (positions.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No open positions';
    container.appendChild(empty);
    return;
  }

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Asset', 'Qty', 'Avg Entry', 'Market Value', 'Unrealized P&L'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  positions.forEach(function(p) {
    var tr = document.createElement('tr');
    [p.asset, p.qty, '$' + Number(p.avg_entry_price).toFixed(2),
     '$' + Number(p.market_value).toFixed(2),
     '$' + Number(p.unrealized_pnl).toFixed(2)].forEach(function(val) {
      var td = document.createElement('td');
      td.textContent = val;
      if (String(val).startsWith('$-')) td.style.color = 'var(--error, #f44336)';
      else if (String(val).startsWith('$') && val !== '$0.00') td.style.color = 'var(--success, #4caf50)';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

async function refreshTraderRisk() {
  var container = document.getElementById('trader-risk');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/risk');
    renderCircuitBreakers(data || { tripped: [], details: [] }, container);
  } catch (e) {
    container.textContent = 'Risk state unavailable';
  }
}

function renderCircuitBreakers(risk, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Circuit Breakers';
  container.appendChild(heading);

  var rules = ['daily_loss', 'weekly_loss', 'position_limit', 'order_rate',
               'drawdown', 'api_errors', 'market_hours', 'reconcile_drift'];

  var grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

  rules.forEach(function(rule) {
    var tripped = (risk.tripped || []).includes(rule);
    var badge = document.createElement('span');
    badge.className = 'trader-cb-badge ' + (tripped ? 'trader-cb-tripped' : 'trader-cb-ok');
    badge.textContent = rule.replace(/_/g, ' ');
    if (tripped) {
      badge.title = 'TRIPPED - Click to clear';
      badge.style.cursor = 'pointer';
      badge.addEventListener('click', function() { clearCircuitBreaker(rule); });
    }
    grid.appendChild(badge);
  });

  container.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Phase 4 Task E -- Global committee report card
//
// Per-specialist tallies across every verdict (NOT filtered by strategy).
// Mirrors the shape of the per-strategy attribution card that ships on
// the strategy drill-down page, so the two read as sibling tables.
// ---------------------------------------------------------------------------

async function refreshTraderCommitteeReport() {
  var container = document.getElementById('trader-committee-report');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/committee-report');
    if (data === null) return; // auth redirect
    renderTraderCommitteeReport(data || { roles: [], verdict_count: 0 }, container);
  } catch (e) {
    container.textContent = 'Committee report unavailable: ' + String(e);
  }
}

function renderTraderCommitteeReport(data, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var verdictCount = data && data.verdict_count || 0;
  var roles = (data && Array.isArray(data.roles)) ? data.roles : [];

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Committee Report (' + verdictCount + ' verdicts)';
  container.appendChild(heading);

  if (verdictCount === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No committee data. Report appears after the first verdict closes.';
    container.appendChild(empty);
    return;
  }

  var hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-bottom:8px;';
  hint.textContent = 'Global per-specialist tallies across every verdict. Right percent uses right + wrong; appearances without a right/wrong tag are excluded from the denominator.';
  container.appendChild(hint);

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Role', 'Appearances', 'Right', 'Wrong', 'Right %', 'Extras'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  roles.forEach(function(r) {
    var tr = document.createElement('tr');
    var extras = r.extras || {};
    var graded = (r.right_count || 0) + (r.wrong_count || 0);
    var rightPct = graded > 0 ? ((r.right_count / graded) * 100).toFixed(1) + '%' : '-';
    var extrasParts = [];
    if (extras.veto_count != null) extrasParts.push('vetoes ' + extras.veto_count);
    if (extras.confidence_avg != null) extrasParts.push('avg conf ' + Number(extras.confidence_avg).toFixed(3));
    var extrasCell = extrasParts.length ? extrasParts.join(', ') : '-';

    [r.role, r.appearances, r.right_count, r.wrong_count, rightPct, extrasCell].forEach(function(val) {
      var td = document.createElement('td');
      td.textContent = String(val);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  // Phase 7 Task 1 -- 30-day committee accuracy trend.  Fires alongside
  // the aggregate table so the operator can answer "is the committee
  // getting better or worse?" without leaving the card.  The fetch is
  // fire-and-forget: a failure renders a gentle empty state inside the
  // chart slot instead of blowing up the whole card.
  var trendCard = document.createElement('div');
  trendCard.style.cssText = 'margin-top:14px;';
  container.appendChild(trendCard);
  _refreshCommitteeTrendInto(trendCard);
}

// ---------------------------------------------------------------------------
// Phase 7 Task 1 -- committee accuracy trend chart (embedded in the
// committee report card).  Fetches /committee-trend?days=30, then
// computes a 7-day rolling hit-rate per role client-side so we can
// show whether the committee is trending up or down.  Roles without
// enough grading coverage (fewer than 3 graded appearances over any
// rolling window) are hidden.
// ---------------------------------------------------------------------------

var COMMITTEE_TREND_COLORS = [
  '#4caf50', '#2196f3', '#ffb300', '#ef5350', '#ab47bc',
  '#26c6da', '#66bb6a', '#ff7043', '#5c6bc0',
];

async function _refreshCommitteeTrendInto(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
  var title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:0.9rem;margin-bottom:6px;';
  title.textContent = 'Hit-rate trend (30 days, 7-day rolling)';
  container.appendChild(title);

  var chartSlot = document.createElement('div');
  container.appendChild(chartSlot);

  try {
    var data = await fetchFromAPI('/api/v1/trader/committee-trend?days=30');
    if (data === null) return;
    _renderCommitteeTrendChart(chartSlot, data || {});
  } catch (e) {
    chartSlot.textContent = 'Trend unavailable: ' + String(e);
    chartSlot.style.cssText = 'opacity:0.6;font-size:0.85rem;';
  }
}

function _renderCommitteeTrendChart(container, data) {
  while (container.firstChild) container.removeChild(container.firstChild);
  var days = (data && Array.isArray(data.days)) ? data.days : [];
  var roles = (data && Array.isArray(data.roles)) ? data.roles : [];
  if (days.length === 0 || roles.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.85rem;';
    empty.textContent = 'No committee verdicts in the last 30 days.';
    container.appendChild(empty);
    return;
  }

  // Build a per-role sorted-by-day points array of [day_start_ms, hit_rate]
  // using a 7-day rolling window centred on the end-of-window day (i.e.
  // the 7-day rolling average including the current day and the 6 prior).
  // Zero-fill missing days so the rolling windows stay stable across
  // silent stretches.
  var dayMs = 24 * 60 * 60 * 1000;
  var windowStartMs = data.window_start_ms || days[0].day_start_ms;
  var windowEndMs = data.window_end_ms || days[days.length - 1].day_start_ms + dayMs;
  var firstDayStart = Math.floor(windowStartMs / dayMs) * dayMs;
  var lastDayStart = Math.floor((windowEndMs - 1) / dayMs) * dayMs;
  var dayIndex = {};
  days.forEach(function(d) { dayIndex[d.day_start_ms] = d; });

  var series = [];
  roles.forEach(function(role, i) {
    var color = COMMITTEE_TREND_COLORS[i % COMMITTEE_TREND_COLORS.length];
    var pts = [];
    for (var ds = firstDayStart; ds <= lastDayStart; ds += dayMs) {
      // Sum right + wrong over the trailing 7-day window ending on `ds`.
      var right = 0, wrong = 0;
      for (var k = 0; k < 7; k++) {
        var bucket = dayIndex[ds - k * dayMs];
        if (!bucket) continue;
        var r = bucket.by_role && bucket.by_role[role];
        if (!r) continue;
        right += r.right_count || 0;
        wrong += r.wrong_count || 0;
      }
      var graded = right + wrong;
      // Require at least 3 graded calls in the window before plotting a
      // hit-rate; otherwise leave a gap.  The line chart skips non-
      // numeric y values so an NaN here produces a real break in the line.
      if (graded >= 3) {
        pts.push([ds, (right / graded) * 100]);
      } else {
        pts.push([ds, NaN]);
      }
    }
    // Drop trailing NaN markers so the series doesn't extend past real data
    if (pts.some(function(p) { return typeof p[1] === 'number' && !isNaN(p[1]); })) {
      series.push({ label: role, color: color, points: pts.map(function(p) {
        return [p[0], typeof p[1] === 'number' && !isNaN(p[1]) ? p[1] : null];
      }).filter(function(p) { return p[1] !== null; }) });
    }
  });

  if (series.length === 0) {
    var noGraded = document.createElement('div');
    noGraded.style.cssText = 'opacity:0.6;font-size:0.85rem;';
    noGraded.textContent = 'Not enough graded calls in the last 30 days to plot a trend yet.';
    container.appendChild(noGraded);
    return;
  }

  var svg = document.createElementNS(TRADER_CHART_SVG_NS, 'svg');
  container.appendChild(svg);
  renderTraderLineChart(svg, series, {
    width: 640,
    height: 200,
    yFormat: function(v) { return v.toFixed(0) + '%'; },
  });

  var legend = document.createElement('div');
  legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:0.8rem;';
  series.forEach(function(s) {
    var sw = document.createElement('span');
    sw.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
    var dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s.color + ';';
    var lab = document.createElement('span');
    lab.textContent = s.label;
    sw.appendChild(dot);
    sw.appendChild(lab);
    legend.appendChild(sw);
  });
  container.appendChild(legend);
}

// ---------------------------------------------------------------------------
// Phase 7 Task 1 -- strategy equity comparison overlay.  Top 3 strategies
// by trade_count get their equity curves fetched in parallel and drawn as
// overlapping polylines.  Checkbox chips underneath toggle visibility so
// the operator can focus on individual strategies without reloading.
// ---------------------------------------------------------------------------

var STRATEGY_OVERLAY_COLORS = ['#4caf50', '#2196f3', '#ffb300'];
var STRATEGY_OVERLAY_STATE = { visible: {} };

function _clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

async function _refreshStrategyOverlayInto(container, records) {
  _clearChildren(container);
  // Top 3 by trade count.  Ties broken by alphabetical strategy_id for
  // stable ordering.  Strategies with 0 trades are excluded -- no curve
  // to draw.
  var ranked = (records || [])
    .filter(function(r) { return (r.trade_count || 0) > 0; })
    .slice()
    .sort(function(a, b) {
      if ((b.trade_count || 0) !== (a.trade_count || 0)) return (b.trade_count || 0) - (a.trade_count || 0);
      return String(a.strategy_id).localeCompare(String(b.strategy_id));
    })
    .slice(0, 3);

  if (ranked.length === 0) return; // no overlay when no strategies have closed trades

  var title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:0.9rem;margin-bottom:6px;';
  title.textContent = 'Equity overlay (top ' + ranked.length + ' by trades)';
  container.appendChild(title);

  var chartSlot = document.createElement('div');
  container.appendChild(chartSlot);

  var chipsSlot = document.createElement('div');
  chipsSlot.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;font-size:0.8rem;';
  container.appendChild(chipsSlot);

  // Default all top-3 visible on first render; preserve user toggles
  // across re-renders using the module-level state map.
  ranked.forEach(function(r) {
    if (!(r.strategy_id in STRATEGY_OVERLAY_STATE.visible)) {
      STRATEGY_OVERLAY_STATE.visible[r.strategy_id] = true;
    }
  });

  // Fetch all three equity curves concurrently.  Each failure is local
  // so one bad curve still lets the other two render.
  var results = await Promise.all(ranked.map(function(r) {
    return fetchFromAPI('/api/v1/trader/strategies/' + encodeURIComponent(r.strategy_id) + '/equity-curve?limit=200')
      .then(function(d) { return { strategy_id: r.strategy_id, points: (d && d.points) || [] }; })
      .catch(function() { return { strategy_id: r.strategy_id, points: [] }; });
  }));

  function drawOverlay() {
    _clearChildren(chartSlot);
    var svg = document.createElementNS(TRADER_CHART_SVG_NS, 'svg');
    chartSlot.appendChild(svg);
    var series = results.map(function(res, i) {
      return {
        label: res.strategy_id,
        color: STRATEGY_OVERLAY_COLORS[i] || '#aaaaaa',
        points: STRATEGY_OVERLAY_STATE.visible[res.strategy_id]
          ? res.points.map(function(p) {
              return [p.closed_at, Number(p.cumulative_pnl_net) || 0];
            })
          : [],
      };
    });
    var anyVisible = series.some(function(s) { return s.points.length >= 2; });
    renderTraderLineChart(svg, series, {
      width: 640,
      height: 200,
      showZeroLine: true,
      yFormat: function(v) { return '$' + v.toFixed(0); },
      emptyMessage: anyVisible ? 'Not enough data yet.' : 'All strategies hidden -- click a chip to show.',
    });
  }

  function renderChips() {
    _clearChildren(chipsSlot);
    ranked.forEach(function(r, i) {
      var chip = document.createElement('label');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!STRATEGY_OVERLAY_STATE.visible[r.strategy_id];
      cb.addEventListener('change', function() {
        STRATEGY_OVERLAY_STATE.visible[r.strategy_id] = cb.checked;
        drawOverlay();
      });
      var dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;background:' +
        (STRATEGY_OVERLAY_COLORS[i] || '#aaaaaa') + ';';
      var lab = document.createElement('span');
      lab.textContent = r.strategy_id + ' (' + (r.trade_count || 0) + ')';
      chip.appendChild(cb);
      chip.appendChild(dot);
      chip.appendChild(lab);
      chipsSlot.appendChild(chip);
    });
  }

  renderChips();
  drawOverlay();
}

// ---------------------------------------------------------------------------
// Phase 3 Task 2 -- Strategy track records
// ---------------------------------------------------------------------------

async function refreshTraderTrackRecords() {
  var container = document.getElementById('trader-track-records');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/track-records');
    if (data === null) return; // auth redirect
    renderTraderTrackRecords((data && data.track_records) || [], container);
  } catch (e) {
    container.textContent = 'Track records unavailable: ' + String(e);
  }
}

function renderTraderTrackRecords(records, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Strategy Track Records (' + records.length + ')';
  container.appendChild(heading);

  if (records.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No closed trades yet. Track records appear after the first verdict lands.';
    container.appendChild(empty);
    return;
  }

  var hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-bottom:8px;';
  hint.textContent = 'Recomputed after every closed verdict. Drives the autonomy ladder size gates.';
  container.appendChild(hint);

  // Phase 7 Task 1 -- strategy equity comparison overlay.  Takes the
  // top 3 strategies by trade_count, fetches their equity curves in
  // parallel, and overlays them so the operator can compare without
  // drilling into each one.  Placed above the table so the chart is
  // the first thing the eye lands on; the table stays the detail view.
  var overlayCard = document.createElement('div');
  overlayCard.style.cssText = 'margin-bottom:14px;';
  container.appendChild(overlayCard);
  _refreshStrategyOverlayInto(overlayCard, records);

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Strategy', 'Trades', 'Win %', 'Net PnL', 'Avg Win', 'Avg Loss', 'Sharpe', 'Max DD'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  records.forEach(function(r) {
    var tr = document.createElement('tr');
    // Phase 4 Task D -- whole row clicks through to the drill-down page.
    tr.className = 'trader-decision-row';
    tr.title = 'Click to open strategy detail';
    tr.addEventListener('click', function() {
      location.hash = '#trader/strategy/' + encodeURIComponent(r.strategy_id);
    });
    var winPct = r.trade_count > 0 ? ((r.win_count / r.trade_count) * 100).toFixed(1) + '%' : '-';
    var netPnl = '$' + Number(r.net_pnl_usd).toFixed(2);
    var avgWin = (Number(r.avg_winner_pct) * 100).toFixed(2) + '%';
    var avgLoss = (Number(r.avg_loser_pct) * 100).toFixed(2) + '%';
    var sharpe = Number(r.rolling_sharpe).toFixed(2);
    var maxDd = (Number(r.max_dd_pct) * 100).toFixed(2) + '%';

    [r.strategy_id, r.trade_count, winPct, netPnl, avgWin, avgLoss, sharpe, maxDd].forEach(function(val, i) {
      var td = document.createElement('td');
      // Make the strategy_id cell visibly link-like (cursor comes via CSS on .trader-decision-row).
      if (i === 0) {
        var link = document.createElement('span');
        link.textContent = String(val);
        link.style.textDecoration = 'underline';
        link.style.opacity = '0.95';
        td.appendChild(link);
      } else {
        td.textContent = String(val);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

// ---------------------------------------------------------------------------
// Phase 2 Task 8 -- Recent decisions card + committee transcript modal
// ---------------------------------------------------------------------------

async function refreshTraderSignalQueue() {
  var container = document.getElementById('trader-signal-queue');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/signals?limit=50');
    if (data === null) return;
    renderTraderSignalQueue(data.pending || [], data.history || [], container);
  } catch (e) {
    container.textContent = 'Signal queue unavailable: ' + String(e);
  }
}

function appendTraderScrollable(parent, child, maxHeightPx) {
  var wrap = document.createElement('div');
  wrap.className = 'trader-scroll-region';
  if (maxHeightPx) wrap.style.maxHeight = maxHeightPx + 'px';
  wrap.appendChild(child);
  parent.appendChild(wrap);
  return wrap;
}

function refreshTraderAfterSignalAction() {
  refreshTraderSignalQueue();
  refreshTraderDecisions();
  if (_strategyDetailState.strategyId) {
    loadStrategyDecisions(_strategyDetailState.strategyId);
    loadStrategyVerdicts(_strategyDetailState.strategyId, true);
  }
  setTimeout(function() {
    refreshTraderSignalQueue();
    refreshTraderDecisions();
    if (_strategyDetailState.strategyId) {
      loadStrategyDecisions(_strategyDetailState.strategyId);
      loadStrategyVerdicts(_strategyDetailState.strategyId, true);
    }
  }, 1500);
}

async function respondToTraderSignal(signalId, action, buttons) {
  if (!signalId || !action) return;
  if (action === 'pause' && !confirm('Pause this strategy for new signals?')) return;
  (buttons || []).forEach(function(btn) { btn.disabled = true; });
  var result = await apiFetch(
    '/api/v1/trader/signals/' + encodeURIComponent(signalId) + '/action',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action }),
    },
  );
  if (result && result.ok) {
    showToast('Trader action sent', 'success');
    refreshTraderAfterSignalAction();
    return;
  }
  (buttons || []).forEach(function(btn) { btn.disabled = false; });
  var msg = (result && result.data && result.data.error) ? result.data.error : 'Signal action failed';
  showToast(msg, 'error');
}

function makeTraderSignalActionButton(label, action, signalId, buttons) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--sm btn--ghost trader-signal-action-btn';
  btn.textContent = label;
  btn.onclick = function() { respondToTraderSignal(signalId, action, buttons); };
  buttons.push(btn);
  return btn;
}

function renderTraderSignalQueue(pending, history, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Signal Queue';
  container.appendChild(heading);

  // --- Pending section ---
  if (pending.length > 0) {
    var pendingLabel = document.createElement('div');
    pendingLabel.style.cssText = 'font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7;margin-bottom:6px;color:var(--accent,#4caf50);';
    pendingLabel.textContent = 'Awaiting Response (' + pending.length + ')';
    container.appendChild(pendingLabel);

    var pendingList = document.createElement('div');
    pendingList.className = 'trader-pending-list';

    pending.forEach(function(s) {
      var row = document.createElement('div');
      row.className = 'trader-pending-row';

      var info = document.createElement('div');
      info.className = 'trader-pending-row__info';

      var badge = document.createElement('span');
      badge.style.cssText = 'font-size:0.75rem;font-weight:700;padding:2px 7px;border-radius:10px;background:var(--accent,#4caf50);color:#fff;flex-shrink:0;';
      badge.textContent = 'PENDING';
      info.appendChild(badge);

      var side = document.createElement('span');
      side.style.cssText = 'font-weight:600;font-size:0.9rem;min-width:32px;' + (s.side === 'buy' ? 'color:#4caf50;' : 'color:#f44336;');
      side.textContent = (s.side || '').toUpperCase();
      info.appendChild(side);

      var asset = document.createElement('span');
      asset.style.cssText = 'font-weight:500;font-size:0.9rem;';
      asset.textContent = s.asset || '-';
      info.appendChild(asset);

      var conf = document.createElement('span');
      conf.style.cssText = 'opacity:0.7;font-size:0.85rem;';
      conf.textContent = 'conf ' + Number(s.raw_score).toFixed(2);
      info.appendChild(conf);

      var when = document.createElement('span');
      when.style.cssText = 'margin-left:auto;opacity:0.5;font-size:0.8rem;white-space:nowrap;';
      when.textContent = new Date(Number(s.generated_at)).toLocaleString();
      info.appendChild(when);
      row.appendChild(info);

      if (CURRENT_USER && CURRENT_USER.isAdmin) {
        var actions = document.createElement('div');
        actions.className = 'trader-pending-row__actions';
        var buttons = [];
        actions.appendChild(makeTraderSignalActionButton('Approve', 'approve', s.id, buttons));
        actions.appendChild(makeTraderSignalActionButton('Skip', 'skip', s.id, buttons));
        actions.appendChild(makeTraderSignalActionButton('$250', 'bigger', s.id, buttons));
        actions.appendChild(makeTraderSignalActionButton('Pause', 'pause', s.id, buttons));
        row.appendChild(actions);
      }

      pendingList.appendChild(row);
    });

    appendTraderScrollable(container, pendingList, 320);

    var divider = document.createElement('div');
    divider.style.cssText = 'border-top:1px solid rgba(128,128,128,0.15);margin:10px 0;';
    container.appendChild(divider);
  }

  // --- History section ---
  var histLabel = document.createElement('div');
  histLabel.style.cssText = 'font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7;margin-bottom:6px;';
  histLabel.textContent = 'Recent Signals (' + history.length + ')';
  container.appendChild(histLabel);

  if (history.length === 0 && pending.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No signals yet. The strategy scanner fires when momentum conditions are met.';
    container.appendChild(empty);
    return;
  }

  if (history.length === 0) {
    var noHist = document.createElement('div');
    noHist.style.cssText = 'opacity:0.5;font-size:0.85rem;';
    noHist.textContent = 'No responded signals yet.';
    container.appendChild(noHist);
    return;
  }

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['When', 'Asset', 'Side', 'Conf', 'Response', 'Outcome'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  history.forEach(function(s) {
    var tr = document.createElement('tr');

    var responseLabel = s.approval_response || 'timeout';
    var outcomeLabel = s.decision_status || (responseLabel === 'skip' ? 'skipped' : responseLabel === 'pause' ? 'paused' : 'vetoed');

    var responseColor = responseLabel === 'approve' ? 'color:#4caf50;' : 'color:#f44336;';
    var outcomeColor = outcomeLabel === 'executed' ? 'color:#4caf50;' : outcomeLabel === 'skipped' || outcomeLabel === 'paused' ? 'color:rgba(128,128,128,0.8);' : 'color:#f44336;';

    var when = new Date(Number(s.generated_at)).toLocaleString();
    var sideStyle = s.side === 'buy' ? 'color:#4caf50;font-weight:600;' : 'color:#f44336;font-weight:600;';

    [
      { text: when, style: '' },
      { text: s.asset || '-', style: 'font-weight:500;' },
      { text: (s.side || '-').toUpperCase(), style: sideStyle },
      { text: Number(s.raw_score).toFixed(2), style: 'opacity:0.8;' },
      { text: responseLabel.toUpperCase(), style: responseColor + 'font-weight:600;font-size:0.85rem;' },
      { text: outcomeLabel.toUpperCase(), style: outcomeColor + 'font-size:0.85rem;' },
    ].forEach(function(cell) {
      var td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.style) td.style.cssText = cell.style;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  appendTraderScrollable(container, table, 360);
}

async function refreshTraderDecisions() {
  var container = document.getElementById('trader-decisions');
  if (!container) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/decisions?limit=25');
    if (data === null) return; // fetchFromAPI returns null on auth redirect
    renderTraderDecisions((data && data.decisions) || [], container);
  } catch (e) {
    container.textContent = 'Decisions unavailable: ' + String(e);
  }
}

function renderTraderDecisions(decisions, container) {
  while (container.firstChild) container.removeChild(container.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Recent Decisions (' + decisions.length + ')';
  container.appendChild(heading);

  if (decisions.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No decisions yet. Signals routed through the committee will show up here.';
    container.appendChild(empty);
    return;
  }

  var hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-bottom:8px;';
  hint.textContent = 'Click a row to see the committee transcript (when linked).';
  container.appendChild(hint);

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['When', 'Asset', 'Action', 'Size', 'Status', 'Thesis'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  decisions.forEach(function(d) {
    var tr = document.createElement('tr');
    tr.className = 'trader-decision-row';
    if (!d.committee_transcript_id) {
      tr.classList.add('trader-decision-row--no-transcript');
      tr.title = 'No committee transcript linked to this decision';
    } else {
      tr.addEventListener('click', function() { openTranscriptModal(d.id); });
    }

    var when = new Date(Number(d.decided_at) || Date.now()).toLocaleString();
    var size = (d.size_usd != null) ? ('$' + Number(d.size_usd).toFixed(0)) : '-';
    var thesis = String(d.thesis || '');
    if (thesis.length > 80) thesis = thesis.slice(0, 77) + '...';

    [when, d.asset || '-', d.action || '-', size, d.status || '-', thesis].forEach(function(val) {
      var td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  appendTraderScrollable(container, table, 320);
}

async function openTranscriptModal(decisionId) {
  var existing = document.getElementById('trader-transcript-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'trader-transcript-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card trader-transcript-box';
  box.style.cssText = 'width:min(780px,96vw);max-height:88vh;overflow-y:auto;padding:22px;';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;';
  var title = document.createElement('h3');
  title.style.margin = '0';
  title.textContent = 'Committee Transcript';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--sm btn--ghost';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  header.appendChild(title);
  header.appendChild(closeBtn);
  box.appendChild(header);

  var loading = document.createElement('div');
  loading.textContent = 'Loading transcript...';
  loading.style.cssText = 'opacity:0.7;';
  box.appendChild(loading);

  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);

  try {
    var data = await fetchFromAPI('/api/v1/trader/decisions/' + encodeURIComponent(decisionId) + '/transcript');
    if (data === null) return; // auth redirect
    loading.remove();
    renderTranscriptBody(box, data);
  } catch (e) {
    loading.textContent = 'Failed to load transcript: ' + String(e);
  }
}

function renderTranscriptBody(box, data) {
  var d = data.decision || {};
  var t = data.transcript || {};
  var body = t.body || {};

  // Decision summary block
  var summary = document.createElement('div');
  summary.className = 'trader-transcript-section';
  var summaryTitle = document.createElement('div');
  summaryTitle.className = 'trader-transcript-section-title';
  summaryTitle.textContent = 'Decision';
  summary.appendChild(summaryTitle);
  var when = new Date(Number(d.decided_at) || Date.now()).toLocaleString();
  var sizeTxt = (d.size_usd != null) ? ('$' + Number(d.size_usd).toFixed(2)) : '-';
  var conf = (d.confidence != null) ? (Number(d.confidence).toFixed(2)) : '-';
  summary.appendChild(kvRow('When', when));
  summary.appendChild(kvRow('Asset', d.asset || '-'));
  summary.appendChild(kvRow('Action', (d.action || '-') + ' (' + (d.entry_type || 'n/a') + ')'));
  summary.appendChild(kvRow('Size', sizeTxt));
  summary.appendChild(kvRow('Status', d.status || '-'));
  summary.appendChild(kvRow('Confidence', conf));
  summary.appendChild(kvRow('Thesis', d.thesis || '-'));
  box.appendChild(summary);

  // Committee metadata
  var meta = document.createElement('div');
  meta.className = 'trader-transcript-section';
  var metaTitle = document.createElement('div');
  metaTitle.className = 'trader-transcript-section-title';
  metaTitle.textContent = 'Committee run';
  meta.appendChild(metaTitle);
  meta.appendChild(kvRow('Rounds executed', String(t.rounds != null ? t.rounds : (body.rounds_executed || '-'))));
  meta.appendChild(kvRow('Total tokens', String(t.total_tokens != null ? t.total_tokens : '-')));
  var costTxt = (t.total_cost_usd != null) ? ('$' + Number(t.total_cost_usd).toFixed(4)) : '-';
  meta.appendChild(kvRow('Total cost', costTxt));
  if (body.started_at && body.finished_at) {
    var runtimeMs = Number(body.finished_at) - Number(body.started_at);
    meta.appendChild(kvRow('Runtime', (runtimeMs / 1000).toFixed(1) + 's'));
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    meta.appendChild(kvRow('Errors', body.errors.join('; ')));
  }
  box.appendChild(meta);

  // Round 1 specialists
  if (Array.isArray(body.round_1) && body.round_1.length > 0) {
    var r1 = document.createElement('div');
    r1.className = 'trader-transcript-section';
    var r1Title = document.createElement('div');
    r1Title.className = 'trader-transcript-section-title';
    r1Title.textContent = 'Round 1 - Specialists';
    r1.appendChild(r1Title);
    body.round_1.forEach(function(op) {
      r1.appendChild(makeSpecialistBlock(op));
    });
    box.appendChild(r1);
  }

  // Coordinator
  if (body.coordinator) {
    var c = document.createElement('div');
    c.className = 'trader-transcript-section';
    var cTitle = document.createElement('div');
    cTitle.className = 'trader-transcript-section-title';
    cTitle.textContent = 'Coordinator synthesis';
    c.appendChild(cTitle);
    c.appendChild(kvRow('Consensus', body.coordinator.consensus_direction || '-'));
    c.appendChild(kvRow('Avg confidence', String(body.coordinator.avg_confidence != null ? body.coordinator.avg_confidence : '-')));
    c.appendChild(kvRow('Skip round 2', String(body.coordinator.skip_round_2)));
    if (Array.isArray(body.coordinator.challenges) && body.coordinator.challenges.length > 0) {
      body.coordinator.challenges.forEach(function(ch) {
        c.appendChild(kvRow('Challenge to ' + (ch.role || '?'), ch.question || '-'));
      });
    }
    box.appendChild(c);
  }

  // Round 2 responses
  if (Array.isArray(body.round_2) && body.round_2.length > 0) {
    var r2 = document.createElement('div');
    r2.className = 'trader-transcript-section';
    var r2Title = document.createElement('div');
    r2Title.className = 'trader-transcript-section-title';
    r2Title.textContent = 'Round 2 - Responses';
    r2.appendChild(r2Title);
    body.round_2.forEach(function(resp) {
      var block = document.createElement('div');
      block.className = 'trader-transcript-specialist';
      var role = document.createElement('div');
      role.className = 'trader-transcript-specialist-role';
      role.textContent = (resp.role || 'unknown') + ' (updated confidence ' + (resp.updated_confidence != null ? resp.updated_confidence : '-') + ')';
      block.appendChild(role);
      var body2 = document.createElement('div');
      body2.textContent = resp.response || '-';
      block.appendChild(body2);
      r2.appendChild(block);
    });
    box.appendChild(r2);
  }

  // Risk officer
  if (body.risk_officer) {
    var rk = document.createElement('div');
    rk.className = 'trader-transcript-section';
    var rkTitle = document.createElement('div');
    rkTitle.className = 'trader-transcript-section-title';
    rkTitle.textContent = 'Risk officer';
    rk.appendChild(rkTitle);
    var vetoBadge = document.createElement('span');
    vetoBadge.className = 'trader-cb-badge ' + (body.risk_officer.veto ? 'trader-cb-tripped' : 'trader-cb-ok');
    vetoBadge.textContent = body.risk_officer.veto ? 'VETO' : 'passed';
    rk.appendChild(vetoBadge);
    rk.appendChild(kvRow('Reason', body.risk_officer.reason || '-'));
    if (Array.isArray(body.risk_officer.concerns) && body.risk_officer.concerns.length > 0) {
      rk.appendChild(kvRow('Concerns', body.risk_officer.concerns.join('; ')));
    }
    box.appendChild(rk);
  }

  // Trader verdict
  if (body.trader) {
    var tr = document.createElement('div');
    tr.className = 'trader-transcript-section';
    var trTitle = document.createElement('div');
    trTitle.className = 'trader-transcript-section-title';
    trTitle.textContent = 'Trader verdict';
    tr.appendChild(trTitle);
    tr.appendChild(kvRow('Action', body.trader.action || '-'));
    tr.appendChild(kvRow('Size multiplier', String(body.trader.size_multiplier != null ? body.trader.size_multiplier : '-')));
    tr.appendChild(kvRow('Confidence', String(body.trader.confidence != null ? body.trader.confidence : '-')));
    tr.appendChild(kvRow('Thesis', body.trader.thesis || '-'));
    box.appendChild(tr);
  }
}

function makeSpecialistBlock(op) {
  var block = document.createElement('div');
  block.className = 'trader-transcript-specialist';
  var role = document.createElement('div');
  role.className = 'trader-transcript-specialist-role';
  role.textContent = (op.role || 'unknown') + ' (confidence ' + (op.confidence != null ? op.confidence : '-') + ')';
  block.appendChild(role);
  var opinion = document.createElement('div');
  opinion.textContent = op.opinion || '-';
  block.appendChild(opinion);
  if (Array.isArray(op.concerns) && op.concerns.length > 0) {
    var concerns = document.createElement('div');
    concerns.style.cssText = 'opacity:0.75;font-size:0.85rem;margin-top:4px;';
    concerns.textContent = 'Concerns: ' + op.concerns.join('; ');
    block.appendChild(concerns);
  }
  return block;
}

function kvRow(label, value) {
  var row = document.createElement('div');
  row.className = 'trader-transcript-kv';
  var lbl = document.createElement('span');
  lbl.className = 'trader-transcript-kv-label';
  lbl.textContent = label;
  var val = document.createElement('span');
  val.className = 'trader-transcript-kv-value';
  val.textContent = value;
  row.appendChild(lbl);
  row.appendChild(val);
  return row;
}

async function engineKillSwitch() {
  if (!confirm('Halt the trading engine? This will block new orders until manually cleared.')) return;
  var res = await apiFetch('/api/v1/trader/halt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'manual halt via dashboard' }),
  });
  if (res && res.ok) {
    alert('Engine halted.');
    refreshTraderRisk();
  } else {
    alert('Halt failed: ' + (res ? res.status : 'network error'));
  }
}

// ===========================================================================
// Phase 4 Task D -- Strategy drill-down page (#trader/strategy/:id)
// ===========================================================================
//
// Mounts inside page-trader underneath (and hiding) the main trader cards.
// Composed of four cards: verdict history (paginated, in-memory cursor),
// equity curve (inline SVG polyline), attribution (per-role tally), and
// recent decisions filtered to this strategy. The decisions card reuses
// openTranscriptModal from the main page for click-to-transcript.

var _strategyDetailState = {
  strategyId: null,
  verdictCursor: null,  // compound cursor {closed_at, id} or null when exhausted
  verdicts: [],         // accumulated across pagination clicks
  // Phase 5 Task 7a -- last known status from the verdicts response
  // (`active` / `paused` / etc.). Used to drive the Pause Strategy
  // button enabled state. null until the first verdicts fetch lands.
  strategyStatus: null,
};

function initStrategyDetail(strategyId) {
  ensureTraderPageDOM();
  var page = document.getElementById('page-trader');
  if (!page) return;

  // Hide the main trader cards while the drill-down is open.
  Array.prototype.forEach.call(page.children, function(child) {
    if (child.id !== 'strategy-detail-container' && child.className !== 'page-heading-row') {
      child.style.display = 'none';
    }
  });

  var container = document.getElementById('strategy-detail-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'strategy-detail-container';
    page.appendChild(container);
  }
  container.style.display = '';
  while (container.firstChild) container.removeChild(container.firstChild);

  // Reset in-memory pagination state for a fresh strategy load.
  _strategyDetailState.strategyId = strategyId;
  _strategyDetailState.verdictCursor = null;
  _strategyDetailState.verdicts = [];
  _strategyDetailState.strategyStatus = null;

  // Back button row
  var backRow = document.createElement('div');
  backRow.style.cssText = 'margin-bottom:10px;display:flex;align-items:center;gap:12px;';
  var backBtn = document.createElement('button');
  backBtn.className = 'btn btn--sm btn--ghost';
  backBtn.textContent = 'Back to Trader';
  backBtn.onclick = function() {
    location.hash = '#trader';
    closeStrategyDetail();
  };
  var title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:1.05rem;';
  title.textContent = 'Strategy: ' + strategyId;
  backRow.appendChild(backBtn);
  backRow.appendChild(title);

  // Phase 5 Task 7a -- Pause Strategy button. Admin-only on the server
  // (POST /api/v1/trader/strategies/:id/pause uses requireAdmin) so we
  // hide the button entirely from non-admins. The button text + disabled
  // state is recomputed in renderStrategyVerdicts when the verdicts
  // response surfaces strategy_status.
  if (CURRENT_USER && CURRENT_USER.isAdmin) {
    var pauseBtn = document.createElement('button');
    pauseBtn.id = 'strategy-detail-pause-btn';
    pauseBtn.className = 'btn btn--sm';
    pauseBtn.textContent = 'Pause Strategy';
    pauseBtn.style.marginLeft = 'auto';
    pauseBtn.onclick = function() { pauseStrategy(strategyId); };
    backRow.appendChild(pauseBtn);
  }

  container.appendChild(backRow);

  // Four cards, stacked
  var equityCard = document.createElement('div');
  equityCard.id = 'strategy-detail-equity';
  equityCard.className = 'stat-card';
  equityCard.style.cssText = 'padding:18px;margin-top:12px;';
  equityCard.textContent = 'Loading equity curve...';
  container.appendChild(equityCard);

  var attribCard = document.createElement('div');
  attribCard.id = 'strategy-detail-attribution';
  attribCard.className = 'stat-card';
  attribCard.style.cssText = 'padding:18px;margin-top:12px;';
  attribCard.textContent = 'Loading attribution...';
  container.appendChild(attribCard);

  var verdictsCard = document.createElement('div');
  verdictsCard.id = 'strategy-detail-verdicts';
  verdictsCard.className = 'stat-card';
  verdictsCard.style.cssText = 'padding:18px;margin-top:12px;';
  verdictsCard.textContent = 'Loading verdict history...';
  container.appendChild(verdictsCard);

  var decisionsCard = document.createElement('div');
  decisionsCard.id = 'strategy-detail-decisions';
  decisionsCard.className = 'stat-card';
  decisionsCard.style.cssText = 'padding:18px;margin-top:12px;';
  decisionsCard.textContent = 'Loading recent decisions...';
  container.appendChild(decisionsCard);

  loadStrategyEquityCurve(strategyId);
  loadStrategyAttribution(strategyId);
  loadStrategyVerdicts(strategyId, true);
  loadStrategyDecisions(strategyId);
}

function closeStrategyDetail() {
  var page = document.getElementById('page-trader');
  if (!page) return;
  var container = document.getElementById('strategy-detail-container');
  if (container) container.style.display = 'none';
  // Restore the main trader cards. Keep the kill-switch-log container
  // hidden when collapsed so we do not unintentionally reveal it.
  Array.prototype.forEach.call(page.children, function(child) {
    if (child.id === 'strategy-detail-container') return;
    if (child.id === 'kill-switch-log-container') return;
    child.style.display = '';
  });
  _strategyDetailState.strategyId = null;
  _strategyDetailState.verdictCursor = null;
  _strategyDetailState.verdicts = [];
  _strategyDetailState.strategyStatus = null;
}

// ---------------------------------------------------------------------------
// Phase 6 Task 5 -- Kill Switch Audit Log page at #trader/kill-switch-log
// ---------------------------------------------------------------------------
//
// Admin-only page mounted inside the trader section. Renders a filterable
// table of kill_switch_log entries read from GET /api/v1/trader/kill-switch-log
// and links to the CSV endpoint for a full export. Non-admins are redirected
// back to #trader.

var _killSwitchLogState = {
  sinceMs: null,
  untilMs: null,
  limit: 100,
};

function closeKillSwitchLogPage() {
  var page = document.getElementById('page-trader');
  if (!page) return;
  var container = document.getElementById('kill-switch-log-container');
  if (container) container.style.display = 'none';
  Array.prototype.forEach.call(page.children, function(child) {
    if (child.id === 'strategy-detail-container') return;
    if (child.id === 'kill-switch-log-container') return;
    child.style.display = '';
  });
}

function renderKillSwitchLogPage() {
  // Admin-only -- match the Users page gate. Non-admin gets bounced back
  // to the main trader page. CURRENT_USER is populated by loadCurrentUser()
  // during app init; defensively bounce to dashboard if missing.
  if (!CURRENT_USER) {
    navigateToPage('page-dashboard', false);
    return;
  }
  if (!CURRENT_USER.isAdmin) {
    location.hash = '#trader';
    return;
  }

  ensureTraderPageDOM();
  var page = document.getElementById('page-trader');
  if (!page) return;

  // Hide the main trader cards + any open strategy drill-down while this
  // admin page is open. Mirror the strategy-detail approach so the page
  // transition stays snappy.
  Array.prototype.forEach.call(page.children, function(child) {
    if (child.id !== 'kill-switch-log-container' && child.className !== 'page-heading-row') {
      child.style.display = 'none';
    }
  });

  var container = document.getElementById('kill-switch-log-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'kill-switch-log-container';
    page.appendChild(container);
  }
  container.style.display = '';
  while (container.firstChild) container.removeChild(container.firstChild);

  // Top bar: Back button, page title, Download CSV button (right-aligned).
  var topBar = document.createElement('div');
  topBar.style.cssText = 'margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;';

  var backBtn = document.createElement('button');
  backBtn.className = 'btn btn--sm btn--ghost';
  backBtn.textContent = 'Back to Trader';
  backBtn.onclick = function() {
    location.hash = '#trader';
    closeKillSwitchLogPage();
  };
  topBar.appendChild(backBtn);

  var title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:1.05rem;';
  title.textContent = 'Kill Switch Audit Log';
  topBar.appendChild(title);

  var csvBtn = document.createElement('button');
  csvBtn.id = 'kill-switch-log-csv-btn';
  csvBtn.className = 'btn btn--sm';
  csvBtn.textContent = 'Download CSV';
  csvBtn.style.marginLeft = 'auto';
  csvBtn.onclick = function() {
    var qs = _buildKillSwitchLogQuery();
    var url = '/api/v1/trader/kill-switch-log.csv' + (qs ? '?' + qs : '');
    window.location.href = url;
  };
  topBar.appendChild(csvBtn);

  container.appendChild(topBar);

  // Filter row: since, until, limit. Kept inline via <input type=datetime-local>
  // so the native picker renders without pulling in a calendar widget.
  var filterRow = document.createElement('div');
  filterRow.className = 'stat-card';
  filterRow.style.cssText = 'padding:14px;margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;';

  var sinceLabel = document.createElement('label');
  sinceLabel.style.cssText = 'display:flex;flex-direction:column;font-size:0.85rem;gap:4px;';
  sinceLabel.textContent = 'Since';
  var sinceInput = document.createElement('input');
  sinceInput.type = 'datetime-local';
  sinceInput.id = 'kill-switch-log-since';
  sinceInput.className = 'input';
  sinceInput.style.minWidth = '200px';
  sinceLabel.appendChild(sinceInput);
  filterRow.appendChild(sinceLabel);

  var untilLabel = document.createElement('label');
  untilLabel.style.cssText = 'display:flex;flex-direction:column;font-size:0.85rem;gap:4px;';
  untilLabel.textContent = 'Until';
  var untilInput = document.createElement('input');
  untilInput.type = 'datetime-local';
  untilInput.id = 'kill-switch-log-until';
  untilInput.className = 'input';
  untilInput.style.minWidth = '200px';
  untilLabel.appendChild(untilInput);
  filterRow.appendChild(untilLabel);

  var limitLabel = document.createElement('label');
  limitLabel.style.cssText = 'display:flex;flex-direction:column;font-size:0.85rem;gap:4px;';
  limitLabel.textContent = 'Limit';
  var limitSelect = document.createElement('select');
  limitSelect.id = 'kill-switch-log-limit';
  limitSelect.className = 'input';
  [50, 100, 500].forEach(function(n) {
    var opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === _killSwitchLogState.limit) opt.selected = true;
    limitSelect.appendChild(opt);
  });
  limitLabel.appendChild(limitSelect);
  filterRow.appendChild(limitLabel);

  var applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn--sm';
  applyBtn.textContent = 'Apply';
  applyBtn.onclick = function() {
    _killSwitchLogState.sinceMs = _parseDateTimeLocalMs(sinceInput.value);
    _killSwitchLogState.untilMs = _parseDateTimeLocalMs(untilInput.value);
    var l = parseInt(limitSelect.value, 10);
    if (Number.isFinite(l) && l > 0) _killSwitchLogState.limit = l;
    loadKillSwitchLogEntries();
  };
  filterRow.appendChild(applyBtn);

  container.appendChild(filterRow);

  // Table card -- populated asynchronously by loadKillSwitchLogEntries.
  var tableCard = document.createElement('div');
  tableCard.id = 'kill-switch-log-table';
  tableCard.className = 'stat-card';
  tableCard.style.cssText = 'padding:18px;margin-top:12px;';
  tableCard.textContent = 'Loading audit log...';
  container.appendChild(tableCard);

  loadKillSwitchLogEntries();
}

// Parses an <input type="datetime-local"> value (`YYYY-MM-DDTHH:mm`) into
// a milliseconds timestamp. Returns null for empty/invalid input so the
// query string excludes the parameter and the server applies its default.
function _parseDateTimeLocalMs(val) {
  if (!val) return null;
  var d = new Date(val);
  var ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _buildKillSwitchLogQuery() {
  var parts = [];
  if (_killSwitchLogState.sinceMs != null) parts.push('since_ms=' + _killSwitchLogState.sinceMs);
  if (_killSwitchLogState.untilMs != null) parts.push('until_ms=' + _killSwitchLogState.untilMs);
  if (_killSwitchLogState.limit != null)   parts.push('limit=' + _killSwitchLogState.limit);
  return parts.join('&');
}

async function loadKillSwitchLogEntries() {
  var card = document.getElementById('kill-switch-log-table');
  if (!card) return;
  var qs = _buildKillSwitchLogQuery();
  var url = '/api/v1/trader/kill-switch-log' + (qs ? '?' + qs : '');
  var data = await fetchFromAPI(url);
  renderKillSwitchLogTable(card, (data && data.entries) || []);
}

function renderKillSwitchLogTable(card, entries) {
  while (card.firstChild) card.removeChild(card.firstChild);

  if (!Array.isArray(entries) || entries.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No kill-switch toggles in the selected window.';
    card.appendChild(empty);
    return;
  }

  var table = document.createElement('table');
  table.className = 'data-table';
  table.style.cssText = 'width:100%;border-collapse:collapse;';

  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  ['Toggled At', 'State', 'Reason', 'Operator'].forEach(function(label) {
    var th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = 'text-align:left;padding:8px 10px;border-bottom:1px solid var(--border-color, #333);font-weight:600;';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  entries.forEach(function(e) {
    var row = document.createElement('tr');

    var tsCell = document.createElement('td');
    tsCell.style.cssText = 'padding:8px 10px;border-bottom:1px solid var(--border-color, #222);';
    tsCell.textContent = _formatKillSwitchLogTs(e.toggled_at_ms);
    row.appendChild(tsCell);

    var stateCell = document.createElement('td');
    stateCell.style.cssText = 'padding:8px 10px;border-bottom:1px solid var(--border-color, #222);';
    stateCell.textContent = (e.new_state === 'tripped') ? 'Tripped' : 'Cleared';
    row.appendChild(stateCell);

    var reasonCell = document.createElement('td');
    reasonCell.style.cssText = 'padding:8px 10px;border-bottom:1px solid var(--border-color, #222);';
    reasonCell.textContent = e.reason || '';
    row.appendChild(reasonCell);

    var byCell = document.createElement('td');
    byCell.style.cssText = 'padding:8px 10px;border-bottom:1px solid var(--border-color, #222);';
    byCell.textContent = e.set_by || '';
    row.appendChild(byCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  card.appendChild(table);

  var footer = document.createElement('div');
  footer.style.cssText = 'margin-top:10px;font-size:0.8rem;opacity:0.65;';
  footer.textContent = 'Showing ' + entries.length + ' entries. Cap is 500 per request; drop the window or download CSV for more.';
  card.appendChild(footer);
}

function _formatKillSwitchLogTs(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
  } catch (_) {
    return String(ms);
  }
}

// Phase 5 Task 7a -- POST the pause endpoint and refresh the page.
async function pauseStrategy(strategyId) {
  if (!strategyId) return;
  if (!confirm('Pause strategy "' + strategyId + '"? New signals will stop until you resume it.')) return;
  var res = await apiFetch(
    '/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/pause',
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  if (res && res.ok) {
    alert('Strategy paused.');
    // Re-fetch verdicts so the response strategy_status flips to 'paused'
    // and the syncPauseButtonState helper disables the button.
    loadStrategyVerdicts(strategyId, true);
  } else {
    var msg = (res && res.data && res.data.error) ? res.data.error : ('HTTP ' + (res ? res.status : 'network error'));
    alert('Pause failed: ' + msg);
  }
}

// Phase 5 Task 7a -- update the Pause Strategy button enabled state +
// label from the current _strategyDetailState.strategyStatus value.
// Called after every verdicts fetch.
function syncPauseButtonState() {
  var btn = document.getElementById('strategy-detail-pause-btn');
  if (!btn) return;
  var status = _strategyDetailState.strategyStatus;
  if (status === 'active' || status === null) {
    btn.disabled = (status !== 'active');
    btn.textContent = (status === 'active') ? 'Pause Strategy' : 'Pause Strategy';
  } else {
    btn.disabled = true;
    btn.textContent = 'Strategy ' + status;
  }
}

async function loadStrategyEquityCurve(strategyId) {
  var card = document.getElementById('strategy-detail-equity');
  if (!card) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/equity-curve');
    if (data === null) return;
    renderStrategyEquityCurve(card, (data && data.points) || []);
  } catch (e) {
    card.textContent = 'Equity curve unavailable: ' + String(e);
  }
}

function renderStrategyEquityCurve(card, points) {
  while (card.firstChild) card.removeChild(card.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Equity Curve (cumulative net pnl)';
  card.appendChild(heading);

  if (!Array.isArray(points) || points.length < 2) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = points.length === 1
      ? 'Need at least 2 verdicts to draw a curve (only 1 so far).'
      : 'No closed verdicts yet.';
    card.appendChild(empty);
    return;
  }

  // SVG sized responsively via viewBox; width/height define the drawing
  // coordinates. Padding leaves room for axis labels.
  var W = 640, H = 240, PAD_L = 50, PAD_R = 16, PAD_T = 16, PAD_B = 28;
  var minT = points[0].closed_at;
  var maxT = points[points.length - 1].closed_at;
  var pnls = points.map(function(p) { return Number(p.cumulative_pnl_net) || 0; });
  var minY = Math.min.apply(null, pnls);
  var maxY = Math.max.apply(null, pnls);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  var tRange = Math.max(maxT - minT, 1);
  var yRange = maxY - minY;

  function xFor(t) { return PAD_L + (t - minT) / tRange * (W - PAD_L - PAD_R); }
  function yFor(v) { return PAD_T + (1 - (v - minY) / yRange) * (H - PAD_T - PAD_B); }

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '240');
  svg.style.cssText = 'background:rgba(255,255,255,0.03);border-radius:6px;';

  // Horizontal grid (5 lines)
  for (var g = 0; g <= 4; g++) {
    var gy = PAD_T + g / 4 * (H - PAD_T - PAD_B);
    var gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gridLine.setAttribute('x1', String(PAD_L));
    gridLine.setAttribute('x2', String(W - PAD_R));
    gridLine.setAttribute('y1', String(gy));
    gridLine.setAttribute('y2', String(gy));
    gridLine.setAttribute('stroke', 'rgba(255,255,255,0.07)');
    svg.appendChild(gridLine);
    // Y-axis label
    var gridVal = maxY - g / 4 * yRange;
    var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(PAD_L - 6));
    label.setAttribute('y', String(gy + 4));
    label.setAttribute('fill', 'rgba(255,255,255,0.55)');
    label.setAttribute('font-size', '10');
    label.setAttribute('text-anchor', 'end');
    label.textContent = '$' + gridVal.toFixed(2);
    svg.appendChild(label);
  }

  // Zero reference line when the curve crosses zero
  if (minY < 0 && maxY > 0) {
    var zeroY = yFor(0);
    var zeroLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    zeroLine.setAttribute('x1', String(PAD_L));
    zeroLine.setAttribute('x2', String(W - PAD_R));
    zeroLine.setAttribute('y1', String(zeroY));
    zeroLine.setAttribute('y2', String(zeroY));
    zeroLine.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    zeroLine.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(zeroLine);
  }

  // X-axis time labels (start + end)
  var startLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  startLabel.setAttribute('x', String(PAD_L));
  startLabel.setAttribute('y', String(H - 8));
  startLabel.setAttribute('fill', 'rgba(255,255,255,0.55)');
  startLabel.setAttribute('font-size', '10');
  startLabel.textContent = new Date(minT).toLocaleDateString();
  svg.appendChild(startLabel);

  var endLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  endLabel.setAttribute('x', String(W - PAD_R));
  endLabel.setAttribute('y', String(H - 8));
  endLabel.setAttribute('fill', 'rgba(255,255,255,0.55)');
  endLabel.setAttribute('font-size', '10');
  endLabel.setAttribute('text-anchor', 'end');
  endLabel.textContent = new Date(maxT).toLocaleDateString();
  svg.appendChild(endLabel);

  // Polyline: "x,y x,y ..."
  var d = points.map(function(p) {
    return xFor(p.closed_at).toFixed(2) + ',' + yFor(Number(p.cumulative_pnl_net) || 0).toFixed(2);
  }).join(' ');
  var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', d);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', pnls[pnls.length - 1] >= 0 ? '#4caf50' : '#f44336');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);

  // Point dots
  points.forEach(function(p) {
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(xFor(p.closed_at).toFixed(2)));
    dot.setAttribute('cy', String(yFor(Number(p.cumulative_pnl_net) || 0).toFixed(2)));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', 'rgba(255,255,255,0.85)');
    svg.appendChild(dot);
  });

  card.appendChild(svg);

  var footer = document.createElement('div');
  footer.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-top:6px;';
  footer.textContent = points.length + ' verdicts - final cumulative $' + pnls[pnls.length - 1].toFixed(2);
  card.appendChild(footer);
}

async function loadStrategyAttribution(strategyId) {
  var card = document.getElementById('strategy-detail-attribution');
  if (!card) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/attribution');
    if (data === null) return;
    renderStrategyAttribution(card, data || { roles: [], verdict_count: 0 });
  } catch (e) {
    card.textContent = 'Attribution unavailable: ' + String(e);
  }
}

function renderStrategyAttribution(card, data) {
  while (card.firstChild) card.removeChild(card.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Specialist Attribution (' + (data.verdict_count || 0) + ' verdicts)';
  card.appendChild(heading);

  var roles = Array.isArray(data.roles) ? data.roles : [];
  if (roles.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No attribution data. Either no closed verdicts yet or agent_attribution_json is empty for each.';
    card.appendChild(empty);
    return;
  }

  var hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-bottom:8px;';
  hint.textContent = 'Right/wrong tallies come from the risk officer and trader; confidence_avg is computed when present.';
  card.appendChild(hint);

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Role', 'Appearances', 'Right', 'Wrong', 'Vetoes', 'Avg Confidence'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  roles.forEach(function(r) {
    var tr = document.createElement('tr');
    var extras = r.extras || {};
    var vetoes = (extras.veto_count != null) ? String(extras.veto_count) : '-';
    var avgConf = (extras.confidence_avg != null) ? Number(extras.confidence_avg).toFixed(3) : '-';
    [r.role, r.appearances, r.right_count, r.wrong_count, vetoes, avgConf].forEach(function(val) {
      var td = document.createElement('td');
      td.textContent = String(val);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  appendTraderScrollable(card, table, 320);
}

async function loadStrategyVerdicts(strategyId, reset) {
  var card = document.getElementById('strategy-detail-verdicts');
  if (!card) return;
  if (reset) {
    _strategyDetailState.verdicts = [];
    _strategyDetailState.verdictCursor = null;
  }
  var url = '/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/verdicts?limit=25';
  var c = _strategyDetailState.verdictCursor;
  if (c && c.closed_at != null && c.id != null) {
    url += '&before_closed_at=' + encodeURIComponent(String(c.closed_at));
    url += '&before_id=' + encodeURIComponent(String(c.id));
  }
  try {
    var data = await fetchFromAPI(url);
    if (data === null) return;
    var newBatch = (data && data.verdicts) || [];
    _strategyDetailState.verdicts = _strategyDetailState.verdicts.concat(newBatch);
    _strategyDetailState.verdictCursor = (data && data.nextBeforeClosedAt != null && data.nextBeforeId != null)
      ? { closed_at: data.nextBeforeClosedAt, id: data.nextBeforeId }
      : null;
    // Phase 5 Task 7a -- track the strategy status for the pause button.
    if (data && Object.prototype.hasOwnProperty.call(data, 'strategy_status')) {
      _strategyDetailState.strategyStatus = data.strategy_status;
    }
    renderStrategyVerdicts(card, strategyId);
    syncPauseButtonState();
  } catch (e) {
    card.textContent = 'Verdict history unavailable: ' + String(e);
  }
}

function renderStrategyVerdicts(card, strategyId) {
  while (card.firstChild) card.removeChild(card.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Verdict History (' + _strategyDetailState.verdicts.length + ')';
  card.appendChild(heading);

  if (_strategyDetailState.verdicts.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No closed verdicts yet for this strategy.';
    card.appendChild(empty);
    return;
  }

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['When', 'Asset', 'Side', 'Grade', 'PnL Net', 'Bench Return', 'Hold DD'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  _strategyDetailState.verdicts.forEach(function(v) {
    var tr = document.createElement('tr');
    var when = new Date(Number(v.closed_at) || Date.now()).toLocaleString();
    var pnlNet = '$' + Number(v.pnl_net).toFixed(2);
    var bench = (Number(v.bench_return) * 100).toFixed(2) + '%';
    var dd = (Number(v.hold_drawdown) * 100).toFixed(2) + '%';
    [when, v.asset || '-', v.side || '-', v.thesis_grade || '-', pnlNet, bench, dd].forEach(function(val, i) {
      var td = document.createElement('td');
      td.textContent = val;
      // Colour-code the pnl_net cell (index 4) and grade badge-ish (index 3)
      if (i === 4) {
        if (String(val).startsWith('$-')) td.style.color = 'var(--error, #f44336)';
        else if (val !== '$0.00') td.style.color = 'var(--success, #4caf50)';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  appendTraderScrollable(card, table, 320);

  // Phase 5 Task 7b -- footer row holds the "Load older" pagination
  // button and the "Download CSV" anchor side by side. Always render the
  // CSV link when at least one verdict exists (the full history is
  // downloadable even when there is nothing older to page through). The
  // CSV link uses an <a> with the attachment-Content-Disposition
  // endpoint so the browser triggers a download instead of navigating.
  var actionRow = document.createElement('div');
  actionRow.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:12px;';

  if (_strategyDetailState.verdictCursor != null) {
    var btn = document.createElement('button');
    btn.className = 'btn btn--sm btn--ghost';
    btn.textContent = 'Load older';
    btn.onclick = function() { loadStrategyVerdicts(strategyId, false); };
    actionRow.appendChild(btn);
  }

  if (_strategyDetailState.verdicts.length > 0) {
    var csvLink = document.createElement('a');
    csvLink.className = 'btn btn--sm btn--ghost';
    csvLink.textContent = 'Download CSV';
    csvLink.href = '/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/verdicts.csv';
    actionRow.appendChild(csvLink);
  }

  if (actionRow.children.length > 0) card.appendChild(actionRow);
}

async function loadStrategyDecisions(strategyId) {
  var card = document.getElementById('strategy-detail-decisions');
  if (!card) return;
  try {
    var data = await fetchFromAPI('/api/v1/trader/strategies/' + encodeURIComponent(strategyId) + '/decisions?limit=25');
    if (data === null) return;
    renderStrategyDecisions(card, (data && data.decisions) || []);
  } catch (e) {
    card.textContent = 'Decisions unavailable: ' + String(e);
  }
}

function renderStrategyDecisions(card, decisions) {
  while (card.firstChild) card.removeChild(card.firstChild);

  var heading = document.createElement('div');
  heading.style.cssText = 'font-weight:600;margin-bottom:10px;';
  heading.textContent = 'Recent Decisions (' + decisions.length + ')';
  card.appendChild(heading);

  if (decisions.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.6;font-size:0.9rem;';
    empty.textContent = 'No decisions yet for this strategy.';
    card.appendChild(empty);
    return;
  }

  var hint = document.createElement('div');
  hint.style.cssText = 'opacity:0.6;font-size:0.8rem;margin-bottom:8px;';
  hint.textContent = 'Click a row to see the committee transcript (when linked).';
  card.appendChild(hint);

  var table = document.createElement('table');
  table.className = 'trader-table';
  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['When', 'Asset', 'Action', 'Size', 'Status', 'Thesis'].forEach(function(h) {
    var th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  decisions.forEach(function(d) {
    var tr = document.createElement('tr');
    tr.className = 'trader-decision-row';
    if (!d.committee_transcript_id) {
      tr.classList.add('trader-decision-row--no-transcript');
      tr.title = 'No committee transcript linked to this decision';
    } else {
      tr.addEventListener('click', function() { openTranscriptModal(d.id); });
    }
    var when = new Date(Number(d.decided_at) || Date.now()).toLocaleString();
    var size = (d.size_usd != null) ? ('$' + Number(d.size_usd).toFixed(0)) : '-';
    var thesis = String(d.thesis || '');
    if (thesis.length > 80) thesis = thesis.slice(0, 77) + '...';
    [when, d.asset || '-', d.action || '-', size, d.status || '-', thesis].forEach(function(val) {
      var td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  appendTraderScrollable(card, table, 320);
}

async function clearCircuitBreaker(rule) {
  if (!confirm('Clear circuit breaker: ' + rule + '?')) return;
  var res = await apiFetch('/api/v1/trader/clear-breaker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule: rule }),
  });
  if (res && res.ok) {
    refreshTraderRisk();
  } else {
    alert('Clear failed: ' + (res ? res.status : 'network error'));
  }
}
