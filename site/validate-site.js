/**
 * Landing page validation.
 *
 * Checks:
 *  1. Do all local resources (href/src) in index.html exist?
 *  2. main.js / styles.css syntax (node --check is run separately).
 *  3. No external requests: only the SVG namespace and the permission text may
 *     look like URLs.
 *  4. The downloadable ZIP exists and is > 0 bytes.
 *  5. Do internal links (#id) target an existing element?
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "index.html"), "utf8");
const js = readFileSync(join(root, "main.js"), "utf8");
const css = readFileSync(join(root, "styles.css"), "utf8");

let failures = 0;
const ok = (msg) => console.log("  OK   " + msg);
const fail = (msg) => {
  failures++;
  console.log("  FAIL " + msg);
};

console.log("[1] local resources");
const refs = new Set();
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) refs.add(m[1]);
for (const m of js.matchAll(/from\s+"(assets\/[^"]+)"/g)) refs.add(m[1]);
const localRefs = [...refs].filter(
  (r) => !r.startsWith("#") && !r.startsWith("http")
);
for (const r of localRefs) {
  const p = join(root, r.split("#")[0].split("?")[0]);
  if (existsSync(p)) ok(`exists: ${r}`);
  else fail(`missing: ${r}`);
}

console.log("[2] downloadable packages");
for (const name of ["sokeri-chrome-extension.zip", "sokeri-dexcom-extension.zip"]) {
  const zip = join(root, name);
  if (existsSync(zip) && statSync(zip).size > 0) {
    ok(`ZIP present: ${name} (${statSync(zip).size} bytes)`);
  } else {
    fail(`ZIP missing or empty: ${name}`);
  }
}

console.log("[3] external resources");
const externals = new Set();
for (const src of [html, js, css]) {
  for (const m of src.matchAll(/https?:\/\/[^\s"')<>]+/g)) {
    externals.add(m[0].replace(/[.,]$/, ""));
  }
}
const allowed = [
  /^https?:\/\/www\.w3\.org\//, // SVG namespace, not a request
  /^https:\/\/\*\.libreview\.io\//, // permission description text, not a request
  /^https:\/\/share(ous1|2)?\.dexcom\.com\//, // Dexcom edition permission text
  /^https:\/\/share\.dexcom\.jp\//, // Dexcom edition permission text
  /^https:\/\/github\.com\/ErdalBirinci\/Sokeri\/?$/, // public repo link
  /^https:\/\/wise\.com\/pay\/me\/erdalb143\/?$/, // donation link
];
for (const url of externals) {
  if (allowed.some((re) => re.test(url))) ok(`allowed: ${url}`);
  else fail(`unexpected external URL: ${url}`);
}

console.log("[4] anchor targets");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/href="#([^"]+)"/g)) {
  if (ids.has(m[1])) ok(`anchor: #${m[1]}`);
  else fail(`anchor without target: #${m[1]}`);
}

console.log("[5] DOM id references in JS");
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) {
  if (ids.has(m[1])) ok(`id: ${m[1]}`);
  else fail(`not found in index.html: ${m[1]}`);
}

console.log("[6] basic a11y markers");
if (/<html lang="en">/.test(html)) ok("lang=en");
else fail("html lang is not en");
if (html.includes('class="skip"')) ok("skip link");
else fail("no skip link");
const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
const missingAlt = imgs.filter((t) => !/\balt="/.test(t));
if (missingAlt.length === 0) ok(`all ${imgs.length} images have alt`);
else fail(`${missingAlt.length} images have no alt`);
if (css.includes(":focus-visible")) ok("focus-visible styles");
else fail("no focus-visible styles");
if (css.includes("prefers-reduced-motion")) ok("reduced-motion support");
else fail("no reduced-motion support");

console.log("[7] no Turkish copy left in the page");
const TURKISH = /[\u011F\u00FC\u015F\u00F6\u00E7\u0131\u0130\u011E\u015E\u00D6\u00C7]/;
for (const [file, text] of [
  ["index.html", html],
  ["main.js", js],
  ["styles.css", css],
]) {
  const hit = text.split("\n").findIndex((line) => TURKISH.test(line));
  if (hit === -1) ok(`${file}: no Turkish characters`);
  else fail(`${file}: Turkish characters on line ${hit + 1}`);
}

console.log("");
if (failures === 0) console.log("ALL CHECKS PASSED");
else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
}
