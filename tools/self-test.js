'use strict';

/**
 * Usage: node tools/self-test.js <video.mp4> [expectedHexOrInt64]
 *
 * Runs the pipeline headlessly (no Electron needed) and prints the hash.
 * If an expected hash is given (copy it out of Stash's database/UI), it
 * also prints the Hamming distance so you can confirm this reimplementation
 * matches a real Stash instance for that file.
 */

const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { hammingDistance } = require('../shared/phash-core');

function toHex(raw) {
  if (/^[0-9a-fA-F]{1,16}$/.test(raw) && !/^\d+$/.test(raw)) {
    return BigInt.asUintN(64, BigInt('0x' + raw)).toString(16).padStart(16, '0');
  }
  try {
    return BigInt.asUintN(64, BigInt(raw)).toString(16).padStart(16, '0');
  } catch {
    return BigInt.asUintN(64, BigInt('0x' + raw)).toString(16).padStart(16, '0');
  }
}

(async () => {
  const [, , videoArg, expected] = process.argv;
  if (!videoArg) {
    console.error('Usage: node tools/self-test.js <video> [expectedHexOrInt64]');
    process.exit(1);
  }
  const videoPath = path.resolve(videoArg);

  process.stdout.write(`Processing ${videoPath} `);
  const { duration, result } = await runPipeline(videoPath, (stage) => {
    if (stage === 'frame') process.stdout.write('.');
  });
  console.log('');
  console.log('duration:', duration.toFixed(3), 's');
  console.log('hash hex:', result.hex);
  console.log('hash int64:', result.int64);

  if (expected) {
    const expectedHex = toHex(expected.trim());
    const distance = hammingDistance(BigInt('0x' + result.hex), BigInt('0x' + expectedHex));
    console.log('expected hex:', expectedHex);
    console.log('hamming distance:', distance, distance === 0 ? '(exact match)' : '(MISMATCH)');
    process.exit(distance === 0 ? 0 : 2);
  }
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
