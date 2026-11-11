/**
 * Sokeri — service worker (MV3).
 *
 * Responsibilities: sign-in, periodic data fetching, the toolbar badge,
 * threshold alerts and messaging with the popup.
 */
import {
  ApiError,
  LibreClient,
  login,
  sha256Hex,
  fetchConnections,
  fetchGraph,
  fetchLogbook,
  fetchGlucoseHistory,
  fetchPortalReadings,
  seriesFromGraph,
  seriesFromLogbook,
  normalizeTargets,
  MMOL,
} from "./libreview.js";

const ALARM = "libre-refresh";
const DATA_KEY = "glucoseData";
const SERIES_CAP_MS = 15 * 24 * 3600 * 1000; // the stored series is capped at 15 days (7-day chart + weekly pattern + reports)

const DEFAULT_SETTINGS = {
  unit: "mgdl", // "mgdl" | "mmoll"
  low: 70, // mg/dL
  high: 180, // mg/dL
  alerts: true,
  sound: true,
  intervalMin: 1,
  remember: true,
  theme: "dark",
  predictMin: 0, // 0 = off, otherwise minutes ahead for trend prediction
  nightLow: 70, // mg/dL during night hours
  nightHigh: 180, // mg/dL during night hours
  nightStart: 23,
  nightEnd: 7,
  personId: null, // selected followed person; null = first connection
  repeatMin: 10, // re-alert while still out of range; 0 = once per episode
  signalLoss: true, // alert when no new reading arrives for a while
};

/** Night is a wrap-around window, e.g. 23 -> 7. start === end disables it. */
function isNightHour(hour, settings) {
  const start = Number(settings.nightStart ?? 23);
  const end = Number(settings.nightEnd ?? 7);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function effLow(settings, ts) {
  const hour = new Date(ts ?? Date.now()).getHours();
  return isNightHour(hour, settings) ? Number(settings.nightLow ?? settings.low) : settings.low;
}

function effHigh(settings, ts) {
  const hour = new Date(ts ?? Date.now()).getHours();
  return isNightHour(hour, settings) ? Number(settings.nightHigh ?? settings.high) : settings.high;
}

const TREND_TEXT = {
  1: "falling fast",
  2: "falling",
  3: "steady",
  4: "rising",
  5: "rising fast",
};

const SOURCE_LABEL = {
  llu: "LibreLinkUp · real time",
  self: "LibreLinkUp · your own reading",
  portal: "LibreView portal · report flow",
};

/* -------------------------------------------------------------- storage */

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function getData() {
  const { [DATA_KEY]: data } = await chrome.storage.local.get(DATA_KEY);
  return data || null;
}

async function getSession() {
  try {
    const s = await chrome.storage.session.get("session");
    if (s.session) return s.session;
  } catch {
    /* fall back to local storage if session storage is unavailable */
  }
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}

async function setSession(session) {
  const settings = await getSettings();
  if (settings.remember) {
    await chrome.storage.local.set({ session });
    try {
      await chrome.storage.session.remove("session");
    } catch {
      /* ignore */
    }
  } else {
    await chrome.storage.session.set({ session });
    await chrome.storage.local.remove("session");
  }
}

async function clearSession() {
  await chrome.storage.local.remove("session");
  try {
    await chrome.storage.session.remove("session");
  } catch {
    /* ignore */
  }
}

function fire(promise) {
  Promise.resolve(promise).catch(() => {});
}

/* ------------------------------------------------------------- sign in */

async function doLogin({ email, password, region, remember }) {
  if (!email || !password) throw new ApiError("Email and password are required.");
  if (typeof remember === "boolean") await saveSettings({ remember });

  const errors = [];
  let portal = null;
  let llu = null;
  let user = null;

  try {
    const r = await login({ kind: "portal", email, password, region });
    portal = { host: r.host, token: r.token, expires: r.expires };
    user = r.user || user;
  } catch (err) {
    errors.push(`LibreView portal: ${err.message}`);
  }

  try {
    const r = await login({ kind: "llu", email, password, region });
    llu = { host: r.host, token: r.token, expires: r.expires };
    user = user || r.user;
  } catch (err) {
    errors.push(`LibreLinkUp: ${err.message}`);
  }

  if (!portal && !llu) {
    throw new ApiError(errors.join("  •  ") || "Sign-in failed.", { detail: errors.join("\n") });
  }

  const userId = user?.id != null ? String(user.id) : null;
  const accountId = userId ? await sha256Hex(userId) : null;

  await setSession({
    user,
    userId,
    accountId,
    region: region || null,
    portal,
    llu,
    createdAt: Date.now(),
  });

  await saveData(null); // clear previous data
  return { warnings: errors, hasPortal: Boolean(portal), hasLlu: Boolean(llu) };
}

async function logout() {
  await clearSession();
  await saveData(null);
  await clearBadge();
  await chrome.alarms.clear(ALARM);
}

/* -------------------------------------------------------------- clients */

function clientsOf(session) {
  const out = [];
  const notExpired = (entry) => !entry?.expires || entry.expires > Date.now();
  if (session?.llu?.token && notExpired(session.llu)) {
    out.push({
      kind: "llu",
      client: new LibreClient({
        host: session.llu.host,
        token: session.llu.token,
        accountId: session.accountId,
      }),
    });
  }
  if (session?.portal?.token && notExpired(session.portal)) {
    out.push({
      kind: "portal",
      client: new LibreClient({
        host: session.portal.host,
        token: session.portal.token,
        accountId: session.accountId,
      }),
    });
  }
  return out;
}

function sessionExpired(session) {
  const entries = [session?.llu, session?.portal].filter(Boolean);
  if (!entries.length) return true;
  return entries.every((e) => e.expires && e.expires <= Date.now());
}

/* ----------------------------------------------------------------- data */

async function saveData(data) {
  if (data) await chrome.storage.local.set({ [DATA_KEY]: data });
  else await chrome.storage.local.remove(DATA_KEY);
  return data;
}

function trimSeries(series) {
  const cutoff = Date.now() - SERIES_CAP_MS;
  return series.filter((p) => p.ts >= cutoff);
}

function mergeSeries(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const p of list || []) {
      if (p && Number.isFinite(p.ts) && Number.isFinite(p.mgdl)) map.set(p.ts, p);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/** The LibreView daily report may return mmol/L; the uom or value magnitude decides. */
function reportToMgDl(raw, uom) {
  if (!raw.length) return [];
  const max = Math.max(...raw.map((r) => r.value));
  const asMmol = String(uom) !== "1" && max <= 40;
  return raw.map((r) => ({
    ts: r.ts,
    mgdl: asMmol ? Math.round(r.value * MMOL) : Math.round(r.value),
  }));
}

function graphConnection(graph) {
  return graph?.connection && typeof graph.connection === "object" ? graph.connection : null;
}

function sensorInfo(graph) {
  const sensor = graphConnection(graph)?.sensor ?? graph?.sensor ?? null;
  if (!sensor) return null;
  return {
    sn: sensor.sn ?? sensor.SN ?? null,
    daysLeft: sensor.sensorState?.daysLeft ?? sensor.daysLeft ?? null,
  };
}

async function fromConnection({ kind, client }, conn) {
  const graph = await fetchGraph(client, conn.patientId);
  const { series, latest } = seriesFromGraph(graph);
  if (!latest && !series.length) return null;

  let logbookSeries = [];
  const logbook = await fetchLogbook(client, conn.patientId);
  if (logbook) logbookSeries = seriesFromLogbook(logbook);

  const connection = graphConnection(graph);
  const targets = normalizeTargets(
    connection?.targetLow ?? graph?.targetLow ?? conn?.targetLow,
    connection?.targetHigh ?? graph?.targetHigh ?? conn?.targetHigh
  );

  return {
    source: kind === "portal" ? "self" : "llu",
    latest,
    series: trimSeries(mergeSeries(logbookSeries, series)),
    targets,
    patient: conn?.patientId
      ? {
          name: [conn.patientFirstName, conn.patientLastName].filter(Boolean).join(" "),
          id: conn.patientId,
        }
      : null,
    sensor: sensorInfo(graph),
  };
}

async function buildData(session, settings) {
  const notes = [];
  const errors = [];
  const entries = clientsOf(session);

  if (!entries.length) {
    return {
      error: sessionExpired(session)
        ? "Your session has expired. Sign in again."
        : "There is no active session.",
    };
  }

  // 1) A LibreLinkUp connection: real-time graph.
  for (const entry of entries) {
    try {
      const conns = await fetchConnections(entry.client);
      const withId = conns.filter((c) => c?.patientId);
      if (!withId.length) continue;
      const people = withId.map((c) => ({
        id: c.patientId,
        name:
          [c.patientFirstName, c.patientLastName].filter(Boolean).join(" ") ||
          String(c.patientId),
      }));
      const wanted = settings?.personId || null;
      const conn = withId.find((c) => String(c.patientId) === String(wanted)) || withId[0];
      const built = await fromConnection(entry, conn);
      if (built) {
        built.sourceLabel = SOURCE_LABEL[built.source];
        built.people = people;
        built.person = conn.patientId;
        return { ...built, notes, errors };
      }
    } catch (err) {
      errors.push(`${SOURCE_LABEL[entry.kind] || entry.kind}: ${err.message}`);
    }
  }

  // 2) Without a connection, try the graph with our own user id
  //    (this path is open if you follow yourself in LibreLinkUp).
  if (session.userId) {
    for (const entry of entries) {
      try {
        const graph = await fetchGraph(entry.client, session.userId);
        const { series, latest } = seriesFromGraph(graph);
        if (latest || series.length) {
          const logbook = await fetchLogbook(entry.client, session.userId);
          const connection = graphConnection(graph);
          const targets = normalizeTargets(
            connection?.targetLow ?? graph?.targetLow,
            connection?.targetHigh ?? graph?.targetHigh
          );
          return {
            source: "self",
            sourceLabel: SOURCE_LABEL.self,
            latest,
            series: trimSeries(mergeSeries(seriesFromLogbook(logbook), series)),
            targets,
            patient: session.user?.firstName
              ? {
                  name: [session.user.firstName, session.user.lastName].filter(Boolean).join(" "),
                  id: session.userId,
                }
              : null,
            sensor: sensorInfo(graph),
            notes,
            errors,
          };
        }
      } catch (err) {
        errors.push(`Your own reading: ${err.message}`);
      }
    }
  }

  // 3) LibreView portal report flow (your own data through the portal).
  const portal = entries.find((e) => e.kind === "portal");
  if (portal) {
    try {
      const raw = await fetchPortalReadings(portal.client, {
        userId: session.userId,
        sinceMs: Date.now() - SERIES_CAP_MS,
      });
      let uom = null;
      try {
        const account = await portal.client.getAccount();
        uom = account?.uom;
      } catch {
        /* if uom is unavailable, the value magnitude tells us */
      }
      const series = reportToMgDl(raw, uom);
      if (series.length) {
        const latest = series[series.length - 1];
        return {
          source: "portal",
          sourceLabel: SOURCE_LABEL.portal,
          latest: { ts: latest.ts, mgdl: latest.mgdl, trend: 0, color: 0, isHigh: false, isLow: false },
          series,
          targets: { low: null, high: null },
          patient: session.user?.firstName
            ? {
                name: [session.user.firstName, session.user.lastName].filter(Boolean).join(" "),
                id: session.userId,
              }
            : null,
          sensor: null,
          notes: ["The portal flow shows the readings your phone has uploaded to LibreView; it can be delayed compared with the sensor-to-phone transfer."],
          errors,
        };
      }
      notes.push("The LibreView report came back empty.");
    } catch (err) {
      errors.push(`LibreView portal: ${err.message}`);
    }
  }

  // 4) With no series at all, try the summary history at least.
  for (const entry of entries) {
    try {
      const history = await fetchGlucoseHistory(entry.client);
      const period = Array.isArray(history) ? history[0] : history;
      const num = (obj, keys) => {
        for (const key of keys) {
          if (obj?.[key] != null && Number.isFinite(Number(obj[key]))) return Math.round(Number(obj[key]));
        }
        return null;
      };
      const avg = num(period, ["average", "Average", "meanValue"]);
      const min = num(period, ["minValue", "MinValue", "minimum"]);
      const max = num(period, ["maxValue", "MaxValue", "maximum"]);
      if (avg != null || min != null || max != null) {
        return {
          source: null,
          sourceLabel: "LibreView · summary history",
          latest: null,
          series: [],
          targets: null,
          patient: null,
          sensor: null,
          summary: { avg, min, max },
          notes: [
            "No real-time reading was available. For real-time data you need to follow yourself in the LibreLinkUp app.",
          ],
          errors,
        };
      }
    } catch (err) {
      errors.push(`Summary history: ${err.message}`);
    }
  }

  return {
    error: "No glucose data could be retrieved.",
    notes,
    errors,
  };
}

/* ---------------------------------------------------------- refresh flow */

let inflight = null;

async function doRefresh() {
  const session = await getSession();
  if (!session) {
    await saveData(null);
    await clearBadge();
    return { ok: false, reason: "logged-out" };
  }

  const settings = await getSettings();
  let result;
  try {
    result = await buildData(session, settings);
  } catch (err) {
    result = { error: err?.message || String(err), errors: [String(err?.message || err)] };
  }

  if (result.error && !result.series) {
    const previous = await getData();
    const data = {
      ...(previous || {}),
      error: result.error,
      notes: result.notes || [],
      errors: result.errors || [],
      stale: Boolean(previous?.series?.length),
      fetchedAt: Date.now(),
      sourceLabel: previous?.sourceLabel || null,
    };
    await saveData(data);
    await updateBadge(data, settings);
    return { ok: false, error: result.error, data };
  }

  const data = {
    source: result.source || null,
    sourceLabel: result.sourceLabel || null,
    latest: result.latest || null,
    series: result.series || [],
    targets: result.targets || null,
    patient: result.patient || null,
    people: result.people || [],
    person: result.person || null,
    sensor: result.sensor || null,
    summary: result.summary || null,
    notes: result.notes || [],
    errors: result.errors || [],
    stale: false,
    fetchedAt: Date.now(),
  };

  await saveData(data);
  await updateBadge(data, settings);
  await maybeAlert(data, settings);
  return { ok: true, data };
}

function refresh(opts) {
  if (inflight) return inflight;
  inflight = doRefresh()
    .catch((err) => ({ ok: false, error: err?.message || String(err) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/* ---------------------------------------------------------------- badge */

function fmtValue(mgdl, unit) {
  return unit === "mmoll" ? (mgdl / MMOL).toFixed(1) : String(Math.round(mgdl));
}

function unitLabel(unit) {
  return unit === "mmoll" ? "mmol/L" : "mg/dL";
}

function rangeState(mgdl, settings, ts) {
  if (mgdl <= effLow(settings, ts)) return "low";
  if (mgdl >= effHigh(settings, ts)) return "high";
  return "ok";
}

const BADGE_COLOR = {
  ok: "#1B7F4F",
  low: "#B3261E",
  high: "#8A5300",
  stale: "#5A6169",
  none: "#5A6169",
};

async function clearBadge() {
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Sokeri — not signed in" });
  } catch {
    /* ignore */
  }
}

async function updateBadge(data, settings) {
  try {
    const latest = data?.latest;
    const age = latest ? Date.now() - latest.ts : Infinity;
    const stale = age > 30 * 60 * 1000;

    if (!latest) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR.none });
      await chrome.action.setBadgeText({ text: data?.error ? "!" : "" });
      await chrome.action.setTitle({
        title: data?.error
          ? `Sokeri — ${data.error}`
          : "Sokeri — no data",
      });
      return;
    }

    const state = stale || data?.error ? "stale" : rangeState(latest.mgdl, settings, latest.ts);
    const text = state === "stale" ? "…" : fmtValue(latest.mgdl, settings.unit);
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR[state] });
    await chrome.action.setBadgeText({ text: text.slice(0, 5) });

    const when = new Date(latest.ts).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const trend = latest.trend ? ` • ${TREND_TEXT[latest.trend] || "trend"}` : "";
    const stateText =
      state === "stale"
        ? `last reading ${when}${data?.error ? ` (${data.error})` : ""}`
        : `${fmtValue(latest.mgdl, settings.unit)} ${unitLabel(settings.unit)} • ${when}${trend}`;
    await chrome.action.setTitle({ title: `Sokeri — ${stateText}` });
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- alerts */

const STALE_ALERT_MS = 20 * 60 * 1000; // no new reading for this long -> signal-loss alert
const NOTIF_ALERT = "sokeri-alert";
const NOTIF_PRED = "sokeri-pred";
const NOTIF_TEST = "sokeri-test";

async function getAlertState() {
  try {
    const { alertState } = await chrome.storage.session.get("alertState");
    return alertState && typeof alertState === "object" ? alertState : {};
  } catch {
    return {};
  }
}

async function getSnooze() {
  try {
    const { alertSnooze } = await chrome.storage.session.get("alertSnooze");
    return alertSnooze && typeof alertSnooze === "object" ? alertSnooze : null;
  } catch {
    return null;
  }
}

/** Notification buttons offer a snooze; the snooze silences value alerts until it ends. */
chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== NOTIF_ALERT && id !== NOTIF_PRED) return;
  const mins = index === 1 ? 60 : 15;
  fire(
    (async () => {
      await chrome.storage.session.set({ alertSnooze: { until: Date.now() + mins * 60000 } });
      try {
        await chrome.notifications.clear(id);
      } catch {
        /* already gone */
      }
    })()
  );
});

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIF_ALERT && id !== NOTIF_PRED && id !== NOTIF_TEST) return;
  try {
    chrome.notifications.clear(id).catch(() => {});
  } catch {
    /* ignore */
  }
});

async function notifyValue(id, title, message, soundKind) {
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2,
      buttons: [{ title: "Snooze 15 min" }, { title: "Snooze 1 h" }],
    });
  } catch {
    /* notifications unavailable */
  }
  if (soundKind) await beep(soundKind);
}

/** Signal-loss watch: warns when readings stop arriving (dead sensor, phone
 *  offline). Runs even when there is no fresh value to judge. */
async function maybeStaleAlert(data, settings, alertState) {
  const latest = data?.latest;
  if (!latest) return alertState;
  const age = Date.now() - latest.ts;
  if (!settings.signalLoss) {
    if (alertState.stale) {
      alertState = { ...alertState };
      delete alertState.stale;
      await chrome.storage.session.set({ alertState });
    }
    return alertState;
  }
  if (age <= STALE_ALERT_MS) {
    if (alertState.stale) {
      alertState = { ...alertState };
      delete alertState.stale;
      await chrome.storage.session.set({ alertState });
    }
    return alertState;
  }
  if (Date.now() - (alertState.stale || 0) < 60 * 60 * 1000) return alertState;
  alertState = { ...alertState, stale: Date.now() };
  await chrome.storage.session.set({ alertState });
  const value = `${fmtValue(latest.mgdl, settings.unit)} ${unitLabel(settings.unit)}`;
  try {
    await chrome.notifications.create("sokeri-stale", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "No new readings",
      message: `Last reading ${value} · ${relAge(age)} ago. Check the sensor and the phone app.`,
      priority: 2,
    });
  } catch {
    /* ignore */
  }
  await beep("stale");
  return alertState;
}

function relAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

async function maybeAlert(data, settings) {
  const latest = data?.latest;
  let alertState = await getAlertState();
  alertState = await maybeStaleAlert(data, settings, alertState);

  if (!settings.alerts) return;
  if (!latest) return;
  if (Date.now() - latest.ts > 30 * 60 * 1000) return;

  const snooze = await getSnooze();
  if (snooze && Date.now() < Number(snooze.until || 0)) return;

  const state = rangeState(latest.mgdl, settings, latest.ts);

  // Trend prediction (experimental, optional): linear fit over the last few
  // readings; if the line crosses an effective threshold within the horizon,
  // warn once per hour. The message says it is a prediction, not advice.
  const horizon = Number(settings.predictMin) || 0;
  if (horizon > 0 && Date.now() - latest.ts <= 30 * 60 * 1000) {
    const pts = (data?.series || []).filter((p) => latest.ts - p.ts <= 45 * 60 * 1000).slice(-6);
    if (pts.length >= 3) {
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
      const n = pts.length;
      const denom = n * sxx - sx * sx;
      if (denom !== 0) {
        const slope = (n * sxy - sx * sy) / denom; // mg/dL per minute
        const lo = effLow(settings, Date.now());
        const hi = effHigh(settings, Date.now());
        let kind = null;
        let mins = Infinity;
        if (slope < -0.5 && latest.mgdl > lo) {
          mins = (latest.mgdl - lo) / -slope;
          if (mins <= horizon) kind = "low";
        } else if (slope > 0.5 && latest.mgdl < hi) {
          mins = (hi - latest.mgdl) / slope;
          if (mins <= horizon) kind = "high";
        }
        if (kind && Number.isFinite(mins) && Date.now() - (alertState.pred || 0) > 60 * 60 * 1000) {
          alertState = { ...alertState, pred: Date.now() };
          await chrome.storage.session.set({ alertState });
          const value = `${fmtValue(latest.mgdl, settings.unit)} ${unitLabel(settings.unit)}`;
          await notifyValue(
            NOTIF_PRED,
            kind === "low" ? "Predicted low" : "Predicted high",
            `${value} • ${slope < 0 ? "falling" : "rising"} ~${Math.abs(slope).toFixed(1)}/min, may cross ${fmtValue(kind === "low" ? lo : hi, settings.unit)} in ~${Math.max(1, Math.round(mins))} min (experimental)`,
            settings.sound ? "pred" : null
          );
        }
      }
    }
  }

  if (state === "ok") {
    await chrome.storage.session.set({
      alertState: alertState.pred ? { pred: alertState.pred } : {},
    });
    return;
  }

  // Repeat: re-alert while still out of range. repeatMin 0 means once per
  // episode (the flag is cleared when the value returns in range above).
  // At night a low always escalates to at least every 5 minutes.
  const repeatMin = Number(settings.repeatMin ?? 10);
  let cooldownMs = repeatMin > 0 ? Math.max(1, repeatMin) * 60 * 1000 : Infinity;
  const night = isNightHour(new Date().getHours(), settings);
  const urgent = night && state === "low";
  if (urgent) cooldownMs = Math.min(cooldownMs, 5 * 60 * 1000);
  const last = alertState[state] || 0;
  if (Date.now() - last < cooldownMs) return;

  await chrome.storage.session.set({ alertState: { ...alertState, [state]: Date.now() } });

  const isLow = state === "low";
  const value = `${fmtValue(latest.mgdl, settings.unit)} ${unitLabel(settings.unit)}`;
  const trend = latest.trend ? `, ${TREND_TEXT[latest.trend]}` : "";
  const when = new Date(latest.ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  await notifyValue(
    NOTIF_ALERT,
    isLow ? "Low glucose" : "High glucose",
    `${value}${trend} • ${when}${urgent ? " • night" : ""}`,
    settings.sound ? (urgent ? "low-urgent" : isLow ? "low" : "high") : null
  );
}

/* Direct-audio fallback for browsers without offscreen documents (Firefox).
   Service workers cannot play audio, so on Chrome this throws silently and
   the offscreen path above is the one that sounds. */
const BEEP_PATTERNS = {
  low: [[932, 0, 0.16, 0.22], [622, 0.2, 0.28, 0.22]],
  "low-urgent": [[932, 0, 0.16, 0.26], [622, 0.2, 0.28, 0.26], [932, 0.55, 0.16, 0.26], [622, 0.75, 0.32, 0.26]],
  stale: [[440, 0, 0.3, 0.12]],
  pred: [[784, 0, 0.14, 0.16], [988, 0.18, 0.2, 0.16]],
  high: [[659, 0, 0.14, 0.2], [880, 0.18, 0.14, 0.2], [1175, 0.36, 0.3, 0.2]],
};

function playDirect(kind) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume();
  for (const [freq, delay, dur, gain] of BEEP_PATTERNS[kind] || BEEP_PATTERNS.high) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }
}

async function beep(kind) {
  if (!chrome.offscreen) {
    try {
      playDirect(kind);
    } catch {
      /* no audio in this context */
    }
    return;
  }
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["AUDIO_PLAYING"],
        justification: "Play the glucose threshold alert sound",
      });
      await new Promise((r) => setTimeout(r, 200));
    }
    chrome.runtime.sendMessage({ type: "beep", kind }).catch(() => {});
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------- CSV import */

/** Tolerant reader parser: our own export plus generic timestamp/value files.
 *  Returns [{ts, mgdl}] in mg/dL. Unit follows the header or the magnitude. */
function parseImportCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delim = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].toLowerCase().split(delim).map((c) => c.trim());
  const tsIdx = head.findIndex((c) => /time|date|timestamp|iso/.test(c));
  const valIdx = head.findIndex((c) => /glucose|value|mg|mmol|bg|sgv/.test(c));
  if (tsIdx < 0 || valIdx < 0) return [];
  const headerMmol = /mmol/.test(head[valIdx]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delim);
    if (cells.length <= Math.max(tsIdx, valIdx)) continue;
    const rawTs = cells[tsIdx].trim().replace(/^["']|["']$/g, "");
    let ts = Date.parse(rawTs);
    if (Number.isNaN(ts) && /^\d+$/.test(rawTs)) {
      const num = Number(rawTs);
      ts = rawTs.length > 11 ? num : num * 1000; // seconds vs milliseconds
    }
    const rawVal = Number(
      String(cells[valIdx]).trim().replace(/^["']|["']$/g, "").replace(",", ".")
    );
    if (!Number.isFinite(ts) || !Number.isFinite(rawVal) || rawVal <= 0) continue;
    rows.push({ ts, rawVal });
  }
  // Unit follows the header; without a hint the whole file's magnitude decides,
  // so one extreme low in mg/dL is never mistaken for mmol/L.
  const asMmol = headerMmol || (rows.length > 0 && Math.max(...rows.map((r) => r.rawVal)) <= 40);
  const out = [];
  for (const { ts, rawVal } of rows) {
    const mgdl = asMmol ? Math.round(rawVal * MMOL) : Math.round(rawVal);
    if (mgdl < 20 || mgdl > 700) continue;
    out.push({ ts, mgdl });
  }
  return out;
}

async function importCsv(text) {
  const pts = parseImportCsv(text);
  if (!pts.length) return { ok: false, error: "empty" };
  const prev = (await getData()) || {};
  await saveData({
    ...prev,
    series: trimSeries(mergeSeries(prev.series, pts)),
    fetchedAt: Date.now(),
  });
  return { ok: true, count: pts.length };
}

/* ------------------------------------------------------------- scheduler */

async function syncAlarm(settings) {
  const period = Math.max(1, Number(settings.intervalMin) || 1);
  try {
    // It matters that the timer is not reset every time the service worker
    // wakes: it is only recreated when missing or when the interval changed.
    const existing = await chrome.alarms.get(ALARM);
    if (existing && Math.abs((existing.periodInMinutes || 0) - period) < 0.01) return;
    await chrome.alarms.clear(ALARM);
    await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: period });
  } catch {
    /* ignore */
  }
}

async function init() {
  try {
    // So the popup can read the session.
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
  } catch {
    /* ignore */
  }

  const settings = await getSettings();
  await syncAlarm(settings);

  const data = await getData();
  const intervalMs = Math.max(1, settings.intervalMin) * 60 * 1000;
  const stale = !data || Date.now() - (data.fetchedAt || 0) > intervalMs + 60 * 1000;
  const session = await getSession();
  if (session && stale) refresh();
  else if (!session) await clearBadge();
  else if (data) await updateBadge(data, settings);
}

/* -------------------------------------------------------- message bridge */

async function statePayload() {
  const [settings, session, data] = await Promise.all([getSettings(), getSession(), getData()]);
  return {
    ok: true,
    authed: Boolean(session),
    user: session?.user || null,
    region: session?.region || null,
    hasPortal: Boolean(session?.portal),
    hasLlu: Boolean(session?.llu),
    settings,
    data,
  };
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case "login": {
      try {
        const result = await doLogin(msg);
        await syncAlarm(await getSettings());
        await refresh();
        return { ok: true, ...result, ...(await statePayload()) };
      } catch (err) {
        return { ok: false, error: err?.message || String(err), detail: err?.detail || null };
      }
    }
    case "logout":
      await logout();
      return { ok: true };

    case "state":
      return statePayload();

    case "refresh": {
      const r = await refresh();
      return { ...(await statePayload()), refreshOk: r.ok, error: r.error || null };
    }

    case "importCsv":
      return importCsv(msg?.text);

    case "saveSettings": {
      const settings = await saveSettings(msg.patch || {});
      await syncAlarm(settings);
      const data = await getData();
      if (data) await updateBadge(data, settings);
      refresh(); // a threshold or interval change refreshes the badge and data in the background
      return { ok: true, settings, data };
    }

    case "testAlert":
      await beep("high");
      try {
        await chrome.notifications.create(NOTIF_TEST, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Test notification",
          message: "Alerts are working.",
        });
      } catch {
        /* ignore */
      }
      return { ok: true };

    case "openTab":
      if (msg.url) await chrome.tabs.create({ url: msg.url });
      return { ok: true };

    default:
      return { ok: false, error: "Unknown request." };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // asynchronous response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refresh();
});

chrome.runtime.onInstalled.addListener(() => fire(init()));
chrome.runtime.onStartup.addListener(() => fire(init()));
fire(init());
