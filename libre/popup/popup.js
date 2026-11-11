/**
 * Sokeri — popup interface.
 *
 * Data is produced by the service worker; this file only handles display,
 * chart drawing and settings collection. Glucose values are always stored in
 * mg/dL and converted to the selected unit for display.
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

const DEFAULTS = {
  unit: "mgdl",
  low: 70,
  high: 180,
  alerts: true,
  sound: true,
  intervalMin: 1,
  remember: true,
  theme: "dark", // "dark" | "light"
  predictMin: 0, // 0 = off, otherwise minutes ahead for trend prediction
  nightLow: 70, // mg/dL, used during night hours
  nightHigh: 180, // mg/dL, used during night hours
  nightStart: 23, // hour (0-23) when night thresholds begin
  nightEnd: 7, // hour (0-23) when night thresholds end
  personId: null, // selected followed person (Libre); null = first connection
  repeatMin: 10, // re-alert while still out of range; 0 = once per episode
  signalLoss: true, // alert when no new reading arrives for a while
};

const EXPORT_NAME = "sokeri-libre-readings.csv";
const REPORT_NAME = "sokeri-libre-report.pdf";

let state = {
  authed: false,
  user: null,
  settings: { ...DEFAULTS },
  data: null,
  events: [],
};

let rangeHours = 3;

/* Self-fit guard: the popup frame is ~600px tall and must never scroll.
   After every render the panel is measured and compacted until it fits. */
let compact = 0;
const CHART_H = [160, 140, 120, 100];
const FIT_BUDGET_PX = 580;

function fitPopup() {
  const app = document.getElementById("view-app");
  if (!state.authed || !app || app.hidden) {
    compact = 0;
    document.body.dataset.compact = "0";
    return;
  }
  for (let level = 0; level <= 3; level++) {
    compact = level;
    document.body.dataset.compact = String(level);
    if (level > 0) renderChart();
    if (app.scrollHeight <= FIT_BUDGET_PX || level === 3) break;
  }
}
let transientNote = null;
let refreshing = false;
let autoTimer = null;

/* -------------------------------------------------------------- helpers */

const send = (msg) => chrome.runtime.sendMessage(msg);

function fmt(mgdl, unit) {
  return unit === "mmoll" ? (mgdl / MMOL).toFixed(1) : String(Math.round(mgdl));
}

function unitLabel(unit) {
  return unit === "mmoll" ? "mmol/L" : "mg/dL";
}

function fromDisp(value, unit) {
  return unit === "mmoll" ? value * MMOL : value;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function fmtX(ts) {
  if (rangeHours < 48) return fmtTime(ts);
  const days = Math.round((Date.now() - ts) / 86400000);
  return days <= 0 ? "now" : `-${days}d`;
}

function relTime(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min ago` : `${hours} hr ago`;
}

function rangeStateOf(mgdl, s, ts) {
  if (mgdl <= effLow(s, ts)) return "low";
  if (mgdl >= effHigh(s, ts)) return "high";
  return "ok";
}

/** Night is a wrap-around window, e.g. 23 -> 7. start === end disables it. */
function isNightHour(hour, s) {
  const start = Number(s.nightStart ?? 23);
  const end = Number(s.nightEnd ?? 7);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Effective low threshold (night value during night hours, day value otherwise). */
function effLow(s, ts) {
  const hour = new Date(ts ?? Date.now()).getHours();
  return isNightHour(hour, s) ? Number(s.nightLow ?? s.low) : s.low;
}

/** Effective high threshold (night value during night hours, day value otherwise). */
function effHigh(s, ts) {
  const hour = new Date(ts ?? Date.now()).getHours();
  return isNightHour(hour, s) ? Number(s.nightHigh ?? s.high) : s.high;
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function pointsInRange() {
  const series = state.data?.series;
  if (!Array.isArray(series) || !series.length) return [];
  const from = Date.now() - rangeHours * 3600 * 1000;
  return series.filter((p) => p.ts >= from);
}

/** Linear trend of the last minutes in mg/dL per minute (null if too few points). */
function trendSlope() {
  const latest = state.data?.latest;
  if (!latest) return null;
  const pts = (state.data?.series || []).filter((p) => latest.ts - p.ts <= 45 * 60 * 1000).slice(-6);
  if (pts.length < 3) return null;
  const t0 = pts[0].ts;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const p of pts) {
    const x = (p.ts - t0) / 60000;
    sx += x;
    sy += p.mgdl;
    sxx += x * x;
    sxy += x * p.mgdl;
  }
  const denom = pts.length * sxx - sx * sx;
  return denom === 0 ? null : (pts.length * sxy - sx * sy) / denom;
}

function seriesOfLast(days) {
  const series = state.data?.series;
  if (!Array.isArray(series) || !series.length) return [];
  return series.filter((p) => p.ts >= Date.now() - days * 86400000);
}

/** Share of readings below / in / above the effective range at their own time. */
function tirSplit(series, s) {
  let below = 0,
    above = 0;
  for (const p of series) {
    if (p.mgdl < effLow(s, p.ts)) below++;
    else if (p.mgdl > effHigh(s, p.ts)) above++;
  }
  const total = series.length;
  return {
    total,
    below: total ? (below / total) * 100 : 0,
    above: total ? (above / total) * 100 : 0,
    in: total ? ((total - below - above) / total) * 100 : 0,
  };
}

/* --------------------------------------------------------------- events */

function bindEvents() {
  $("login-form").addEventListener("submit", onLogin);

  $("btn-refresh").addEventListener("click", () => doRefresh());

  $("btn-settings").addEventListener("click", () => {
    setView(panelView === "settings" ? "app" : "settings");
  });

  $("btn-reports").addEventListener("click", () => {
    setView(panelView === "reports" ? "app" : "reports");
  });

  const accSel = document.getElementById("set-account");
  if (accSel) {
    accSel.addEventListener("change", async (e) => {
      const r = await send({ type: "switchAccount", email: e.target.value });
      if (r?.ok) {
        state = { ...state, ...r };
        render();
      } else {
        renderAccounts();
      }
    });
  }
  const accAdd = document.getElementById("btn-account-add");
  if (accAdd) {
    accAdd.addEventListener("click", () => {
      addingAccount = true;
      render();
      $("email").focus();
    });
  }
  const accCancel = document.getElementById("btn-add-cancel");
  if (accCancel) {
    accCancel.addEventListener("click", () => {
      addingAccount = false;
      render();
    });
  }

  $("btn-logout-2").addEventListener("click", () => $("btn-logout").click());

  $("btn-help").addEventListener("click", () => {
    setView("settings");
    const help = $("settings").querySelector(".help");
    help.open = true;
    help.scrollIntoView({ block: "nearest" });
    help.querySelector("summary").focus();
  });

  // Inline sign-out confirmation: a native confirm() would show its buttons
  // in the browser UI language, so the popup asks in its own language instead.
  const logoutConfirm = $("logout-confirm");
  const hideLogoutConfirm = () => {
    logoutConfirm.hidden = true;
  };
  $("btn-logout").addEventListener("click", () => {
    logoutConfirm.hidden = false;
    $("btn-logout-no").focus();
  });
  $("btn-logout-no").addEventListener("click", () => {
    hideLogoutConfirm();
    $("btn-logout").focus();
  });
  logoutConfirm.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideLogoutConfirm();
      $("btn-logout").focus();
    }
  });
  $("btn-logout-yes").addEventListener("click", async () => {
    hideLogoutConfirm();
    stopAuto();
    await send({ type: "logout" });
    transientNote = null;
    state = { ...state, authed: false, user: null, data: null };
    render();
    $("email").focus();
  });

  $("btn-test").addEventListener("click", () => send({ type: "testAlert" }));

  document.querySelectorAll(".ranges button").forEach((btn) => {
    btn.addEventListener("click", () => {
      rangeHours = Number(btn.dataset.range);
      document
        .querySelectorAll(".ranges button")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      renderChart();
      renderStats();
    });
  });

  document.querySelectorAll("[data-unit]").forEach((btn) => {
    btn.addEventListener("click", () => save({ unit: btn.dataset.unit }));
  });

  $("btn-theme").addEventListener("click", () =>
    save({ theme: state.settings.theme === "light" ? "dark" : "light" })
  );

  const personSel = document.getElementById("set-person");
  if (personSel) {
    personSel.addEventListener("change", async (e) => {
      await save({ personId: e.target.value || null });
      doRefresh();
    });
  }

  $("set-low").addEventListener("change", () => saveThreshold("low"));
  $("set-high").addEventListener("change", () => saveThreshold("high"));
  $("set-night-low").addEventListener("change", () => saveThreshold("nightLow"));
  $("set-night-high").addEventListener("change", () => saveThreshold("nightHigh"));
  const clampHour = (id, key) => {
    const v = Math.round(Number($(id).value));
    if (!Number.isFinite(v)) {
      syncSettingsForm();
      return;
    }
    save({ [key]: Math.min(23, Math.max(0, v)) });
  };
  $("set-night-start").addEventListener("change", () => clampHour("set-night-start", "nightStart"));
  $("set-night-end").addEventListener("change", () => clampHour("set-night-end", "nightEnd"));
  $("set-predict").addEventListener("change", (e) =>
    save({ predictMin: Number(e.target.value) || 0 })
  );
  $("btn-event-add").addEventListener("click", async () => {
    const kind = $("set-event-kind").value || "other";
    const events = [...getEvents(), { ts: Date.now(), kind }].sort((a, b) => a.ts - b.ts);
    await saveEvents(events);
  });
  $("event-list").addEventListener("click", async (e) => {
    const idx = e.target?.dataset?.del;
    if (idx == null) return;
    await saveEvents(getEvents().filter((_, i) => String(i) !== String(idx)));
  });
  $("btn-export").addEventListener("click", () => {
    const btn = $("btn-export");
    const series = [...(state.data?.series || [])].sort((a, b) => a.ts - b.ts);
    if (!series.length) {
      btn.textContent = "No data";
      setTimeout(() => {
        btn.textContent = "Export CSV";
      }, 2000);
      return;
    }
    const unit = state.settings.unit;
    const rows = [`timestamp_iso,value_${unit === "mmoll" ? "mmol_L" : "mg_dL"}`];
    for (const p of series) {
      rows.push(
        `${new Date(p.ts).toISOString()},${unit === "mmoll" ? (p.mgdl / MMOL).toFixed(1) : p.mgdl}`
      );
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = EXPORT_NAME;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
    btn.textContent = "Saved ✓";
    setTimeout(() => {
      btn.textContent = "Export CSV";
    }, 2000);
  });
  let eraseArmed = false;
  let eraseTimer = 0;
  $("btn-erase").addEventListener("click", async () => {
    const btn = $("btn-erase");
    if (!eraseArmed) {
      eraseArmed = true;
      btn.textContent = "Click again to erase everything";
      eraseTimer = setTimeout(() => {
        eraseArmed = false;
        btn.textContent = "Delete all local data";
      }, 4000);
      return;
    }
    clearTimeout(eraseTimer);
    eraseArmed = false;
    btn.textContent = "Delete all local data";
    btn.disabled = true;
    try {
      stopAuto();
      await send({ type: "logout" });
      await chrome.storage.local.remove(["settings", "glucoseData", "events"]);
      state = { authed: false, user: null, settings: { ...DEFAULTS }, data: null, events: [] };
      rangeHours = 3;
      syncSettingsForm();
      render();
      $("email").focus();
    } finally {
      btn.disabled = false;
    }
  });
  $("btn-pdf").addEventListener("click", downloadPdf);
  $("btn-clinic").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("clinic/clinic.html") });
  });
  $("set-alerts").addEventListener("change", (e) => save({ alerts: e.target.checked }));
  $("set-sound").addEventListener("change", (e) => save({ sound: e.target.checked }));
  $("set-repeat").addEventListener("change", (e) => save({ repeatMin: Number(e.target.value) || 0 }));
  $("set-signal").addEventListener("change", (e) => save({ signalLoss: e.target.checked }));
  $("set-interval").addEventListener("change", (e) =>
    save({ intervalMin: Number(e.target.value) })
  );
  $("set-remember").addEventListener("change", (e) => save({ remember: e.target.checked }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      state.settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      syncSettingsForm();
    }
    if (changes.glucoseData) {
      state.data = changes.glucoseData.newValue || null;
      render();
    }
    if (changes.events) {
      state.events = changes.events.newValue || [];
      renderEvents();
      if (state.authed) renderChart();
    }
  });

  window.addEventListener("resize", () => {
    if (state.authed) renderChart();
  });
}

async function save(patch) {
  const r = await send({ type: "saveSettings", patch });
  if (r?.settings) state.settings = r.settings;
  if (r?.data !== undefined) state.data = r.data;
  syncSettingsForm();
  render();
  if (patch.intervalMin) startAuto();
}

function saveThreshold(key) {
  const s = state.settings;
  const map = {
    low: "set-low",
    high: "set-high",
    nightLow: "set-night-low",
    nightHigh: "set-night-high",
  };
  const input = map[key] ? $(map[key]) : null;
  if (!input) {
    syncSettingsForm();
    return;
  }
  let value = parseFloat(input.value);
  if (!Number.isFinite(value)) {
    syncSettingsForm();
    return;
  }
  let mgdl = Math.round(fromDisp(value, s.unit));
  if (key === "low") {
    mgdl = Math.min(Math.max(mgdl, 40), (s.high ?? 180) - 20);
  } else if (key === "high") {
    mgdl = Math.max(Math.min(mgdl, 400), (s.low ?? 70) + 20);
  } else if (key === "nightLow") {
    mgdl = Math.min(Math.max(mgdl, 40), (s.nightHigh ?? 180) - 20);
  } else if (key === "nightHigh") {
    mgdl = Math.max(Math.min(mgdl, 400), (s.nightLow ?? 70) + 20);
  }
  save({ [key]: mgdl });
}

const EVENT_LABEL = { meal: "Meal", insulin: "Insulin", exercise: "Exercise", other: "Other" };

function getEvents() {
  return Array.isArray(state.events) ? state.events : [];
}

async function saveEvents(events) {
  state.events = events;
  try {
    await chrome.storage.local.set({ events });
  } catch {
    /* storage unavailable */
  }
  renderEvents();
  if (state.authed) renderChart();
}

function renderEvents() {
  const list = document.getElementById("event-list");
  if (!list) return;
  list.textContent = "";
  const all = getEvents();
  for (const ev of all.slice(-8).reverse()) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${EVENT_LABEL[ev.kind] || "Other"} · ${fmtTime(ev.ts)} (${relTime(ev.ts)})`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost danger mini";
    del.dataset.del = String(all.indexOf(ev));
    del.textContent = "Delete";
    li.append(span, del);
    list.appendChild(li);
  }
}

/* Dexcom multi-account selector. Uses getElementById on purpose: the Libre
   panel has no such element and must keep validating cleanly. */
function renderAccounts() {
  const row = document.getElementById("account-row");
  const sel = document.getElementById("set-account");
  if (!row || !sel) return;
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  if (!accounts.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  sel.textContent = "";
  for (const a of accounts) {
    const opt = document.createElement("option");
    opt.value = a.email;
    opt.textContent = a.email;
    if (a.active) opt.selected = true;
    sel.appendChild(opt);
  }
}

/* Followed-person selector (Libre only). Uses getElementById on purpose: the
   Dexcom panel has no such element and must keep validating cleanly. */
function renderPerson() {
  const row = document.getElementById("person-row");
  const sel = document.getElementById("set-person");
  if (!row || !sel) return;
  const people = state.data?.people || [];
  if (!people.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  sel.textContent = "";
  for (const p of people) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    sel.appendChild(opt);
  }
  sel.value = state.data?.person || state.settings.personId || people[0].id;
}

async function onLogin(event) {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const errorEl = $("login-error");
  const button = $("login-btn");

  errorEl.hidden = true;
  if (!email || !password) {
    errorEl.textContent = "Email and password are required.";
    errorEl.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const r = await send({
      type: "login",
      email,
      password,
      region: $("region").value,
      remember: $("remember").checked,
    });
    if (!r?.ok) {
      errorEl.textContent = r?.error || "Sign in failed.";
      errorEl.hidden = false;
      return;
    }
    transientNote = r.warnings?.length ? r.warnings.join("  •  ") : null;
    state = { ...state, ...(await send({ type: "state" })) };
    $("password").value = "";
    addingAccount = false;
    render();
    startAuto();
  } catch (err) {
    errorEl.textContent = "Could not send the request. Check your internet connection.";
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
}

/* --------------------------------------------------------- data refresh */

async function doRefresh() {
  if (refreshing || !state.authed) return;
  $("logout-confirm").hidden = true;
  refreshing = true;
  const button = $("btn-refresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  button.setAttribute("aria-busy", "true");
  try {
    const r = await send({ type: "refresh" });
    if (r) state = { ...state, ...r };
    render();
  } catch {
    /* if the background did not answer, the next timer run retries */
  } finally {
    refreshing = false;
    button.disabled = false;
    button.textContent = "Refresh";
    button.setAttribute("aria-busy", "false");
  }
}

function startAuto() {
  stopAuto();
  const minutes = Math.max(1, state.settings?.intervalMin || 1);
  autoTimer = setInterval(() => doRefresh(), minutes * 60 * 1000);
}

function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

/* ------------------------------------------------------------- painting */

/* Panel views: the dashboard is replaced by settings or reports, so only one
   view is ever measured by the fit guard and the frame cannot scroll. */
let panelView = "app"; // "app" | "settings" | "reports"
let addingAccount = false; // Dexcom: the sign-in form adds another account

function setView(name) {
  panelView = name;
  $("settings").hidden = name !== "settings";
  $("reports").hidden = name !== "reports";
  $("view-app").classList.toggle("settings-open", name === "settings");
  $("view-app").classList.toggle("reports-open", name === "reports");
  $("btn-settings").setAttribute("aria-expanded", String(name === "settings"));
  $("btn-settings").textContent = name === "settings" ? "Close settings" : "Settings";
  $("btn-reports").setAttribute("aria-expanded", String(name === "reports"));
  $("btn-reports").textContent = name === "reports" ? "Close" : "Reports";
  if (name === "reports") renderReports();
  fitPopup();
}

function render() {
  document.body.dataset.theme = state.settings.theme === "light" ? "light" : "dark";
  $("view-login").hidden = state.authed && !addingAccount;
  $("view-app").hidden = !state.authed || addingAccount;
  if (!state.authed) {
    stopAuto();
    fitPopup();
    return;
  }
  if (state.data?.source) transientNote = null;
  renderHeader();
  renderBanner();
  renderHero();
  renderChart();
  renderStats();
  renderEvents();
  renderPerson();
  renderAccounts();
  const cancel = document.getElementById("btn-add-cancel");
  if (cancel) cancel.hidden = !addingAccount;
  if (panelView === "reports" && !$("reports").hidden) renderReports();
  fitPopup();
}

function renderHeader() {
  const d = state.data;
  const s = state.settings;
  const name =
    d?.patient?.name ||
    [state.user?.firstName, state.user?.lastName].filter(Boolean).join(" ") ||
    state.user?.email ||
    "Your readings";
  $("patient-name").textContent = name;

  let source = d?.sourceLabel || (d?.error ? "Source not found" : "");
  const t = d?.targets;
  if (t?.low && t?.high && (t.low !== s.low || t.high !== s.high)) {
    const hint = `target ${fmt(t.low, s.unit)}–${fmt(t.high, s.unit)} ${unitLabel(s.unit)}`;
    source = source ? `${source} · ${hint}` : hint;
  }
  $("source-label").textContent = source;
}

function renderBanner() {
  const d = state.data;
  const banner = $("banner");
  const messages = [];

  if (d?.error) messages.push({ kind: "error", text: d.error });
  if (transientNote) messages.push({ kind: "note", text: transientNote });
  if (!d?.error) {
    if (d?.stale && d?.latest) {
      const ageMs = Date.now() - d.latest.ts;
      messages.push({
        kind: "note",
        text:
          ageMs > 20 * 60 * 1000
            ? `No new readings for ${relTime(d.latest.ts)}. Check the sensor and the phone app.`
            : `No new data. Last reading ${relTime(d.latest.ts)}.`,
      });
    } else if (d?.notes?.length) {
      messages.push({ kind: "note", text: d.notes[0] });
    }
  }

  if (messages.length) {
    banner.hidden = false;
    banner.dataset.kind = messages[0].kind;
    banner.textContent = messages[0].text;
  } else {
    banner.hidden = true;
  }

  const list = $("err-list");
  list.textContent = "";
  const errors = (d?.errors || []).slice(0, 6);
  for (const text of errors) {
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  }
  $("btn-help").textContent = errors.length ? `No data? (${errors.length})` : "No data?";
}

function renderHero() {
  const s = state.settings;
  const latest = state.data?.latest;

  $("unit").textContent = unitLabel(s.unit);
  const stateEl = $("range-state");

  if (!latest) {
    $("value").textContent = "—";
    stateEl.textContent = "No reading";
    stateEl.dataset.state = "none";
    $("trend").textContent = "";
    $("when").textContent = "";
    return;
  }

  const stale = Date.now() - latest.ts > 30 * 60 * 1000;
  const kind = stale ? "none" : rangeStateOf(latest.mgdl, s, latest.ts);

  $("value").textContent = fmt(latest.mgdl, s.unit);
  stateEl.dataset.state = kind;
  stateEl.textContent =
    kind === "none"
      ? `Last reading ${relTime(latest.ts)}`
      : kind === "low"
        ? "Low"
        : kind === "high"
          ? "High"
          : "In range";

  const trend = TREND[latest.trend];
  $("trend").textContent = trend ? `${trend[0]} ${trend[1]}` : "";
  $("when").textContent = `${fmtTime(latest.ts)} (${relTime(latest.ts)})`;
}

function splitSegments(points, gapMs) {
  const segments = [];
  let current = [];
  for (const p of points) {
    if (current.length && p.ts - current[current.length - 1].ts > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) segments.push(current);
  return segments;
}

function renderChart() {
  const host = $("chart");
  const s = state.settings;
  const note = $("chart-note");
  const readout = $("chart-readout");
  const points = pointsInRange();
  const lo = effLow(s, Date.now());
  const hi = effHigh(s, Date.now());
  const light = document.body.dataset.theme === "light";
  const C = {
    line: light ? "#1f2622" : "#f2f5f7",
    grid: light ? "#ded8cb" : "#1e242b",
    dotStroke: light ? "#ffffff" : "#101418",
  };

  host.textContent = "";
  note.textContent = `Target ${fmt(lo, s.unit)}–${fmt(hi, s.unit)} ${unitLabel(s.unit)}`;

  if (points.length < 2) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = points.length ? "Only one reading." : "No readings in this range.";
    host.appendChild(empty);
    host.setAttribute("aria-label", "Glucose chart: no readings in this range");
    readout.textContent = "";
    return;
  }

  const width = Math.max(240, host.clientWidth || 340);
  const height = CHART_H[compact] || 160;
  const pad = { t: 12, r: 14, b: 18, l: 38 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const now = Date.now();
  const from = now - rangeHours * 3600 * 1000;

  // Predicted trajectory (dashed): the x-domain grows into the horizon so
  // the projection is drawn to scale instead of squeezed at the edge.
  const horizon = Number(s.predictMin) || 0;
  const slope = horizon > 0 ? trendSlope() : null;
  const showProj =
    slope != null && (slope <= -0.5 || slope >= 0.5) && now - points[points.length - 1].ts <= 30 * 60 * 1000;
  const endT = showProj ? now + horizon * 60 * 1000 : now;

  // y axis range: covers the target band and the readings together
  const values = points.map((p) => p.mgdl);
  let yMin = Math.min(lo, ...values);
  let yMax = Math.max(hi, ...values);
  const span = Math.max(yMax - yMin, 60);
  yMin = Math.max(20, yMin - span * 0.14);
  yMax = Math.min(700, yMax + span * 0.14);
  const step = span > 220 ? 50 : span > 110 ? 25 : 20;
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;

  const X = (ts) => pad.l + ((ts - from) / (endT - from)) * plotW;
  const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    "aria-hidden": "true",
    focusable: "false",
  });

  // target range band
  const bandTop = Math.max(pad.t, Y(hi));
  const bandBottom = Math.min(pad.t + plotH, Y(lo));
  if (bandBottom > bandTop) {
    svg.appendChild(
      svgEl("rect", {
        x: pad.l,
        y: bandTop,
        width: plotW,
        height: bandBottom - bandTop,
        fill: "rgba(61, 220, 151, 0.09)",
      })
    );
  }

  // threshold lines (dashed) — their numeric values are in the caption
  for (const value of [lo, hi]) {
    if (value < yMin || value > yMax) continue;
    svg.appendChild(
      svgEl("line", {
        x1: pad.l,
        y1: Y(value),
        x2: pad.l + plotW,
        y2: Y(value),
        stroke: "rgba(61, 220, 151, 0.55)",
        "stroke-width": 1,
        "stroke-dasharray": "4 4",
      })
    );
  }

  // grid + y axis labels
  const mid = Math.round((yMin + yMax) / 2 / step) * step;
  for (const value of [yMin, mid, yMax]) {
    const y = Y(value);
    svg.appendChild(
      svgEl("line", {
        x1: pad.l,
        y1: y,
        x2: pad.l + plotW,
        y2: y,
        stroke: C.grid,
        "stroke-width": 1,
      })
    );
    const label = svgEl("text", {
      x: pad.l - 6,
      y: y + 3,
      "text-anchor": "end",
      class: "axis-label",
    });
    label.textContent = fmt(value, s.unit);
    svg.appendChild(label);
  }

  // reading line (split at gaps longer than 20 minutes)
  for (const segment of splitSegments(points, 20 * 60 * 1000)) {
    if (segment.length === 1) {
      svg.appendChild(
        svgEl("circle", {
          cx: X(segment[0].ts),
          cy: Y(segment[0].mgdl),
          r: 2.5,
          fill: C.line,
        })
      );
      continue;
    }
    const d = segment
      .map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)} ${Y(p.mgdl).toFixed(1)}`)
      .join(" ");
    svg.appendChild(
      svgEl("path", {
        d,
        fill: "none",
        stroke: C.line,
        "stroke-width": 1.75,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
  }

  // "now" marker when the domain extends into the prediction horizon
  if (showProj) {
    svg.appendChild(
      svgEl("line", {
        x1: X(now),
        y1: pad.t,
        x2: X(now),
        y2: pad.t + plotH,
        stroke: "rgba(127, 200, 255, 0.4)",
        "stroke-width": 1,
        "stroke-dasharray": "2 3",
      })
    );
  }

  // newest reading
  const last = points[points.length - 1];
  const pointColor =
    last.mgdl <= lo ? "#ff5c5c" : last.mgdl >= hi ? "#ffb020" : "#3ddc97";
  svg.appendChild(
    svgEl("circle", {
      cx: X(last.ts),
      cy: Y(last.mgdl),
      r: 4,
      fill: pointColor,
      stroke: C.dotStroke,
      "stroke-width": 2,
    })
  );

  // dashed projection from the newest reading into the horizon (experimental)
  if (showProj) {
    const vEnd = last.mgdl + slope * horizon;
    const yEnd = Y(Math.max(yMin, Math.min(yMax, vEnd)));
    svg.appendChild(
      svgEl("line", {
        x1: X(last.ts),
        y1: Y(last.mgdl),
        x2: X(endT),
        y2: yEnd,
        stroke: pointColor,
        "stroke-width": 1.5,
        "stroke-dasharray": "4 3",
        opacity: "0.75",
      })
    );
    const tag = svgEl("text", {
      x: Math.min(X(endT) - 4, pad.l + plotW - 4),
      y: Math.max(pad.t + 10, Math.min(pad.t + plotH - 2, yEnd - 5)),
      "text-anchor": "end",
      class: "x-label",
    });
    tag.textContent = `~${fmt(Math.round(vEnd), s.unit)}`;
    svg.appendChild(tag);
  }

  // event markers (vertical ticks with a one-letter tag)
  const EVENT_TAG = { meal: "M", insulin: "I", exercise: "E", other: "•" };
  for (const ev of state.events || []) {
    if (!ev || ev.ts < from || ev.ts > now) continue;
    svg.appendChild(
      svgEl("line", {
        x1: X(ev.ts),
        y1: pad.t,
        x2: X(ev.ts),
        y2: pad.t + plotH,
        stroke: "#ffb020",
        "stroke-width": 1,
        "stroke-dasharray": "2 3",
      })
    );
    const tag = svgEl("text", {
      x: Math.min(X(ev.ts) + 4, pad.l + plotW - 10),
      y: pad.t + 11,
      class: "x-label",
    });
    tag.textContent = EVENT_TAG[ev.kind] || "•";
    svg.appendChild(tag);
  }

  // x axis labels
  for (const [ts, anchor, x] of [
    [from, "start", pad.l],
    [from + (now - from) / 2, "middle", pad.l + plotW / 2],
    [now, "end", X(now)],
  ]) {
    const label = svgEl("text", { x, y: height - 4, "text-anchor": anchor, class: "x-label" });
    label.textContent = fmtX(ts);
    svg.appendChild(label);
  }

  host.appendChild(svg);

  const hover = svgEl("circle", {
    r: 4.5,
    fill: "none",
    stroke: "#7fc8ff",
    "stroke-width": 2,
    visibility: "hidden",
  });
  svg.appendChild(hover);

  const defaultReadout = `${fmtTime(points[0].ts)} – ${fmtTime(last.ts)}`;
  readout.textContent = defaultReadout;

  const min = Math.min(...values);
  const max = Math.max(...values);
  host.setAttribute(
    "aria-label",
    `Glucose chart for the last ${rangeHours} hours. Lowest ${fmt(min, s.unit)}, highest ${fmt(
      max,
      s.unit
    )}, most recent ${fmt(last.mgdl, s.unit)} ${unitLabel(s.unit)}. Target range ${fmt(
      lo,
      s.unit
    )} to ${fmt(hi, s.unit)}.`
  );

  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (width / rect.width);
    const ts = from + ((px - pad.l) / plotW) * (now - from);
    let best = null;
    let bestDistance = Infinity;
    for (const p of points) {
      const distance = Math.abs(p.ts - ts);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = p;
      }
    }
    if (best) {
      readout.textContent = `${fmtTime(best.ts)} · ${fmt(best.mgdl, s.unit)} ${unitLabel(s.unit)}`;
      hover.setAttribute("cx", X(best.ts));
      hover.setAttribute("cy", Y(best.mgdl));
      hover.setAttribute("visibility", "visible");
    }
  });

  svg.addEventListener("pointerleave", () => {
    readout.textContent = defaultReadout;
    hover.setAttribute("visibility", "hidden");
  });
}

function renderStats() {
  const s = state.settings;
  const points = pointsInRange();
  const target = {
    tir: $("stat-tir"),
    avg: $("stat-avg"),
    gmi: $("stat-gmi"),
    min: $("stat-min"),
    max: $("stat-max"),
    cv: $("stat-cv"),
  };

  if (!points.length) {
    const summary = state.data?.summary;
    const hasSummary =
      summary && [summary.avg, summary.min, summary.max].some((v) => v != null);
    if (hasSummary) {
      $("chart-note").textContent = "Last 14 days summary";
      target.tir.textContent = "—";
      target.avg.textContent = summary.avg != null ? fmt(summary.avg, s.unit) : "—";
      target.gmi.textContent = "—";
      target.min.textContent = summary.min != null ? fmt(summary.min, s.unit) : "—";
      target.max.textContent = summary.max != null ? fmt(summary.max, s.unit) : "—";
      target.cv.textContent = "—";
    } else {
      for (const node of Object.values(target)) node.textContent = "—";
    }
    return;
  }

  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  let inRange = 0;
  for (const p of points) {
    sum += p.mgdl;
    sumSq += p.mgdl * p.mgdl;
    if (p.mgdl < min) min = p.mgdl;
    if (p.mgdl > max) max = p.mgdl;
    if (p.mgdl >= s.low && p.mgdl <= s.high) inRange++;
  }

  const mean = sum / points.length;
  const sd = Math.sqrt(Math.max(0, sumSq / points.length - mean * mean));
  target.tir.textContent = `${Math.round((inRange / points.length) * 100)}%`;
  target.avg.textContent = fmt(mean, s.unit);
  // Glucose Management Indicator: 3.31 + 0.02392 × mean (mg/dL).
  target.gmi.textContent = `${(3.31 + 0.02392 * mean).toFixed(1)}%`;
  target.min.textContent = fmt(min, s.unit);
  target.max.textContent = fmt(max, s.unit);
  target.cv.textContent = mean > 0 ? `${Math.round((sd / mean) * 100)}%` : "—";
}

/* --------------------------------------------------------------- reports */

function renderReports() {
  const s = state.settings;
  const series = seriesOfLast(7);
  const split = tirSplit(series, s);

  const below = document.querySelector(".tir-below");
  const inside = document.querySelector(".tir-inside");
  const above = document.querySelector(".tir-above");
  if (below && inside && above) {
    below.style.width = `${split.below.toFixed(1)}%`;
    inside.style.width = `${split.in.toFixed(1)}%`;
    above.style.width = `${split.above.toFixed(1)}%`;
  }
  const legend = $("rep-tir-legend");
  if (legend) {
    legend.textContent = series.length
      ? `${Math.round(split.in)}% in range · ${Math.round(split.below)}% low · ${Math.round(split.above)}% high · ${series.length} readings, last 7 days`
      : "No readings in the last 7 days.";
  }
  renderPattern($("pattern"), s);
  const note = $("rep-note");
  if (note) {
    const stored = (state.data?.series || []).length;
    note.textContent = stored
      ? `${stored} readings stored on this device (up to 15 days).`
      : "Nothing stored yet — press Refresh.";
  }
}

/** Weekly pattern: average glucose per weekday and hour, coloured by range. */
function renderPattern(host, s) {
  if (!host) return;
  host.textContent = "";
  const series = seriesOfLast(15);
  const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
  const W = 296;
  const labelW = 12;
  const topH = 12;
  const cols = 24;
  const rows = 7;
  const cw = (W - labelW) / cols;
  const ch = 11;
  const H = topH + rows * ch + 4;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", focusable: "false" });
  const acc = new Map();
  for (const p of series) {
    const d = new Date(p.ts);
    const key = `${(d.getDay() + 6) % 7}:${d.getHours()}`;
    const cell = acc.get(key) || { sum: 0, n: 0 };
    cell.sum += p.mgdl;
    cell.n++;
    acc.set(key, cell);
  }
  const lo = effLow(s, Date.now());
  const hi = effHigh(s, Date.now());
  for (let r = 0; r < rows; r++) {
    const day = svgEl("text", { x: labelW - 4, y: topH + r * ch + 9, "text-anchor": "end", class: "x-label" });
    day.textContent = DAYS[r];
    svg.appendChild(day);
    for (let c = 0; c < cols; c++) {
      const cell = acc.get(`${r}:${c}`);
      let fill = "rgba(154, 164, 174, 0.14)";
      if (cell) {
        const avg = cell.sum / cell.n;
        if (avg < lo) fill = avg < lo - 30 ? "#ff5c5c" : "rgba(255, 92, 92, 0.55)";
        else if (avg > hi) fill = avg > hi + 60 ? "#ffb020" : "rgba(255, 176, 32, 0.55)";
        else fill = "rgba(61, 220, 151, 0.6)";
      }
      svg.appendChild(
        svgEl("rect", {
          x: labelW + c * cw + 0.5,
          y: topH + r * ch + 1,
          width: Math.max(1, cw - 1),
          height: ch - 2,
          rx: 1.5,
          fill,
        })
      );
    }
  }
  for (const h of [0, 6, 12, 18, 23]) {
    const label = svgEl("text", { x: labelW + h * cw + cw / 2, y: 9, "text-anchor": "middle", class: "x-label" });
    label.textContent = `${h}h`;
    svg.appendChild(label);
  }
  host.appendChild(svg);
  host.setAttribute(
    "aria-label",
    series.length
      ? `Weekly pattern from ${series.length} readings: green cells average in range, red below, amber above.`
      : "Weekly pattern: no readings yet."
  );
}

/* ---------------------------------------------------------- PDF report */

function pdfEsc(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Minimal one-page PDF (hand-written, no libraries): summary + table + note. */
function buildPdf() {
  const s = state.settings;
  const d = state.data;
  const series = [...(d?.series || [])].sort((a, b) => a.ts - b.ts);
  const week = series.filter((p) => p.ts >= Date.now() - 7 * 86400000);
  const split = tirSplit(week.length ? week : series, s);
  const unit = unitLabel(s.unit);
  const name =
    d?.patient?.name || state.user?.firstName || state.user?.email || "Your readings";
  const lines = [];
  const avg = week.length ? week.reduce((a, p) => a + p.mgdl, 0) / week.length : null;
  lines.push(["Sokeri glucose report", 16, true]);
  lines.push([`Generated ${new Date().toLocaleString("en-US")} · ${name}`, 10, false]);
  lines.push([
    `Range: last 7 days · ${week.length} readings · all values in ${unit}`,
    10,
    false,
  ]);
  lines.push(["", 10, false]);
  lines.push([
    `In range ${split.in.toFixed(1)}% · below ${split.below.toFixed(1)}% · above ${split.above.toFixed(1)}%`,
    11,
    true,
  ]);
  if (avg != null) {
    lines.push([`Average ${fmt(avg, s.unit)} ${unit} · GMI ${(3.31 + 0.02392 * avg).toFixed(1)}%`, 10, false]);
    const lo7 = Math.min(...week.map((p) => p.mgdl));
    const hi7 = Math.max(...week.map((p) => p.mgdl));
    lines.push([`Lowest ${fmt(lo7, s.unit)} · highest ${fmt(hi7, s.unit)} ${unit}`, 10, false]);
  }
  lines.push([`Thresholds: low ${fmt(effLow(s, Date.now()), s.unit)}, high ${fmt(effHigh(s, Date.now()), s.unit)} ${unit} (night ${fmt(s.nightLow ?? s.low, s.unit)}–${fmt(s.nightHigh ?? s.high, s.unit)})`, 10, false]);
  lines.push(["", 10, false]);
  lines.push(["Recent events", 11, true]);
  const events = (state.events || []).slice(-10).reverse();
  if (!events.length) lines.push(["None logged.", 10, false]);
  for (const ev of events) {
    lines.push([
      `${new Date(ev.ts).toLocaleString("en-US")} — ${EVENT_LABEL[ev.kind] || "Other"}`,
      10,
      false,
    ]);
  }
  lines.push(["", 10, false]);
  lines.push(["Not a medical device. Confirm decisions on your sensor's own screen.", 9, false]);
  lines.push(["Generated locally by Sokeri; nothing was uploaded.", 9, false]);

  let content = "";
  let y = 800;
  for (const [text, size, bold] of lines) {
    if (!text) {
      y -= size * 0.8;
      continue;
    }
    content += `BT /${bold ? "F2" : "F1"} ${size} Tf 50 ${y.toFixed(1)} Td (${pdfEsc(text.slice(0, 160))}) Tj ET\n`;
    y -= size * 1.5;
  }
  // TIR bar: three segments under the summary line.
  const barY = y + 6;
  const barW = 495;
  content += `0.85 0.87 0.89 rg 50 ${barY.toFixed(1)} ${barW} 12 re f\n`;
  const segs = [
    [split.below / 100, "1 0.36 0.36"],
    [split.in / 100, "0.24 0.86 0.59"],
    [split.above / 100, "1 0.69 0.13"],
  ];
  let bx = 50;
  for (const [frac, color] of segs) {
    const w = Math.max(0, barW * frac);
    if (w > 0.5) content += `${color} rg ${bx.toFixed(1)} ${barY.toFixed(1)} ${w.toFixed(1)} 12 re f\n`;
    bx += w;
  }

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function downloadPdf() {
  const btn = $("btn-pdf");
  if (!(state.data?.series || []).length) {
    btn.textContent = "No data";
    setTimeout(() => {
      btn.textContent = "PDF report";
    }, 2000);
    return;
  }
  const blob = buildPdf();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = REPORT_NAME;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
  btn.textContent = "Saved ✓";
  setTimeout(() => {
    btn.textContent = "PDF report";
  }, 2000);
}

/* ---------------------------------------------------------- settings form */

function syncSettingsForm() {
  const s = state.settings;
  const unit = s.unit;

  document
    .querySelectorAll("[data-unit]")
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === unit)));

  const low = $("set-low");
  const high = $("set-high");
  const decimals = unit === "mmoll";
  low.min = decimals ? "2" : "40";
  low.max = decimals ? "7" : "120";
  low.step = decimals ? "0.1" : "1";
  high.min = decimals ? "6" : "120";
  high.max = decimals ? "25" : "400";
  high.step = decimals ? "0.1" : "1";

  if (document.activeElement !== low) low.value = fmt(s.low, unit);
  if (document.activeElement !== high) high.value = fmt(s.high, unit);

  const nlow = $("set-night-low");
  const nhigh = $("set-night-high");
  if (document.activeElement !== nlow) nlow.value = fmt(s.nightLow ?? s.low, unit);
  if (document.activeElement !== nhigh) nhigh.value = fmt(s.nightHigh ?? s.high, unit);
  $("set-night-start").value = String(s.nightStart ?? 23);
  $("set-night-end").value = String(s.nightEnd ?? 7);
  $("set-predict").value = String(s.predictMin || 0);

  $("set-alerts").checked = Boolean(s.alerts);
  $("set-sound").checked = Boolean(s.sound);
  $("set-repeat").value = String(s.repeatMin ?? 10);
  $("set-signal").checked = s.signalLoss !== false;
  $("set-interval").value = String(s.intervalMin);
  $("set-remember").checked = s.remember !== false;
}

/* ------------------------------------------------------------- start-up */

async function boot() {
  bindEvents();
  try {
    const stored = await chrome.storage.local.get("events");
    if (Array.isArray(stored.events)) state.events = stored.events;
  } catch {
    /* events unavailable */
  }
  try {
    const initial = await send({ type: "state" });
    if (initial) state = { ...state, ...initial };
  } catch {
    /* the background is not ready yet */
  }
  syncSettingsForm();
  render();
  if (state.authed) {
    startAuto();
    doRefresh();
  } else {
    $("email").focus();
  }
}

boot();

// Web fonts shift metrics after load; re-fit once they arrive.
if (document.fonts?.ready) {
  document.fonts.ready
    .then(() => {
      if (state.authed) render();
    })
    .catch(() => {});
}
