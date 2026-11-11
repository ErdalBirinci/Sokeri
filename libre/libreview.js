/**
 * Unofficial LibreView / LibreLinkUp API client.
 *
 * The endpoints in this file are not published or endorsed by Abbott. Sources
 * verified by the community:
 *   - FokkeZB/libreview-unofficial      (documentation + OpenAPI draft)
 *   - skobkars/lvconnect                (libreview.com portal sign-in, daily report flow)
 *   - zaengerlein/libreviewmcp          (product/version/Account-Id headers)
 *   - InventivetalentDev/LibreViewApi   (authTicket, glucoseHistory)
 *   - PyLibreLinkUp / nightscout-librelink-up  (llu/connections graph, TrendArrow)
 *   - nightscout/nightscout-connect            (Account-Id + version 4.16.0,
 *     October 2025 Abbott API changes)
 *
 * This module contains only the network layer and response parsing; it does
 * not deal with the UI or persistence (storage).
 */

export const PRODUCT = "llu.android";
// LibreLinkUp version header. Since October 2025 the server requires at least
// 4.16.0 (otherwise 403 + status 920 / minimumVersion); 4.17.0 is the current one.
export const VERSION = "4.17.0";
export const DEFAULT_HOST = "https://api.libreview.io";

/** Steps that can be accepted automatically during portal sign-in. */
const AUTO_ACCEPT_STEPS = new Set(["tou", "pp", "policy", "consents"]);

/** Known region subdomains; if none matches, the automatic redirect is followed. */
export const REGIONS = ["ae", "ap", "au", "ca", "de", "eu", "eu2", "fr", "jp", "uk", "us"];

const REQUEST_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, { status = 0, step = null, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.step = step;
    this.detail = detail;
  }
}

export function hostFor(region) {
  const r = String(region || "").trim().toLowerCase();
  return r ? `https://api-${r}.libreview.io` : DEFAULT_HOST;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------ network */

async function request(url, opts = {}) {
  const {
    method = "GET",
    body,
    token,
    accountId,
    accept = "application/json",
    authHeader = true,
    portal = false,
    extraHeaders = {},
  } = opts;

  const headers = { accept, ...extraHeaders };
  // Portal endpoints (the libreview.com web app) do not accept the
  // product/version headers; sending them returns "ProductMismatch". They are
  // added only for LibreLinkUp (llu.*) endpoints.
  if (!portal) {
    headers.product = PRODUCT;
    headers.version = VERSION;
  }
  if (token && authHeader) headers.authorization = `Bearer ${token}`;
  if (accountId) headers["account-id"] = accountId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Every request must come fresh from the server for the live value; HTTP cache off.
      cache: "no-store",
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new ApiError(
      err?.name === "AbortError"
        ? "The server timed out."
        : "Could not reach the server. Check your internet connection.",
      { detail: String(err?.message || err) }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let serverMessage = null;
    let minimumVersion = null;
    try {
      const parsed = JSON.parse(text);
      serverMessage = parsed?.error?.message || parsed?.message || null;
      minimumVersion = parsed?.data?.minimumVersion || parsed?.minimumVersion || null;
    } catch {
      /* the body is not JSON */
    }
    if (res.status === 403 && minimumVersion) {
      throw new ApiError(
        `The LibreLinkUp API was updated (at least ${minimumVersion} required). Update the extension version.`,
        { status: res.status, detail: text.slice(0, 300) }
      );
    }
    if (/ProductMismatch/i.test(serverMessage || "") || /ProductMismatch/i.test(text)) {
      throw new ApiError(
        "The server rejected the product header. This endpoint belongs to the portal (libreview.com); the request headers were updated, please try again.",
        { status: res.status, detail: text.slice(0, 300) }
      );
    }
    if (res.status === 403) {
      throw new ApiError(
        "The server rejected the request (403). Your account may require extra verification; try signing in at libreview.com in the browser.",
        { status: res.status, detail: text.slice(0, 300) }
      );
    }
    throw new ApiError(serverMessage || `The server responded with ${res.status}.`, {
      status: res.status,
      detail: text.slice(0, 300),
    });
  }
  if (/^\s*</.test(text)) {
    throw new ApiError("The server returned an HTML response; the request may have been blocked.", {
      detail: text.slice(0, 200),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("The server response could not be read.", { detail: text.slice(0, 200) });
  }
}

/** Plain-text request for endpoints that do not return JSON (report HTML). */
async function requestText(url, opts = {}) {
  const { token, accept = "text/html", authHeader = true, method = "GET", portal = false } = opts;
  const headers = { accept };
  if (!portal) {
    headers.product = PRODUCT;
    headers.version = VERSION;
  }
  if (token && authHeader) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, cache: "no-store", signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(`The report could not be downloaded (HTTP ${res.status}).`, { status: res.status });
    }
    return text;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      err?.name === "AbortError" ? "The report download timed out." : "The report could not be downloaded.",
      { detail: String(err?.message || err) }
    );
  } finally {
    clearTimeout(timer);
  }
}

function tokenFrom(body) {
  return (
    body?.data?.authTicket?.token ||
    body?.ticket?.token ||
    body?.data?.user?.token ||
    null
  );
}

function stepErrorMessage(step, props) {
  const title = props?.titleKey || props?.textKey || "";
  switch (step) {
    case "captcha":
      return "LibreView asked for a robot check (captcha) during sign-in. Complete that step by signing in at libreview.com in the browser, then try again.";
    case "otp":
    case "mfa":
    case "twoFactor":
    case "totp":
      return "Your account asked for two-factor authentication. First sign in at libreview.com in the browser to register this device as trusted, then try again.";
    default:
      return `Sign-in stopped at the "${step}" step${title ? ` (${title})` : ""}. Complete that step by signing in at libreview.com in the browser and try again.`;
  }
}

/**
 * Signs in with an email address and password.
 * The regional redirect (data.redirect) and the terms-of-use steps that can be
 * accepted automatically (status 4) are resolved here.
 *
 * @param {"portal"|"llu"} kind portal → /auth/login, llu → /llu/auth/login
 */
export async function login({ kind = "portal", email, password, region, trustedDeviceToken }) {
  const path = kind === "llu" ? "/llu/auth/login" : "/auth/login";
  const payload = { email: String(email || "").trim(), password: String(password || "") };
  if (kind === "portal" && trustedDeviceToken) payload.trustedDeviceToken = trustedDeviceToken;

  let host = hostFor(region);
  // Portal sign-in (/auth/login) uses the same headers as the LibreView web
  // app itself; llu sign-in requires product/version.
  const opts = kind === "portal" ? { portal: true } : {};
  let body = await request(`${host}${path}`, { method: "POST", body: payload, ...opts });

  // Regional redirect: api.libreview.io → api-eu.libreview.io and so on.
  for (let i = 0; i < 4 && body?.data?.redirect && body?.data?.region; i++) {
    const next = hostFor(body.data.region);
    if (next === host) break;
    host = next;
    body = await request(`${host}${path}`, { method: "POST", body: payload, ...opts });
  }

  // Terms of use / privacy policy steps.
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const step = body?.status === 4 ? body?.data?.step?.type : null;
    if (!step) break;
    if (seen.has(step)) {
      throw new ApiError(`Sign-in kept stopping at the "${step}" step.`, { status: 4, step });
    }
    seen.add(step);
    if (!AUTO_ACCEPT_STEPS.has(step)) {
      throw new ApiError(stepErrorMessage(step, body?.data?.step?.props), { status: 4, step });
    }
    const token = tokenFrom(body);
    body = await request(`${host}/auth/continue/${encodeURIComponent(step)}`, {
      method: "POST",
      token,
      ...opts,
    });
  }

  if (body?.error) {
    throw new ApiError(body.error.message || "Sign-in failed.", { status: body?.status ?? 0 });
  }

  const token = tokenFrom(body);
  if (!token) {
    const step = body?.data?.step?.type;
    if (step) throw new ApiError(stepErrorMessage(step, body?.data?.step?.props), { status: 4, step });
    throw new ApiError("The server did not return an authentication token for this sign-in.", {
      status: body?.status ?? 0,
      detail: JSON.stringify(body || {}).slice(0, 300),
    });
  }

  const expiresRaw = body?.data?.authTicket?.expires ?? body?.ticket?.expires ?? null;
  const expires = expiresRaw == null ? null : expiresRaw > 1e12 ? expiresRaw : expiresRaw * 1000;

  return {
    host,
    token,
    expires,
    status: body?.status ?? 0,
    user: body?.data?.user || body?.user || null,
  };
}

/* ------------------------------------------------------------- client */

/** A path that is already an absolute URL is used as is, otherwise it is joined to the client root. */
function resolveUrl(base, path) {
  const s = String(path || "");
  if (/^https?:/i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  return `${base}${s.startsWith("/") ? "" : "/"}${s}`;
}

/** Response shapes vary between versions; the first known key with a value wins. */
function pick(obj, keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

export class LibreClient {
  constructor({ host, token, accountId = null }) {
    this.host = String(host || DEFAULT_HOST).replace(/\/+$/, "");
    this.token = token;
    this.accountId = accountId;
  }

  get(path, accept, opts = {}) {
    return request(resolveUrl(this.host, path), {
      token: this.token,
      accountId: this.accountId,
      accept,
      ...opts,
    });
  }

  post(path, body, opts = {}) {
    return request(resolveUrl(this.host, path), {
      method: "POST",
      body,
      token: this.token,
      accountId: this.accountId,
      ...opts,
    });
  }

  async getAccount() {
    const body = await this.get("/account");
    return body?.data?.user || null;
  }
}

function unwrap(body, label) {
  if (body?.error) throw new ApiError(body.error.message || `Could not retrieve ${label}.`, { status: body?.status });
  return body?.data ?? null;
}

/* ------------------------------------------------------- data endpoints */

export async function fetchConnections(client) {
  const data = unwrap(await client.get("/llu/connections"), "Connection list");
  return Array.isArray(data) ? data : [];
}

export async function fetchGraph(client, patientId) {
  const data = unwrap(
    await client.get(`/llu/connections/${encodeURIComponent(patientId)}/graph`),
    "Glucose graph"
  );
  return data && typeof data === "object" ? data : null;
}

export async function fetchLogbook(client, patientId) {
  try {
    const data = unwrap(
      await client.get(`/llu/connections/${encodeURIComponent(patientId)}/logbook`),
      "Daily logbook"
    );
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // not every account has a logbook; it is not critical
  }
}

export async function fetchGlucoseHistory(client) {
  const data = unwrap(
    await client.get("/glucoseHistory?numPeriods=5&period=14", undefined, { portal: true }),
    "Summary history"
  );
  return data;
}

/**
 * The measurement flow of the libreview.com portal itself.
 * Instead of a real-time endpoint, LibreView's "Daily Log" report has to be
 * generated and downloaded (the lvconnect flow). The result contains the
 * readings the phone has uploaded to LibreView.
 */
export async function fetchPortalReadings(client, { userId, sinceMs }) {
  const settings = await client.get("/reportSettings", undefined, { portal: true });
  const dataSources =
    pick(settings?.data, ["dataSources", "sources"]) ?? pick(settings, ["dataSources", "sources"]);
  const ids =
    dataSources && typeof dataSources === "object" ? Object.keys(dataSources) : [];
  if (!ids.length) {
    throw new ApiError(
      "No reportable device (data source) was found in the LibreView account. First upload your sensor data to LibreView from the LibreLink app."
    );
  }

  let primaryId = ids[0];
  let primaryMin = Infinity;
  const rank = (src) => {
    const days = Array.isArray(src?.daysData) && src.daysData.length ? Math.min(...src.daysData) : 9999;
    return days;
  };
  for (const id of ids) {
    const d = rank(dataSources[id]);
    if (d < primaryMin) {
      primaryMin = d;
      primaryId = id;
    }
  }

  const primary = dataSources[primaryId] || {};
  const secondary = ids.filter((id) => id !== primaryId);
  const sinceSec = Math.floor(sinceMs / 1000);
  const endSec = Math.floor(Date.now() / 1000);

  const report = await client.post(
    "/reports",
    {
      PrimaryDeviceId: primaryId,
      PrimaryDeviceTypeId: primary.type,
      SecondaryDeviceIds: secondary,
      PrintReportsWithPatientInformation: false,
      ReportIds: [500000 + Number(primary.type || 0)],
      ClientReportIDs: [5],
      StartDates: [sinceSec],
      EndDate: endSec,
      PatientId: userId,
      CultureCode: "en-US",
    },
    { portal: true }
  );

  const reportUrl = absolute(
    pick(report?.data, ["url", "reportUrl"]) ?? pick(report, ["url", "reportUrl"]),
    client.host
  );
  if (!reportUrl) throw new ApiError("The LibreView report could not be generated.");

  // 1) report channel
  const channels = await client.get(reportUrl, undefined, { portal: true });
  const channelUrl = absolute(
    pick(channels?.data, ["lp", "channel", "url"]) ?? pick(channels, ["lp", "channel"]),
    client.host
  );
  if (!channelUrl) throw new ApiError("The LibreView report channel was not found.");

  // 2) wait for the channel status
  let docUrl = null;
  for (let i = 0; i < 25 && !docUrl; i++) {
    const step = await client.get(channelUrl, undefined, { portal: true });
    const op = pick(step, ["operation", "op"]) ?? pick(step?.data, ["operation", "op"]);
    const args = pick(step, ["args"]) ?? pick(step?.data, ["args"]);
    if (op === "update" && Array.isArray(args?.urls)) {
      docUrl = absolute(
        args.urls[5] || args.urls.find((u) => /^https?:/i.test(String(u))) || null,
        client.host
      );
      break;
    }
    if (op && op !== "started") {
      throw new ApiError(`Unexpected LibreView report stage: ${op}`);
    }
    await sleep(1200);
  }
  if (!docUrl) throw new ApiError("The LibreView report could not be prepared (timed out).");

  // 3) download the report
  const html = await requestText(`${docUrl}?session=${encodeURIComponent(client.token)}`, {
    portal: true,
  });

  return parseReportHtml(html);
}

/** A /reports response may be relative. */
function absolute(url, base) {
  if (!url) return null;
  const s = String(url);
  if (/^https?:/i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `${base}${s}`;
  return `${base}/${s}`;
}

/** Extracts the window.report object from the report HTML and turns it into a reading list. */
export function parseReportHtml(html) {
  const match =
    /window\.report\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i.exec(html) ||
    /window\.report\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:<\/body|$)/i.exec(html) ||
    /window\.report\s*=\s*(\{.*\})/i.exec(html);
  if (!match) throw new ApiError("The LibreView report could not be parsed (window.report not found).");

  let report;
  try {
    report = JSON.parse(match[1]);
  } catch {
    throw new ApiError("The LibreView report could not be read as JSON.");
  }

  const data = pick(report, ["Data", "data"]) || report;
  const days = pick(data, ["Days", "days"]);
  if (!Array.isArray(days)) throw new ApiError("No measurement day was found in the LibreView report.");

  const offsetMs = new Date().getTimezoneOffset() * 60 * 1000;
  const out = [];
  for (const day of days) {
    const flat = flatten(pick(day, ["Glucose", "glucose", "GlucoseData", "glucoseData"]));
    for (const g of flat) {
      const value = pick(g, ["Value", "value"]);
      const stamp = pick(g, ["Timestamp", "timestamp", "Time", "time"]);
      if (value == null || stamp == null) continue;
      const raw = Number(stamp);
      if (!Number.isFinite(raw)) continue;
      // LibreView stores local wall-clock time as UTC; shift it back.
      const ts = (raw > 1e12 ? raw : raw * 1000) + offsetMs;
      if (!Number.isFinite(ts)) continue;
      out.push({ ts, value: Number(value) });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function flatten(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    const out = [];
    for (const item of input) out.push(...flatten(item));
    return out;
  }
  return [input];
}

/* --------------------------------------------------- measurement shaping */

/** Converts a local wall-clock string such as "6/20/2023 4:44:13 AM" to epoch ms. */
export function parseStamp(value) {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;

  const s = String(value).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (m) {
    const [, mo, da, yr, h, mi, se, ap] = m;
    let hour = Number(h);
    if (ap) {
      const pm = ap.toLowerCase() === "pm";
      if (hour === 12) hour = 0;
      if (pm) hour += 12;
    }
    return new Date(Number(yr), Number(mo) - 1, Number(da), hour, Number(mi), Number(se || 0)).getTime();
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Converts a measurement object to a value in mg/dL. */
export function toMgDl(measurement) {
  if (!measurement) return null;
  if (measurement.ValueInMgPerDl != null && Number.isFinite(Number(measurement.ValueInMgPerDl))) {
    return Number(measurement.ValueInMgPerDl);
  }
  const v = Number(measurement.Value);
  if (!Number.isFinite(v)) return null;
  // GlucoseUnits: 0 = mmol/L, 1 = mg/dL
  return measurement.GlucoseUnits === 1 ? v : Math.round(v * 18.018);
}

/**
 * Turns a LibreLinkUp graph response into a flat series.
 * @returns {{series: Array<{ts:number,mgdl:number}>, latest: object|null}}
 */
export function seriesFromGraph(graph) {
  if (!graph) return { series: [], latest: null };

  // Real API response: { connection: { glucoseMeasurement, ... }, graphData: [...] }.
  // The older flat shape is supported too: { glucoseMeasurement, graphData }.
  const conn =
    graph.connection && typeof graph.connection === "object" ? graph.connection : null;
  const points = [];
  const raw = Array.isArray(graph.graphData)
    ? graph.graphData
    : conn && Array.isArray(conn.graphData)
      ? conn.graphData
      : [];
  for (const entry of raw) {
    const ts = parseStamp(entry?.Timestamp ?? entry?.FactoryTimestamp);
    const mgdl = toMgDl(entry);
    if (ts && mgdl != null) points.push({ ts, mgdl });
  }

  const m = graph.glucoseMeasurement ?? conn?.glucoseMeasurement ?? null;
  let latest = null;
  if (m) {
    const ts = parseStamp(m.Timestamp ?? m.FactoryTimestamp);
    const mgdl = toMgDl(m);
    if (ts && mgdl != null) {
      latest = {
        ts,
        mgdl,
        trend: Number(m.TrendArrow) || 0,
        color: Number(m.MeasurementColor) || 0,
        isHigh: Boolean(m.IsHigh ?? m.isHigh),
        isLow: Boolean(m.IsLow ?? m.isLow),
        sensor: m.SensorID || m.sensorId || null,
      };
      points.push({ ts, mgdl });
    }
  }

  const byTs = new Map();
  for (const p of points) byTs.set(p.ts, p);
  const series = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);

  // glucoseMeasurement is normally the newest reading; still, if the series has
  // a newer point use it as the live value (the trend arrow stays 0 if unknown).
  const newest = series[series.length - 1];
  if (newest && (!latest || newest.ts > latest.ts)) {
    latest = { ...(latest || {}), ts: newest.ts, mgdl: newest.mgdl, trend: latest?.trend || 0 };
  }

  return { series, latest };
}

/** Converts the daily report logbook into the same series shape. */
export function seriesFromLogbook(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    const ts = parseStamp(e?.Timestamp ?? e?.FactoryTimestamp);
    const mgdl = toMgDl(e);
    if (ts && mgdl != null) out.push({ ts, mgdl });
  }
  return out;
}

/**
 * Converts the LibreView target range to mg/dL and checks that it is plausible.
 * The API may hand back either mg/dL (70/180) or mmol/L (3.9/10.0); sample
 * responses have also contained meaningless numbers (0.81/1.53).
 */
export function normalizeTargets(low, high) {
  let l = Number(low);
  let h = Number(high);
  if (!Number.isFinite(l) || !Number.isFinite(h) || l <= 0 || h <= 0) return null;
  if (h <= 40 && l < 40) {
    l = Math.round(l * MMOL);
    h = Math.round(h * MMOL);
  }
  if (l < 30 || h > 600 || h <= l) return null;
  return { low: Math.round(l), high: Math.round(h) };
}

/** mmol/L ↔ mg/dL conversions. */
export const MMOL = 18.018;
export function toDisplay(mgdl, unit) {
  return unit === "mmoll" ? mgdl / MMOL : mgdl;
}
export function fromDisplay(value, unit) {
  return unit === "mmoll" ? value * MMOL : value;
}
