/**
 * Sokeri — clinic mode.
 *
 * A full-tab read-only display: big value, trend, 24-hour chart and time in
 * range. Read-only on purpose: thresholds are changed in the popup, never
 * here. Refreshes every minute and on every storage change.
 */

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const MMOL = 18.018;

const TREND = {
  1: ["↓", "falling fast"],
  2: ["↘", "falling"],
  3: ["→", "steady"],
  4: ["↗", "rising"],
  5: ["↑", "rising fast"],
};

const send = (msg) => chrome.runtime.sendMessage(msg);

let lang = "en";
const C_STR = {
  en: {
    inRange: "In range",
    low: "Low",
    high: "High",
    noReading: "No reading",
    lastReading: "Last reading {ago}",
    steady: "steady",
    rising: "rising",
    falling: "falling",
    riseFast: "rising fast",
    fallFast: "falling fast",
    justNow: "just now",
    minAgo: "{n} min ago",
    hrAgo: "{n} hr ago",
    hrMinAgo: "{n} hr {m} min ago",
    chartNote: "Last 24 hours · target {lo}–{hi}",
    tir: "{in}% in range · {below}% low · {above}% high · {n} readings, last 7 days",
    noData7: "No readings in the last 7 days.",
    noData24: "No readings in the last 24 hours.",
    readOnly:
      "Read-only display. Not a medical device — confirm decisions on your sensor's own screen.",
    refreshNote: "Refreshes every minute while this tab is open.",
  },
  fi: {
    inRange: "Alueella",
    low: "Matala",
    high: "Korkea",
    noReading: "Ei lukemaa",
    lastReading: "Viimeisin lukema {ago}",
    steady: "vakaa",
    rising: "nousee",
    falling: "laskee",
    riseFast: "nousee nopeasti",
    fallFast: "laskee nopeasti",
    justNow: "juuri nyt",
    minAgo: "{n} min sitten",
    hrAgo: "{n} t sitten",
    hrMinAgo: "{n} t {m} min sitten",
    chartNote: "Viimeiset 24 tuntia · tavoite {lo}–{hi}",
    tir: "{in}% alueella · {below}% matala · {above}% korkea · {n} lukemaa, viimeiset 7 päivää",
    noData7: "Ei lukemia viimeisen 7 päivän aikana.",
    noData24: "Ei lukemia viimeisen 24 tunnin aikana.",
    readOnly:
      "Vain lukunäkymä. Ei lääkinnällinen laite — varmista päätökset sensorisi omalta näytöltä.",
    refreshNote: "Päivittyy minuutin välein tämän välilehden ollessa auki.",
  },
};

function ct(key, vars) {
  let s = (C_STR[lang] && C_STR[lang][key]) ?? C_STR.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

function fmt(mgdl, unit) {
  return unit === "mmoll" ? (mgdl / MMOL).toFixed(1) : String(Math.round(mgdl));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(lang === "fi" ? "fi-FI" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return ct("justNow");
  if (minutes < 60) return ct("minAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? ct("hrMinAgo", { n: hours, m: rest }) : ct("hrAgo", { n: hours });
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function render(payload) {
  const s = { low: 70, high: 180, ...(payload?.settings || {}) };
  lang = s.lang === "fi" ? "fi" : "en";
  document.documentElement.lang = lang;
  const ro = document.getElementById("clinic-ro");
  if (ro) ro.textContent = ct("readOnly");
  const rf = document.getElementById("clinic-rf");
  if (rf) rf.textContent = ct("refreshNote");
  const d = payload?.data || null;
  const unit = s.unit === "mmoll" ? "mmoll" : "mgdl";
  document.body.dataset.theme = s.theme === "light" ? "light" : "dark";

  const name =
    d?.patient?.name || payload?.user?.firstName || payload?.user?.email || "Your readings";
  $("source").textContent = `${name}${d?.sourceLabel ? ` · ${d.sourceLabel}` : ""}`;

  const latest = d?.latest;
  $("unit").textContent = unit === "mmoll" ? "mmol/L" : "mg/dL";
  const stateEl = $("state");
  if (!latest) {
    $("value").textContent = "—";
    stateEl.textContent = d?.error || ct("noReading");
    stateEl.dataset.state = "none";
    $("trend").textContent = "";
    $("when").textContent = "";
  } else {
    const stale = Date.now() - latest.ts > 30 * 60 * 1000;
    const kind = stale ? "none" : latest.mgdl <= s.low ? "low" : latest.mgdl >= s.high ? "high" : "ok";
    $("value").textContent = fmt(latest.mgdl, unit);
    stateEl.dataset.state = kind;
    stateEl.textContent =
      kind === "none"
        ? ct("lastReading", { ago: relTime(latest.ts) })
        : kind === "low"
          ? ct("low")
          : kind === "high"
            ? ct("high")
            : ct("inRange");
    const trendKey = { 1: "fallFast", 2: "falling", 3: "steady", 4: "rising", 5: "riseFast" }[latest.trend];
    const trend = TREND[latest.trend];
    $("trend").textContent = trend && trendKey ? `${trend[0]} ${ct(trendKey)}` : "";
    $("when").textContent = `${fmtTime(latest.ts)} (${relTime(latest.ts)})`;
  }

  renderChart(d?.series || [], s, unit);
  renderTir(d?.series || [], s);
}

function renderChart(series, s, unit) {
  const host = $("chart");
  host.textContent = "";
  const from = Date.now() - 24 * 3600 * 1000;
  const points = series.filter((p) => p.ts >= from);
  if (points.length < 2) {
    host.textContent = ct("noData24");
    return;
  }
  const W = 860;
  const H = 220;
  const pad = { t: 14, r: 16, b: 24, l: 48 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const now = Date.now();
  const values = points.map((p) => p.mgdl);
  let yMin = Math.min(s.low, ...values);
  let yMax = Math.max(s.high, ...values);
  const span = Math.max(yMax - yMin, 60);
  yMin = Math.max(20, Math.floor((yMin - span * 0.1) / 10) * 10);
  yMax = Math.min(700, Math.ceil((yMax + span * 0.1) / 10) * 10);
  const X = (ts) => pad.l + ((ts - from) / (now - from)) * plotW;
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });

  svg.appendChild(
    svgEl("rect", {
      x: pad.l,
      y: Math.max(pad.t, Y(s.high)),
      width: plotW,
      height: Math.max(0, Math.min(pad.t + plotH, Y(s.low)) - Math.max(pad.t, Y(s.high))),
      fill: "rgba(61, 220, 151, 0.09)",
    })
  );
  const light = document.body.dataset.theme === "light";
  const grid = light ? "#ded8cb" : "#1e242b";
  for (const v of [yMin, Math.round((yMin + yMax) / 2), yMax]) {
    svg.appendChild(
      svgEl("line", { x1: pad.l, y1: Y(v), x2: pad.l + plotW, y2: Y(v), stroke: grid })
    );
    const label = svgEl("text", {
      x: pad.l - 8,
      y: Y(v) + 4,
      "text-anchor": "end",
      fill: "var(--muted)",
      "font-size": "12",
    });
    label.textContent = fmt(v, unit);
    svg.appendChild(label);
  }
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)} ${Y(p.mgdl).toFixed(1)}`).join(" ");
  svg.appendChild(
    svgEl("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 2.5, "stroke-linecap": "round" })
  );
  const last = points[points.length - 1];
  const color = last.mgdl <= s.low ? "#ff5c5c" : last.mgdl >= s.high ? "#ffb020" : "#3ddc97";
  svg.appendChild(svgEl("circle", { cx: X(last.ts), cy: Y(last.mgdl), r: 6, fill: color }));
  $("chart-note").textContent = ct("chartNote", { lo: fmt(s.low, unit), hi: fmt(s.high, unit) });
  host.appendChild(svg);
}

function renderTir(series, s) {
  const el = $("tir");
  const from = Date.now() - 7 * 86400000;
  const pts = series.filter((p) => p.ts >= from);
  if (!pts.length) {
    el.textContent = ct("noData7");
    return;
  }
  let below = 0;
  let above = 0;
  for (const p of pts) {
    if (p.mgdl < s.low) below++;
    else if (p.mgdl > s.high) above++;
  }
  const inside = pts.length - below - above;
  const pct = (n) => Math.round((n / pts.length) * 100);
  el.textContent = ct("tir", {
    in: pct(inside),
    below: pct(below),
    above: pct(above),
    n: pts.length,
  });
}

async function load() {
  try {
    const payload = await send({ type: "state" });
    if (payload) render(payload);
  } catch {
    /* the background is not ready yet */
  }
}

load();
setInterval(load, 60 * 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.glucoseData || changes.settings)) load();
});
