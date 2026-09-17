const REFRESH_MS = 2000;
const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4",
                      "--series-5", "--series-6", "--series-7", "--series-8"];

let modelColor = new Map();      // model name -> css var()
let lastTimeseries = [];
let showChartTable = false;

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatCost(n) {
  return "$" + n.toFixed(2);
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
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
  ];
  const grid = document.getElementById("stat-grid");
  grid.replaceChildren(...cards.map(c => el("div", { class: "stat-card" }, [
    el("div", { class: "label" }, [c.label]),
    el("div", { class: "value" + (c.accent ? " accent" : "") }, [c.value]),
  ])));
}

function renderLegend(modelOrder) {
  const legend = document.getElementById("chart-legend");
  if (modelOrder.length <= 1) {
    legend.replaceChildren();
    return;
  }
  legend.replaceChildren(...modelOrder.map(model => el("span", { class: "legend-item" }, [
    el("span", { class: "swatch", style: `background:${colorFor(model)}` }),
    el("span", {}, [model]),
  ])));
}

function hideTooltip() {
  const existing = document.getElementById("chart-tooltip");
  if (existing) existing.remove();
}

function showTooltip(anchorEl, point) {
  hideTooltip();
  const chartWrap = document.querySelector(".chart-wrap");
  const hourLabel = point.hour.slice(11, 13) + ":00";

  const rows = Object.entries(point.by_model)
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => el("div", { class: "t-row" }, [
      el("span", { class: "swatch", style: `background:${colorFor(model)};width:10px;height:3px;border-radius:2px;` }),
      el("span", {}, [model]),
      el("span", { class: "t-value" }, [formatTokens(tokens)]),
    ]));

  const tooltip = el("div", { class: "tooltip", id: "chart-tooltip" }, [
    el("div", { class: "t-title" }, [hourLabel]),
    ...rows,
  ]);
  chartWrap.appendChild(tooltip);

  const barRect = anchorEl.getBoundingClientRect();
  const wrapRect = chartWrap.getBoundingClientRect();
  tooltip.style.left = (barRect.left - wrapRect.left + barRect.width / 2) + "px";
  tooltip.style.top = (barRect.top - wrapRect.top - 6) + "px";
}

function renderChart(timeseries, modelOrder) {
  lastTimeseries = timeseries;
  const chart = document.getElementById("chart");
  const axis = document.getElementById("chart-axis");

  if (!timeseries.length) {
    chart.replaceChildren(el("div", { class: "empty" }, ["No activity in the last 24h"]));
    axis.replaceChildren();
    return;
  }

  const max = Math.max(...timeseries.map(p => p.total), 1);
  const gridlines = el("div", { class: "gridlines" }, [0, 1, 2, 3].map(() => el("div")));

  const bars = timeseries.map(point => {
    const segs = modelOrder
      .filter(model => point.by_model[model])
      .map(model => {
        const tokens = point.by_model[model];
        const pct = Math.max((tokens / max) * 100, tokens > 0 ? 1.5 : 0);
        return el("div", { class: "seg", style: `height:${pct}%;background:${colorFor(model)}` });
      });
    const col = el("div", { class: "bar-col" }, segs);
    col.addEventListener("pointerenter", () => showTooltip(col, point));
    col.addEventListener("pointerleave", hideTooltip);
    col.addEventListener("focus", () => showTooltip(col, point));
    col.addEventListener("blur", hideTooltip);
    col.tabIndex = 0;
    return col;
  });

  chart.replaceChildren(gridlines, ...bars);

  // Sparse x-axis labels — every 3rd hour, to avoid crowding 24 columns.
  axis.replaceChildren(...timeseries.map((point, i) => {
    const label = i % 3 === 0 ? point.hour.slice(11, 13) + ":00" : "";
    return el("span", {}, [label]);
  }));
}

function renderChartTable(timeseries, modelOrder) {
  const container = document.getElementById("chart-table");
  if (!timeseries.length) {
    container.replaceChildren(el("div", { class: "empty" }, ["No activity in the last 24h"]));
    return;
  }
  const thead = el("tr", {}, [
    el("th", {}, ["Hour"]),
    ...modelOrder.map(m => el("th", { class: "num" }, [m])),
    el("th", { class: "num" }, ["Total"]),
  ]);
  const rows = timeseries.map(point => el("tr", {}, [
    el("td", {}, [point.hour.slice(11, 13) + ":00"]),
    ...modelOrder.map(m => el("td", { class: "num" }, [formatTokens(point.by_model[m] || 0)])),
    el("td", { class: "num" }, [formatTokens(point.total)]),
  ]));
  const table = el("table", {}, [el("thead", {}, [thead]), el("tbody", {}, rows)]);
  container.replaceChildren(table);
}

function renderModelTable(byModel) {
  const tbody = document.querySelector("#model-table tbody");
  if (!byModel.length) {
    tbody.replaceChildren(el("tr", {}, [el("td", { colspan: "6", class: "empty" }, ["No usage yet"])]));
    return;
  }
  tbody.replaceChildren(...byModel.map(m => el("tr", {}, [
    el("td", {}, [el("span", { class: "swatch", style: `background:${colorFor(m.model)}` }), el("span", {}, [m.model])]),
    el("td", { class: "num" }, [formatTokens(m.totals.input_tokens)]),
    el("td", { class: "num" }, [formatTokens(m.totals.output_tokens)]),
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
    tbody.replaceChildren(el("tr", {}, [el("td", { colspan: "6", class: "empty" }, ["No sessions yet"])]));
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
    renderLegend(modelOrder);
    renderChart(data.timeseries, modelOrder);
    if (showChartTable) renderChartTable(data.timeseries, modelOrder);
    renderModelTable(data.by_model);
    renderProjectTable(data.by_project);
    renderSessionTable(data.sessions);

    dot.classList.remove("stale");
    updatedAt.textContent = "updated " + new Date().toLocaleTimeString();
  } catch (err) {
    dot.classList.add("stale");
    updatedAt.textContent = "connection lost — retrying...";
    console.error(err);
  }
}

document.getElementById("chart-table-toggle").addEventListener("click", (e) => {
  showChartTable = !showChartTable;
  document.getElementById("chart-table").hidden = !showChartTable;
  document.querySelector(".chart-wrap").hidden = showChartTable;
  e.target.textContent = showChartTable ? "View as chart" : "View as table";
  if (showChartTable) {
    const modelOrder = [...modelColor.keys()];
    renderChartTable(lastTimeseries, modelOrder);
  }
});

refresh();
setInterval(refresh, REFRESH_MS);
