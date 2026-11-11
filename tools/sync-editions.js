// Keeps the Dexcom edition's shared files in sync with the Libre edition.
// Libre is the source of truth; Dexcom differs only by small brand deltas.
// popup.html is structural (person vs account rows) and stays manual.
//
// Usage:
//   node tools/sync-editions.js          verify only (exit 1 on drift)
//   node tools/sync-editions.js --write  copy shared files libre -> dexcom
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);

const IDENTICAL = ["popup/popup.css", "offscreen/offscreen.js"];

const DELTAS = [
  {
    file: "popup/popup.js",
    swaps: [
      [" * Sokeri — popup interface.", " * Sokeri for Dexcom — popup interface."],
      [
        "  personId: null, // selected followed person (Libre); null = first connection",
        "  personId: null, // unused in the Dexcom edition (accounts are used instead)",
      ],
      ['const EXPORT_NAME = "sokeri-libre-readings.csv";', 'const EXPORT_NAME = "sokeri-dexcom-readings.csv";'],
      ['const REPORT_NAME = "sokeri-libre-report.pdf";', 'const REPORT_NAME = "sokeri-dexcom-report.pdf";'],
    ],
  },
  {
    file: "clinic/clinic.js",
    swaps: [[" * Sokeri — clinic mode.", " * Sokeri for Dexcom — clinic mode."]],
  },
  {
    file: "clinic/clinic.html",
    swaps: [
      ["<title>Sokeri — clinic mode</title>", "<title>Sokeri for Dexcom — clinic mode</title>"],
      ["<h1>Sokeri — clinic mode</h1>", "<h1>Sokeri for Dexcom — clinic mode</h1>"],
    ],
  },
];

let drift = 0;
const want = process.argv.includes("--write") ? "write" : "check";

for (const file of IDENTICAL) {
  const a = read(`libre/${file}`);
  const b = read(`dexcom/${file}`);
  if (a === b) {
    console.log(`  OK   ${file} identical`);
  } else if (want === "write") {
    write(`dexcom/${file}`, a);
    console.log(`  SYNC ${file} copied libre -> dexcom`);
  } else {
    console.log(`  DRIFT ${file} differs (run with --write)`);
    drift++;
  }
}

for (const { file, swaps } of DELTAS) {
  let expected = read(`libre/${file}`);
  for (const [from, to] of swaps) {
    if (!expected.includes(from)) {
      console.log(`  DRIFT ${file}: libre base changed (missing ${JSON.stringify(from.slice(0, 40))})`);
      drift++;
      expected = null;
      break;
    }
    expected = expected.split(from).join(to);
  }
  if (expected == null) continue;
  const actual = read(`dexcom/${file}`);
  if (actual === expected) {
    console.log(`  OK   ${file} matches (deltas applied)`);
  } else if (want === "write") {
    write(`dexcom/${file}`, expected);
    console.log(`  SYNC ${file} regenerated from libre`);
  } else {
    console.log(`  DRIFT ${file} differs beyond the known deltas`);
    drift++;
  }
}

console.log(drift === 0 ? "\nIN SYNC" : `\n${drift} DRIFT(S) FOUND`);
process.exit(drift === 0 ? 0 : 1);
