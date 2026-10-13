/*!
 * 风暴屏蔽器 — 图标生成脚本
 *
 * 纯 Node（只用内置 zlib），手写 PNG 编码，不依赖任何第三方包。
 *   用法: node tools/make-icons.js
 * 产物: icons/icon16.png icon32.png icon48.png icon128.png
 *
 * 图形：深色圆角方块 + 粉色"禁止"斜杠与圆圈 —— 一眼看出是拦东西的。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Buffer/Uint8Array，长度 w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个 filter type 字节（0 = None）
  const rowBytes = w * 4;
  const raw = Buffer.alloc(h * (rowBytes + 1));
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y += 1) {
    raw[y * (rowBytes + 1)] = 0;
    src.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 绘制 ------------------------------ */

const PINK = [0xfb, 0x72, 0x99];
const DARK_A = [0x25, 0x25, 0x30];
const DARK_B = [0x14, 0x14, 0x1a];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** 覆盖率式抗锯齿：每像素 3x3 超采样，返回 0..1 */
function sample(sx, sy, predicate) {
  let hits = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const x = sx + (i + 0.5) / 3;
      const y = sy + (j + 0.5) / 3;
      if (predicate(x, y)) hits += 1;
    }
  }
  return hits / 9;
}

function roundedSquare(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 禁止符：圆环 + 45° 斜杠 */
function forbidden(x, y, size) {
  const c = size / 2;
  const dx = x - c;
  const dy = y - c;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const outer = size * 0.3;
  const inner = size * 0.215;
  const inRing = dist <= outer && dist >= inner;

  // 斜杠：沿 (1,-1) 方向的带子，长度限制在圆内
  const u = (dx - dy) / Math.SQRT2; // 垂直于斜杠方向的距离
  const v = (dx + dy) / Math.SQRT2; // 沿斜杠方向
  const halfWidth = size * 0.052;
  const inBar = Math.abs(u) <= halfWidth && Math.abs(v) <= outer * 0.98;

  return inRing || inBar;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const bgCov = sample(x, y, (px, py) => roundedSquare(px, py, size, radius));
      const fgCov = sample(x, y, (px, py) => roundedSquare(px, py, size, radius) && forbidden(px, py, size));

      const t = (x + y) / (2 * size);
      const color = mix(mix(DARK_A, DARK_B, t), PINK, fgCov);
      const radiusAlpha = Math.round(bgCov * 255);

      const o = (y * size + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = radiusAlpha;
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------ 主流程 ------------------------------ */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = render(size);
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, png);
  process.stdout.write('wrote ' + path.relative(path.join(__dirname, '..'), file) + ' (' + png.length + ' bytes)\n');
}
