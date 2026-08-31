'use strict';

/**
 * Regression harness against a live Stash instance.
 *
 * Usage: node tools/stash-check.js [--url http://localhost:9999/graphql] [--filter substring]
 *
 * Asks Stash (GraphQL) for every file that has a stored phash, runs this
 * port's pipeline on each one, and prints the Hamming distance per file.
 * Exit code is non-zero if any file mismatches or fails, so it can gate a
 * change to the algorithm or the ffmpeg invocation.
 *
 * Point FFMPEG_PATH / FFPROBE_PATH at the same binaries Stash uses to take
 * ffmpeg-version differences out of the picture.
 */

const { runPipeline } = require('../src/pipeline');
const { hammingDistance } = require('../shared/phash-core');
const { describeBinaries } = require('../src/ffmpeg-extract');

const QUERY = `{
  findScenes(filter: { per_page: -1 }) {
    scenes { files { path duration width height video_codec fingerprints { type value } } }
  }
}`;

function parseArgs(argv) {
  const opts = { url: process.env.STASH_URL || 'http://localhost:9999/graphql', filter: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') opts.url = argv[++i];
    else if (argv[i] === '--filter') opts.filter = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return opts;
}

async function fetchFiles(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) throw new Error(`Stash returned HTTP ${res.status}`);
  const { data, errors } = await res.json();
  if (errors) throw new Error(`GraphQL: ${errors.map((e) => e.message).join('; ')}`);

  const seen = new Set();
  const files = [];
  for (const scene of data.findScenes.scenes) {
    for (const f of scene.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const phash = f.fingerprints.find((x) => x.type === 'phash');
      if (phash) files.push({ ...f, phash: phash.value });
    }
  }
  return files;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  let files = await fetchFiles(opts.url);
  if (opts.filter) files = files.filter((f) => f.path.includes(opts.filter));

  const bins = await describeBinaries();
  console.log(`stash: ${opts.url}`);
  console.log(`ffmpeg: ${bins.ffmpeg.path} (${bins.ffmpeg.version})`);
  console.log(`ffprobe: ${bins.ffprobe.path} (${bins.ffprobe.version})`);
  console.log(`files: ${files.length}\n`);

  let failures = 0;
  for (const f of files) {
    const started = Date.now();
    try {
      const { duration, result } = await runPipeline(f.path, () => {}, { preview: false });
      const distance = hammingDistance(result.hash, BigInt('0x' + f.phash));
      if (distance !== 0) failures++;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `${distance === 0 ? 'OK  ' : 'DIFF'} dist=${String(distance).padStart(2)}  ` +
        `dur=${duration.toFixed(2)}/${f.duration}  ${f.width}x${f.height} ${f.video_codec}  ${secs}s  ${f.path}`
      );
    } catch (err) {
      failures++;
      console.log(`ERR  ${f.path}: ${err.message.split('\n')[0]}`);
    }
  }

  console.log(`\nmismatches: ${failures}/${files.length}`);
  process.exit(failures === 0 ? 0 : 2);
})().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
