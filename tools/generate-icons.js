/**
 * Generates the extension icons (no dependencies, plain Node).
 * Run: node tools/generate-icons.js
 *
 * Design: a glucose trend line and the newest reading dot on a dark ground.
 * 4x supersampling + downsampling keeps it readable at 16px too.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const EDITION = process.argv[2] === "dexcom" ? "dexcom" : "libre";
const OUT_DIR = path.join(__dirname, "..", EDITION, "icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersample factor

const BG = [0x12, 0x17, 0x1c, 255];
// Libre: clinical blue, Dexcom: signal green — so the two toolbar icons differ.
const LINE = EDITION === "dexcom" ? [0x3d, 0xdc, 0x97, 255] : [0x4d, 0xb2, 0xff, 255];

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------- image maths */

/** Signed distance of a rounded rectangle. */
function sdRoundRect(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to the capsule around a segment between two points. */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Trend line points (0..1 normalised coordinates, y grows downwards). */
const POINTS = [
  [0.17, 0.64],
  [0.35, 0.44],
  [0.5, 0.57],
  [0.67, 0.3],
  [0.83, 0.46],
];

function renderIcon(size) {
  const fine = size * SS;
  const half = size / 2;
  const radius = size * 0.22;
  const strokeWidth = size * 0.115;
  const dotRadius = size * 0.095;

  const acc = new Float64Array(fine * fine * 4);

  // Points are moved into the centre-based coordinate system used by cx, cy.
  const pts = POINTS.map(([px, py]) => [px * size - half, py * size - half]);

  for (let fy = 0; fy < fine; fy++) {
    for (let fx = 0; fx < fine; fx++) {
      // fine pixel centre → coordinate in size units
      const x = (fx + 0.5) / SS;
      const y = (fy + 0.5) / SS;
      const cx = x - half;
      const cy = y - half;

      let col = null;

      if (sdRoundRect(cx, cy, half, radius) <= 0) col = BG;

      if (col) {
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[i + 1];
          if (sdSegment(cx, cy, ax, ay, bx, by) <= strokeWidth / 2) col = LINE;
        }
        const [dx, dy] = pts[pts.length - 1];
        if (Math.hypot(cx - dx, cy - dy) <= dotRadius) col = LINE;
      }

      if (col) {
        const o = (fy * fine + fx) * 4;
        acc[o] += col[0];
        acc[o + 1] += col[1];
        acc[o + 2] += col[2];
        acc[o + 3] += col[3];
      }
    }
  }

  const samples = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * fine + (x * SS + sx)) * 4;
          r += acc[o];
          g += acc[o + 1];
          b += acc[o + 2];
          a += acc[o + 3];
        }
      }
      const d = (y * size + x) * 4;
      out[d] = Math.round(r / samples);
      out[d + 1] = Math.round(g / samples);
      out[d + 2] = Math.round(b / samples);
      out[d + 3] = Math.round(a / samples);
    }
  }
  return encodePNG(size, size, out);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`written: ${path.relative(process.cwd(), file)}`);
}
