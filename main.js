/**
 * Sokeri — landing page interactions.
 *
 * Three parts:
 *   1. Popup preview tabs + sample glucose chart (SVG).
 *   2. Copy button and toast notification.
 *   3. Hero stage parallax — a few pixels of pointer follow, CSS-only motion.
 */

/* ==================================================== sample data generator */

/** Deterministic pseudo-random generator: the same series on every visit. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Realistic-looking series at roughly 4 readings per hour (mg/dL). */
function makeSeries(points, seed) {
  const rnd = seeded(seed);
  const out = [];
  let v = 118;
  let drift = 0;
  for (let i = 0; i < points; i++) {
    drift += (rnd() - 0.5) * 7;
    drift *= 0.82; // mean reversion
    v += drift * 0.55 + (rnd() - 0.5) * 5;
    // slight post-meal rise wave
    v += Math.sin((i / points) * Math.PI * 2 + seed) * 4;
    v = Math.min(246, Math.max(72, v));
    out.push(Math.round(v));
  }
  return out;
}

const RANGES = {
  3: { points: 14, label: "Last 3 hours", seed: 7 },
  6: { points: 26, label: "Last 6 hours", seed: 13 },
  12: { points: 48, label: "Last 12 hours", seed: 29 },
  24: { points: 92, label: "Last 24 hours", seed: 47 },
};

/** Currently selected time range and unit (the readout line follows them). */
let currentRange = 3;
let currentUnit = "mgdl";

const MG_PER_MMOL = 18.0182;

/**
 * Draws the glucose chart: shaded target band (70–180), axis labels,
 * filled area under the series. `width/height` are SVG coordinates.
 */
function renderChart(host, values, { width = 420, height = 150, hours = 3 } = {}) {
  const lo = 40;
  const hi = 280;
  const padL = 30;
  const padR = 6;
  const padT = 8;
  const padB = 18;

  const x = (i) =>
    padL + (i / Math.max(1, values.length - 1)) * (width - padL - padR);
  const y = (v) =>
    padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);

  const line = values
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${y(lo)} L${x(0).toFixed(1)} ${y(lo)} Z`;

  const gridVals = [70, 180, 240];
  const grid = gridVals
    .map((v) => {
      const band = v === 70 || v === 180;
      return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${width - padR}" y2="${y(v).toFixed(1)}"
        stroke="${band ? "#2a4a3d" : "#262d34"}" stroke-width="1"
        stroke-dasharray="${band ? "0" : "2 4"}" />
      <text x="4" y="${(y(v) + 3.5).toFixed(1)}" fill="#9aa4ae" font-size="9.5">${v}</text>`;
    })
    .join("");

  const xLabels = [0, 1, 2, 3]
    .map((i, index, all) => {
      const fraction = index / (all.length - 1);
      if (fraction === 1) return "now";
      const back = hours * (1 - fraction);
      return Number.isInteger(back) ? `-${back}h` : `-${back.toFixed(1)}h`;
    })
    .map((t, i, a) => {
      const px = padL + (i / (a.length - 1)) * (width - padL - padR);
      const anchor = i === 0 ? "start" : i === a.length - 1 ? "end" : "middle";
      return `<text x="${px.toFixed(1)}" y="${height - 4}" fill="#9aa4ae" font-size="9.5" text-anchor="${anchor}">${t}</text>`;
    })
    .join("");

  const last = values[values.length - 1];
  const dot = `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}"
      r="4.5" fill="#7fc8ff" stroke="#101418" stroke-width="2" />`;

  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="presentation" focusable="false">
    <rect x="${padL}" y="${y(180).toFixed(1)}" width="${width - padL - padR}"
      height="${(y(70) - y(180)).toFixed(1)}" fill="#3ddc97" opacity="0.07" />
    ${grid}
    <path d="${area}" fill="#7fc8ff" opacity="0.14" />
    <path d="${line}" fill="none" stroke="#7fc8ff" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" />
    ${dot}
    ${xLabels}
  </svg>`;
}

/** Small sparkline (for the toolbar menu). */
function renderSpark(host, values) {
  const w = 240;
  const h = 44;
  const lo = Math.min(...values) - 6;
  const hi = Math.max(...values) + 6;
  const pts = values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * w;
      const py = h - ((v - lo) / (hi - lo)) * h;
      return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="presentation" focusable="false">
    <path d="${pts}" fill="none" stroke="#7fc8ff" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

/* ================================================ preview tabs */

const frame = document.getElementById("popup-frame");
const tabButtons = document.querySelectorAll(".pv-tabs button");
const views = document.querySelectorAll(".pv");

function showView(name) {
  for (const v of views) v.hidden = v.dataset.view !== name;
  for (const b of tabButtons)
    b.setAttribute("aria-pressed", String(b.dataset.show === name));
}

for (const b of tabButtons) {
  b.addEventListener("click", () => showView(b.dataset.show));
}

/* time range buttons (chart redraw) */
const chartHost = document.getElementById("pv-chart");
const chartNote = document.getElementById("pv-chart-note");
const chartReadout = document.getElementById("pv-chart-readout");

function drawRange(hours) {
  currentRange = hours;
  const cfg = RANGES[hours] || RANGES[3];
  const values = makeSeries(cfg.points, cfg.seed);
  renderChart(chartHost, values, { hours });
  chartNote.textContent = cfg.label;
  chartReadout.textContent = formatReadout(values);
}

/** Formats the series in the selected unit as "104–138 mg/dL". */
function formatReadout(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return currentUnit === "mmoll"
    ? `${(lo / MG_PER_MMOL).toFixed(1)}–${(hi / MG_PER_MMOL).toFixed(1)} mmol/L`
    : `${lo}–${hi} mg/dL`;
}

for (const btn of document.querySelectorAll(".pv-ranges button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".pv-ranges button"))
      b.setAttribute("aria-pressed", String(b === btn));
    drawRange(Number(btn.dataset.range));
  });
}

drawRange(3);

/* unit buttons: mg/dL ↔ mmol/L (preview) */
const statBase = { tir: "94", avg: 118, min: 96, max: 154 };
const pvNum = document.querySelector(".pv-num");
const pvUnit = document.querySelector(".pv-unit");
const statCells = document.querySelectorAll(".pv-stats dd");

function setUnit(unit) {
  currentUnit = unit;
  const conv = (mg) =>
    unit === "mmoll" ? (mg / MG_PER_MMOL).toFixed(1) : String(mg);
  pvNum.textContent = conv(112);
  pvUnit.textContent = unit === "mmoll" ? "mmol/L" : "mg/dL";
  statCells[1].textContent = conv(statBase.avg);
  statCells[2].textContent = conv(statBase.min);
  statCells[3].textContent = conv(statBase.max);
  // rewrite the readout line with the new unit
  drawRange(currentRange);
}

for (const btn of document.querySelectorAll(".pv-seg button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".pv-seg button"))
      b.setAttribute("aria-pressed", String(b === btn));
    setUnit(btn.dataset.unit);
  });
}

/* toolbar sparkline */
const sparkHost = document.getElementById("tb-spark");
if (sparkHost) renderSpark(sparkHost, makeSeries(24, 13));

/* ============================================== copy + toast */

const toast = document.getElementById("toast");
let toastTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

const copyBtn = document.getElementById("copy-url");
if (copyBtn) {
  const label = document.getElementById("copy-url-label");
  const original = label.textContent;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy);
      label.textContent = "Copied ✓";
      showToast("Address copied to the clipboard. Paste it into a new tab.");
      setTimeout(() => {
        label.textContent = original;
      }, 2400);
    } catch {
      showToast("Copy failed; select the address manually: chrome://extensions");
    }
  });
}

/* ============================================ hero live simulation */

/**
 * The hero shot pretends to be alive: every few seconds the sample value
 * takes a small random step and the trend label follows the direction.
 * Decorative only — the numbers are fixed sample data, not measurements.
 */
(function heroLiveSim() {
  const num = document.querySelector(".shot-num");
  const trend = document.querySelector(".shot-trend");
  const age = document.querySelector(".shot-age");
  if (!num || !trend || !age) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let value = Number(num.textContent) || 112;
  const arrows = { up: "\u2197 Rising", flat: "\u2192 Steady", down: "\u2198 Falling" };
  setInterval(() => {
    const step = Math.round((Math.random() - 0.5) * 8);
    value = Math.min(190, Math.max(80, value + step));
    num.textContent = String(value);
    trend.textContent = step > 1 ? arrows.up : step < -1 ? arrows.down : arrows.flat;
    age.textContent = "just now";
  }, 5000);
})();

/* ================================================ hero stage parallax */

/**
 * The hero shot follows the pointer by a few pixels. The layers are moved with
 * CSS custom properties, so all animation stays on the compositor; when the
 * visitor prefers reduced motion nothing is bound at all.
 */
function initHeroParallax() {
  const stage = document.querySelector(".hero-stage");
  if (!stage) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let frame = 0;
  const apply = (px, py) => {
    stage.style.setProperty("--px", px.toFixed(3));
    stage.style.setProperty("--py", py.toFixed(3));
  };

  stage.addEventListener("pointermove", (e) => {
    // a finger drag must not shift the card while the page scrolls
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = stage.getBoundingClientRect();
      apply((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
    });
  });

  stage.addEventListener("pointerleave", () => apply(0, 0));
}

initHeroParallax();
