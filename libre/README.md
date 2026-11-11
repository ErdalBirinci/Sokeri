# Sokeri

Two Chrome extensions (Manifest V3) that track your glucose readings inside
the browser.

| Edition | Folder | Account | Sensors |
| --- | --- | --- | --- |
| Sokeri for FreeStyle Libre | `sokeri/` (this folder) | LibreView | FreeStyle Libre |
| Sokeri for Dexcom | `dexcom/` | Dexcom Share | Dexcom G6 / G7 |

Both share the same panel: live value, trend arrow, chart, time-in-range
stats and threshold alerts. See `dexcom/README.md` for the Dexcom edition.

## Libre edition

Signs in with your LibreView account and tracks your **FreeStyle Libre**
glucose readings inside the browser.

- Live value on the toolbar badge (colour: in range / high / low)
- Trend arrow in the popup, 3/6/12/24 hour and 7-day charts with a target range band
- Time in range (TIR), average, GMI estimate, variability (%CV), lowest and highest values
- High / low threshold alerts (desktop notification + optional sound), with
  snooze buttons, configurable repeat, night escalation for lows, a signal-loss
  watch, separate night thresholds and optional trend prediction (experimental,
  drawn as a dashed line on the chart)
- Followed-person selector when your account follows more than one person
- Event markers (meal / insulin / exercise) drawn on the chart
- Reports view: 7-day time-in-range bar, weekly daily-pattern heatmap, CSV
  export, a one-page PDF report for doctor visits and a full-tab clinic mode
  (all generated locally, nothing uploaded)
- mg/dL ↔ mmol/L conversion, light / dark themes, refresh interval settings

> **Important:** this is not a medical device, is not intended for diagnosis or
> treatment and is not affiliated with Abbott. It is a convenience display for
> adults (18+). You use it entirely at your own responsibility; always confirm
> critical decisions on your sensor's own screen or on your readings.

---

## Installation

1. Keep this folder (`libre/`) somewhere permanent on your
   computer.
2. Open `chrome://extensions` in Chrome.
3. Turn on the **Developer mode** toggle in the top right.
4. Click **Load unpacked** and select this folder.
5. Click the icon that appears in the toolbar and sign in.

When an update arrives, replace the files and press **Reload** on the
`chrome://extensions` page.

---

## Sign-in and real-time data

The extension tries to open **two separate sessions** with your email and
password:

| Session | Endpoint | What it is for |
| --- | --- | --- |
| LibreView portal | `POST /auth/login` | Your libreview.com account; your own reading history and the report flow |
| LibreLinkUp | `POST /llu/auth/login` | Real-time readings and the trend graph |

Both are the same Abbott account, so a single successful sign-in is enough.

### Follow yourself to get real-time data

The LibreLinkUp API only provides real-time data to accounts with a **follower**
relationship. To see your own readings you have to follow yourself — a one-time
setup:

1. Install the **LibreLinkUp** app on your phone and open it with your account.
2. Use **Add participant** to invite **your own email address**.
3. Accept that invitation from the **LibreLink** app.
4. Press **Refresh** in the extension.

If you skip this step the extension automatically moves on to a second path: the
LibreView portal's "Daily Log" report is generated and downloaded (the
`/reports` flow). That path shows the readings your phone has **uploaded** to
LibreView, so it can lag behind the sensor-to-phone transfer.

If none of that works, at least the **last 14 day summary** (average / lowest /
highest) is shown, and the extension writes what failed and why into the detail
list.

---

## Settings

In the **Settings** view of the popup (opens in place of the dashboard so the
panel never needs scrolling):

- **Unit** — mg/dL or mmol/L (applied instantly everywhere)
- **Low / high threshold** — drives the alerts and the badge colour; entered in
  your selected unit and stored in mg/dL
- **High / low alerts** — desktop notification when a threshold is crossed,
  with Snooze 15 min / 1 h buttons right on the notification
- **Alert sound** — a two or three tone sound with the notification
- **Repeat** — re-alert while still out of range: once per episode or every
  5 / 10 / 15 / 30 minutes; at night a low always repeats every 5 minutes
- **Signal loss** — warns when no new reading arrives for 20 minutes
- **Refresh interval** — 1, 2 or 5 minutes
- **Remember session** — when off, the session is deleted when the browser closes
- **Night thresholds** — separate low/high values plus the night-hours window
  (e.g. 23–7); outside that window the day thresholds apply
- **Trend prediction** — experimental: warns when the recent trend line would
  cross a threshold within 15/30 minutes; off by default, not medical advice
- **Followed person** — appears when your account follows more than one
  person; switches whose readings are shown
- **Log event** — pins a meal / insulin / exercise / other marker at the
  current time on the chart; deletable from the list below
- **Test notification** — fires a test notification and sound
- **Reports** — replaces the dashboard with the reports view (time-in-range
  bar, pattern heatmap, CSV export, PDF report, clinic mode)
- **Delete all local data** — erases readings, events, settings and session
  from this browser (two clicks, no undo)

Settings are stored only in this browser's extension storage
(`chrome.storage.local`).

---

## How it works

The data flow lives in `background.js` (the service worker) and is tried in this
order:

1. **`GET /llu/connections`** → if a connection exists,
   **`GET /llu/connections/{id}/graph`** (+ `.../logbook`)
   → real-time reading, trend arrow, roughly 14 hours of series, 14 days of logbook
2. Without a connection, **`GET /llu/connections/{our own id}/graph`**
   → open directly if you follow yourself
3. **LibreView portal report** — `GET /reportSettings` → `POST /reports` →
   wait for the channel status → download the report HTML and parse the
   `window.report` object
4. **`GET /glucoseHistory?numPeriods=5&period=14`** → summary only

The timer is scheduled with `chrome.alarms`; it is not restarted every time the
service worker wakes, so the countdown does not reset. Every refresh updates the
badge and checks the thresholds (repeat interval from settings; snoozable from
the notification; signal-loss watch on reading age).

### Headers used

```
Authorization: Bearer <authTicket.token>
product: llu.android
version: 4.17.0
Account-Id: <sha256(user id)>
```

> **Note:** the `product`/`version` headers are sent only to LibreLinkUp
> (`/llu/*`) endpoints. LibreView portal endpoints (`/auth/login`,
> `/reportSettings`, `/reports`, `/glucoseHistory`) reject those headers
> (`ProductMismatch`), so they are not sent there. Abbott added a minimum
> version requirement to the API in October 2025 (403 + `minimumVersion:
> 4.16.0`), which is why the version is `4.17.0`.

Regional redirection (`data.redirect` / `data.region`) is followed automatically;
`api.libreview.io` → `api-eu.libreview.io` and so on. Terms of use and privacy
policy steps (`status: 4`) are accepted automatically.

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Sign-in failed" | Check the email and password; leave **Region** on automatic |
| Captcha / robot check | Sign in once at libreview.com in the browser, then try again |
| Two-factor authentication | Sign in at libreview.com the same way to make this a trusted device |
| "No connection found" | Follow the **follow yourself** steps above |
| The value never updates | Hover the badge; the tooltip shows the time of the last reading and the error |
| An old value is shown | After 30 minutes the badge turns grey and shows `…` |

Detailed error texts appear in the popup's **No data?** list.

---

## Privacy

- Your email and password are stored only in this browser's extension storage and
  are sent directly to Abbott's servers (`*.libreview.io`).
- **No data is sent to any third party, analytics service or server.**
- Erasure: the **Delete all local data** button in settings removes everything
  (readings, events, settings, session) from the device. No account, no
  backup, nothing to request — there is simply nothing stored elsewhere.
- The extension loads no external source code (no CDN, no remote scripts); all
  code is local.
- `host_permissions` covers only `https://*.libreview.io/*`.
- The authentication token is valid for about 6 months; with **Remember
  session** off it is deleted when the browser closes.

---

## Files

```
libre/
├── manifest.json            MV3 manifest
├── background.js            service worker: sign-in, refresh, badge, alerts
├── libreview.js             LibreView / LibreLinkUp API client
├── popup/
│   ├── popup.html           sign-in, dashboard, settings and reports screens
│   ├── popup.css            styles
│   └── popup.js             chart, statistics, settings, reports, PDF builder
├── clinic/                  full-tab clinic-mode display (clinic.html/js)
├── offscreen/               audio context for the threshold alerts
├── icons/                   16/32/48/128 px icons
└── tools/generate-icons.js  regenerates the icons: node tools/generate-icons.js
```

---

## Sources

This extension relies on unofficial API knowledge verified by the community:

- [FokkeZB/libreview-unofficial](https://github.com/FokkeZB/libreview-unofficial) — endpoint documentation and OpenAPI draft
- [skobkars/lvconnect](https://github.com/skobkars/lvconnect) — portal sign-in and daily report flow
- [zaengerlein/libreviewmcp](https://github.com/zaengerlein/libreviewmcp) — headers and Account-Id
- [InventivetalentDev/LibreViewApi](https://github.com/InventivetalentDev/LibreViewApi) — authTicket, glucoseHistory
- [PyLibreLinkUp](https://github.com/gipert/PyLibreLinkUp) / [nightscout-librelink-up](https://github.com/timoschlueter/nightscout-librelink-up) — connection graph and TrendArrow

The Abbott APIs are unofficial; a version change can break the extension.
