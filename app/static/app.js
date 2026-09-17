const REFRESH_MS = 2000;
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4",
                      "--series-5", "--series-6", "--series-7", "--series-8"];
const NET_COLORS = { sent: "var(--series-1)", received: "var(--series-2)" };

const RANGES = ["1h", "24h", "7d", "30d", "1y"];
const RANGE_STORAGE_KEY = "claude-usage-ranges";

let modelColor = new Map();      // model name -> css var()
let tokenRange = "24h";
let netRange = "24h";
let lastTokenSeries = [];
let lastNetSeries = [];
let showTokenTable = false;
let showNetTable = false;
let showModelTable = false;
let showProjectTable = false;
let lastByModel = [];
let lastByProject = [];

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function formatCost(n) {
  return "$" + n.toFixed(2);
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

// point.bucket is "YYYY-MM-DDTHH:MM" (UTC, floored to the range's bucket
// width). Short ranges only need the clock; longer ones need the date.
function bucketLabel(point, range) {
  const b = point.bucket;
  if (range === "1h" || range === "24h") return b.slice(11, 16);
  if (range === "7d") return b.slice(5, 10) + " " + b.slice(11, 16);
  return b.slice(0, 10);
}

function emptyRangeText(range) {
  return `No activity in the last ${range}`;
}

function loadRanges() {
  try {
    const saved = JSON.parse(localStorage.getItem(RANGE_STORAGE_KEY) || "{}");
    if (RANGES.includes(saved.token)) tokenRange = saved.token;
    if (RANGES.includes(saved.net)) netRange = saved.net;
  } catch (_) { /* storage unavailable — keep defaults */ }
}

function saveRanges() {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify({ token: tokenRange, net: netRange }));
  } catch (_) { /* storage unavailable — selection just won't persist */ }
}

function renderRangeToggle(containerId, current, onSelect) {
  const container = document.getElementById(containerId);
  container.replaceChildren(...RANGES.map(range => {
    const button = el("button", { type: "button", "aria-pressed": String(range === current) }, [range]);
    button.addEventListener("click", () => onSelect(range));
    return button;
  }));
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "-";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return totalSeconds + "s";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Fixed categorical order, assigned once per known model set so colors stay
// stable across refreshes rather than being re-cycled when the mix changes.
function assignModelColors(modelOrder) {
  modelColor = new Map();
  modelOrder.forEach((model, i) => {
    modelColor.set(model, `var(${SERIES_VARS[i % SERIES_VARS.length]})`);
  });
}

function colorFor(model) {
  return modelColor.get(model) || "var(--text-muted)";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderStatGrid(data) {
  const t = data.global_totals;
  const totalTokens = t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
  const cards = [
    { label: "Total tokens", value: formatTokens(totalTokens) },
    { label: "Estimated cost", value: formatCost(t.cost_usd), accent: true },
    { label: "Saved by caching", value: formatCost(t.cache_savings_usd), accent: true },
    { label: "Messages", value: t.message_count.toLocaleString() },
    { label: "Active sessions (5m)", value: String(data.active_sessions_5min) },
    { label: "Sessions tracked", value: String(data.sessions.length) },
    { label: "Projects tracked", value: String(data.by_project.length) },
    { label: "Avg response time", value: formatDuration(data.avg_turn_duration_ms) },
  ];
  const grid = document.getElementById("stat-grid");
  grid.replaceChildren(...cards.map(c => el("div", { class: "stat-card" }, [
    el("div", { class: "label" }, [c.label]),
    el("div", { class: "value" + (c.accent ? " accent" : "") }, [c.value]),
  ])));
}

function renderPeriodStats(containerId, totals, rateLimitHits) {
  const total = totals.input_tokens + totals.output_tokens
    + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
  const container = document.getElementById(containerId);
  container.replaceChildren(
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Tokens"]),
      el("div", { class: "value" }, [formatTokens(total)]),
    ]),
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Cost"]),
      el("div", { class: "value" }, [formatCost(totals.cost_usd)]),
    ]),
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Thinking tokens"]),
      el("div", { class: "value" }, [formatTokens(totals.thinking_tokens)]),
    ]),
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Rate-limit hits"]),
      el("div", { class: "value" + (rateLimitHits > 0 ? " warn" : "") }, [String(rateLimitHits)]),
    ]),
  );
}

// Horizontal bars, direct-labeled so no legend is needed.
// rows: [{ name, value, label, color }], bars sized relative to the max value.
function renderHorizontalBars(containerId, rows, emptyText) {
  const container = document.getElementById(containerId);
  if (!rows.length) {
    container.replaceChildren(el("div", { class: "empty" }, [emptyText]));
    return;
  }
  const max = Math.max(...rows.map(r => r.value), Number.EPSILON);
  container.replaceChildren(...rows.map(r => {
    const pct = Math.max((r.value / max) * 100, 2);
    return el("div", { class: "tool-bar-row" }, [
      el("div", { class: "tool-bar-name", title: r.name }, [r.name]),
      el("div", { class: "tool-bar-track" }, [
        el("div", { class: "tool-bar-fill", style: `width:${pct}%;background:${r.color}` }),
      ]),
      el("div", { class: "tool-bar-count" }, [r.label]),
    ]);
  }));
}

function renderToolUsage(toolUsage) {
  renderHorizontalBars("tool-usage-bars", toolUsage.map((t, i) => ({
    name: t.tool,
    value: t.count,
    label: String(t.count),
    color: t.tool === "Other" ? "var(--text-muted)" : `var(${SERIES_VARS[i % SERIES_VARS.length]})`,
  })), "No tool calls recorded yet");
}

function totalTokens(totals) {
  return totals.input_tokens + totals.output_tokens
    + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
}

function renderModelBars(byModel) {
  renderHorizontalBars("model-bars", byModel.map(m => ({
    name: m.model,
    value: m.totals.cost_usd,
    label: `${formatCost(m.totals.cost_usd)} \u00b7 ${formatTokens(totalTokens(m.totals))}`,
    color: colorFor(m.model),
  })), "No usage yet");
}

function renderProjectBars(byProject) {
  renderHorizontalBars("project-bars", byProject.map((p, i) => ({
    name: p.project,
    value: p.totals.cost_usd,
    label: `${formatCost(p.totals.cost_usd)} \u00b7 ${formatTokens(totalTokens(p.totals))}`,
    color: `var(${SERIES_VARS[i % SERIES_VARS.length]})`,
  })), "No usage yet");
}

function renderLegend(containerId, entries) {
  const legend = document.getElementById(containerId);
  if (entries.length <= 1) {
    legend.replaceChildren();
    return;
  }
  legend.replaceChildren(...entries.map(({ label, color }) => el("span", { class: "legend-item" }, [
    el("span", { class: "swatch", style: `background:${color}` }),
    el("span", {}, [label]),
  ])));
}

// --- Generic stacked bar chart with hover tooltip -------------------------
// `seriesOf(point)` returns [[label, value, color], ...] for that hour.
// `wrapEl`/`chartEl`/`axisEl` are this chart's own DOM nodes (each chart
// gets its own tooltip element, scoped to its own wrapper).

function hideTooltip(wrapEl) {
  const existing = wrapEl.querySelector(".tooltip");
  if (existing) existing.remove();
}

function showTooltip(wrapEl, anchorEl, hourLabel, rows, formatValue) {
  hideTooltip(wrapEl);
  const tooltip = el("div", { class: "tooltip" }, [
    el("div", { class: "t-title" }, [hourLabel]),
    ...rows.map(([label, value, color]) => el("div", { class: "t-row" }, [
      el("span", { class: "swatch", style: `background:${color};width:10px;height:3px;border-radius:2px;` }),
      el("span", {}, [label]),
      el("span", { class: "t-value" }, [formatValue(value)]),
    ])),
  ]);
  wrapEl.appendChild(tooltip);

  const barRect = anchorEl.getBoundingClientRect();
  const wrapRect = wrapEl.getBoundingClientRect();
  tooltip.style.left = (barRect.left - wrapRect.left + barRect.width / 2) + "px";
  tooltip.style.top = (barRect.top - wrapRect.top - 6) + "px";
}

function renderStackedChart({ wrapEl, chartEl, axisEl, timeseries, range, seriesOf, formatValue }) {
  if (!timeseries.some(p => p.total > 0)) {
    chartEl.replaceChildren(el("div", { class: "empty" }, [emptyRangeText(range)]));
    axisEl.replaceChildren();
    return;
  }

  const max = Math.max(...timeseries.map(p => p.total), 1);
  const gridlines = el("div", { class: "gridlines" }, [0, 1, 2, 3].map(() => el("div")));

  const bars = timeseries.map(point => {
    const series = seriesOf(point).filter(([, value]) => value > 0);
    const segs = series.map(([, value, color]) => {
      const pct = Math.max((value / max) * 100, 1.5);
      return el("div", { class: "seg", style: `height:${pct}%;background:${color}` });
    });
    const col = el("div", { class: "bar-col" }, segs);
    const label = bucketLabel(point, range);
    const open = () => showTooltip(wrapEl, col, label, series, formatValue);
    const close = () => hideTooltip(wrapEl);
    col.addEventListener("pointerenter", open);
    col.addEventListener("pointerleave", close);
    col.addEventListener("focus", open);
    col.addEventListener("blur", close);
    col.tabIndex = 0;
    return col;
  });

  chartEl.style.setProperty("--bars", String(timeseries.length));
  axisEl.style.setProperty("--bars", String(timeseries.length));
  chartEl.replaceChildren(gridlines, ...bars);

  // Aim for roughly a dozen axis labels regardless of how fine the buckets
  // are (5-minute buckets over 24h means ~288 bars — too many to label each).
  const labelEvery = Math.max(1, Math.ceil(timeseries.length / 12));
  const lastLabelIndex = Math.floor((timeseries.length - 1) / labelEvery) * labelEvery;
  axisEl.replaceChildren(...timeseries.map((point, i) => {
    if (i % labelEvery !== 0) return el("span");
    const edge = i === 0 ? " axis-label-start" : i === lastLabelIndex ? " axis-label-end" : "";
    return el("span", {}, [el("span", { class: "axis-label" + edge }, [bucketLabel(point, range)])]);
  }));
}

function renderChartTable(containerId, timeseries, range, columns, formatValue) {
  const container = document.getElementById(containerId);
  const active = timeseries.filter(p => p.total > 0);
  if (!active.length) {
    container.replaceChildren(el("div", { class: "empty" }, [emptyRangeText(range)]));
    return;
  }
  const thead = el("tr", {}, [
    el("th", {}, ["Time"]),
    ...columns.map(c => el("th", { class: "num" }, [c.label])),
    el("th", { class: "num" }, ["Total"]),
  ]);
  const rows = active.map(point => el("tr", {}, [
    el("td", {}, [bucketLabel(point, range)]),
    ...columns.map(c => el("td", { class: "num" }, [formatValue(c.get(point) || 0)])),
    el("td", { class: "num" }, [formatValue(point.total)]),
  ]));
  const table = el("table", {}, [el("thead", {}, [thead]), el("tbody", {}, rows)]);
  container.replaceChildren(table);
}

// --- Token chart -----------------------------------------------------------

function renderTokenChart(timeseries, modelOrder) {
  lastTokenSeries = timeseries;
  renderStackedChart({
    wrapEl: document.getElementById("chart-wrap"),
    chartEl: document.getElementById("chart"),
    axisEl: document.getElementById("chart-axis"),
    timeseries,
    range: tokenRange,
    seriesOf: point => modelOrder.map(model => [model, point.by_model[model] || 0, colorFor(model)]),
    formatValue: formatTokens,
  });
}

// --- Network chart -----------------------------------------------------------

function renderNetworkChart(timeseries) {
  lastNetSeries = timeseries;
  renderStackedChart({
    wrapEl: document.getElementById("net-chart-wrap"),
    chartEl: document.getElementById("net-chart"),
    axisEl: document.getElementById("net-chart-axis"),
    timeseries,
    range: netRange,
    seriesOf: point => [
      ["Sent", point.sent, NET_COLORS.sent],
      ["Received", point.received, NET_COLORS.received],
    ],
    formatValue: formatBytes,
  });
}

function renderNetworkPanel(network) {
  const unavailableEl = document.getElementById("network-unavailable");
  const bodyEl = document.getElementById("network-body");

  if (!network || !network.available) {
    unavailableEl.hidden = false;
    bodyEl.hidden = true;
    return;
  }
  unavailableEl.hidden = true;
  bodyEl.hidden = false;

  const stats = document.getElementById("net-stats");
  stats.replaceChildren(
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Sent to Anthropic"]),
      el("div", { class: "value" }, [formatBytes(network.bytes_sent_total)]),
    ]),
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Received from Anthropic"]),
      el("div", { class: "value" }, [formatBytes(network.bytes_received_total)]),
    ]),
    el("div", { class: "stat-card" }, [
      el("div", { class: "label" }, ["Last sample"]),
      el("div", { class: "value" }, [formatTime(network.last_sample_at)]),
    ]),
  );

  renderLegend("net-legend", [
    { label: "Sent", color: NET_COLORS.sent },
    { label: "Received", color: NET_COLORS.received },
  ]);
  renderNetworkChart(network.timeseries);
  if (showNetTable) renderNetTable();
}

function renderNetTable() {
  renderChartTable("net-chart-table", lastNetSeries, netRange, [
    { label: "Sent", get: p => p.sent },
    { label: "Received", get: p => p.received },
  ], formatBytes);
}

function renderTokenTable(modelOrder) {
  renderChartTable("chart-table", lastTokenSeries, tokenRange,
    modelOrder.map(m => ({ label: m, get: p => p.by_model[m] })),
    formatTokens);
}

function renderModelTable(byModel) {
  const tbody = document.querySelector("#model-table tbody");
  if (!byModel.length) {
    tbody.replaceChildren(el("tr", {}, [el("td", { colspan: "7", class: "empty" }, ["No usage yet"])]));
    return;
  }
  tbody.replaceChildren(...byModel.map(m => el("tr", {}, [
    el("td", {}, [el("span", { class: "swatch", style: `background:${colorFor(m.model)}` }), el("span", {}, [m.model])]),
    el("td", { class: "num" }, [formatTokens(m.totals.input_tokens)]),
    el("td", { class: "num" }, [formatTokens(m.totals.output_tokens)]),
    el("td", { class: "num" }, [formatTokens(m.totals.thinking_tokens)]),
    el("td", { class: "num" }, [formatTokens(m.totals.cache_creation_input_tokens)]),
    el("td", { class: "num" }, [formatTokens(m.totals.cache_read_input_tokens)]),
    el("td", { class: "num" }, [formatCost(m.totals.cost_usd)]),
  ])));
}

function renderProjectTable(byProject) {
  const tbody = document.querySelector("#project-table tbody");
  if (!byProject.length) {
    tbody.replaceChildren(el("tr", {}, [el("td", { colspan: "3", class: "empty" }, ["No usage yet"])]));
    return;
  }
  tbody.replaceChildren(...byProject.map(p => {
    const total = p.totals.input_tokens + p.totals.output_tokens
      + p.totals.cache_creation_input_tokens + p.totals.cache_read_input_tokens;
    return el("tr", {}, [
      el("td", {}, [p.project]),
      el("td", { class: "num" }, [formatTokens(total)]),
      el("td", { class: "num" }, [formatCost(p.totals.cost_usd)]),
    ]);
  }));
}

function renderSessionTable(sessions) {
  const tbody = document.querySelector("#session-table tbody");
  if (!sessions.length) {
    tbody.replaceChildren(el("tr", {}, [el("td", { colspan: "8", class: "empty" }, ["No sessions yet"])]));
    return;
  }
  tbody.replaceChildren(...sessions.map(s => {
    const total = s.totals.input_tokens + s.totals.output_tokens
      + s.totals.cache_creation_input_tokens + s.totals.cache_read_input_tokens;
    return el("tr", {}, [
      el("td", {}, [formatTime(s.last_activity)]),
      el("td", {}, [s.project]),
      el("td", {}, s.models.flatMap(m => [
        el("span", { class: "swatch", style: `background:${colorFor(m)}` }),
        el("span", { style: "margin-right:10px" }, [m]),
      ])),
      el("td", { class: "num" }, [String(s.totals.message_count)]),
      el("td", { class: "num" }, [formatTokens(total)]),
      el("td", { class: "num" }, [formatCost(s.totals.cost_usd)]),
      el("td", { class: "num" }, [formatDuration(s.duration_ms)]),
      el("td", { class: "num" }, [formatDuration(s.avg_turn_ms)]),
    ]);
  }));
}

// --- Quota (rate_limits from the statusline hook) --------------------------

function formatCountdown(resetsAtEpoch) {
  if (!resetsAtEpoch) return "";
  const seconds = resetsAtEpoch - Date.now() / 1000;
  if (seconds <= 0) return "resets now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function quotaFillClass(pct) {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "";
}

function renderQuotaRow(name, window) {
  if (!window || typeof window.used_percentage !== "number") return null;
  const pct = Math.max(0, Math.min(100, window.used_percentage));
  return el("div", {}, [
    el("div", { class: "quota-row-head" }, [
      el("span", { class: "name" }, [name]),
      el("span", { class: "detail" }, [`${pct.toFixed(0)}% \u00b7 ${formatCountdown(window.resets_at)}`]),
    ]),
    el("div", { class: "quota-track" }, [
      el("div", { class: `quota-fill ${quotaFillClass(pct)}`, style: `width:${pct}%` }),
    ]),
  ]);
}

let lastQuota = null;

function renderQuotaPanel(quota) {
  const unavailableEl = document.getElementById("quota-unavailable");
  const bodyEl = document.getElementById("quota-body");
  lastQuota = quota;

  if (!quota || !quota.available) {
    unavailableEl.hidden = false;
    bodyEl.hidden = true;
    return;
  }
  unavailableEl.hidden = true;
  bodyEl.hidden = false;

  const rows = [
    renderQuotaRow("5-hour window", quota.rate_limits.five_hour),
    renderQuotaRow("7-day window", quota.rate_limits.seven_day),
    renderQuotaRow("Spend limit", quota.rate_limits.spend_limit),
  ].filter(Boolean);

  const children = [el("div", { class: "quota-rows" }, rows)];

  const cache = quota.prompt_cache || {};
  if (typeof cache.hit_ratio === "number" || typeof cache.warm === "boolean") {
    const items = [];
    if (typeof cache.warm === "boolean") {
      items.push(el("span", { class: "item" }, ["Cache: ", el("b", {}, [cache.warm ? "warm" : "cold"])]));
    }
    if (typeof cache.hit_ratio === "number") {
      items.push(el("span", { class: "item" }, ["Hit ratio: ", el("b", {}, [(cache.hit_ratio * 100).toFixed(0) + "%"])]));
    }
    if (cache.last_miss_cause && cache.last_miss_cause.causes) {
      items.push(el("span", { class: "item" }, ["Last miss: ", el("b", {}, [cache.last_miss_cause.causes.join(", ")])]));
    }
    children.push(el("div", { class: "cache-health" }, items));
  }

  if (quota.stale) {
    children.push(el("div", { class: "quota-stale-note" }, [`Last updated ${formatTime(quota.updated_at)} \u2014 no active session right now`]));
  }

  bodyEl.replaceChildren(...children);
}

// Live-recompute the countdown text every 30s without waiting for the next
// /api/stats poll, since resets_at doesn't change between polls.
setInterval(() => { if (lastQuota) renderQuotaPanel(lastQuota); }, 30000);

async function refresh() {
  const dot = document.getElementById("live-dot");
  const updatedAt = document.getElementById("updated-at");
  try {
    const res = await fetch(`/api/stats?range=${tokenRange}&net_range=${netRange}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const modelOrder = data.model_order || [];

    assignModelColors(modelOrder);
    renderStatGrid(data);
    renderPeriodStats("today-stats", data.today, data.rate_limit_hits.today);
    renderPeriodStats("week-stats", data.week, data.rate_limit_hits.week);
    renderLegend("chart-legend", modelOrder.map(m => ({ label: m, color: colorFor(m) })));
    renderTokenChart(data.timeseries, modelOrder);
    if (showTokenTable) renderTokenTable(modelOrder);
    lastByModel = data.by_model;
    lastByProject = data.by_project;
    if (showModelTable) renderModelTable(data.by_model); else renderModelBars(data.by_model);
    if (showProjectTable) renderProjectTable(data.by_project); else renderProjectBars(data.by_project);
    renderToolUsage(data.tool_usage);
    renderSessionTable(data.sessions);
    renderNetworkPanel(data.network);
    renderQuotaPanel(data.quota);

    dot.classList.remove("stale");
    updatedAt.textContent = "updated " + new Date().toLocaleTimeString();
  } catch (err) {
    dot.classList.add("stale");
    updatedAt.textContent = "connection lost — retrying...";
    console.error(err);
  }
}

function selectTokenRange(range) {
  tokenRange = range;
  saveRanges();
  renderRangeToggle("token-range", tokenRange, selectTokenRange);
  refresh();
}

function selectNetRange(range) {
  netRange = range;
  saveRanges();
  renderRangeToggle("net-range", netRange, selectNetRange);
  refresh();
}

loadRanges();
renderRangeToggle("token-range", tokenRange, selectTokenRange);
renderRangeToggle("net-range", netRange, selectNetRange);

document.getElementById("chart-table-toggle").addEventListener("click", (e) => {
  showTokenTable = !showTokenTable;
  document.getElementById("chart-table").hidden = !showTokenTable;
  document.getElementById("chart-wrap").hidden = showTokenTable;
  e.target.textContent = showTokenTable ? "View as chart" : "View as table";
  if (showTokenTable) renderTokenTable([...modelColor.keys()]);
});

document.getElementById("model-table-toggle").addEventListener("click", (e) => {
  showModelTable = !showModelTable;
  document.getElementById("model-table-wrap").hidden = !showModelTable;
  document.getElementById("model-bars").hidden = showModelTable;
  e.target.textContent = showModelTable ? "View as chart" : "View as table";
  if (showModelTable) renderModelTable(lastByModel); else renderModelBars(lastByModel);
});

document.getElementById("project-table-toggle").addEventListener("click", (e) => {
  showProjectTable = !showProjectTable;
  document.getElementById("project-table-wrap").hidden = !showProjectTable;
  document.getElementById("project-bars").hidden = showProjectTable;
  e.target.textContent = showProjectTable ? "View as chart" : "View as table";
  if (showProjectTable) renderProjectTable(lastByProject); else renderProjectBars(lastByProject);
});

document.getElementById("net-table-toggle").addEventListener("click", (e) => {
  showNetTable = !showNetTable;
  document.getElementById("net-chart-table").hidden = !showNetTable;
  document.getElementById("net-chart-wrap").hidden = showNetTable;
  e.target.textContent = showNetTable ? "View as chart" : "View as table";
  if (showNetTable) renderNetTable();
});

// Pause polling while the tab isn't visible — no point hitting the API and
// re-rendering every 2s when nobody can see it — and refresh immediately
// when it becomes visible again so the view isn't stale.
let refreshTimer = null;

function startPolling() {
  if (refreshTimer !== null) return;
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

function stopPolling() {
  if (refreshTimer === null) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

if (!document.hidden) startPolling();
