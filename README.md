# Sokeri

![version](https://img.shields.io/badge/version-1.1.0-green)
![platform](https://img.shields.io/badge/Chrome-Manifest%20V3-blue)
![languages](https://img.shields.io/badge/UI-English%20%7C%20suomi-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

Two Chrome extensions (Manifest V3) that track your glucose readings inside
the browser, plus the landing page that presents them.

**Repository:** https://github.com/ErdalBirinci/Sokeri  
**Live site (GitHub Pages):** https://erdalbirinci.github.io/Sokeri/

Fork it, adapt it, send improvements back — everything is here.

| Edition | Folder | Account | Sensors |
| --- | --- | --- | --- |
| Sokeri for FreeStyle Libre | `libre/` | LibreView | FreeStyle Libre |
| Sokeri for Dexcom | `dexcom/` | Dexcom Share | Dexcom G6 / G7 |

Both share the same panel: live value on the toolbar badge, trend arrow,
3/6/12/24-hour and 7-day charts, time-in-range stats (incl. GMI and
variability), high/low threshold alerts with snooze, repeat, night escalation
and a signal-loss watch, day/night thresholds and optional trend prediction
(drawn on the chart), a reports view (TIR bar, pattern heatmap, PDF report,
clinic mode), CSV export **and CSV import**, event markers, mg/dL ↔ mmol/L
conversion, light/dark themes, an **English/Finnish interface** with a
first-run onboarding tour, and multi-person/multi-account tracking. See
`libre/README.md` and `dexcom/README.md` for the edition manuals.

---

## Screenshots

Sample data. Dark theme, light theme, settings, reports, Dexcom multi-account
and the full-tab clinic mode:

| Dashboard (dark) | Dashboard (light) | Settings |
| --- | --- | --- |
| ![Dashboard, dark theme](docs/screenshots/dashboard-dark.png) | ![Dashboard, light theme](docs/screenshots/dashboard-light.png) | ![Settings view](docs/screenshots/settings-dark.png) |

| Reports (TIR, pattern, PDF, clinic) | Dexcom settings (multi-account) |
| --- | --- |
| ![Reports view](docs/screenshots/reports-dark.png) | ![Dexcom settings with account switcher](docs/screenshots/dexcom-settings.png) |

![Clinic mode](docs/screenshots/clinic-mode.png)

## Demo

A simulated day on the landing page — one hour per second (MP4, ~15 s,
no sound, made-up data):

<video src="docs/media/simulator.mp4" width="640" controls muted loop playsinline></video>

---

## Folders

```
sokeri-project/
├── libre/                   Libre edition (load this folder unpacked in Chrome)
│   ├── manifest.json
│   ├── background.js        service worker: sign-in, refresh, badge, alerts
│   ├── libreview.js         LibreView / LibreLinkUp API client
│   ├── popup/              sign-in + dashboard + settings + reports
│   ├── clinic/             full-tab clinic-mode display
│   ├── offscreen/          audio context for the threshold alerts
│   └── icons/              16/32/48/128 px icons (blue)
├── dexcom/                  Dexcom edition (load this folder unpacked in Chrome)
│   ├── manifest.json
│   ├── background.js
│   ├── dexcom.js            Dexcom Share API client
│   ├── popup/
│   ├── clinic/
│   ├── offscreen/
│   └── icons/              16/32/48/128 px icons (green)
├── site/                    landing page (English)
│   ├── index.html
│   ├── styles.css
│   ├── main.js
│   └── validate-site.js
├── tools/
│   ├── validate.js          extension checks: node tools/validate.js
│   ├── generate-icons.js    icon painter: node tools/generate-icons.js [libre|dexcom]
│   ├── sync-editions.js     keep dexcom/ in sync with libre/: --write
│   ├── build-zips.js        packaged editions for download (site/*.zip)
│   └── build-firefox.js     beta Firefox packages (see docs/firefox.md)
├── docs/                    store-listing.md, launch-post.md, firefox.md, media/
├── CHANGELOG.md
└── LICENSE                  MIT
```

Firefox is beta and untested here (no Firefox on the build machine):
`node tools/build-firefox.js`, then follow `docs/firefox.md`.

---

## Privacy in one paragraph

The site (`site/`) collects nothing: no cookies, no analytics, no accounts,
no servers. Each extension stores your readings, settings and session **only
in your own browser** (`chrome.storage`) and talks **only** to your CGM
provider's servers (LibreView or Dexcom Share). Nothing is sent anywhere else.
You can erase everything at any time with the **Delete all local data**
button in the extension settings. Full details: the Privacy section on the
landing page.

---

## Important

Neither extension is a medical device, neither is intended for diagnosis or
treatment, and neither is affiliated with Abbott or Dexcom. For adults (18+)
as a convenience display only; always confirm critical decisions on your
sensor's own screen.
