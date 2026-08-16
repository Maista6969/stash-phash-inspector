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
const { describeBinaries } = require('../src/ffmpeg-extract');
const { hammingDistance } = require('../shared/phash-core');
const { parseHashInput } = require('../shared/hash-format');


(async () => {
  const [, , videoArg, expected] = process.argv;
  if (!videoArg) {
    console.error('Usage: node tools/self-test.js <video> [expectedHexOrInt64]');
    process.exit(1);
  }
  const videoPath = path.resolve(videoArg);

  const bins = await describeBinaries();
  console.log(`ffmpeg:  ${bins.ffmpeg.version}  ${bins.ffmpeg.path}`);
  console.log(`ffprobe: ${bins.ffprobe.version}  ${bins.ffprobe.path}`);
  process.stdout.write(`Processing ${videoPath} `);
  const { duration, result } = await runPipeline(videoPath, (stage, payload) => {
    if (stage === 'frame') process.stdout.write('.');
    if (stage === 'slow-seek') process.stdout.write(`\n  fast seek failed at ${payload.timeSeconds.toFixed(3)}s, switching to accurate seek (as Stash does)\n`);
  }, { preview: false });
  console.log('');
  console.log('duration:', duration.toFixed(3), 's');
  console.log('hash hex:', result.hex);
  console.log('hash int64:', result.int64);

  if (expected) {
    const expectedHex = parseHashInput(expected);
    if (!expectedHex) {
      console.error(`ERROR: "${expected}" is not a phash (expected 16 hex digits or a signed int64)`);
      process.exit(1);
    }
    const distance = hammingDistance(BigInt('0x' + result.hex), BigInt('0x' + expectedHex));
    console.log('expected hex:', expectedHex);
    console.log('hamming distance:', distance, distance === 0 ? '(exact match)' : '(MISMATCH)');
    process.exit(distance === 0 ? 0 : 2);
  }
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
