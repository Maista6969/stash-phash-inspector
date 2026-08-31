'use strict';

const { spawn } = require('child_process');
const { decodeBMP } = require('../shared/bmp');
const { roundDurationLikeStash } = require('../shared/phash-core');

/**
 * Resolves which ffmpeg/ffprobe binary to actually run, in priority order:
 *   1. FFMPEG_PATH / FFPROBE_PATH env vars -- explicit override. The Nix
 *      devShell sets these to the Nix store's ffmpeg so local development
 *      never depends on the optional npm-downloaded binaries below.
 *   2. The bundled `ffmpeg-static` / `ffprobe-static` npm packages, if
 *      installed -- these ship a real binary and are what packaged
 *      Electron releases use so end users don't need ffmpeg installed at
 *      all. They're `optionalDependencies` (see package.json) precisely
 *      so environments that don't want them (e.g. NixOS, where a
 *      non-Nix-built binary may not run) can skip the install cleanly.
 *   3. Plain 'ffmpeg' / 'ffprobe' resolved from PATH, as a last resort.
 */
function resolveBinary(envVar, staticModuleName, fallbackCommand) {
  if (process.env[envVar]) return process.env[envVar];

  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const resolved = require(staticModuleName);
    let binPath = typeof resolved === 'string' ? resolved : resolved.path;
    if (binPath) {
      // When packaged, this path points inside app.asar, which isn't
      // executable -- electron-builder unpacks these two modules (see
      // package.json "build.asarUnpack") to a sibling app.asar.unpacked
      // directory; redirect there.
      binPath = binPath.replace('app.asar', 'app.asar.unpacked');
      return binPath;
    }
  } catch {
    // Optional dependency not installed -- fall through to PATH.
  }

  return fallbackCommand;
}

let ffmpegPath;
let ffprobePath;
function getFfmpegPath() {
  if (!ffmpegPath) ffmpegPath = resolveBinary('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg');
  return ffmpegPath;
}
function getFfprobePath() {
  if (!ffprobePath) ffprobePath = resolveBinary('FFPROBE_PATH', 'ffprobe-static', 'ffprobe');
  return ffprobePath;
}

/**
 * Runs a command and collects stdout as a Buffer. Rejects on non-zero exit.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * Mirrors how Stash determines VideoFile.Duration: the container/format
 * duration from ffprobe, NOT "seek to the end and read the last packet"
 * (that trick is only needed by standalone reimplementations that don't
 * already have a probed VideoFile on hand). Getting this right matters a
 * lot -- every one of the 25 sample timestamps is derived from it.
 */
async function probeDuration(inputPath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ];
  const out = await run(getFfprobePath(), args);
  const duration = parseFloat(out.toString().trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine duration for ${inputPath} (got "${out.toString().trim()}")`);
  }
  return roundDurationLikeStash(duration);
}

/**
 * Mirrors transcoder.ScreenshotTime with ScreenshotOutputTypeBMP: a single
 * frame, output as uncompressed BMP so no lossy compression enters the hash
 * pipeline. When `width` is given, scales to that width with height
 * auto-computed to keep aspect ratio and stay even (-2) -- this is the path
 * used for the actual 160px hash frame. When `width` is omitted, no `-vf
 * scale` filter is applied at all, so the frame comes out at the source
 * video's native resolution (used for the filmstrip/zoom preview).
 *
 * `slowSeek` mirrors ScreenshotOptions.SlowSeek: normally `-ss` goes before
 * `-i` (fast keyframe seek, then decode up to the exact time); with
 * slowSeek it goes after `-i`, decoding from the start. Stash flips to slow
 * seek for the rest of a video the first time a fast seek fails.
 */
async function extractFrame(inputPath, timeSeconds, { width, slowSeek = false, preview = false } = {}) {
  const seek = ['-ss', formatSeconds(timeSeconds)];
  const args = ['-v', 'error', '-y'];
  if (!slowSeek) args.push(...seek);
  args.push('-i', inputPath);
  if (slowSeek) args.push(...seek);
  args.push('-frames:v', '1');
  if (width != null) {
    args.push('-vf', `scale=${width}:-2`);
  }
  if (preview) {
    // Display-only frames stay compressed: a native-resolution RGBA frame
    // is tens of MB, and 25 of them per video would have to cross IPC and
    // sit in renderer memory. PNG is lossless, so the zoom view is still
    // pixel-exact; a low compression level keeps the encode fast.
    args.push('-c:v', 'png', '-compression_level', '20', '-f', 'image2', 'pipe:1');
    return { png: await run(getFfmpegPath(), args) };
  }
  // ScreenshotOutputTypeBMP: codec bmp, format rawvideo (byte-identical to
  // image2 for a single frame, but this is the literal Stash invocation).
  args.push('-c:v', 'bmp', '-f', 'rawvideo', 'pipe:1');
  const bmpBuffer = await run(getFfmpegPath(), args);
  return decodeBMP(bmpBuffer);
}

// options.go: `fmt.Sprint(seconds)` -- Go's %v for float64 is the shortest
// representation that round-trips, which is also what JS String() gives.
function formatSeconds(t) {
  return String(t);
}

/**
 * Which binaries are actually in use and what version they report. Stash
 * downloads its own ffmpeg (6.1 at the time of writing), and swscale output
 * can differ between ffmpeg versions, so when a hash doesn't match the
 * first question is "which ffmpeg produced each side?".
 */
async function describeBinaries() {
  async function describe(cmd) {
    try {
      const out = await run(cmd, ['-version']);
      const first = out.toString().split('\n')[0];
      const m = /version\s+(\S+)/.exec(first);
      return { path: cmd, version: m ? m[1] : first.trim() };
    } catch (err) {
      return { path: cmd, version: `unavailable (${err.message.split('\n')[0]})` };
    }
  }
  return {
    ffmpeg: await describe(getFfmpegPath()),
    ffprobe: await describe(getFfprobePath()),
  };
}

module.exports = { probeDuration, extractFrame, describeBinaries };
