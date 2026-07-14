'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeBMP } = require('../shared/bmp');

// Builds a BITMAPINFOHEADER BMP the way ffmpeg's bmp encoder lays it out:
// 14-byte file header, 40-byte info header, then bottom-up rows padded to
// 4 bytes. `pixels` is row-major top-to-bottom [r,g,b(,a)] per pixel.
function makeBMP({ width, height, bpp, pixels, topDown = false }) {
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(topDown ? -height : height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < height; y++) {
    const fileRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixels[y * width + x];
      const o = 54 + fileRow * rowSize + x * bytesPerPixel;
      buf[o] = b; buf[o + 1] = g; buf[o + 2] = r;
      if (bytesPerPixel === 4) buf[o + 3] = a;
    }
  }
  return buf;
}

const threeByTwo = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [10, 20, 30], [40, 50, 60], [70, 80, 90],
];

test('decodes 24-bit bottom-up BMP with row padding into top-down RGBA', () => {
  // width 3 * 3 bytes = 9 -> padded to 12 per row; exercises the padding path
  const img = decodeBMP(makeBMP({ width: 3, height: 2, bpp: 24, pixels: threeByTwo }));
  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(img.data.subarray(20, 24)), [70, 80, 90, 255]);
});

test('decodes top-down (negative height) BMP in the same orientation', () => {
  const a = decodeBMP(makeBMP({ width: 3, height: 2, bpp: 24, pixels: threeByTwo }));
  const b = decodeBMP(makeBMP({ width: 3, height: 2, bpp: 24, pixels: threeByTwo, topDown: true }));
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
});

test('decodes 32-bit BMP and keeps the alpha byte', () => {
  const px = threeByTwo.map(([r, g, b], i) => [r, g, b, 100 + i]);
  const img = decodeBMP(makeBMP({ width: 3, height: 2, bpp: 32, pixels: px }));
  assert.equal(img.data[3], 100);
  assert.equal(img.data[23], 105);
});

test('accepts a plain Uint8Array view with a non-zero byteOffset', () => {
  const bmp = makeBMP({ width: 3, height: 2, bpp: 24, pixels: threeByTwo });
  const padded = new Uint8Array(bmp.length + 7);
  padded.set(bmp, 7);
  const img = decodeBMP(padded.subarray(7));
  assert.deepEqual(Array.from(img.data.subarray(0, 4)), [255, 0, 0, 255]);
});

test('rejects non-BMP input and unsupported encodings', () => {
  assert.throws(() => decodeBMP(new Uint8Array(64)), /bad magic/);
  const compressed = makeBMP({ width: 1, height: 1, bpp: 24, pixels: [[1, 2, 3]] });
  compressed.writeUInt32LE(1, 30);
  assert.throws(() => decodeBMP(compressed), /compression/);
  const sixteen = makeBMP({ width: 1, height: 1, bpp: 24, pixels: [[1, 2, 3]] });
  sixteen.writeUInt16LE(16, 28);
  assert.throws(() => decodeBMP(sixteen), /bit depth/);
});
