'use strict';

// ---------------------------------------------------------------------------
// In-process progress event bus: mirrors the Electron IPC channel pattern
// (ipcMain.send / ipcRenderer.on) but runs entirely in the browser thread.
// ---------------------------------------------------------------------------

const _listeners = new Map(); // jobId -> Set<callback>

function _emit(jobId, stage, payload) {
  const set = _listeners.get(jobId);
  if (set) for (const cb of set) cb({ stage, payload });
}

// ---------------------------------------------------------------------------
// ffmpeg.wasm setup
// ---------------------------------------------------------------------------
//
// Single-threaded build chosen deliberately: the multi-threaded core requires
// COOP / COEP headers, which GitHub Pages cannot set.

const PREVIEW_WIDTH = 480; // caps in-browser memory; Electron extracts at native res

let _ff = null;
let _ffReady = null;

function _getFF() {
  if (!_ffReady) {
    _ff = new FFmpegWASM.FFmpeg();
    _ffReady = _ff.load({
      coreURL: new URL('vendor/core/ffmpeg-core.js', document.baseURI).href,
      wasmURL: new URL('vendor/core/ffmpeg-core.wasm', document.baseURI).href,
    }).then(() => _ff);
  }
  return _ffReady;
}

// All ff.exec() calls are serialised: ffmpeg.wasm can only run one command at a time.
let _queue = Promise.resolve();
function _serialized(fn) {
  const r = _queue.then(fn, fn);
  _queue = r.then(() => {}, () => {});
  return r;
}

async function _probeDuration(ff, name) {
  let duration = null;
  const handler = ({ message }) => {
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(message);
    if (m) duration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  };
  ff.on('log', handler);
  try { await ff.exec(['-i', name]); } catch { /* expected — no output file given */ }
  ff.off('log', handler);
  if (duration === null) throw new Error(`Could not determine duration for ${name}`);
  return duration;
}

async function _extractFrame(ff, name, t, width, out) {
  await ff.exec([
    '-v', 'error', '-ss', String(t), '-i', name,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-c:v', 'bmp', '-f', 'image2', out,
  ]);
  const bytes = await ff.readFile(out);
  await ff.deleteFile(out);
  return BmpDecoder.decodeBMP(bytes);
}

// ---------------------------------------------------------------------------
// File registry — chooseVideos() stores picked File objects here so
// runPipeline() can look them up by the filename string it receives back.
// ---------------------------------------------------------------------------

const _files = new Map(); // filename -> File

// ---------------------------------------------------------------------------
// window.phashAPI — identical surface to Electron's preload.js
// ---------------------------------------------------------------------------
//
// Progress payloads are shaped to match exactly what main.js serialises over
// IPC, so src/renderer.js runs unchanged in both contexts.

window.phashAPI = {

  chooseVideos() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.multiple = true;
      input.addEventListener('change', () => {
        const names = [];
        for (const file of input.files) {
          _files.set(file.name, file);
          names.push(file.name);
        }
        resolve(names);
      }, { once: true });
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });
  },

  onProgress(jobId, callback) {
    if (!_listeners.has(jobId)) _listeners.set(jobId, new Set());
    _listeners.get(jobId).add(callback);
    return () => {
      const s = _listeners.get(jobId);
      if (s) { s.delete(callback); if (!s.size) _listeners.delete(jobId); }
    };
  },

  async runPipeline(jobId, videoPath) {
    const file = _files.get(videoPath);
    if (!file) return { ok: false, error: `File not found in registry: ${videoPath}` };
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const inputName = `${jobId}.${ext}`;

    try {
      const ff = await _getFF();

      await _serialized(async () => ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer())));

      const duration = await _serialized(() => _probeDuration(ff, inputName));
      _emit(jobId, 'duration', { duration });

      const timestamps = PhashCore.computeScreenshotTimestamps(duration, PhashCore.COLUMNS * PhashCore.ROWS);

      const frames = [];
      for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        const [frame, preview] = await _serialized(async () => [
          await _extractFrame(ff, inputName, t, PhashCore.SCREENSHOT_WIDTH, `${jobId}_h_${i}.bmp`),
          await _extractFrame(ff, inputName, t, PREVIEW_WIDTH, `${jobId}_p_${i}.bmp`),
        ]);
        frames.push(frame);
        // Payload shape matches main.js IPC serialisation so renderer.js works unchanged.
        _emit(jobId, 'frame', {
          index: i, total: timestamps.length, timeSeconds: t,
          previewWidth: preview.width, previewHeight: preview.height, previewData: preview.data,
        });
      }

      await _serialized(() => ff.deleteFile(inputName));

      const montage = PhashCore.buildMontage(frames, PhashCore.COLUMNS, PhashCore.ROWS);
      _emit(jobId, 'montage', { width: montage.width, height: montage.height, data: montage.data });

      const result = PhashCore.computePerceptionHash(montage);
      _emit(jobId, 'hash', {
        hex: result.hex,
        int64: result.int64,
        median: result.median,
        dctCoefficients8x8: Array.from(result.dctCoefficients8x8),
        resizedGray64x64: Array.from(result.resizedGray64x64),
        bits: result.bits,
      });

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[phash-inspector] pipeline error:', err);
      _emit(jobId, 'error', { message });
      return { ok: false, error: message };
    }
  },

  hammingDistance(hexA, hexB) {
    let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
    let n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return Promise.resolve(n);
  },
};

// ---------------------------------------------------------------------------
// Point the "download desktop version" link at this repo's releases page,
// derived from the github.io hostname so it doesn't need to be hardcoded.
// ---------------------------------------------------------------------------

(function wireDesktopLink() {
  const link = document.getElementById('desktop-link');
  if (!link) return;
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : null;
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (owner && repo) link.href = `https://github.com/${owner}/${repo}/releases/latest`;
})();
