'use strict';

/**
 * Deterministic synthetic images for the golden-hash tests.
 *
 * Nothing here is random in the Math.random() sense: every image is derived
 * from a fixed-seed xorshift PRNG (integer-only, so it's identical on every
 * JS engine), which means the images never need to be committed as binaries.
 * Expected hashes in expected.json were produced by running the real Go
 * libraries Stash uses (tools/go-reference) over PNGs written by this same
 * generator -- see `node test/fixtures/generate.js <outDir>`.
 *
 * Deliberately adversarial: uniform noise is the worst case for a port of a
 * floating-point DCT (values land close to the median), and odd aspect
 * ratios exercise nfnt/resize's per-axis weight tables.
 */

const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { encodePNG } = require('./png');

function xorshift32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function image(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function noise(width, height, seed) {
  const rnd = xorshift32(seed);
  return image(width, height, () => [rnd() & 255, rnd() & 255, rnd() & 255]);
}

function solid(width, height, rgb) {
  return image(width, height, () => rgb);
}

function gradient(width, height) {
  return image(width, height, (x, y) => [
    Math.floor((255 * x) / Math.max(1, width - 1)),
    Math.floor((255 * y) / Math.max(1, height - 1)),
    128,
  ]);
}

// 5x5 grid of distinct smooth tiles -- shaped like a real montage of
// 160x90 frames, with hard edges at tile boundaries.
function tiledMontage(seed) {
  const rnd = xorshift32(seed);
  const tileW = 160, tileH = 90;
  const tiles = [];
  for (let i = 0; i < 25; i++) tiles.push([rnd() & 255, rnd() & 255, rnd() & 255, (rnd() % 7) + 1]);
  return image(tileW * 5, tileH * 5, (x, y) => {
    const t = tiles[Math.floor(y / tileH) * 5 + Math.floor(x / tileW)];
    const lx = x % tileW, ly = y % tileH;
    const wave = Math.floor(60 * Math.sin((lx * t[3]) / 20) * Math.cos(ly / 15));
    return [t[0] + wave, t[1] - wave, t[2] + wave];
  });
}

// name -> image. Keep this list append-only: expected.json is keyed by name.
const FIXTURES = {
  'noise-800x800': () => noise(800, 800, 0xC0FFEE),
  'noise-800x450': () => noise(800, 450, 0xBEEF),
  'noise-800x600': () => noise(800, 600, 0x5EED),
  'noise-320x320': () => noise(320, 320, 0x1234),
  'noise-100x77': () => noise(100, 77, 0x7777),
  'noise-64x64': () => noise(64, 64, 0x6464),
  'noise-63x65': () => noise(63, 65, 0x6365),
  'noise-16x16': () => noise(16, 16, 0x1616),
  'noise-1000x20': () => noise(1000, 20, 0xA5A5),
  'noise-20x1000': () => noise(20, 1000, 0x5A5A),
  'noise-1x1': () => noise(1, 1, 0x0001),
  'solid-black': () => solid(800, 800, [0, 0, 0]),
  'solid-white': () => solid(800, 800, [255, 255, 255]),
  'solid-mid': () => solid(800, 450, [128, 64, 200]),
  'gradient-800x450': () => gradient(800, 450),
  'gradient-200x800': () => gradient(200, 800),
  'montage-tiles-a': () => tiledMontage(0xAAAA),
  'montage-tiles-b': () => tiledMontage(0xBBBB),
};

function buildFixture(name) {
  const make = FIXTURES[name];
  if (!make) throw new Error(`Unknown fixture ${name}`);
  return make();
}

module.exports = { FIXTURES, buildFixture };

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node test/fixtures/generate.js <outDir>');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  for (const name of Object.keys(FIXTURES)) {
    const img = buildFixture(name);
    const file = path.join(outDir, `${name}.png`);
    writeFileSync(file, encodePNG(img));
    console.log(file);
  }
}
