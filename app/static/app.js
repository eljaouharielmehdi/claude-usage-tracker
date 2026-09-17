const REFRESH_MS = 2000;
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4",
                      "--series-5", "--series-6", "--series-7", "--series-8"];
const NET_COLORS = { sent: "var(--series-1)", received: "var(--series-2)" };

let modelColor = new Map();      // model name -> css var()
let lastTokenSeries = [];
let lastNetSeries = [];
let showTokenTable = false;
let showNetTable = false;

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

function bucketLabel(point) {
  // point.bucket is "YYYY-MM-DDTHH:MM" (UTC, floored to a 5-minute step).
  return point.bucket.slice(11, 16);
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

// Tool usage — horizontal bars, direct-labeled so no legend is needed.
function renderToolUsage(toolUsage) {
  const container = document.getElementById("tool-usage-bars");
  if (!toolUsage.length) {
    container.replaceChildren(el("div", { class: "empty" }, ["No tool calls recorded yet"]));
    return;
  }
  const max = Math.max(...toolUsage.map(t => t.count), 1);
  container.replaceChildren(...toolUsage.map((t, i) => {
    const color = t.tool === "Other" ? "var(--text-muted)" : `var(${SERIES_VARS[i % SERIES_VARS.length]})`;
    const pct = Math.max((t.count / max) * 100, 2);
    return el("div", { class: "tool-bar-row" }, [
      el("div", { class: "tool-bar-name" }, [t.tool]),
      el("div", { class: "tool-bar-track" }, [
        el("div", { class: "tool-bar-fill", style: `width:${pct}%;background:${color}` }),
      ]),
      el("div", { class: "tool-bar-count" }, [String(t.count)]),
    ]);
  }));
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

function renderStackedChart({ wrapEl, chartEl, axisEl, timeseries, seriesOf, formatValue }) {
  if (!timeseries.length) {
    chartEl.replaceChildren(el("div", { class: "empty" }, ["No activity in the last 24h"]));
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
    const label = bucketLabel(point);
    const open = () => showTooltip(wrapEl, col, label, series, formatValue);
    const close = () => hideTooltip(wrapEl);
    col.addEventListener("pointerenter", open);
    col.addEventListener("pointerleave", close);
    col.addEventListener("focus", open);
    col.addEventListener("blur", close);
    col.tabIndex = 0;
    return col;
  });

  chartEl.replaceChildren(gridlines, ...bars);

  // Aim for roughly a dozen axis labels regardless of how fine the buckets
  // are (5-minute buckets over 24h means ~288 bars — too many to label each).
  const labelEvery = Math.max(1, Math.ceil(timeseries.length / 12));
  axisEl.replaceChildren(...timeseries.map((point, i) => {
    const label = i % labelEvery === 0 ? bucketLabel(point) : "";
    return el("span", {}, [label]);
  }));
}

function renderChartTable(containerId, timeseries, columns, formatValue) {
  const container = document.getElementById(containerId);
  if (!timeseries.length) {
    container.replaceChildren(el("div", { class: "empty" }, ["No activity in the last 24h"]));
    return;
  }
  const thead = el("tr", {}, [
    el("th", {}, ["Time"]),
    ...columns.map(c => el("th", { class: "num" }, [c.label])),
    el("th", { class: "num" }, ["Total"]),
  ]);
  const rows = timeseries.map(point => el("tr", {}, [
    el("td", {}, [bucketLabel(point)]),
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
  renderChartTable("net-chart-table", lastNetSeries, [
    { label: "Sent", get: p => p.sent },
    { label: "Received", get: p => p.received },
  ], formatBytes);
}

function renderTokenTable(modelOrder) {
  renderChartTable("chart-table", lastTokenSeries,
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

async function refresh() {
  const dot = document.getElementById("live-dot");
  const updatedAt = document.getElementById("updated-at");
  try {
    const res = await fetch("/api/stats");
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
    renderModelTable(data.by_model);
    renderProjectTable(data.by_project);
    renderToolUsage(data.tool_usage);
    renderSessionTable(data.sessions);
    renderNetworkPanel(data.network);

    dot.classList.remove("stale");
    updatedAt.textContent = "updated " + new Date().toLocaleTimeString();
  } catch (err) {
    dot.classList.add("stale");
    updatedAt.textContent = "connection lost — retrying...";
    console.error(err);
  }
}

document.getElementById("chart-table-toggle").addEventListener("click", (e) => {
  showTokenTable = !showTokenTable;
  document.getElementById("chart-table").hidden = !showTokenTable;
  document.getElementById("chart-wrap").hidden = showTokenTable;
  e.target.textContent = showTokenTable ? "View as chart" : "View as table";
  if (showTokenTable) renderTokenTable([...modelColor.keys()]);
});

document.getElementById("net-table-toggle").addEventListener("click", (e) => {
  showNetTable = !showNetTable;
  document.getElementById("net-chart-table").hidden = !showNetTable;
  document.getElementById("net-chart-wrap").hidden = showNetTable;
  e.target.textContent = showNetTable ? "View as chart" : "View as table";
  if (showNetTable) renderNetTable();
});

refresh();
setInterval(refresh, REFRESH_MS);
