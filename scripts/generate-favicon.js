#!/usr/bin/env node
'use strict';
/**
 * Generates favicon.png (48×48) from the brand colours defined in favicon.svg.
 * Requires only Node built-ins (no npm packages).
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 48,
  H = 48;
const BG = [0x11, 0x11, 0x11, 0xff];
const GOLD = [0xc9, 0xa8, 0x4c, 0xff];
const BORDER = [0xc9, 0xa8, 0x4c, 0x99]; // gold, 60% opacity

// ---- pixel buffer (RGBA) --------------------------------------------------
const buf = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++)
  buf.writeUInt32BE(((BG[0] << 24) | (BG[1] << 16) | (BG[2] << 8) | BG[3]) >>> 0, i * 4);

const px = (x, y, c) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
};

// Rounded border (1-pixel inset on the 48-grid, skip corners radius≈6)
const R = 6; // corner radius in pixels
for (let i = R; i < W - R; i++) {
  px(i, 1, BORDER);
  px(i, H - 2, BORDER);
}
for (let i = R; i < H - R; i++) {
  px(1, i, BORDER);
  px(W - 2, i, BORDER);
}

// "N" glyph — left bar x=[15..18], right bar x=[29..32], diagonal connects them
// Vertical bars: 3 px wide, y=[12..36]
for (let y = 12; y <= 36; y++) {
  for (let dx = 0; dx < 3; dx++) {
    px(15 + dx, y, GOLD);
    px(30 + dx, y, GOLD);
  }
}
// Diagonal: top-left (17,12) → bottom-right (30,36), 3 px thick
for (let step = 0; step <= 24; step++) {
  const x = Math.round(17 + (step / 24) * 13);
  const y = 12 + step;
  for (let dx = 0; dx < 3; dx++) px(x + dx, y, GOLD);
}

// ---- PNG encoding ---------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4);
  lb.writeUInt32BE(data.length);
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6; // 8-bit RGBA

const raw = [];
for (let y = 0; y < H; y++) {
  raw.push(0); // filter: None
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    raw.push(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, '..', 'favicon.png');
fs.writeFileSync(out, png);
console.log('Generated:', out, `(${png.length} bytes)`);
