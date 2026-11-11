# Firefox port (beta)

`node tools/build-firefox.js` produces `dist-firefox/libre` and
`dist-firefox/dexcom` from the same sources. The Chrome ZIPs are unaffected.

## Install for testing

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** and pick `dist-firefox/<edition>/manifest.json`.
3. Click the toolbar icon and sign in (Firefox 129+ required).

Temporary add-ons vanish on restart; for permanent installs the package must
be signed on addons.mozilla.org (free account, automated review for
unlisted/self-distributed builds).

## Known differences from Chrome

- No offscreen documents: alert sounds play through the background page
  directly (`playDirect` in `background.js`).
- Notification action buttons are not shown by Firefox, so **snooze from the
  notification is Chrome-only**; repeat, night escalation and signal-loss
  alerts work the same.
- Everything else (badge, chart, reports, PDF, clinic mode, accounts,
  Finnish UI, onboarding, CSV import) is shared code.

## Test checklist before any release

- [ ] Sign in (Libre + Dexcom regions) and live badge value
- [ ] Threshold alert with sound (low + high)
- [ ] Repeat + night escalation timing
- [ ] Signal-loss alert after 20 min without data
- [ ] Reports: TIR bar, heatmap, CSV export, PDF download, clinic tab
- [ ] CSV import merges without duplicates
- [ ] Language switch EN ↔ FI, onboarding on a fresh profile
- [ ] No console errors on the background page (`about:debugging` → Inspect)
