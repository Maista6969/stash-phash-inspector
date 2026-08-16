'use strict';

/**
 * End-to-end check of the browser build: serves web/dist plus one video
 * over HTTP, drives a headless Chromium through the Chrome DevTools
 * Protocol, runs the video through the real ffmpeg.wasm pipeline in the
 * page, and prints the resulting hash (and the Hamming distance if an
 * expected hash is given).
 *
 * Usage: node tools/web-check.js <video> [expectedHex] [--chrome /path/to/chromium]
 *
 * Needs: `pnpm run web:build` already run, and a Chromium/Chrome binary
 * (CHROME env var, --chrome, or `chromium` / `google-chrome` on PATH).
 * No npm dependencies -- Node 22+'s built-in fetch/WebSocket are enough.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { hammingDistance } = require('../shared/phash-core');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png',
};

function parseArgs(argv) {
  const out = { video: null, expected: null, chrome: process.env.CHROME || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--chrome') out.chrome = argv[++i];
    else if (!out.video) out.video = argv[i];
    else if (!out.expected) out.expected = argv[i];
  }
  return out;
}

function findChrome(explicit) {
  const candidates = [explicit, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c.includes('/') ? fs.existsSync(c) : execSync(`command -v ${c}`, { stdio: 'pipe' }).toString().trim()) return c;
    } catch { /* keep looking */ }
  }
  throw new Error('No Chromium binary found; pass --chrome or set CHROME');
}

function serve(dist, videoPath) {
  const videoName = path.basename(videoPath);
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file;
    if (url === `/__video/${videoName}`) file = videoPath;
    else file = path.join(dist, url === '/' ? 'index.html' : url);
    if (!file.startsWith(dist) && file !== videoPath) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, videoName })));
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else events.push(msg);
  };
  return {
    // Resolves with the CDP `result` object, rejects on a CDP error.
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    events,
    close: () => ws.close(),
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.video) {
    console.error('Usage: node tools/web-check.js <video> [expectedHex] [--chrome path]');
    process.exit(1);
  }
  const dist = path.join(__dirname, '..', 'web', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('web/dist missing -- run `pnpm run web:build` first');
  const chrome = findChrome(opts.chrome);
  const { server, port, videoName } = await serve(dist, path.resolve(opts.video));
  const userDataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phash-web-check-'));

  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devtoolsUrl = null;
  proc.stderr.on('data', (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(d.toString());
    if (m) devtoolsUrl = m[1];
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    proc.kill();
    server.close();
    // Chromium keeps writing to its profile for a moment after SIGTERM.
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  process.on('exit', cleanup);

  for (let i = 0; i < 100 && !devtoolsUrl; i++) await new Promise((r) => setTimeout(r, 100));
  if (!devtoolsUrl) throw new Error('Chromium did not report a DevTools URL');
  const httpBase = `http://${devtoolsUrl.split('/')[2]}`;
  const targets = await (await fetch(`${httpBase}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const client = await cdp(page.webSocketDebuggerUrl);

  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  for (let i = 0; i < 100; i++) {
    const { result } = await client.send('Runtime.evaluate', { expression: 'document.readyState === "complete" && !!window.phashAPI && !!window.PipelineCore' });
    if (result.value) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Drive the same public API the renderer uses; addVideo() then runs the
  // full UI path too, so a hash card appearing means the page really works.
  const expression = `(async () => {
    const res = await fetch('/__video/${encodeURIComponent(videoName)}');
    const file = new File([await res.blob()], ${JSON.stringify(videoName)});
    const [name] = window.phashAPI.registerFiles([file]);
    addVideo(name);
    const started = Date.now();
    while (Date.now() - started < 600000) {
      const hex = document.querySelector('.hash-hex').textContent;
      const status = document.querySelector('.filmstrip-row .status').textContent;
      if (/^[0-9a-f]{16}$/.test(hex)) {
        // Also exercise the "compare against a known phash" box with the
        // signed int64 spelling, the one Stash's database uses.
        const input = document.querySelector('.golden-input');
        input.value = document.querySelector('.hash-int64').textContent;
        input.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 200));
        return {
          hex, status,
          backend: document.getElementById('backend-info').textContent,
          frames: document.querySelectorAll('.filmstrip figure').length,
          golden: document.querySelector('.golden-result').textContent,
        };
      }
      if (status.startsWith('Error')) return { error: status };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { error: 'timeout' };
  })()`;
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 620000 });
  if (exceptionDetails) throw new Error(`page threw: ${JSON.stringify(exceptionDetails.exception || exceptionDetails)}`);
  const out = result.value;
  const consoleErrors = client.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => { const d = e.params.exceptionDetails; return `${d.text} ${d.exception ? d.exception.description : ''} @ ${d.url}:${d.lineNumber}`; });
  client.close();

  if (out.error) {
    console.error('FAILED:', out.error, consoleErrors.length ? `\nconsole: ${consoleErrors.join('\n')}` : '');
    process.exit(1);
  }
  if (consoleErrors.length) console.log(`page exceptions:\n  ${consoleErrors.join('\n  ')}`);
  console.log(`backend: ${out.backend}`);
  console.log(`frames rendered: ${out.frames}`);
  console.log(`hash hex: ${out.hex}`);
  console.log(`int64 round-trip via the compare box: ${out.golden}`);
  if (!out.golden.startsWith('exact match')) {
    console.error('FAILED: the compare box did not recognise the int64 form of the hash');
    process.exit(1);
  }
  if (opts.expected) {
    const distance = hammingDistance(BigInt('0x' + out.hex), BigInt('0x' + opts.expected));
    console.log(`expected: ${opts.expected}\nhamming distance: ${distance} ${distance === 0 ? '(exact match)' : '(MISMATCH)'}`);
    process.exit(distance === 0 ? 0 : 2);
  }
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
