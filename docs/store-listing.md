# Chrome Web Store listing (copy-paste)

Upload each edition (`libre/`, `dexcom/`) as its own store item, zipped with
`node tools/build-zips.js` (the ZIPs in `site/` are the same packages).

Privacy policy URL (required by the store): use the site's privacy section:

- `https://erdalbirinci.github.io/Sokeri/#privacy`

## Sokeri (Libre edition)

**Short description (132 chars max):**
Follow your FreeStyle Libre glucose in the browser: live badge value, trend arrow, chart, time-in-range stats and threshold alerts.

**Detailed description:**
Sokeri signs in with your LibreView account and keeps your FreeStyle Libre
readings one click away: the toolbar badge shows the live value in your
threshold colours, the panel shows the trend arrow, a 3/6/12/24-hour and 7-day
chart with target band, time in range (TIR), average, GMI estimate, variability
(%CV), lowest and highest values.

- High/low threshold alerts with snooze, configurable repeat, night escalation
  for lows and a signal-loss watch (desktop notification + optional sound)
- Separate night thresholds, experimental trend prediction drawn on the chart
- Reports view: 7-day TIR bar, weekly pattern heatmap, CSV export, one-page
  PDF report for doctor visits, full-tab clinic mode — all generated locally
- Followed-person selector, event markers, mg/dL ↔ mmol/L, light/dark themes

Everything is stored only in your browser and sent only to Abbott's servers
(`*.libreview.io`). No analytics, no ads, no external code. Open source (MIT):
https://github.com/ErdalBirinci/Sokeri

Not a medical device, not for diagnosis or treatment, adults (18+) only.
Unofficial community build, not affiliated with Abbott.

## Sokeri for Dexcom (Dexcom edition)

Same as above, with this sign-in paragraph instead:

Sokeri signs in with your Dexcom Share account (US / outside-US / Japan
regions) and keeps your Dexcom G6/G7 readings one click away … Multiple
Dexcom accounts can be signed in side by side with an in-settings switcher.

**Category:** Productivity (or Health & Fitness, if listed in your locale)
**Language:** English
