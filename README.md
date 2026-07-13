# Stash pHash Inspector

A standalone Electron app that reproduces and visualizes
[Stash](https://github.com/stashapp/stash)'s video perceptual hash
algorithm (`pkg/hash/videophash/phash.go`), stage by stage, entirely on
your machine. Nothing is uploaded anywhere.

## Setup

**On NixOS**, use the included flake instead of a raw `pnpm install` for
Electron itself:

```
nix develop
pnpm install
pnpm start
```

The flake provides `nodejs`, `pnpm`, `ffmpeg`/`ffprobe`, and a nixpkgs-built
`electron` binary (wired up via `ELECTRON_OVERRIDE_DIST_PATH` so `pnpm`'s
own `electron` package never needs to download a binary). `pnpm start`
launches with `--no-sandbox`, since Chromium's setuid sandbox helper
generally isn't set up in a Nix devShell — this only disables the OS-level
process sandbox for this local dev tool; the app loads no remote content.

**Everywhere else:**

```
pnpm install
pnpm start
```

This is a pnpm workspace (`pnpm-workspace.yaml`) covering the root Electron
app and `web/` (the GitHub Pages build) — one lockfile, one `pnpm install`
at the repo root sets both up. If you only care about the web build, `cd
web && pnpm install` still works on its own.

Requires `ffmpeg` and `ffprobe` on your `PATH` either way (the same
requirement Stash itself has).

## Layout

The app is organized by _pipeline stage_, not by video: all videos'
frame filmstrips are grouped together, then all collages, then all DCT
heatmaps, then all hashes. That's deliberate — the point of the tool is
comparing two similar videos, and putting the same stage next to each
other (filmstrips stacked directly above one another, collages side by
side) means your eye travels a few pixels instead of a full page scroll.
Filmstrip rows also scroll in sync: dragging any one of them scrolls all
of them together, so sample index N lines up across videos.

The filmstrip thumbnails are a **second screenshot at the source video's
native resolution**, taken at the exact same timestamp as each hash frame,
purely so the frames are readable and the zoom/slider comparison is
pixel-accurate. It's a separate `ffmpeg` call with no scale filter at all
— the 160px frame that actually gets hashed is extracted independently
and never touches the display path.

## Zooming in

Everything in the app is clickable:

- **Click a frame** in any filmstrip to open a draggable before/after slider
  against another loaded video at the same sample index — drag the handle
  (or use the invisible full-width range track under it) to wipe between
  the two. Both sides are extracted at the **source video's native
  resolution** (a separate, unscaled ffmpeg call at the same timestamp;
  never a re-extraction of what's already in memory, and never touches the
  160px hash path). Switch which two videos you're comparing with the
  Video A / Video B dropdowns, and step through sample indices with the
  Prev/Next buttons or the ← / → arrow keys, without closing the modal.
- **Click a collage** to open the same slider, but for the literal
  160px-tile pixels that get hashed — this is the view to trust if you're
  debugging a mismatch. Check "Overlay DCT diff contribution" to lay a
  heatmap over the slider showing which regions of the (downsampled)
  collage the coefficients that actually flipped bits care about most —
  see the DCT grid bullet below for what "care about" means here.
- **Click a DCT grid** to open a bit-level diff: pick any two loaded
  videos and see three 8×8 grids side by side — video A, a diff grid
  highlighting exactly which of the 64 coefficients landed on opposite
  sides of the median (i.e. which bits actually flipped and contributed
  to the Hamming distance), and video B. The same cells are outlined in
  red on the A/B grids too, so you can trace a specific frequency
  coefficient's value on both sides.

**About the collage's DCT overlay:** a DCT coefficient isn't "located" at
one pixel — each one is a weighted sum over the *entire* 64×64 downsampled
grid via its own 2D cosine basis function. So the overlay isn't a literal
"these exact pixels changed" map; it's the magnitude of the flipped
coefficients' basis functions (weighted by how much each one's value
actually differs between the two videos), which tells you where the
brightness *pattern* those specific frequencies respond to is strongest.
Low-frequency coefficients (near the top-left of the DCT grid) light up
broad regions; higher-frequency ones light up finer, more localized
patterns.

## Theme

Colors are lifted directly from Stash's own dark theme
(`ui/v2.5/src/styles/_theme.scss`) so the tool feels at home next to the
app it's inspecting: `#202b33` background, `#30404d` cards, `#137cbd`
primary, `#48aff0` links, and the same success/warning/danger accents.

## What it does

For each video you add, it:

1. Probes duration with `ffprobe` and computes the same 25 sample
   timestamps Stash does (`offset = 0.05 * duration`,
   `step = 0.9 * duration / 25`).
2. Extracts each frame with the _exact same ffmpeg invocation_ Stash uses
   (`-ss T -i file -frames:v 1 -vf scale=160:-2 -c:v bmp`), shown as a
   filmstrip.
3. Assembles the 5×5 collage (montage) exactly as Stash's
   `combineImages` does.
4. Runs the perceptual hash algorithm (`goimagehash.PerceptionHash`) —
   64×64 anti-aliased resize → grayscale → top-left 8×8 DCT-II block →
   median threshold → 64-bit hash — and shows the DCT coefficient heatmap
   and resulting bits.
5. Lets you compare hashes across multiple loaded videos (Hamming
   distance matrix) or paste in a hash you already have from a real Stash
   instance to check for an exact match.

Run `node tools/self-test.js <video> [expectedHash]` to do the same thing
headlessly from the command line — handy for scripting a batch check
against a folder of files you've already hashed in Stash.

## Fidelity notes — read this before trusting a "match"

This is a clean-room JavaScript port, not a recompilation of Stash's Go
code, so it's honest to separate what's verified from what's inferred.
Every stage in `shared/phash-core.js` has a `CONFIDENCE` comment; summary:

| Stage                   | Confidence | Why                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sample timestamps       | High       | Read directly from `phash.go` source (v0.28.1 tag).                                                                                                                                                                                                                                                       |
| ffmpeg frame extraction | High       | Uses the literal ffmpeg binary with the same args Stash passes (confirmed from a Stash issue thread showing the real command line), so decode/scale math is whatever your installed ffmpeg's libswscale does — same as Stash if you use the same ffmpeg build.                                            |
| Montage assembly        | High       | Simple pixel copy, matches `imaging.New` + `imaging.Paste` (no blending, no compression) — confirmed against `disintegration/imaging`'s actual `tools.go` source.                                                                                                                                        |
| 64×64 resize            | **High**   | Line-for-line port of `nfnt/resize`'s actual fixed-point Bilinear path (`resize.go`/`filters.go`/`converter.go`), including int16 weight quantization, truncating (not rounded) integer division, and edge-clamp behavior — not a floating-point approximation of it.                                    |
| Grayscale               | High       | Verified against `transforms/pixels.go`: reduces to plain `0.299R + 0.587G + 0.114B` on the resize's exact 8-bit output.                                                                                                                                                                                  |
| DCT-II                  | High       | Line-for-line port of `transforms/static.go`'s `forwardDCT64`/`32`/`16`/`8`/`4` (Lee's recursive algorithm) and its exact constant tables, not a mathematically-equivalent-but-differently-ordered re-derivation.                                                                                        |
| Median + bit packing    | High       | Read directly from `hashcompute.go` and `etcs/utils.go`: median is the average of the two middle values of the 64 DCT coefficients (`quickSelectMedian`'s even-length branch), and `if p > median { leftShiftSet(64-idx-1) }`.                                                                          |

**This has been cross-checked against the real upstream Go libraries, not
just read from source.** `shared/phash-core.js` was validated by building
an actual local Go module tree with unmodified copies of `nfnt/resize`,
`corona10/goimagehash`, and `disintegration/imaging` fetched straight from
GitHub, computing `goimagehash.PerceptionHash` on 25+ synthetic test
images (random noise at several sizes/aspect ratios, plus solid colors and
extreme aspect ratios), and diffing the result against this JS port
byte-for-byte. All cases now match bit-for-bit. That process actually
caught two real bugs along the way, not just approximation gaps:

- The 64×64 resize previously re-normalized filter weights to sum to
  exactly 1.0 in floating point, whereas `nfnt/resize` quantizes weights
  to `int16` and divides by their *actual* (possibly not-quite-256)
  quantized sum — different final byte values on some pixels.
- The DCT previously used a direct-sum re-derivation of the DCT-II math
  that's mathematically equivalent to Lee's recursive algorithm but not
  operation-for-operation identical, so it could round differently on
  values that land very close together — enough, on adversarial random
  noise, to flip which side of the median threshold a coefficient landed
  on.

Both are now literal ports of the upstream algorithms rather than
reimplementations from the general concept, so there's no remaining
"medium confidence" stage — every stage's code takes the same path to the
same bits as the Go original, not merely a mathematically-equivalent one.

If you want to re-run this verification yourself (e.g. after touching
`shared/phash-core.js`, or against your own video's montage rather than
synthetic test images), the included `tools/go-reference/` program uses
the real `goimagehash` + `nfnt/resize` libraries directly:

```
cd tools/go-reference
go mod init phashref && go mod tidy
go run . /path/to/exported-montage.png
```

Export a collage from the app with the "Save collage as PNG…" button, run
it through the Go reference tool, and compare against what the app shows.
Note this is purely an optional development/verification aid — nothing in
the shipped app (desktop or web) runs or depends on Go at any point.

You can also point `tools/self-test.js` at a video whose real Stash phash
you already know, and it'll print the Hamming distance for you — 0 means
an exact bit-for-bit match.

## Why duration matters so much

All 25 timestamps are a linear function of the probed duration. If this
app's ffprobe reports even a slightly different duration than Stash's did
at generation time (different ffmpeg build, container edge case,
variable-frame-rate weirdness), every sample timestamp shifts, and for
short clips that's often enough to land on a different side of a scene
cut — which is exactly the sensitivity this tool is meant to make
visible. Check the "Duration" line the app prints against what Stash
shows for the same file if a hash mismatch looks larger than resize
rounding alone would explain.

## Releases and the web build

This repo builds two things from one codebase:

- **Desktop app** — push a tag like `v0.2.0` and
  `.github/workflows/release.yml` builds Linux/macOS/Windows
  distributables (electron-builder) and attaches them to a GitHub
  Release automatically. All three are portable, single-download
  formats — no installer wizard, no admin rights, no system-wide
  registration:
  - **Linux**: `.AppImage` — one executable file, `chmod +x` and run.
  - **Windows**: `.exe` (electron-builder's `portable` NSIS target) —
    one executable, unpacks to a temp dir at launch, no install step.
  - **macOS**: `.zip` containing the `.app` bundle — unzip and run; no
    `.dmg` drag-to-Applications step. (macOS apps are inherently a
    folder, not a true single file, but this skips the installer UX;
    it'll also be unsigned/unnotarized, so first launch needs
    right-click → Open, or `xattr -c` to clear the quarantine flag.)
    Packaged builds bundle `ffmpeg-static` /
    `ffprobe-static` (optional package dependencies, see below) so end users
    don't need ffmpeg installed at all.
- **Web build** — every push to `main` that touches `web/` or `shared/`
  runs `.github/workflows/pages.yml`, which builds `web/dist` and
  deploys it to GitHub Pages. It's the exact same tool running in the
  browser via [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
  instead of a native ffmpeg binary — no server, no upload, everything
  still runs locally in the visitor's browser.

**Why this can't silently drift into two different tools:** `shared/phash-core.js`
and `shared/bmp.js` are the _only_ copies of the hashing algorithm in the
repo. The Electron app `require()`s them directly; the web build copies
the literal same files into `web/dist/shared/` at build time (see
`web/build.mjs`) and loads them as `<script>` tags (they're written
UMD-style — `module.exports` in Node, `window.X` in the browser). A bug
fix or algorithm change only has to happen once.

To enable Pages: repo Settings → Pages → Source → "GitHub Actions" (one-time
setup). To cut a desktop release: `git tag v0.2.0 && git push --tags`.

### Bundled ffmpeg for packaged releases

`ffmpeg-static` / `ffprobe-static` are listed as `optionalDependencies`
specifically so environments that don't want them (Nix, most notably —
see the flake's `FFMPEG_PATH`/`FFPROBE_PATH` env vars, which take
priority and skip these packages entirely) can omit them cleanly with
`pnpm install --no-optional`. `src/ffmpeg-extract.js` resolves the
actual binary to run in this order: `FFMPEG_PATH`/`FFPROBE_PATH` env vars
→ these bundled packages → `ffmpeg`/`ffprobe` on `PATH`.

### Honesty about what's been tested where

`shared/phash-core.js` has been cross-validated against a real local Go
build of unmodified `nfnt/resize`, `corona10/goimagehash`, and
`disintegration/imaging` (fetched directly from GitHub, not reconstructed
from memory) across 25+ synthetic test images — random noise at several
sizes and aspect ratios, solid colors, and extreme aspect ratios — and
every one now matches the JS output bit-for-bit. `pnpm install`, the
Electron app's own syntax check (`pnpm test`), a real Linux `AppImage`
build via `electron-builder`, and the `web/build.mjs` static-site build
have all actually been run in this environment, not just written and
assumed to work. The Windows `portable` target was **not** built
end-to-end here — cross-compiling a Windows target from Linux needs Wine,
which isn't installed in this sandbox — but the `release.yml` workflow
builds it natively on a `windows-latest` GitHub Actions runner instead of
cross-compiling, which is the standard, more reliable way to do this
anyway; the same electron-builder config that already produced a working
Linux AppImage here is what runs on that runner.

What hasn't been done in this sandbox: an actual click-through of the
Electron UI or the web UI in a real browser (no display here), and an
end-to-end run against a real video file (no `ffmpeg`/sample video
present). Both pipelines are unchanged by this round of work aside from
the `main.js` module-system fix, so give the app a real run — and ideally
`tools/self-test.js` against a video whose Stash phash you already know
— before relying on either the app or the pnpm scripts you haven't
personally executed yet.

## Project layout

```
main.js                  Electron main process (spawns ffmpeg, runs pipeline, IPC)
preload.js                Context-isolated IPC bridge
flake.nix                  Nix devShell (NixOS-friendly Electron + ffmpeg)
shared/
  phash-core.js             THE algorithm: montage, resize, grayscale, DCT, hashing (UMD)
  bmp.js                     Minimal BMP decoder (UMD, DataView-based)
src/
  ffmpeg-extract.js          ffprobe/ffmpeg invocations + binary resolution
  pipeline.js                 Orchestrates the above with progress callbacks (Electron only)
  index.html / renderer.js / styles.css   Electron UI
web/
  index.html / app.js / styles.css   Browser UI + ffmpeg.wasm pipeline
  build.mjs                   Assembles web/dist for GitHub Pages
tools/
  self-test.js               Headless CLI runner
  go-reference/main.go        Optional gold-standard check using the real Go libs
.github/workflows/
  release.yml                 Tag push -> multi-platform Electron build -> GitHub Release
  pages.yml                    Push to main -> build web/ -> deploy to GitHub Pages
```
