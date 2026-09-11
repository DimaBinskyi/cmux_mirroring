// Generates the PWA icons (terminal-prompt glyph on a dark gradient) as raw
// PNGs with no image-library dependency: pixels are drawn with signed-distance
// coverage, then encoded straight to PNG chunks via zlib.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Coverage from a signed distance: 1 inside, 0 outside, ~1.5px AA ramp.
function coverage(dist) {
  return Math.max(0, Math.min(1, 0.75 - dist / 1.5 + 0.5));
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const top = [0x1e, 0x29, 0x3b];
  const bottom = [0x0c, 0x12, 0x22];
  const green = [0x34, 0xd3, 0x99];
  const white = [0xe2, 0xe8, 0xf0];

  const stroke = 0.085 * size;
  // Chevron ">" of the terminal prompt
  const segs = [
    [0.28 * size, 0.34 * size, 0.46 * size, 0.50 * size],
    [0.46 * size, 0.50 * size, 0.28 * size, 0.66 * size],
  ];
  // Cursor block "_" to the right of the chevron
  const cur = { x0: 0.54 * size, y0: 0.545 * size, x1: 0.74 * size, y1: 0.645 * size };

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const bg = [
      Math.round(top[0] + (bottom[0] - top[0]) * t),
      Math.round(top[1] + (bottom[1] - top[1]) * t),
      Math.round(top[2] + (bottom[2] - top[2]) * t),
    ];
    for (let x = 0; x < size; x++) {
      let [r, g, b] = bg;

      const dChevron = Math.min(
        distToSegment(x + 0.5, y + 0.5, ...segs[0]),
        distToSegment(x + 0.5, y + 0.5, ...segs[1]),
      );
      const aChevron = coverage(dChevron - stroke / 2);
      if (aChevron > 0) {
        r = r * (1 - aChevron) + green[0] * aChevron;
        g = g * (1 - aChevron) + green[1] * aChevron;
        b = b * (1 - aChevron) + green[2] * aChevron;
      }

      const dxOut = Math.max(cur.x0 - (x + 0.5), (x + 0.5) - cur.x1, 0);
      const dyOut = Math.max(cur.y0 - (y + 0.5), (y + 0.5) - cur.y1, 0);
      const aCursor = coverage(Math.hypot(dxOut, dyOut));
      if (aCursor > 0) {
        r = r * (1 - aCursor) + white[0] * aCursor;
        g = g * (1 - aCursor) + white[1] * aCursor;
        b = b * (1 - aCursor) + white[2] * aCursor;
      }

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = 255; // iOS renders transparency as black — keep icons opaque
    }
  }
  return encodePng(size, rgba);
}

const targets = [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of targets) {
  fs.writeFileSync(path.join(OUT_DIR, name), render(size));
  console.log(`wrote public/${name}`);
}
