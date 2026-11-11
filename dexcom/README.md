# Sokeri for Dexcom

A Chrome extension (Manifest V3) that signs in with your Dexcom account and
tracks your **Dexcom G6 / G7** glucose readings inside the browser.

- Live value on the toolbar badge (colour: in range / high / low)
- Trend arrow in the popup, 3/6/12/24 hour and 7-day charts with a target range band
- Time in range (TIR), average, GMI estimate, variability (%CV), lowest and highest values
- High / low threshold alerts (desktop notification + optional sound), with
  snooze buttons, configurable repeat, night escalation for lows, a signal-loss
  watch, separate night thresholds and optional trend prediction (experimental,
  drawn as a dashed line on the chart)
- Multiple Dexcom accounts with an in-settings switcher
- Event markers (meal / insulin / exercise) drawn on the chart
- Reports view: 7-day time-in-range bar, weekly daily-pattern heatmap, CSV
  export, a one-page PDF report for doctor visits and a full-tab clinic mode
  (all generated locally, nothing uploaded)
- mg/dL ↔ mmol/L conversion, light / dark themes, refresh interval settings

> **Important:** this is not a medical device, is not intended for diagnosis or
> treatment and is not affiliated with Dexcom. It is a convenience display for
> adults (18+). You use it entirely at your own responsibility; always confirm
> critical decisions on your sensor's own screen or on your readings.

---

## Installation

1. Keep this folder (`dexcom/`) somewhere permanent on your
   computer.
2. Open `chrome://extensions` in Chrome.
3. Turn on the **Developer mode** toggle in the top right.
4. Click **Load unpacked** and select this folder.
5. Click the icon that appears in the toolbar and sign in.

When an update arrives, replace the files and press **Reload** on the
`chrome://extensions` page.

---

## Sign-in and real-time data

The extension signs in with your Dexcom Share account — the same email and
password you use in the Dexcom app on your phone:

| Step | Endpoint | What it is for |
| --- | --- | --- |
| Authenticate | `POST /General/AuthenticatePublisherAccount` | Email + password → account id |
| Login | `POST /General/LoginPublisherAccountById` | Account id + password → session id |
| Readings | `POST /Publisher/ReadPublisherLatestGlucoseValues` | Up to 288 values over the last 24 hours |

Pick the **account region** that matches where your Dexcom account was
registered: United States, outside the US (incl. Europe) or Japan — each uses a
different server (`share2.dexcom.com`, `shareous1.dexcom.com`,
`share.dexcom.jp`).

No invitation or follower setup is needed: your own account's shared values
are read directly. If no data arrives, open the Dexcom app on your phone and
make sure it is signed in with the same account, has an internet connection
and an active sensor. Dexcom Share sessions last about 24 hours; afterwards
the extension asks you to sign in again.

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
- **Account** — switch between the signed-in Dexcom accounts; **Add** signs
  in another one without leaving settings
- **Refresh interval** — 1, 2 or 5 minutes
- **Remember session** — when off, the session is deleted when the browser closes
- **Night thresholds** — separate low/high values plus the night-hours window
  (e.g. 23–7); outside that window the day thresholds apply
- **Trend prediction** — experimental: warns when the recent trend line would
  cross a threshold within 15/30 minutes; off by default, not medical advice
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

The data flow lives in `background.js` (the service worker):

1. **`POST ReadPublisherLatestGlucoseValues`** (`minutes: 1440`, `maxCount: 288`)
   → up to 24 hours of readings in 5-minute steps
2. The newest value becomes the live reading; its `Trend` field
   (`DoubleUp` … `Flat` … `DoubleDown`) becomes the trend arrow3. The timer is scheduled with `chrome.alarms`; it is not restarted every time
   the service worker wakes, so the countdown does not reset. Every refresh
   updates the badge and checks the thresholds (repeat interval from settings;
   snoozable from the notification; signal-loss watch on reading age).

Detailed error texts appear in the popup's **No data?** list.

---

## Privacy

- Your email and password are stored only in this browser's extension storage and
  are sent directly to Dexcom's servers (`share2.dexcom.com`,
  `shareous1.dexcom.com`, `share.dexcom.jp`).
- **No data is sent to any third party, analytics service or server.**
- Erasure: the **Delete all local data** button in settings removes everything
  (readings, events, settings, session) from the device. No account, no
  backup, nothing to request — there is simply nothing stored elsewhere.
- The extension loads no external source code (no CDN, no remote scripts); all
  code is local.
- `host_permissions` covers only the three Dexcom Share hosts above.

---

## Files

```
dexcom/
├── manifest.json            MV3 manifest
├── background.js            service worker: sign-in, refresh, badge, alerts
├── dexcom.js                Dexcom Share API client
├── popup/
│   ├── popup.html           sign-in, dashboard, settings and reports screens
│   ├── popup.css            styles
│   └── popup.js             chart, statistics, settings, reports, PDF builder
├── clinic/                  full-tab clinic-mode display (clinic.html/js)
├── offscreen/               audio context for the threshold alerts
└── icons/                   16/32/48/128 px icons
```

---

## Sources

This extension relies on unofficial API knowledge verified by the community:

- [pydexcom](https://github.com/gagebenne/pydexcom) — Share API flow, regions and application ids
- [dexcom (Dart)](https://github.com/Calebh101/dexcom) — endpoint and Trend documentation
- [mntndev/dexcom-share](https://pkg.go.dev/github.com/mntndev/dexcom-share) — base URLs and reading limits
- [StephenBlackWasAlreadyTaken gist](https://gist.github.com/StephenBlackWasAlreadyTaken/adb0525344bedade1e25) — Share endpoint reference

The Dexcom Share API is unofficial; a server-side change can break the extension.
