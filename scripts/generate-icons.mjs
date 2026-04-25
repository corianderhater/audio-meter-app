// One-shot generator for the PWA icons. Run with `node scripts/generate-icons.mjs`.
// Writes public/icon-192.png and public/icon-512.png.
// Pure-Node, no dependencies — uses zlib + a minimal PNG encoder.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "public");

// Monochrome (white background, black bars) to match the B&W app theme.
const BG = [255, 255, 255];
const INK = [0, 0, 0];
const BARS = [INK, INK, INK, INK, INK, INK, INK];

function makePixels(size) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      px[o] = BG[0];
      px[o + 1] = BG[1];
      px[o + 2] = BG[2];
      px[o + 3] = 255;
    }
  }

  // Draw a row of vertical bars centered, with varying heights.
  const padding = Math.round(size * 0.18);
  const usable = size - padding * 2;
  const barCount = BARS.length;
  const gap = Math.max(2, Math.round(usable / (barCount * 6)));
  const barW = Math.floor((usable - gap * (barCount - 1)) / barCount);
  const baseline = size - padding;

  const heights = [0.45, 0.7, 0.9, 1.0, 0.85, 0.6, 0.4];

  for (let b = 0; b < barCount; b++) {
    const x0 = padding + b * (barW + gap);
    const h = Math.round(usable * heights[b]);
    const y0 = baseline - h;
    const c = BARS[b];
    for (let y = y0; y < baseline; y++) {
      for (let x = x0; x < x0 + barW; x++) {
        const o = (y * size + x) * 4;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
        px[o + 3] = 255;
      }
    }
  }

  return px;
}

function crc32(buf) {
  let c;
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  const t = crc32.table;
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixels) {
  // Add filter byte (0) at the start of every scanline.
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, (y + 1) * stride).reduce((_, b, i) => {
      filtered[y * (stride + 1) + 1 + i] = b;
      return _;
    }, 0);
  }
  const idat = deflateSync(filtered);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeIcon(size) {
  const px = makePixels(size);
  const png = encodePng(size, px);
  const path = resolve(OUT, `icon-${size}.png`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}

writeIcon(192);
writeIcon(512);
