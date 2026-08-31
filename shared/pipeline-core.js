'use strict';

/**
 * Pipeline orchestration shared by the Electron app (src/pipeline.js binds
 * it to a native ffmpeg) and the web build (web/browser-api.js binds it to
 * ffmpeg.wasm). Mirrors phash.go's generateSprite: probe duration, derive
 * the 25 timestamps, extract each frame with fast-seek and a one-way
 * fallback to slow seek, assemble the montage, hash it.
 *
 * Keeping this in one place means the seek policy and progress-event
 * contract can't drift between the two builds.
 *
 * deps:
 *   probeDuration(videoPath) -> Promise<number>   Stash-rounded seconds
 *   extractFrame(videoPath, timeSeconds, { width?, slowSeek, preview }) -> Promise<frame>
 *       width undefined means "no scale filter" (native resolution).
 *       Hash frames (preview: false) must come back decoded as
 *       {width,height,data}; preview frames are display-only and may come
 *       back in whatever form the UI binding prefers (the Electron and web
 *       bindings both return { png: bytes }).
 *   preview: false to skip the display-only preview extraction entirely
 *   previewWidth: cap the preview at this width (default: native resolution)
 *
 * onProgress(stage, payload) is called with:
 *   ('duration', { duration })
 *   ('timestamps', { timestamps })
 *   ('slow-seek', { timeSeconds, reason })   fast seek failed; rest of this
 *                                             video uses accurate seek
 *   ('frame', { index, total, timeSeconds, frame, previewFrame })
 *       frame = {width,height,data} at SCREENSHOT_WIDTH -- feeds the hash
 *       previewFrame = whatever extractFrame returned for the preview, or null
 *   ('montage', { montage })
 *   ('hash', result)  // result = computePerceptionHash() output
 */

// Wrapped in an IIFE: as a classic <script> in the browser this file shares
// one global lexical scope with phash-core.js, so no top-level const here
// may reuse a name that file declares.
(function (root) {
const PhashCore = (typeof module !== 'undefined' && module.exports)
  ? require('./phash-core')
  : root.PhashCore;

const { COLUMNS, ROWS, SCREENSHOT_WIDTH, computeScreenshotTimestamps, buildMontage, computePerceptionHash } = PhashCore;

async function runPipeline(videoPath, onProgress = () => {}, deps) {
  if (!deps || !deps.probeDuration || !deps.extractFrame) {
    throw new Error('runPipeline needs deps.probeDuration and deps.extractFrame');
  }
  const wantPreview = deps.preview !== false;
  const previewOpts = { preview: true, ...(deps.previewWidth != null ? { width: deps.previewWidth } : {}) };

  const duration = await deps.probeDuration(videoPath);
  onProgress('duration', { duration });

  const timestamps = computeScreenshotTimestamps(duration, COLUMNS * ROWS);
  onProgress('timestamps', { timestamps });

  // phash.go generateSprite: the first time a fast (-ss before -i) seek
  // fails, retry that frame with an accurate seek and stay in slow-seek
  // mode for every remaining frame of this video.
  let slowSeek = false;
  async function extractWithFallback(t, opts) {
    try {
      return await deps.extractFrame(videoPath, t, { ...opts, slowSeek });
    } catch (err) {
      if (slowSeek) throw err;
      onProgress('slow-seek', { timeSeconds: t, reason: err.message });
      slowSeek = true;
      return deps.extractFrame(videoPath, t, { ...opts, slowSeek });
    }
  }

  const frames = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    // Two independent extractions at the same timestamp: the 160px-wide
    // frame that actually gets hashed, and a display-only preview with no
    // scale filter (or a capped width in the browser). Taking a second
    // screenshot rather than rescaling the hash frame keeps the hash path
    // completely untouched by anything the UI needs.
    const [frame, previewFrame] = await Promise.all([
      extractWithFallback(t, { width: SCREENSHOT_WIDTH }),
      wantPreview ? extractWithFallback(t, previewOpts) : null,
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

const PipelineCore = { runPipeline };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PipelineCore;
} else {
  root.PipelineCore = PipelineCore;
}
}(typeof window !== 'undefined' ? window : globalThis));
