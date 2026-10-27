// 生成一个简单的 256x256 ICO（纯色圆角方块 + 上下箭头），无外部依赖
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const px = Buffer.alloc(S * S * 4, 0);
const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
};
const inRound = (x, y, x0, y0, x1, y1, rad) => {
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
};

// 背景：圆角方块，蓝紫渐变
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRound(x, y, 8, 8, S - 9, S - 9, 56)) continue;
    const t = (x + y) / (2 * S);
    const r = Math.round(75 + (122 - 75) * t);
    const g = Math.round(141 + (92 - 141) * t);
    const b = Math.round(255 + (255 - 255) * t);
    set(x, y, r, g, b);
  }
}

// 上箭头（白色）
const arrow = (cx, yTop, yBot, halfW, headH) => {
  for (let y = yTop; y <= yBot; y++) {
    const inHead = y <= yTop + headH;
    const w = inHead
      ? Math.round(halfW * ((y - yTop) / headH))
      : Math.round(halfW * 0.34);
    for (let x = cx - w; x <= cx + w; x++) set(x, y, 255, 255, 255);
  }
};
arrow(128, 52, 118, 46, 44);
arrow(128, 138, 204, 46, 44);

// 编码 PNG
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ICO 包装（单张 256x256 PNG）
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.ico', Buffer.concat([ico, png]));
console.log('icon.ico 已生成', fs.statSync('build/icon.ico').size, 'bytes');
