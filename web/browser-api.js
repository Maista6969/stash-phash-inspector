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

// Same ffprobe invocation as src/ffmpeg-extract.js. ffmpeg.wasm routes
// ffprobe's stdout through 'log' events (type 'stdout'), so collect those.
// Earlier versions of this file scraped ffmpeg's "Duration: HH:MM:SS.cc"
// banner instead, which is truncated to centiseconds rather than rounded,
// and so could disagree with Stash's math.Round by 0.01s.
async function _probeDuration(ff, name) {
  const lines = [];
  const handler = ({ type, message }) => { if (type === 'stdout') lines.push(message); };
  ff.on('log', handler);
  try {
    await ff.ffprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      name,
    ]);
  } finally {
    ff.off('log', handler);
  }
  const raw = lines.join('\n').trim();
  const duration = parseFloat(raw);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for ${name} (ffprobe said "${raw}")`);
  }
  return PhashCore.roundDurationLikeStash(duration);
}

// Same argument list as src/ffmpeg-extract.js extractFrame, with the
// output going to ffmpeg.wasm's in-memory FS instead of a pipe.
async function _extractFrame(ff, name, t, { width, slowSeek, preview }, out) {
  const seek = ['-ss', String(t)];
  const args = ['-v', 'error', '-y'];
  if (!slowSeek) args.push(...seek);
  args.push('-i', name);
  if (slowSeek) args.push(...seek);
  args.push('-frames:v', '1');
  if (width != null) args.push('-vf', `scale=${width}:-2`);
  // Previews are display-only and stay PNG-compressed (same as the
  // Electron build); hash frames use Stash's literal BMP invocation.
  if (preview) args.push('-c:v', 'png', '-compression_level', '20', '-f', 'image2', out);
  else args.push('-c:v', 'bmp', '-f', 'rawvideo', out);
  const code = await ff.exec(args);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  let bytes;
  try {
    bytes = await ff.readFile(out);
  } catch {
    throw new Error('ffmpeg produced no output frame');
  }
  await ff.deleteFile(out);
  return preview ? { png: bytes } : BmpDecoder.decodeBMP(bytes);
}

// ---------------------------------------------------------------------------
// File registry -- chooseVideos() / registerFiles() store picked File
// objects here so runPipeline() can look them up by the filename string it
// receives back.
// ---------------------------------------------------------------------------

const _files = new Map(); // filename -> File

// ---------------------------------------------------------------------------
// window.phashAPI -- identical surface to Electron's preload.js
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
      input.addEventListener('change', () => resolve(window.phashAPI.registerFiles(input.files)), { once: true });
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });
  },

  /** Dropped File objects are usable directly in the browser. */
  acceptDroppedFiles(files) {
    return window.phashAPI.registerFiles(files);
  },

  /** Registers File objects (from a picker or a drop) and returns their names. */
  registerFiles(files) {
    const names = [];
    for (const file of files) {
      _files.set(file.name, file);
      names.push(file.name);
    }
    return names;
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
    let frameCounter = 0;

    try {
      const ff = await _getFF();
      await _serialized(async () => ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer())));

      const deps = {
        previewWidth: PREVIEW_WIDTH,
        probeDuration: (name) => _serialized(() => _probeDuration(ff, name)),
        extractFrame: (name, t, opts) =>
          _serialized(() => _extractFrame(ff, name, t, opts, `${jobId}_${frameCounter++}.${opts.preview ? 'png' : 'bmp'}`)),
      };

      // Payload shapes match main.js's IPC serialisation so renderer.js works unchanged.
      const onProgress = (stage, payload) => {
        if (stage === 'frame') {
          _emit(jobId, 'frame', {
            index: payload.index, total: payload.total, timeSeconds: payload.timeSeconds,
            previewPng: payload.previewFrame.png,
          });
        } else if (stage === 'montage') {
          const { montage } = payload;
          _emit(jobId, 'montage', { width: montage.width, height: montage.height, data: montage.data });
        } else if (stage === 'hash') {
          _emit(jobId, 'hash', {
            hex: payload.hex,
            int64: payload.int64,
            median: payload.median,
            dctCoefficients8x8: Array.from(payload.dctCoefficients8x8),
            resizedGray64x64: Array.from(payload.resizedGray64x64),
            bits: payload.bits,
          });
        } else {
          _emit(jobId, stage, payload);
        }
      };

      const { duration, result } = await PipelineCore.runPipeline(inputName, onProgress, deps);
      await _serialized(() => ff.deleteFile(inputName));
      return { ok: true, duration, hex: result.hex, int64: result.int64 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[phash-inspector] pipeline error:', err);
      _emit(jobId, 'error', { message });
      return { ok: false, error: message };
    }
  },

  /** Which ffmpeg is doing the decoding -- shown in the header so a mismatch
   *  against Stash can be traced to a build difference. */
  async describeBackend() {
    return { name: 'ffmpeg.wasm', detail: `@ffmpeg/core ${window.FFMPEG_CORE_VERSION || ''}`.trim() };
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
