'use strict';

const { spawn } = require('child_process');
const { decodeBMP } = require('../shared/bmp');

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
  return duration;
}

/**
 * Mirrors transcoder.ScreenshotTime: input-seeking (-ss before -i), a
 * single frame, output as uncompressed BMP so no lossy compression enters
 * the hash pipeline. When `width` is given, scales to that width with
 * height auto-computed to keep aspect ratio and stay even (-2) -- this is
 * the path used for the actual 160px hash frame. When `width` is omitted,
 * no `-vf scale` filter is applied at all, so the frame comes out at the
 * source video's native resolution (used for the filmstrip/zoom preview).
 */
async function extractFrame(inputPath, timeSeconds, { width } = {}) {
  const args = [
    '-v', 'error',
    '-ss', String(timeSeconds),
    '-i', inputPath,
    '-frames:v', '1',
  ];
  if (width != null) {
    args.push('-vf', `scale=${width}:-2`);
  }
  args.push('-c:v', 'bmp', '-f', 'image2', 'pipe:1');
  const bmpBuffer = await run(getFfmpegPath(), args);
  return decodeBMP(bmpBuffer);
}

module.exports = { probeDuration, extractFrame };
