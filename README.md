# Stash pHash Inspector

A small desktop and browser tool that reproduces [Stash](https://github.com/stashapp/stash)'s video fingerprint (also known as the PHASH, the perceptual hash) one stage at a time, so you can see _why_ two videos got the
fingerprints they did. Everything runs on your own machine; nothing is uploaded anywhere.

Try it in the browser at [maista6969.github.io/stash-phash-inspector](https://maista6969.github.io/stash-phash-inspector/), or grab a desktop build from the [releases page](https://github.com/Maista6969/stash-phash-inspector/releases).

## Why this exists

Stash's duplicate finder works off a 64-bit perceptual hash, and most of the time it does what you'd hope: two encodes of the same video land a
handful of bits apart and get flagged. But when it goes wrong there is nothing to look at. Two files that are obviously the same come back 20
bits apart, or a file you re-encoded at a different resolution hashes to a completely different value, and all you have is a pair of hex strings.
Is it a bad frame sample? A scene cut that landed differently? A different duration reported by ffprobe? Stash doesn't say, because it was never
meant to explain itself. I wanted to see the 25 frames it picked, the collage it built from them, and the exact coefficients that decided each bit,
side by side for both files, and to be able to trust that what I was looking at was really what Stash computed and not an approximation of it.
So this tool reproduces the algorithm bit for bit and draws every intermediate step.

## How it works

Add one or more videos with the button, or drop them onto the window. For each one the tool does what Stash does:

1. **Probes the duration** with ffprobe and works out the 25 sample points Stash uses: skip the first and last 5%, then spread evenly
2. **Grabs one frame at each point** with ffmpeg, scaled to 160 pixels wide, exactly the way Stash does it. These show up as a filmstrip
3. **Tiles the 25 frames into a 5x5 collage.** This collage is the only thing that ever gets hashed
4. **Hashes the collage:** shrink to 64×64, convert to grey, take a discrete cosine transform, keep the 8×8 lowest frequencies, and set a
   bit for every coefficient above the median. That gives the 64-bit fingerprint, shown as hex and as the signed integer Stash stores

The page is organised by stage rather than by video, so all filmstrips sit together, then all collages, then all frequency grids, then all hashes.
When you're comparing two files, that keeps the things you want to compare next to each other. Filmstrips scroll in sync.

Everything is clickable:

- **Click a frame** for a before/after slider between two videos at the same sample index, at the source's full resolution.
  Arrow keys step through the samples.
- **Click a collage** for the same slider on the actual hashed pixels, with an optional heatmap showing which regions pushed the two
  fingerprints apart
- **Click a frequency grid** to see exactly which of the 64 bits flipped between two videos
- **Paste a known fingerprint** from Stash (hex or the signed integer) under any hash to check for an exact match

Two videos are processed at a time; the rest queue. Each row has a Remove button. The header shows which ffmpeg build is doing the
decoding, which can really matter.

## Limitations

**ffmpeg's decoder is not the risk; ffprobe's duration can be.** I
expected different ffmpeg versions to produce slightly different pixels.
They don't, at least not for H.264: the 160-pixel frames from ffmpeg
4.4, 6.1, 7.0, 7.1, 8.1 and 9.0 are byte-for-byte identical on every
frame of every file tested, and all of them reproduce Stash's hashes.
What did differ was ffprobe. The 4.x series reports the duration of some
MP4s a few milliseconds differently from 6.x and later, and because
every sample time is a fraction of that number, a 4.x ffprobe put three
samples on the wrong frame of a test clip and got a hash 22 bits away.
Use an ffprobe from the same era as Stash's (6.x or newer). The header
shows which versions are in use, and `FFMPEG_PATH` / `FFPROBE_PATH`
override them.

**Duration is the sensitive input.** All 25 sample times are a fraction of the probed duration, so if ffprobe reports a slightly different
duration than it did when Stash scanned the file (variable frame rate, odd containers), the samples shift and can land on the other side of a
scene cut. The app shows the duration it used so you can check it against Stash.

**The browser build is slower and its previews are smaller.** ffmpeg.wasm runs single-threaded, and previews are capped at 480 pixels wide to keep
memory in check. The hashed frames themselves are identical. Use the desktop build for full-resolution comparison.

**It tracks the current Stash algorithm.** If Stash changes [how it generates the sprite or hashes it](https://github.com/stashapp/stash/issues/3722),
this will need updating. The constants and commands all live in one file with comments pointing at the Stash source they mirror.

**Release builds are unsigned**, and the Windows and macOS packages are produced by CI without being launched by a person. The Linux AppImage has been run.

## Technical details

If you only want to use the tool you can stop here. This section is for anyone who wants to know what "bit for bit" actually rests on.

### One copy of the algorithm

`shared/phash-core.js` is the whole algorithm, and it is the only copy. The Electron app requires it; the browser build copies the same file into
the page. The stage orchestration (probe, sample, seek fallback, collage, hash) is likewise one file, `shared/pipeline-core.js`, that both builds
plug their own ffmpeg into. A fix only ever has to happen once.

### The details that turned out to matter

Most of the algorithm is a straightforward port. A few things are not obvious from a description of pHash:

- **Duration is rounded to two decimals before anything else.** Stash rounds the ffprobe duration when it scans a file, and the sample times
  are computed from that rounded value. Skipping this moves every sample by up to 5 ms. That sounds like nothing, but on synthetic clips where
  every frame differs it flips 14 to 28 of the 64 bits, and I verified against a running Stash that the rounded version is the right one.
- **The ffmpeg command is copied, not approximated.** Fast seek before the input, one frame, `scale=160:-2`, BMP out over `rawvideo`. If a fast
  seek fails, Stash retries that frame with an accurate seek and keeps accurate seeking for the rest of that video, so this does too. Six
  ffmpeg releases from 4.4 to 9.0 give identical bytes for this command on H.264 input, so the decode step is stable across versions.
- **The 64×64 shrink is integer arithmetic.** Stash uses the `nfnt/resize` Go library, which quantises its bilinear weights to 16-bit integers,
  truncates rather than rounds, and divides by the sum of the quantised weights it actually used. A floating-point resize gives different bytes
  on some pixels, and a different byte can flip a bit.
- **The DCT is a specific algorithm, not just the DCT.** `goimagehash` uses Lee's recursive fast DCT with hard-coded constants. Any
  mathematically equivalent DCT can round differently in the last digit, and on noisy input that is enough to move a coefficient across the
  median. This port does the same operations in the same order.
- **The median includes the DC term** and is the mean of the two middle values of all 64 coefficients, which is what the Go code does, even
  though textbook pHash excludes DC.
- **A quirk is kept on purpose.** Stash's collage code divides by the row count where it means the column count. It only works because the grid
  is square, and this port does the same thing so the two can't drift.

### How it is verified

- `pnpm test` hashes a fixed set of synthetic images (noise at many sizes and aspect ratios, solid colours, gradients, tiled collages) plus
  a real collage exported from a video, and checks every hash against values produced by the actual Go libraries Stash uses, pinned to the
  versions in Stash's `go.mod`. The Go program that generates those values is in `tools/go-reference`.
- `tools/stash-check.js` asks a running Stash instance for every file it has fingerprinted, hashes each one with this tool, and reports the
  distance. On the development library, every file matches with Stash's own ffmpeg 6.1 and with ffmpeg 6.1.6, 7.0, 7.1, 8.1 and 9.0. ffmpeg
  4.4 matches too, but only when paired with a newer ffprobe.
- `tools/ui-check.js` drives the real UI, both the browser build in a headless Chromium and the Electron app, through loading a video,
  rendering, hashing, and the compare box.

### Setup

Requires `ffmpeg` and `ffprobe` on your `PATH` for development; packaged releases bundle their own.

```
pnpm install
pnpm start
```

On NixOS, use the flake so Electron and ffmpeg come from the Nix store:

```
nix develop
pnpm install
pnpm start
```

The flake sets `ELECTRON_OVERRIDE_DIST_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH`; `pnpm start` passes `--no-sandbox` because the Chromium
setuid helper isn't set up in a dev shell.

Useful commands:

```
pnpm test                                  # unit tests + golden hashes
node tools/self-test.js <video> [hash]     # hash one file headlessly
node tools/stash-check.js --url http://localhost:9999/graphql
pnpm run web:build && pnpm run web:start   # browser build, served locally
node tools/ui-check.js [--electron] <video> [hash]
```

Point `stash-check` at Stash's own binaries to rule out ffmpeg differences:

```
FFMPEG_PATH=/path/to/stash/ffmpeg FFPROBE_PATH=/path/to/stash/ffprobe \
  node tools/stash-check.js --url http://localhost:9999/graphql
```

### Releases

Pushing a `v*` tag builds a Linux AppImage, a Windows portable `.exe`, and macOS `.zip`s for both architectures, and attaches them to a draft
GitHub release. Every push to `main` that touches the web build or the shared files redeploys the browser version to GitHub Pages.

### Layout

```
main.js / preload.js       Electron main process and IPC bridge
shared/
  phash-core.js            The algorithm
  pipeline-core.js         Stage orchestration, bound to a backend by both builds
  bmp.js                   Tiny BMP decoder for ffmpeg's output
  hash-format.js           hex / int64 parsing
src/
  ffmpeg-extract.js        Native ffmpeg/ffprobe calls
  pipeline.js              Node binding of pipeline-core
  index.html, renderer.js, styles.css   The UI (renderer and styles are shared with web/)
web/
  browser-api.js           ffmpeg.wasm binding of pipeline-core
  build.mjs                Assembles web/dist
test/                      Test suite and Go-generated golden hashes
tools/                     self-test, stash-check, ui-check, go-reference
```
