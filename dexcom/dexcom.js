/**
 * Unofficial Dexcom Share API client.
 *
 * The endpoints in this file are not published or endorsed by Dexcom. Flow
 * verified by the community (pydexcom, Dexcom-Share clients):
 *   1. POST {base}/General/AuthenticatePublisherAccount {accountName, password,
 *      applicationId} -> accountId (a UUID string)
 *   2. POST {base}/General/LoginPublisherAccountById {accountId, password,
 *      applicationId} -> sessionId (a UUID string)
 *   3. POST {base}/Publisher/ReadPublisherLatestGlucoseValues {sessionId,
 *      minutes, maxCount} -> array of {WT, ST, DT, Value, Trend}
 * A legacy single-step login (LoginPublisherAccountByName -> sessionId) is
 * kept as a fallback for servers that do not accept the two-step flow.
 *
 * Regions:
 *   us  -> https://share2.dexcom.com  (accounts registered in the US)
 *   ous -> https://shareous1.dexcom.com (accounts registered outside the US)
 *   jp  -> https://share.dexcom.jp (Japan)
 *
 * This module contains only the network layer and response parsing; it does
 * not deal with the UI or persistence (storage).
 */

export const APPLICATION_IDS = {
  us: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  ous: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  jp: "d8665ade-9673-4e27-9ff6-92db4ce13d13",
};

export const BASE_URLS = {
  us: "https://share2.dexcom.com/ShareWebServices/Services",
  ous: "https://shareous1.dexcom.com/ShareWebServices/Services",
  jp: "https://share.dexcom.jp/ShareWebServices/Services",
};

/** Region keys shown in the sign-in form. Unknown values fall back to "ous". */
export const REGIONS = ["us", "ous", "jp"];

export function baseFor(region) {
  const r = String(region || "").trim().toLowerCase();
  return BASE_URLS[r] || BASE_URLS.ous;
}

export function appIdFor(region) {
  const r = String(region || "").trim().toLowerCase();
  return APPLICATION_IDS[r] || APPLICATION_IDS.ous;
}

const REQUEST_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function request(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
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
    try {
      const parsed = JSON.parse(text);
      serverMessage = parsed?.Message || parsed?.message || null;
    } catch {
      /* the body is not JSON */
    }
    if (res.status === 401 || res.status === 403 || /password|account|auth/i.test(serverMessage || "")) {
      throw new ApiError(
        "Dexcom rejected the email or password. Double check them and the selected region (US / outside US / Japan).",
        { status: res.status, detail: (serverMessage || text).slice(0, 300) }
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
  const cleaned = text.trim().replace(/^"|"$/g, "");
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(cleaned)) return cleaned; // plain UUID string
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("The server response could not be read.", { detail: text.slice(0, 200) });
  }
}

/**
 * Signs in with a Dexcom Share account (the same email and password used in
 * the Dexcom G6/G7 phone app). Returns { base, accountId, sessionId }.
 */
export async function login({ email, password, region }) {
  const accountName = String(email || "").trim();
  if (!accountName || !password) throw new ApiError("Email and password are required.");
  const base = baseFor(region);
  const applicationId = appIdFor(region);

  // Step 1: account name + password -> accountId.
  let accountId = null;
  try {
    accountId = await request(`${base}/General/AuthenticatePublisherAccount`, {
      accountName,
      password: String(password),
      applicationId,
    });
  } catch (err) {
    // Older servers answer the legacy single-step login instead.
    if (err?.status === 404 || /not found/i.test(err?.message || "")) {
      const sessionId = await request(`${base}/General/LoginPublisherAccountByName`, {
        accountName,
        password: String(password),
        applicationId,
      });
      return { base, accountId: null, sessionId };
    }
    throw err;
  }
  if (typeof accountId !== "string" || !accountId) {
    throw new ApiError("Dexcom did not return an account id for this sign-in.");
  }

  // Step 2: accountId + password -> sessionId.
  const sessionId = await request(`${base}/General/LoginPublisherAccountById`, {
    accountId,
    password: String(password),
    applicationId,
  });
  if (typeof sessionId !== "string" || !sessionId) {
    throw new ApiError("Dexcom did not return a session for this sign-in.");
  }
  return { base, accountId, sessionId };
}

/* ------------------------------------------------------------- client */

export class DexcomClient {
  constructor({ base, sessionId }) {
    this.base = String(base || BASE_URLS.ous).replace(/\/+$/, "");
    this.sessionId = sessionId;
  }

  /**
   * Latest shared glucose values, most recent last after sorting.
   * minutes: 1..1440 look-back window; maxCount: 1..288 values.
   */
  async getLatest({ minutes = 1440, maxCount = 288 } = {}) {
    const body = await request(`${this.base}/Publisher/ReadPublisherLatestGlucoseValues`, {
      sessionId: this.sessionId,
      minutes: Math.min(Math.max(Number(minutes) || 1440, 1), 1440),
      maxCount: Math.min(Math.max(Number(maxCount) || 288, 1), 288),
    });
    if (!Array.isArray(body)) {
      throw new ApiError("Dexcom returned an unexpected readings response.", {
        detail: JSON.stringify(body || {}).slice(0, 200),
      });
    }
    return body;
  }
}

/* --------------------------------------------------- measurement shaping */

/**
 * Dexcom stamps look like "/Date(1426780716000-0700)/". The leading number is
 * milliseconds since the epoch (UTC); the suffix is only a display offset.
 */
export function parseStamp(value) {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const m = /\/Date\((\d+)(?:[+-]\d{4})?\)\//.exec(String(value));
  if (m) return Number(m[1]);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

const TREND_TO_ARROW = {
  // Newer Share responses use words; older ones use numbers 0..9.
  DoubleUp: 5,
  1: 5,
  SingleUp: 4,
  2: 4,
  FortyFiveUp: 4,
  3: 4,
  Flat: 3,
  4: 3,
  None: 0,
  0: 0,
  FortyFiveDown: 2,
  5: 2,
  SingleDown: 2,
  6: 2,
  DoubleDown: 1,
  7: 1,
  NotComputable: 0,
  8: 0,
  RateOutOfRange: 0,
  9: 0,
};

/** Maps a Dexcom Trend value to the 1..5 arrow scale (0 = unknown). */
export function trendToArrow(trend) {
  if (trend == null) return 0;
  const key = typeof trend === "string" ? trend : Number(trend);
  return TREND_TO_ARROW[key] ?? 0;
}

/**
 * Turns a ReadPublisherLatestGlucoseValues response into a flat series.
 * Dexcom values are already mg/dL.
 * @returns {{series: Array<{ts:number,mgdl:number}>, latest: object|null}}
 */
export function seriesFromDexcom(entries) {
  if (!Array.isArray(entries)) return { series: [], latest: null };
  const byTs = new Map();
  for (const e of entries) {
    const ts = parseStamp(e?.ST ?? e?.DT ?? e?.WT);
    const mgdl = Number(e?.Value);
    if (!ts || !Number.isFinite(mgdl) || mgdl <= 0) continue;
    byTs.set(ts, { ts, mgdl: Math.round(mgdl), trend: trendToArrow(e?.Trend) });
  }
  const series = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  const newest = series[series.length - 1];
  const latest = newest
    ? {
        ts: newest.ts,
        mgdl: newest.mgdl,
        trend: newest.trend || 0,
        color: 0,
        isHigh: false,
        isLow: false,
        sensor: null,
      }
    : null;
  return { series: series.map(({ ts, mgdl }) => ({ ts, mgdl })), latest };
}
