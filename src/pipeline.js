'use strict';

const { probeDuration, extractFrame } = require('./ffmpeg-extract');
const {
  COLUMNS, ROWS, SCREENSHOT_WIDTH,
  computeScreenshotTimestamps, buildMontage, computePerceptionHash,
} = require('../shared/phash-core');

/**
 * Runs the full pipeline for one video and reports progress along the way
 * so the UI can render each stage as it completes.
 *
 * onProgress(stage, payload) is called with:
 *   ('duration', { duration })
 *   ('timestamps', { timestamps })
 *   ('frame', { index, total, timeSeconds, frame, previewFrame })
 *       frame = {width,height,data} at SCREENSHOT_WIDTH -- feeds the hash
 *       previewFrame = {width,height,data} at the source video's native
 *         resolution -- display only, for the zoom/comparison modal. It's
 *         a second, independent ffmpeg call at the same timestamp (no
 *         `-vf scale`, so ffmpeg emits the frame at whatever resolution
 *         the source video actually is) rather than a downscaled preview,
 *         so what you're comparing in the modal is exactly what's in the
 *         original file, pixel for pixel.
 *   ('montage', { montage })
 *   ('hash', result)  // result = computePerceptionHash() output
 */
async function runPipeline(videoPath, onProgress = () => {}) {
  const duration = await probeDuration(videoPath);
  onProgress('duration', { duration });

  const timestamps = computeScreenshotTimestamps(duration, COLUMNS * ROWS);
  onProgress('timestamps', { timestamps });

  const frames = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    // Two independent ffmpeg calls at the same timestamp: one at the
    // hash's native 160px width (this is the one that ever gets hashed),
    // and one with no scale filter at all, i.e. the source's own native
    // resolution, purely so the filmstrip/zoom view is full quality.
    // Taking an extra screenshot rather than downscaling (or upscaling) a
    // shared frame keeps the hash path completely untouched.
    const [frame, previewFrame] = await Promise.all([
      extractFrame(videoPath, t, { width: SCREENSHOT_WIDTH }),
      extractFrame(videoPath, t, {}),
    ]);
    frames.push(frame);
    onProgress('frame', { index: i, total: timestamps.length, timeSeconds: t, frame, previewFrame });
  }

  const montage = buildMontage(frames, COLUMNS, ROWS);
  onProgress('montage', { montage });

  const result = computePerceptionHash(montage);
  onProgress('hash', result);

  return { videoPath, duration, timestamps, montage, result };
}

module.exports = { runPipeline };
