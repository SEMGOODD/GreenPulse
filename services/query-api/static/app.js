/* GreenPulse dashboard: polls the query-api and renders zones, KPIs,
   the trend chart and the alerts. Plain JavaScript, no build step.
   Every value coming from the API is inserted with textContent (never as HTML). */
"use strict";

const CONFIG = JSON.parse(document.getElementById("config").textContent);
const METRICS = CONFIG.metrics;
const METRIC_ORDER = CONFIG.metric_order; // display order (JSON objects lose it)
const REFRESH_MS = CONFIG.refresh_seconds * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  metric: load("gp-metric", "temperature", (v) => v in METRICS),
  minutes: Number(load("gp-minutes", "60", (v) => ["15", "60", "360", "1440"].includes(v))),
  alertView: "active",
  showTable: false,
  paused: false,
  hiddenSensors: new Set(),
  overview: null,
  readings: null,
  alerts: null,
  lastSuccess: null,
  failing: false,
  clockOffset: 0, // server clock - browser clock, so "x s ago" is right
  timer: null,
};

// ---------------------------------------------------------------- helpers

function load(key, fallback, isValid) {
  try {
    const value = localStorage.getItem(key);
    return value !== null && isValid(value) ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* not critical */ }
}

/** Create an element. Strings in children become text nodes (safe). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// Static icon markup (constants written here, never data from the API).
const ICONS = {
  ok: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12.5 2.7 2.7L16.5 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  offline: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M12 5v14m-6-6 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};

function icon(name) {
  const node = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  node.innerHTML = ICONS[name];
  return node;
}

const STATUS_LABELS = { ok: "Normal", alert: "Alert", offline: "Offline" };

function statusPill(stateName) {
  return el("span", { class: `status status-${stateName}` }, icon(stateName), STATUS_LABELS[stateName]);
}

/** Colors follow the sensor, never its rank: a sensor keeps its slot forever. */
const sensorSlots = new Map();
function colorOf(sensorId) {
  if (!sensorSlots.has(sensorId)) sensorSlots.set(sensorId, (sensorSlots.size % 8) + 1);
  return `var(--series-${sensorSlots.get(sensorId)})`;
}

function sensorLabel(sensorId) {
  const text = sensorId.replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatValue(metric, value) {
  return `${value.toFixed(1)} ${METRICS[metric].unit}`;
}

function alertTitle(alert) {
  const label = METRICS[alert.metric]?.label ?? alert.metric;
  return `${alert.kind === "high" ? "High" : "Low"} ${label.toLowerCase()}`;
}

const numberFormat = new Intl.NumberFormat();
const timeFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const timeFormatSeconds = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function now() {
  return Date.now() + state.clockOffset;
}

function ago(isoOrMs) {
  const seconds = Math.max(0, Math.round((now() - new Date(isoOrMs).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function duration(fromIso, toIso) {
  const minutes = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Element whose text is a relative time, refreshed every second. */
function agoNode(tag, isoOrMs, prefix = "") {
  return el(tag, { "data-ago": String(isoOrMs), "data-prefix": prefix }, prefix + ago(isoOrMs));
}

async function getJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------- data loop

async function refresh() {
  clearTimeout(state.timer);
  const chart = document.getElementById("chart");
  if (!state.readings || state.readings.metric !== state.metric || state.readings.minutes !== state.minutes) {
    chart.setAttribute("data-loading", ""); // keep the old frame, dimmed
  }
  const [overview, alerts, readings] = await Promise.allSettled([
    getJSON("/api/overview"),
    getJSON("/api/alerts?limit=50"),
    getJSON(`/api/readings?metric=${state.metric}&minutes=${state.minutes}`),
  ]);

  if (overview.status === "fulfilled") {
    state.overview = overview.value;
    state.clockOffset = new Date(overview.value.server_time).getTime() - Date.now();
    renderOverview();
  }
  if (alerts.status === "fulfilled") {
    state.alerts = alerts.value.alerts;
    renderAlerts();
  }
  if (readings.status === "fulfilled" && readings.value.metric === state.metric
      && readings.value.minutes === state.minutes) {
    state.readings = readings.value;
    chart.removeAttribute("data-loading");
    renderChart();
  }

  state.failing = [overview, alerts, readings].some((r) => r.status === "rejected");
  if (!state.failing) state.lastSuccess = Date.now();
  document.getElementById("error-banner").hidden = !state.failing;
  renderLive();
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.paused && !document.hidden) state.timer = setTimeout(refresh, REFRESH_MS);
}

function renderLive() {
  const live = document.getElementById("live-status");
  const text = document.getElementById("live-text");
  if (state.paused) {
    live.dataset.state = "paused";
    text.textContent = "Paused";
  } else if (state.failing) {
    live.dataset.state = "error";
    text.textContent = state.lastSuccess ? `Offline · last update ${ago(state.lastSuccess + state.clockOffset)}` : "Can't connect";
  } else {
    live.dataset.state = "live";
    text.textContent = "Live";
  }
}

// ---------------------------------------------------------------- KPIs & zones

function renderOverview() {
  const { kpis, sensors } = state.overview;
  for (const sensor of sensors) colorOf(sensor.sensor_id); // fix the color slots in configured order

  const online = document.getElementById("kpi-online");
  online.replaceChildren(String(kpis.sensors_online), el("small", {}, `/ ${kpis.sensors_total}`));
  const offline = kpis.sensors_total - kpis.sensors_online;
  document.getElementById("kpi-online-note").replaceChildren(
    offline === 0 ? "All zones reporting" : `${offline} zone${offline > 1 ? "s" : ""} not reporting`);

  document.getElementById("kpi-alerts").textContent = String(kpis.active_alerts);
  document.getElementById("kpi-alerts-note").replaceChildren(
    kpis.active_alerts === 0
      ? el("span", { class: "status status-ok" }, icon("ok"), "All within range")
      : el("span", { class: "status status-alert" }, icon("alert"), "Needs attention"));

  const temp = document.getElementById("kpi-temp");
  temp.replaceChildren(kpis.avg_temperature === null ? "—" : kpis.avg_temperature.toFixed(1),
    kpis.avg_temperature === null ? "" : el("small", {}, METRICS.temperature.unit));

  document.getElementById("kpi-readings").textContent = numberFormat.format(kpis.readings_last_hour);
  document.getElementById("kpi-readings-note").textContent =
    `≈ ${numberFormat.format(Math.round(kpis.readings_last_hour / 60))} per minute`;

  document.title = kpis.active_alerts > 0 ? `(${kpis.active_alerts}) GreenPulse` : "GreenPulse";
  document.getElementById("hero-sub").textContent = kpis.active_alerts > 0
    ? `${kpis.active_alerts} alert${kpis.active_alerts > 1 ? "s need" : " needs"} your attention.`
    : sensors.length === 0
      ? "Waiting for the first readings from your sensors…"
      : "Everything is within range. Here is how your greenhouses are doing right now.";

  const zones = document.getElementById("zones");
  zones.removeAttribute("aria-busy");
  if (sensors.length === 0) {
    zones.replaceChildren(el("p", { class: "card alerts-empty" }, "No sensor has reported yet. Readings will appear here within a few seconds of the simulator starting."));
    return;
  }
  zones.replaceChildren(...sensors.map(renderZone));
}

function renderZone(sensor) {
  const breaches = new Map(sensor.alerts.map((a) => [a.metric, a]));
  const metrics = METRIC_ORDER.map((key) => {
    const meta = METRICS[key];
    const breach = breaches.get(key);
    const value = sensor.values ? sensor.values[key] : null;
    return el("div", { class: "metric", "data-breach": breach ? "" : null },
      el("div", { class: "metric-label", title: meta.label }, meta.short),
      el("div", { class: "metric-value" }, value === null ? "—" : value.toFixed(1), el("small", {}, meta.unit)),
      breach && el("div", { class: "metric-flag" }, icon(breach.kind === "high" ? "up" : "down"),
        `${breach.kind === "high" ? "Above" : "Below"} ${breach.threshold} ${meta.unit}`));
  });

  let foot;
  if (!sensor.recorded_at) foot = el("p", { class: "zone-foot" }, "No data in the last 24 h");
  else if (sensor.state === "offline") foot = agoNode("p", sensor.recorded_at, "No data since ");
  else foot = agoNode("p", sensor.recorded_at, "Updated ");
  foot.className = "zone-foot";

  return el("article", { class: "zone", "data-state": sensor.state, "aria-label": sensorLabel(sensor.sensor_id) },
    el("header", { class: "zone-head" },
      el("h3", { class: "zone-name" },
        el("i", { class: "swatch", style: `background:${colorOf(sensor.sensor_id)}`, "aria-hidden": "true" }),
        el("span", {}, sensorLabel(sensor.sensor_id))),
      statusPill(sensor.state)),
    el("div", { class: "zone-metrics" }, metrics),
    foot);
}

// ---------------------------------------------------------------- alerts

function renderAlerts() {
  const list = document.getElementById("alerts");
  const active = state.alerts.filter((a) => !a.resolved_at);
  const history = state.alerts.filter((a) => a.resolved_at);

  const count = document.getElementById("count-active");
  count.textContent = String(active.length);
  count.toggleAttribute("data-hot", active.length > 0);

  const items = state.alertView === "active" ? active : history;
  if (items.length === 0) {
    list.replaceChildren(el("li", { class: "alerts-empty" },
      icon("ok"),
      state.alertView === "active"
        ? "All clear: every zone is within its normal range."
        : "No resolved alerts yet."));
    return;
  }
  list.replaceChildren(...items.map(renderAlert));
}

function renderAlert(alert) {
  const meta = METRICS[alert.metric] ?? { unit: "", label: alert.metric };
  const fmt = (v) => `${v.toFixed(1)} ${meta.unit}`;
  const resolved = Boolean(alert.resolved_at);
  const detail = resolved
    ? `Peak ${fmt(alert.worst_value)} · limit ${fmt(alert.threshold)}`
    : `Now ${fmt(alert.last_value)} · peak ${fmt(alert.worst_value)} · limit ${fmt(alert.threshold)}`;
  const when = resolved
    ? el("div", { class: "alert-when" }, el("strong", {}, `Lasted ${duration(alert.started_at, alert.resolved_at)}`),
        agoNode("span", alert.resolved_at, "ended "))
    : el("div", { class: "alert-when" }, el("strong", {}, "Ongoing"), agoNode("span", alert.started_at, "started "));

  return el("li", { class: "alert-item", "data-resolved": resolved ? "" : null },
    el("span", { class: "alert-icon" }, icon(resolved ? "ok" : "alert")),
    el("div", {},
      el("div", { class: "alert-title" },
        alertTitle(alert),
        el("span", { class: "alert-zone" },
          el("i", { class: "swatch", style: `background:${colorOf(alert.sensor_id)}`, "aria-hidden": "true" }),
          sensorLabel(alert.sensor_id)),
        resolved && el("span", { class: "status status-ok" }, icon("ok"), "Resolved")),
      el("div", { class: "alert-detail" }, detail)),
    when);
}

// ---------------------------------------------------------------- chart

const chartState = { geometry: null, focusIndex: null };

/** Round tick values: 0, 5, 10... or 0, 2, 4... depending on the range. */
function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1e6; v += step) ticks.push(Number(v.toFixed(6)));
  return { ticks, step };
}

function timeTicks(from, to, width) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * 60000);
  const wanted = Math.max(2, Math.floor(width / 90));
  const step = steps.find((s) => (to - from) / s <= wanted) ?? steps.at(-1);
  // Align on the local clock (14:00, 14:15...), not on UTC.
  const offset = new Date(from).getTimezoneOffset() * 60000;
  const ticks = [];
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) ticks.push(t);
  return ticks;
}

function renderChart() {
  const data = state.readings;
  if (!data) return;
  const container = document.getElementById("chart");
  const meta = METRICS[data.metric];
  const rangeLabel = { 15: "last 15 minutes", 60: "last hour", 360: "last 6 hours", 1440: "last 24 hours" }[data.minutes];

  document.getElementById("chart-title").textContent = `${meta.label} (${meta.unit})`;
  const bucket = data.bucket_seconds >= 60 ? `${data.bucket_seconds / 60} min` : `${data.bucket_seconds} s`;
  document.getElementById("chart-sub").textContent = `${rangeLabel} · averaged per ${bucket}`;

  renderLegend(data.series);

  const width = container.clientWidth;
  const height = container.clientHeight;
  const margin = { top: 14, right: 12, bottom: 26, left: 40 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);

  const from = data.to - data.minutes * 60000;
  const series = data.series.filter((s) => !state.hiddenSensors.has(s.sensor_id) && s.points.length);

  container.querySelector("svg")?.remove();
  container.querySelector(".chart-empty")?.remove();
  hideTooltip();

  if (series.length === 0) {
    const message = data.series.some((s) => s.points.length)
      ? "All zones are hidden. Select one in the legend."
      : `No readings in the ${rangeLabel} yet.`;
    container.append(el("div", { class: "chart-empty" }, message));
    chartState.geometry = null;
    renderTable(data);
    return;
  }

  // Y range covers the data AND the thresholds: you see how close each zone is to its limit.
  const values = series.flatMap((s) => s.points.map((p) => p[1]));
  for (const limit of [meta.low, meta.high]) if (limit !== null) values.push(limit);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = (max - min) * 0.08 || 1;
  min -= pad;
  max += pad;
  if (data.metric !== "temperature") { min = Math.max(0, min); max = Math.min(100, max); }
  const { ticks } = niceTicks(min, max);
  min = Math.min(min, ticks[0]);
  max = Math.max(max, ticks.at(-1));

  const x = (t) => margin.left + ((t - from) / (data.to - from)) * innerW;
  const y = (v) => margin.top + (1 - (v - min) / (max - min)) * innerH;

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": `${meta.label} chart, ${rangeLabel}. Use the Table button for the values.` });

  // Out-of-range zones, washed in the critical color, behind everything else.
  if (meta.high !== null && meta.high < max) {
    root.append(svg("rect", { class: "danger-zone", x: margin.left, y: margin.top, width: innerW, height: Math.max(0, y(meta.high) - margin.top) }));
  }
  if (meta.low !== null && meta.low > min) {
    root.append(svg("rect", { class: "danger-zone", x: margin.left, y: y(meta.low), width: innerW, height: Math.max(0, margin.top + innerH - y(meta.low)) }));
  }

  const grid = svg("g", { class: "grid" });
  for (const tick of ticks) {
    grid.append(svg("line", { x1: margin.left, x2: margin.left + innerW, y1: y(tick), y2: y(tick) }));
    const label = svg("text", { class: "tick", x: margin.left - 8, y: y(tick) + 4, "text-anchor": "end" });
    label.textContent = numberFormat.format(tick);
    root.append(label);
  }
  root.prepend(grid);
  root.append(svg("line", { class: "baseline", x1: margin.left, x2: margin.left + innerW, y1: margin.top + innerH, y2: margin.top + innerH }));

  for (const tick of timeTicks(from, data.to, innerW)) {
    const label = svg("text", { class: "tick", x: x(tick), y: height - 6, "text-anchor": "middle" });
    label.textContent = timeFormat.format(tick);
    root.append(label);
  }

  for (const [limit, word] of [[meta.high, "max"], [meta.low, "min"]]) {
    if (limit === null || limit < min || limit > max) continue;
    root.append(svg("line", { class: "threshold", x1: margin.left, x2: margin.left + innerW, y1: y(limit), y2: y(limit) }));
    const label = svg("text", { class: "threshold-label", x: margin.left + innerW - 4,
      y: word === "max" ? y(limit) - 6 : y(limit) + 14, "text-anchor": "end" });
    label.textContent = `${word} ${limit} ${meta.unit}`;
    root.append(label);
  }

  // Lines: a gap in the data (sensor offline) breaks the line instead of bridging it.
  const gap = data.bucket_seconds * 1000 * 2.5;
  for (const s of series) {
    let d = "";
    let previous = null;
    for (const [t, v] of s.points) {
      d += `${previous !== null && t - previous <= gap ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      previous = t;
    }
    root.append(svg("path", { class: "series", d, style: `stroke:${colorOf(s.sensor_id)}` }));
    const [lastT, lastV] = s.points.at(-1);
    root.append(svg("circle", { class: "end-dot", cx: x(lastT), cy: y(lastV), r: 4, style: `fill:${colorOf(s.sensor_id)}` }));
  }

  // Hover layer: crosshair + one dot per zone, driven by an invisible overlay.
  const crosshair = svg("line", { class: "crosshair", y1: margin.top, y2: margin.top + innerH, visibility: "hidden" });
  const hoverDots = series.map((s) => svg("circle", { class: "hover-dot", r: 5, visibility: "hidden", style: `fill:${colorOf(s.sensor_id)}` }));
  const overlay = svg("rect", { class: "overlay", x: margin.left, y: margin.top, width: innerW, height: innerH, tabindex: 0,
    "aria-label": "Chart values: use the left and right arrow keys to move through time" });
  root.append(crosshair, ...hoverDots, overlay);
  container.prepend(root);

  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const lookup = series.map((s) => new Map(s.points));
  chartState.geometry = { x, y, times, series, lookup, crosshair, hoverDots, from, margin, innerW, meta, metric: data.metric };

  overlay.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const t = from + ((event.clientX - box.left - margin.left) / innerW) * (data.to - from);
    showAt(nearestIndex(times, t));
  });
  overlay.addEventListener("pointerleave", hideTooltip);
  overlay.addEventListener("focus", () => showAt(chartState.focusIndex ?? times.length - 1));
  overlay.addEventListener("blur", hideTooltip);
  overlay.addEventListener("keydown", (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (event.key === "Escape") { hideTooltip(); return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    const current = chartState.focusIndex ?? times.length - 1;
    showAt(Math.min(times.length - 1, Math.max(0, current + moves[event.key])));
  });

  renderTable(data);
}

function nearestIndex(sorted, target) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid; else hi = mid;
  }
  return Math.abs(sorted[lo] - target) <= Math.abs(sorted[hi] - target) ? lo : hi;
}

function showAt(index) {
  const g = chartState.geometry;
  if (!g || index === null || index < 0) return;
  chartState.focusIndex = index;
  const t = g.times[index];
  const cx = g.x(t);
  g.crosshair.setAttribute("x1", cx);
  g.crosshair.setAttribute("x2", cx);
  g.crosshair.setAttribute("visibility", "visible");

  const rows = [];
  g.series.forEach((s, i) => {
    const value = g.lookup[i].get(t);
    const dot = g.hoverDots[i];
    if (value === undefined) { dot.setAttribute("visibility", "hidden"); return; }
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", g.y(value));
    dot.setAttribute("visibility", "visible");
    rows.push({ sensorId: s.sensor_id, value });
  });
  rows.sort((a, b) => b.value - a.value); // same order as the lines, top to bottom

  const tooltip = document.getElementById("tooltip");
  tooltip.replaceChildren(
    el("div", { class: "tooltip-time" }, timeFormatSeconds.format(t)),
    ...rows.map((r) => el("div", { class: "tooltip-row" },
      el("i", { class: "key", style: `background:${colorOf(r.sensorId)}`, "aria-hidden": "true" }),
      el("strong", {}, formatValue(g.metric, r.value)),
      el("span", {}, sensorLabel(r.sensorId)))));
  tooltip.hidden = false;
  // Keep the tooltip beside the crosshair, on the side with more room.
  const chartWidth = document.getElementById("chart").clientWidth;
  const left = cx + 14 + tooltip.offsetWidth > chartWidth ? cx - 14 - tooltip.offsetWidth : cx + 14;
  tooltip.style.left = `${Math.max(0, left)}px`;
}

function hideTooltip() {
  const g = chartState.geometry;
  document.getElementById("tooltip").hidden = true;
  if (!g) return;
  g.crosshair.setAttribute("visibility", "hidden");
  g.hoverDots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
}

function renderLegend(series) {
  const legend = document.getElementById("legend");
  legend.replaceChildren(...series.map((s) => {
    const shown = !state.hiddenSensors.has(s.sensor_id);
    const button = el("button", { type: "button", "aria-pressed": String(shown),
      title: shown ? "Hide this zone" : "Show this zone" },
      el("i", { class: "key", style: `background:${colorOf(s.sensor_id)}`, "aria-hidden": "true" }),
      sensorLabel(s.sensor_id));
    button.addEventListener("click", () => {
      if (shown) state.hiddenSensors.add(s.sensor_id); else state.hiddenSensors.delete(s.sensor_id);
      renderChart();
      legend.querySelectorAll("button")[series.indexOf(s)]?.focus();
    });
    return button;
  }));
}

/** Accessible alternative to the chart: the same data as a table, newest first. */
function renderTable(data) {
  const wrap = document.getElementById("table-wrap");
  if (!state.showTable) { wrap.hidden = true; return; }
  const meta = METRICS[data.metric];
  const series = data.series.filter((s) => s.points.length);
  const lookup = series.map((s) => new Map(s.points));
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a);
  const table = el("table", { class: "data-table" },
    el("caption", { class: "chart-sub", style: "text-align:left;padding:4px 10px" }, `${meta.label} (${meta.unit}), newest first`),
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Time"),
      ...series.map((s) => el("th", { scope: "col" }, sensorLabel(s.sensor_id))))),
    el("tbody", {}, ...times.map((t) => el("tr", {},
      el("th", { scope: "row" }, timeFormatSeconds.format(t)),
      ...lookup.map((m) => el("td", {}, m.has(t) ? m.get(t).toFixed(1) : "—"))))));
  wrap.replaceChildren(table);
  wrap.hidden = false;
}

// ---------------------------------------------------------------- controls

function setPressed(group, attribute, value) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === String(value)));
  }
}

function setupControls() {
  document.getElementById("refresh-every").textContent = String(CONFIG.refresh_seconds);

  const metricFilter = document.getElementById("metric-filter");
  for (const key of METRIC_ORDER) {
    metricFilter.append(el("button", { type: "button", "data-metric": key }, METRICS[key].label));
  }
  setPressed(metricFilter, "metric", state.metric);
  metricFilter.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.metric === state.metric) return;
    state.metric = button.dataset.metric;
    save("gp-metric", state.metric);
    setPressed(metricFilter, "metric", state.metric);
    refresh();
  });

  const rangeFilter = document.getElementById("range-filter");
  setPressed(rangeFilter, "minutes", state.minutes);
  rangeFilter.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || Number(button.dataset.minutes) === state.minutes) return;
    state.minutes = Number(button.dataset.minutes);
    save("gp-minutes", String(state.minutes));
    setPressed(rangeFilter, "minutes", state.minutes);
    refresh();
  });

  const alertFilter = document.getElementById("alert-filter");
  alertFilter.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.alertView = button.dataset.view;
    setPressed(alertFilter, "view", state.alertView);
    if (state.alerts) renderAlerts();
  });

  const tableButton = document.getElementById("table-btn");
  tableButton.addEventListener("click", () => {
    state.showTable = !state.showTable;
    tableButton.setAttribute("aria-pressed", String(state.showTable));
    if (state.readings) renderTable(state.readings);
  });

  const pauseButton = document.getElementById("pause-btn");
  pauseButton.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseButton.setAttribute("aria-pressed", String(state.paused));
    pauseButton.textContent = state.paused ? "Resume" : "Pause";
    if (state.paused) { clearTimeout(state.timer); renderLive(); } else refresh();
  });

  // Theme: system -> light -> dark -> system.
  const themeButton = document.getElementById("theme-btn");
  const applyThemeLabel = () => themeButton.setAttribute("aria-label",
    `Theme: ${document.documentElement.dataset.theme ?? "system"} (click to change)`);
  applyThemeLabel();
  themeButton.addEventListener("click", () => {
    const order = [undefined, "light", "dark"];
    const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length];
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    save("gp-theme", next ?? "system");
    applyThemeLabel();
  });

  // No polling while the tab is in the background; catch up as soon as it is back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.timer);
    else if (!state.paused) refresh();
  });

  // Redraw the chart when its width changes (window resize, rotation).
  let frame = null;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => state.readings && renderChart());
  }).observe(document.getElementById("chart"));

  // Relative times ("12 s ago") tick every second without refetching.
  setInterval(() => {
    for (const node of document.querySelectorAll("[data-ago]")) {
      node.textContent = node.dataset.prefix + ago(node.dataset.ago);
    }
    if (state.failing) renderLive();
  }, 1000);
}

setupControls();
refresh();
