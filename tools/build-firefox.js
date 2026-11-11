// Packages both editions for Firefox (beta, untested in this repo).
// Firefox MV3 differences handled here:
//   - background scripts instead of a service worker (same file, modules kept)
//   - no offscreen documents: background.js falls back to direct audio
//     (see playDirect) when chrome.offscreen is missing
//   - no notification buttons: Firefox shows the notification without them,
//     so snooze stays a Chrome-only convenience for now
//   - Gecko id + minimum version stamped into the manifest copy
// Usage: node tools/build-firefox.js   -> dist-firefox/libre, dist-firefox/dexcom
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist-firefox");

const EDITIONS = [
  { folder: "libre", geckoId: "sokeri-libre@erdalbirinci.github.io" },
  { folder: "dexcom", geckoId: "sokeri-dexcom@erdalbirinci.github.io" },
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

for (const { folder, geckoId } of EDITIONS) {
  const dest = path.join(out, folder);
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(path.join(root, folder), dest);
  // Drop the Chrome-only audio document; the background falls back to audio.
  fs.rmSync(path.join(dest, "offscreen"), { recursive: true, force: true });

  const manifestPath = path.join(dest, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.minimum_chrome_version;
  delete manifest.offscreen;
  manifest.permissions = (manifest.permissions || []).filter((p) => p !== "offscreen");
  manifest.background = { scripts: ["background.js"], type: "module" };
  manifest.browser_specific_settings = {
    gecko: { id: geckoId, strict_min_version: "129.0" },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  OK   dist-firefox/${folder} (load via about:debugging)`);
}

console.log("\nDone. Temporary files: load dist-firefox/<edition> with");
console.log("Firefox -> about:debugging -> This Firefox -> Load Temporary Add-on.");
