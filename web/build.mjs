// Assembles web/dist -- the folder GitHub Pages actually serves.
//
// Deliberately dependency-free (just Node's fs) rather than using a
// bundler: the UI is plain browser JS, and ffmpeg.wasm already ships UMD
// builds we can copy as-is and load with <script> tags.
//
// Files gathered from three places into one output directory:
//   - this folder (index.html, browser-api.js)
//   - ../src  (renderer.js, styles.css -- the EXACT same files the Electron
//               app uses; browser-api.js provides window.phashAPI so they
//               run unchanged in both contexts)
//   - ../shared (phash-core.js / bmp.js -- one canonical copy of the algorithm)
//   - node_modules/@ffmpeg/* (vendored so the site works without a CDN)
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dist = path.join(__dirname, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(path.join(dist, 'shared'), { recursive: true });
mkdirSync(path.join(dist, 'vendor', 'core'), { recursive: true });

function copy(src, dest) {
  if (!existsSync(src)) {
    throw new Error(`Missing expected file: ${src}\nDid you run "pnpm install" first?`);
  }
  cpSync(src, dest);
  console.log(`${path.relative(__dirname, src)} -> ${path.relative(__dirname, dest)}`);
}

// Web-specific shell
copy(path.join(__dirname, 'index.html'),      path.join(dist, 'index.html'));
copy(path.join(__dirname, 'browser-api.js'),  path.join(dist, 'browser-api.js'));

// Shared UI -- the exact same files shipped in the Electron app
copy(path.join(root, 'src', 'renderer.js'),  path.join(dist, 'renderer.js'));
copy(path.join(root, 'src', 'styles.css'),   path.join(dist, 'styles.css'));

// The one canonical copy of the hashing algorithm
copy(path.join(root, 'shared', 'phash-core.js'), path.join(dist, 'shared', 'phash-core.js'));
copy(path.join(root, 'shared', 'bmp.js'),         path.join(dist, 'shared', 'bmp.js'));

// Vendored ffmpeg.wasm (UMD build -- loaded as a plain <script> tag, no
// bundler needed). Self-hosted so the page works offline once cached and
// doesn't depend on a third party staying up.
//
// @ffmpeg/util is intentionally NOT vendored: its UMD build is broken for
// browsers (internally uses CJS `exports` and `require`). We only needed it
// for fetchFile(), which is replaced by File.arrayBuffer() in browser-api.js.
//
// Copy ALL .js files from the ffmpeg UMD directory, not just ffmpeg.js --
// the bundle spawns a Web Worker from a separate webpack chunk (e.g.
// 814.ffmpeg.js) whose name may change across versions.
const nm = path.join(__dirname, 'node_modules');
const ffmpegUmdDir = path.join(nm, '@ffmpeg', 'ffmpeg', 'dist', 'umd');
if (!existsSync(ffmpegUmdDir)) {
  throw new Error(`Missing expected directory: ${ffmpegUmdDir}\nDid you run "pnpm install" first?`);
}
for (const f of readdirSync(ffmpegUmdDir).filter(f => f.endsWith('.js'))) {
  copy(path.join(ffmpegUmdDir, f), path.join(dist, 'vendor', f));
}
copy(path.join(nm, '@ffmpeg', 'core', 'dist', 'umd', 'ffmpeg-core.js'),   path.join(dist, 'vendor', 'core', 'ffmpeg-core.js'));
copy(path.join(nm, '@ffmpeg', 'core', 'dist', 'umd', 'ffmpeg-core.wasm'), path.join(dist, 'vendor', 'core', 'ffmpeg-core.wasm'));

console.log('\nBuilt web/dist. To preview locally:\n  pnpm run web:start\n(Don\'t open index.html via file:// -- ffmpeg.wasm must be served over http/https.)');
