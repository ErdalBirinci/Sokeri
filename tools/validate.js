// Post-build sanity checks: manifest validity, DOM id consistency,
// HTML tag balance, and external-resource leaks. Runs for both editions
// (the Libre extension in libre/ and the Dexcom extension in dexcom/).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let failed = 0;
const ok = (msg) => console.log(`  OK   ${msg}`);
const bad = (msg) => {
  failed += 1;
  console.log(`  FAIL ${msg}`);
};

const EDITIONS = [
  {
    prefix: "libre/",
    label: "libre",
    client: "libreview.js",
    allowedHosts: [/^https:\/\/(\*\.)?libreview\.(io|com)\//],
  },
  {
    prefix: "dexcom/",
    label: "dexcom",
    client: "dexcom.js",
    allowedHosts: [/^https:\/\/share(ous1|2)?\.dexcom\.com\//, /^https:\/\/share\.dexcom\.jp\//],
  },
];

for (const ed of EDITIONS) {
  console.log(`[${ed.label}] manifest.json`);
  let manifest;
  try {
    manifest = JSON.parse(read(`${ed.prefix}manifest.json`));
    ok(`${ed.label}: parses as JSON`);
  } catch (e) {
    bad(`${ed.label}: invalid JSON: ${e.message}`);
    process.exit(1);
  }
  const manifestFiles = [
    manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ].filter(Boolean);
  for (const f of manifestFiles) {
    if (fs.existsSync(path.join(root, ed.prefix, f))) ok(`${ed.label}: exists: ${f}`);
    else bad(`${ed.label}: missing file referenced by manifest: ${f}`);
  }
  if (!fs.existsSync(path.join(root, ed.prefix, ed.client))) {
    bad(`${ed.label}: missing API client: ${ed.client}`);
  } else {
    ok(`${ed.label}: exists: ${ed.client}`);
  }
  for (const p of manifest.host_permissions || []) {
    if (!ed.allowedHosts.some((re) => re.test(p)) && !/^https:\/\/(\*\.)?libreview\.(io|com)\//.test(p)) {
      bad(`${ed.label}: unexpected host permission: ${p}`);
    }
  }
  if ((manifest.host_permissions || []).length) ok(`${ed.label}: host permissions checked`);

  // --- popup id consistency ---
  console.log(`[${ed.label}] popup id consistency`);
  const popupHtml = read(`${ed.prefix}popup/popup.html`);
  const popupJs = read(`${ed.prefix}popup/popup.js`);
  const htmlIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...popupJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  let idErrors = 0;
  for (const id of jsIds) {
    if (!htmlIds.has(id)) {
      bad(`${ed.label}: popup.js references #${id} but popup.html has no such id`);
      idErrors++;
    }
  }
  if (!idErrors) ok(`${ed.label}: all ${jsIds.size} $("id") references resolve`);

  // --- safety nets: snooze, repeat, signal-loss, reports view ---
  console.log(`[${ed.label}] safety nets`);
  const backgroundJs = read(`${ed.prefix}background.js`);
  for (const token of ["alertSnooze", "NOTIF_ALERT", "maybeStaleAlert", "repeatMin"]) {
    if (backgroundJs.includes(token)) ok(`${ed.label}: background.js has ${token}`);
    else bad(`${ed.label}: background.js is missing ${token}`);
  }
  for (const token of ["setView", "renderReports", "buildPdf", "clinic/clinic.html", "tirSplit"]) {
    if (popupJs.includes(token)) ok(`${ed.label}: popup.js has ${token}`);
    else bad(`${ed.label}: popup.js is missing ${token}`);
  }
  if (popupHtml.includes('id="reports"') && popupHtml.includes('id="btn-reports"')) {
    ok(`${ed.label}: reports view is wired in popup.html`);
  } else {
    bad(`${ed.label}: reports view is missing in popup.html`);
  }

  // --- popup self-fit guard (the frame must never scroll) ---
  console.log(`[${ed.label}] popup self-fit guard`);
  const css = read(`${ed.prefix}popup/popup.css`);
  if (popupJs.includes("fitPopup") && popupJs.includes("FIT_BUDGET_PX")) {
    ok(`${ed.label}: popup.js measures and compacts until it fits`);
  } else {
    bad(`${ed.label}: popup.js is missing the fitPopup guard`);
  }
  if (css.includes("settings-open") && css.includes('data-compact="3"')) {
    ok(`${ed.label}: popup.css has the settings view + compact levels`);
  } else {
    bad(`${ed.label}: popup.css is missing the settings-open / compact rules`);
  }

  // --- HTML tag balance (popup + offscreen) ---
  console.log(`[${ed.label}] HTML tag balance`);
  const VOID = new Set(["meta", "link", "input", "img", "br", "hr", "source", "path", "circle", "rect", "line"]);
  for (const file of [
    `${ed.prefix}popup/popup.html`,
    `${ed.prefix}offscreen/offscreen.html`,
    `${ed.prefix}clinic/clinic.html`,
  ]) {
    const html = read(file).replace(/<!--[\s\S]*?-->/g, "");
    const stack = [];
    let balanceOk = true;
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g)) {
      const [, close, tag, selfClose] = m;
      const t = tag.toLowerCase();
      if (VOID.has(t) || selfClose) continue;
      if (close) {
        const top = stack.pop();
        if (top !== t) {
          bad(`${file}: closing </${t}> but expected </${top || "nothing"}>`);
          balanceOk = false;
          break;
        }
      } else stack.push(t);
    }
    if (balanceOk && stack.length === 0) ok(`${file}: tags balanced`);
    else if (balanceOk) bad(`${file}: unclosed <${stack.join(">, <")}>`);
  }
}

// --- no external URLs except the CGM servers ---
console.log("[shared] external resources");
const codeFiles = [];
for (const ed of EDITIONS) {
  codeFiles.push(
    `${ed.prefix}manifest.json`,
    `${ed.prefix}background.js`,
    `${ed.prefix}${ed.client}`,
    `${ed.prefix}popup/popup.html`,
    `${ed.prefix}popup/popup.js`,
    `${ed.prefix}popup/popup.css`,
    `${ed.prefix}offscreen/offscreen.html`,
    `${ed.prefix}offscreen/offscreen.js`,
    `${ed.prefix}clinic/clinic.html`,
    `${ed.prefix}clinic/clinic.js`
  );
}
codeFiles.push("tools/generate-icons.js");
let urlErrors = 0;
for (const file of codeFiles) {
  const text = read(file);
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    const url = m[0];
    if (/libreview\.(io|com)/.test(url)) continue;
    if (/share(ous1|2)?\.dexcom\.com/.test(url)) continue;
    if (/share\.dexcom\.jp/.test(url)) continue;
    if (url.includes("www.w3.org")) continue; // SVG namespaces
    bad(`${file}: external URL ${url}`);
    urlErrors++;
  }
}
if (!urlErrors) ok("no external URLs outside the CGM servers");

// --- the extension copy is English only ---
console.log("[shared] no Turkish copy left");
const TURKISH = /[\u011F\u00FC\u015F\u00F6\u00E7\u0131\u0130\u011E\u015E\u00D6\u00C7]/;
const copyFiles = [];
for (const ed of EDITIONS) {
  copyFiles.push(
    `${ed.prefix}manifest.json`,
    `${ed.prefix}README.md`,
    `${ed.prefix}background.js`,
    `${ed.prefix}${ed.client}`,
    `${ed.prefix}popup/popup.html`,
    `${ed.prefix}popup/popup.js`,
    `${ed.prefix}popup/popup.css`,
    `${ed.prefix}offscreen/offscreen.html`,
    `${ed.prefix}offscreen/offscreen.js`,
    `${ed.prefix}clinic/clinic.html`,
    `${ed.prefix}clinic/clinic.js`
  );
}
copyFiles.push("README.md", "tools/generate-icons.js");
let copyErrors = 0;
for (const file of copyFiles) {
  const line = read(file)
    .split("\n")
    .findIndex((text) => TURKISH.test(text));
  if (line === -1) ok(`${file}: no Turkish characters`);
  else {
    bad(`${file}: Turkish characters on line ${line + 1}`);
    copyErrors++;
  }
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
