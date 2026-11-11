// Packages both editions into site/*.zip (same output as the manual pack).
// Usage: node tools/build-zips.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");

function filesFor(folder) {
  const base = path.join(root, folder);
  const list = ["manifest.json", "background.js", "README.md"];
  for (const extra of ["libreview.js", "dexcom.js"]) {
    if (fs.existsSync(path.join(base, extra))) list.push(extra);
  }
  for (const dir of ["popup", "offscreen", "clinic"]) {
    const full = path.join(base, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) list.push(`${dir}/${f}`);
  }
  for (const icon of ["icon16.png", "icon32.png", "icon48.png", "icon128.png"]) {
    list.push(`icons/${icon}`);
  }
  return list;
}

function pack(folder, outName) {
  const files = filesFor(folder);
  for (const f of files) {
    if (!fs.existsSync(path.join(root, folder, f))) {
      throw new Error(`missing file: ${folder}/${f}`);
    }
  }
  // Deterministic-ish zip via Python (available on the dev machine and CI).
  const script = `
import zipfile, sys
folder, out = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        z.write(folder + "/" + f, f)
z = zipfile.ZipFile(out)
assert z.testzip() is None
print(out, z.filelist and len(z.filelist), "files")
`;
  execFileSync(
    "python3",
    ["-c", script, path.join(root, folder), path.join(root, "site", outName), ...files],
    { stdio: "inherit", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
  );
}

pack("libre", "sokeri-chrome-extension.zip");
pack("dexcom", "sokeri-dexcom-extension.zip");
