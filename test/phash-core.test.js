'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PhashCore = require('../shared/phash-core');
const { FIXTURES, buildFixture } = require('./fixtures/generate');
const { decodePNG } = require('./fixtures/png');

const expected = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'expected.json'), 'utf8'));

// Golden hashes: expected.json was produced by the real Go libraries Stash
// uses (tools/go-reference) over these exact images. Any difference here is
// a real divergence from Stash, not a test-authoring opinion.
for (const name of Object.keys(FIXTURES)) {
  test(`golden hash: ${name}`, () => {
    assert.ok(expected[name], `expected.json has no entry for ${name}; regenerate it (see tools/go-reference/main.go)`);
    const result = PhashCore.computePerceptionHash(buildFixture(name));
    assert.equal(result.hex, expected[name].hex);
    assert.equal(result.int64, expected[name].int64);
  });
}

test('golden hash: real montage exported from a library video', () => {
  const name = 'real-montage-no-labels';
  const img = decodePNG(readFileSync(path.join(__dirname, 'fixtures', `${name}.png`)));
  assert.equal(img.width, 800);
  assert.equal(img.height, 600);
  const result = PhashCore.computePerceptionHash(img);
  assert.equal(result.hex, expected[name].hex);
});

test('every golden entry has a fixture', () => {
  for (const name of Object.keys(expected)) {
    assert.ok(name in FIXTURES || name === 'real-montage-no-labels', `stale expected.json entry: ${name}`);
  }
});

test('computePerceptionHash exposes consistent bit/median/hex views', () => {
  const result = PhashCore.computePerceptionHash(buildFixture('montage-tiles-a'));
  assert.equal(result.bits.length, 64);
  let fromBits = 0n;
  result.bits.forEach((b, idx) => { if (b) fromBits |= 1n << BigInt(63 - idx); });
  assert.equal(fromBits, result.hash);
  assert.equal(result.hex, result.hash.toString(16).padStart(16, '0'));
  assert.equal(BigInt.asUintN(64, BigInt(result.int64)), result.hash);
});

test('computeScreenshotTimestamps mirrors phash.go (5% offset, 90% span, 25 steps)', () => {
  const ts = PhashCore.computeScreenshotTimestamps(100);
  assert.equal(ts.length, 25);
  assert.equal(ts[0], 5);
  assert.ok(Math.abs(ts[1] - 8.6) < 1e-12);
  assert.ok(Math.abs(ts[24] - (5 + 24 * 3.6)) < 1e-12);
});

test('hammingDistance counts differing bits across the full 64-bit width', () => {
  assert.equal(PhashCore.hammingDistance(0n, 0n), 0);
  assert.equal(PhashCore.hammingDistance(0n, 0xffffffffffffffffn), 64);
  assert.equal(PhashCore.hammingDistance(0x8000000000000001n, 0n), 2);
  assert.equal(PhashCore.hammingDistance(0xaa7fd5aa8a2a2a2an, 0xaa7fd5aa8a2a2a2bn), 1);
});

test('buildMontage places frame i at column i%5, row floor(i/5)', () => {
  const frames = [];
  for (let i = 0; i < 25; i++) {
    const data = new Uint8ClampedArray(2 * 3 * 4);
    for (let p = 0; p < 6; p++) { data[p * 4] = i; data[p * 4 + 3] = 255; }
    frames.push({ width: 2, height: 3, data });
  }
  const m = PhashCore.buildMontage(frames);
  assert.equal(m.width, 10);
  assert.equal(m.height, 15);
  for (let i = 0; i < 25; i++) {
    const x = (i % 5) * 2, y = Math.floor(i / 5) * 3;
    assert.equal(m.data[(y * 10 + x) * 4], i, `frame ${i} red channel at its origin`);
    assert.equal(m.data[((y + 2) * 10 + x + 1) * 4], i, `frame ${i} red channel at its far corner`);
  }
});

test('buildMontage rejects wrong frame counts and mismatched sizes', () => {
  const frame = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  assert.throws(() => PhashCore.buildMontage([frame]), /Expected 25 frames/);
  const frames = Array.from({ length: 25 }, () => frame);
  frames[7] = { width: 2, height: 1, data: new Uint8ClampedArray(8) };
  assert.throws(() => PhashCore.buildMontage(frames), /same dimensions/);
});
