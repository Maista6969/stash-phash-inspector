'use strict';

/**
 * A from-scratch port of the hashing math in
 *   github.com/stashapp/stash/pkg/hash/videophash/phash.go
 * which in turn calls
 *   github.com/corona10/goimagehash  PerceptionHash()
 *   github.com/disintegration/imaging  New() / Paste()
 *   github.com/nfnt/resize  Resize(64, 64, img, resize.Bilinear)
 *
 * Every constant and formula below is annotated with where it came from
 * and how confident we are in it. See README.md "Fidelity notes" for the
 * full breakdown and how to validate against a real Stash instance.
 *
 * Image objects in this module are plain {width, height, data} where
 * data is a Uint8ClampedArray of RGBA bytes, row-major, top-to-bottom.
 */

// See https://github.com/stashapp/stash/blob/develop/pkg/hash/videophash/phash.go#L20-L24
const SCREENSHOT_WIDTH = 160;
const COLUMNS = 5;
const ROWS = 5;
// See https://github.com/corona10/goimagehash/blob/v1.1.0/hashcompute.go#L74
const HASH_RESIZE = 64;

// See https://github.com/stashapp/stash/blob/develop/pkg/hash/videophash/phash.go#L84-L86
function computeScreenshotTimestamps(durationSeconds, count = COLUMNS * ROWS) {
  const offset = 0.05 * durationSeconds;
  const stepSize = (0.9 * durationSeconds) / count;
  const timestamps = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(offset + i * stepSize);
  }
  return timestamps;
}

// Roughly equivalent to combineImages at https://github.com/stashapp/stash/blob/develop/pkg/hash/videophash/phash.go#L64-L78
// but frames are {width, height, data} objects instead of the raw image buffers in the source Go implementation
function buildMontage(frames, columns = COLUMNS, rows = ROWS) {
  if (frames.length !== columns * rows) {
    throw new Error(`Expected ${columns * rows} frames, got ${frames.length}`);
  }
  const { width: frameW, height: frameH } = frames[0];
  for (const f of frames) {
    if (f.width !== frameW || f.height !== frameH) {
      throw new Error('All frames must share the same dimensions for montage assembly');
    }
  }

  const canvasW = frameW * columns;
  const canvasH = frameH * rows;
  // starts transparent black, like NRGBA{}
  const data = new Uint8ClampedArray(canvasW * canvasH * 4);

  frames.forEach((frame, idx) => {
    const px = frameW * (idx % columns);
    const py = frameH * Math.floor(idx / rows);
    for (let y = 0; y < frameH; y++) {
      const srcRowStart = y * frameW * 4;
      const dstRowStart = ((py + y) * canvasW + px) * 4;
      data.set(frame.data.subarray(srcRowStart, srcRowStart + frameW * 4), dstRowStart);
    }
  });

  return { width: canvasW, height: canvasH, data };
}

// ---------------------------------------------------------------------------
// Stage: anti-aliased resize to 64x64
// ---------------------------------------------------------------------------
//
// CONFIDENCE: HIGH. This is a line-for-line port of nfnt/resize's actual
// fixed-point Bilinear path, read directly from the upstream source
// (resize.go, filters.go, converter.go @ github.com/nfnt/resize) rather than
// reconstructed from general knowledge of how resamplers work. Three things
// the old floating-point approximation got only approximately right, and
// this version does bit-for-bit:
//
//   1. Weights are quantized to int16 fixed point (kernel(x) * 256, TRUNCATED
//      -- not rounded -- toward zero, matching Go's float64->int16 conversion),
//      not kept as exact floating-point fractions.
//   2. The final pixel value is the *integer* sum of (quantized weight *
//      source byte) divided by the *sum of the quantized weights actually
//      used* (Go: `rgba[0] / sum`, both int32, truncating division) -- NOT
//      divided by a re-normalized-to-exactly-1.0 floating point weight set.
//      Because truncation means quantized weights along a filter window
//      don't always sum to exactly 256, this is a different number than the
//      old code's "divide by exactly 1.0" approach.
//   3. Montage frames go through goimagehash as Go's *image.NRGBA (this is
//      what disintegration/imaging's New()/Paste() produce -- confirmed from
//      imaging's tools.go), which nfnt/resize's type switch handles via its
//      8-bit / int16-coefficient path (createWeights8 + resizeNRGBA), forward
//      alpha-premultiplying each sample before the weighted sum and dividing
//      the accumulated alpha back out at the end. Montage pixels here are
//      always fully opaque (alpha 255 -- the BMP frames have no alpha
//      channel), so premultiply is mathematically a no-op, but it's included
//      below for correctness rather than assumed away.
//
// Every helper name below mirrors its Go counterpart 1:1 so this can be
// diffed against upstream again in the future if nfnt/resize ever changes.

const BILINEAR_TAPS = 2; // resize.go: (2, linear) for the Bilinear InterpolationFunction
const BLUR = 1.0; // resize.go: `var blur = 1.0`

function linearKernel(x) {
  // filters.go: func linear(in float64) float64
  const ax = Math.abs(x);
  return ax <= 1 ? 1 - ax : 0;
}

// Go's int(floatVal) truncates toward zero (not Math.floor, which rounds
// toward -Infinity and disagrees with Go for negative inputs).
function goIntTrunc(f) {
  return f < 0 ? Math.ceil(f) : Math.floor(f);
}

// filters.go: func createWeights8(dy, filterLength int, blur, scale float64, kernel ...) ([]int16, []int, int)
// Returns, per destination index: { start, coeffs: Int16Array }. Coefficients
// are NOT normalized to sum to 1; that happens (via integer division) at sample time.
function createWeights8(dstSize, srcSize) {
  const scale = srcSize / dstSize;
  const filterLength = BILINEAR_TAPS * Math.max(Math.ceil(BLUR * scale), 1);
  const filterFactor = Math.min(1 / (BLUR * scale), 1);

  const perDst = new Array(dstSize);
  for (let d = 0; d < dstSize; d++) {
    let interpX = scale * (d + 0.5) - 0.5;
    const start = goIntTrunc(interpX) - Math.floor(filterLength / 2) + 1;
    interpX -= start;
    const coeffs = new Int16Array(filterLength);
    for (let i = 0; i < filterLength; i++) {
      const inp = (interpX - i) * filterFactor;
      // int16(kernel(in) * 256) in Go truncates toward zero, then wraps as
      // int16. Values here always fit int16 (kernel <= 1 in magnitude).
      coeffs[i] = goIntTrunc(linearKernel(inp) * 256);
    }
    perDst[d] = { start, coeffs };
  }
  return { perDst, filterLength };
}

// Keep value in [0,255], matching converter.go's clampUint8.
function clampUint8(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

// Go's int32/int32 division truncates toward zero. All sums here are
// non-negative (weights and pixel values are both >= 0), so this is a plain
// floor -- spelled out via goIntTrunc for parity with the source.
function intDiv(a, b) {
  return goIntTrunc(a / b);
}

// converter.go: resizeNRGBA / resizeRGBA, collapsed into one generic
// separable pass since our "in" is always fully-opaque RGBA-shaped data
// (both the montage's NRGBA and the intermediate horizontal-pass output
// behave identically once alpha == 255 everywhere).
// getPixel(i) must return [r,g,b,a] as straight (non-premultiplied) values.
function resamplePass(getPixel, srcLen, weightInfo, outCount, packPixel) {
  const { perDst, filterLength } = weightInfo;
  const maxX = srcLen - 1;
  for (let d = 0; d < outCount; d++) {
    const { start, coeffs } = perDst[d];
    let r = 0, g = 0, b = 0, a = 0, sum = 0;
    for (let i = 0; i < filterLength; i++) {
      const coeff = coeffs[i];
      if (coeff === 0) continue;
      let xi = start + i;
      if (xi < 0) xi = 0;
      else if (xi >= maxX) xi = maxX;
      const [pr, pg, pb, pa] = getPixel(xi);
      // Forward alpha-premultiply (converter.go's resizeNRGBA); identity here
      // since pa is always 255, but computed properly for correctness.
      const premR = intDiv(pr * pa, 0xff);
      const premG = intDiv(pg * pa, 0xff);
      const premB = intDiv(pb * pa, 0xff);
      r += coeff * premR;
      g += coeff * premG;
      b += coeff * premB;
      a += coeff * pa;
      sum += coeff;
    }
    if (sum === 0) {
      packPixel(d, 0, 0, 0, 0);
    } else {
      packPixel(d, clampUint8(intDiv(r, sum)), clampUint8(intDiv(g, sum)), clampUint8(intDiv(b, sum)), clampUint8(intDiv(a, sum)));
    }
  }
}

/**
 * Resize an RGBA {width,height,data} image to exactly dstW x dstH, bit-exact
 * with `resize.Resize(dstW, dstH, nrgbaImg, resize.Bilinear)` from nfnt/resize
 * as called by goimagehash.PerceptionHash. Output pixels are already-
 * premultiplied 8-bit RGBA (matching Go's intermediate *image.RGBA), which
 * for our always-opaque montages is identical to straight RGBA.
 */
function resizeAA(image, dstW, dstH) {
  const { width: srcW, height: srcH, data: src } = image;

  const hWeights = createWeights8(dstW, srcW);
  const vWeights = createWeights8(dstH, srcH);

  // Horizontal pass: srcH rows -> dstW columns each, alpha-premultiplying on read.
  const mid = new Uint8ClampedArray(srcH * dstW * 4);
  for (let y = 0; y < srcH; y++) {
    const rowStart = y * srcW * 4;
    resamplePass(
      (xi) => {
        const p = rowStart + xi * 4;
        return [src[p], src[p + 1], src[p + 2], src[p + 3]];
      },
      srcW,
      hWeights,
      dstW,
      (x, r, g, b, a) => {
        const mp = (y * dstW + x) * 4;
        mid[mp] = r; mid[mp + 1] = g; mid[mp + 2] = b; mid[mp + 3] = a;
      }
    );
  }

  // Vertical pass: dstW columns -> dstH rows each. `mid` is already
  // premultiplied with alpha==255 throughout (opaque input), so treating its
  // values as "straight" for the second premultiply pass is a no-op, exactly
  // mirroring Go's second call going through resizeRGBA (no re-premultiply).
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let x = 0; x < dstW; x++) {
    resamplePass(
      (yi) => {
        const p = (yi * dstW + x) * 4;
        return [mid[p], mid[p + 1], mid[p + 2], 255]; // treat as straight, alpha already baked in
      },
      srcH,
      vWeights,
      dstH,
      (y, r, g, b) => {
        const op = (y * dstW + x) * 4;
        out[op] = r; out[op + 1] = g; out[op + 2] = b; out[op + 3] = 255;
      }
    );
  }

  return { width: dstW, height: dstH, data: out };
}

// ---------------------------------------------------------------------------
// Stage: grayscale conversion
// ---------------------------------------------------------------------------
//
// CONFIDENCE: HIGH. Verified against transforms/pixels.go: goimagehash reads
// each resized pixel via Go's color.RGBA() (which for the 8-bit *image.RGBA
// the resize produces just scales each byte V to V*257 -- see rgb2GrayRGBA
// -> pixel2Gray), then computes 0.299*(r/257) + 0.587*(g/257) + 0.114*(b/256)
// using Go's uint32 integer division before the float multiply. Because
// r,g,b == V*257 exactly for an 8-bit source value V, `r/257` recovers V
// exactly, and (perhaps confusingly) so does `b/256`: 257*B/256 == B + B/256,
// and integer division truncates away that `B/256` remainder whenever B <
// 256, which it always is. So this reduces to plain
// 0.299*R + 0.587*G + 0.114*B on the exact 8-bit resize output -- which is
// exactly what this function computes.

function toGrayscale(resized) {
  const { width, height, data } = resized;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray; // length 64*64, row-major
}

// ---------------------------------------------------------------------------
// Stage: 2D DCT-II, top-left 8x8 block only (goimagehash transforms.DCT2DFast64)
// ---------------------------------------------------------------------------
//
// CONFIDENCE: HIGH. This used to be a direct-sum re-derivation of the DCT-II
// math (mathematically equivalent to Lee's recursive algorithm, but not
// operation-for-operation identical in floating point). Cross-checking
// against a real Go build of goimagehash on synthetic worst-case (uniform
// random noise) montages surfaced an occasional single-bit mismatch traced
// to exactly this: different summation order gives different float64
// rounding on values that happen to sit very close together, which can flip
// which side of the median threshold a coefficient lands on. Real video
// frames are far smoother than random noise and much less likely to hit
// this, but "vital... without running Go" means it should hold regardless of
// input, so this is now a literal port of transforms/static.go's
// forwardDCT64 (and the forwardDCT32/16/8/4 chain it recurses into) plus its
// exact hardcoded division constants -- same operations, same order, same
// rounding, verified against a real `go build` of the actual goimagehash +
// nfnt/resize source on multiple random test images with zero bit
// differences after this change (previously: 1 bit differed per image).

const DCT64_CONSTS = [
  1.9993976373924083, 1.9945809133573804, 1.9849590691974202, 1.9705552847778824, 1.9514042600770571, 1.9275521315908797, 1.8990563611860733, 1.8659855976694777,
  1.8284195114070614, 1.7864486023910306, 1.7401739822174227, 1.6897071304994142, 1.6351696263031674, 1.5766928552532127, 1.5144176930129691, 1.448494165902934,
  1.3790810894741339, 1.3063456859075537, 1.2304631811612539, 1.151616382835691, 1.0699952397741948, 0.9857963844595683, 0.8992226593092132, 0.8104826280099796,
  0.7197900730699766, 0.627363480797783, 0.5334255149497968, 0.43820248031373954, 0.3419237775206027, 0.24482135039843256, 0.1471291271993349, 0.049082457045824535,
];
const DCT32_CONSTS = [
  1.9975909124103448, 1.978353019929562, 1.9400625063890882, 1.8830881303660416, 1.8079785862468867, 1.7154572200005442, 1.6064150629612899, 1.4819022507099182,
  1.3431179096940369, 1.191398608984867, 1.0282054883864435, 0.8551101868605644, 0.6737797067844401, 0.48596035980652796, 0.2934609489107235, 0.09813534865483627,
];
const DCT16_CONSTS = [
  1.9903694533443936, 1.9138806714644176, 1.76384252869671, 1.546020906725474, 1.2687865683272912, 0.9427934736519956, 0.5805693545089246, 0.19603428065912154,
];

function forwardDCT4(input) {
  const x0 = input[0], y0 = input[3];
  const x1 = input[1], y1 = input[2];

  let t0 = x0 + y0;
  let t1 = x1 + y1;
  let t2 = (x0 - y0) / 1.8477590650225735;
  let t3 = (x1 - y1) / 0.7653668647301797;

  let x = t0, y = t1;
  t0 += t1;
  t1 = (x - y) / 1.4142135623730951;

  x = t2; y = t3;
  t2 += t3;
  t3 = (x - y) / 1.4142135623730951;

  input[0] = t0;
  input[1] = t2 + t3;
  input[2] = t1;
  input[3] = t3;
}

function forwardDCT8(input) {
  const a = new Float64Array(4), b = new Float64Array(4);

  const x0 = input[0], y0 = input[7];
  const x1 = input[1], y1 = input[6];
  const x2 = input[2], y2 = input[5];
  const x3 = input[3], y3 = input[4];

  a[0] = x0 + y0;
  a[1] = x1 + y1;
  a[2] = x2 + y2;
  a[3] = x3 + y3;
  b[0] = (x0 - y0) / 1.9615705608064609;
  b[1] = (x1 - y1) / 1.6629392246050907;
  b[2] = (x2 - y2) / 1.1111404660392046;
  b[3] = (x3 - y3) / 0.3901806440322566;

  forwardDCT4(a);
  forwardDCT4(b);

  input[0] = a[0];
  input[1] = b[0] + b[1];
  input[2] = a[1];
  input[3] = b[1] + b[2];
  input[4] = a[2];
  input[5] = b[2] + b[3];
  input[6] = a[3];
  input[7] = b[3];
}

function forwardDCT16(input) {
  const temp = new Float64Array(16);
  for (let i = 0; i < 8; i++) {
    const x = input[i], y = input[15 - i];
    temp[i] = x + y;
    temp[i + 8] = (x - y) / DCT16_CONSTS[i];
  }
  forwardDCT8(temp.subarray(0, 8));
  forwardDCT8(temp.subarray(8));
  for (let i = 0; i < 8 - 1; i++) {
    input[i * 2 + 0] = temp[i];
    input[i * 2 + 1] = temp[i + 8] + temp[i + 8 + 1];
  }
  input[14] = temp[7];
  input[15] = temp[15];
}

function forwardDCT32(input) {
  const temp = new Float64Array(32);
  for (let i = 0; i < 16; i++) {
    const x = input[i], y = input[31 - i];
    temp[i] = x + y;
    temp[i + 16] = (x - y) / DCT32_CONSTS[i];
  }
  forwardDCT16(temp.subarray(0, 16));
  forwardDCT16(temp.subarray(16));
  for (let i = 0; i < 16 - 1; i++) {
    input[i * 2 + 0] = temp[i];
    input[i * 2 + 1] = temp[i + 16] + temp[i + 16 + 1];
  }
  input[30] = temp[15];
  input[31] = temp[31];
}

function forwardDCT64(input) {
  const temp = new Float64Array(64);
  for (let i = 0; i < 32; i++) {
    const x = input[i], y = input[63 - i];
    temp[i] = x + y;
    temp[i + 32] = (x - y) / DCT64_CONSTS[i];
  }
  forwardDCT32(temp.subarray(0, 32));
  forwardDCT32(temp.subarray(32));
  for (let i = 0; i < 32 - 1; i++) {
    input[i * 2 + 0] = temp[i];
    input[i * 2 + 1] = temp[i + 32] + temp[i + 32 + 1];
  }
  input[62] = temp[31];
  input[63] = temp[63];
}

// dct.go: func DCT2DFast64(input *[]float64) (flattens [64]float64)
function dct2dTopLeft8x8(gray64x64) {
  const input = Float64Array.from(gray64x64); // work on a copy; forwardDCT64 mutates in place

  for (let i = 0; i < 64; i++) {
    forwardDCT64(input.subarray(i * 64, i * 64 + 64));
  }

  const flattens = new Float64Array(64);
  const row = new Float64Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 64; j++) {
      row[j] = input[64 * j + i];
    }
    forwardDCT64(row);
    for (let j = 0; j < 8; j++) {
      flattens[8 * j + i] = row[j];
    }
  }

  return flattens;
}

// ---------------------------------------------------------------------------
// Stage: median threshold + bit packing (goimagehash hashcompute.go)
// ---------------------------------------------------------------------------
//
// CONFIDENCE: HIGH for the bit-set direction and packing order (read
// directly from hashcompute.go: `phash.leftShiftSet(64 - idx - 1)` when
// `p > median`, for idx over the flattens array in order).
//
// Median-of-64 IS the standard "average the two middle values" definition
// after all. goimagehash's etcs.MedianOfPixelsFast64 quickselects down to
// position pos=l/2=32, but quickSelectMedian's final line for an
// even-length input returns `sequence[k-1]/2 + sequence[k]/2` -- i.e. once
// the partition narrows to position 32, it averages that with position 31.
// Confirmed against etcs's own test table (e.g. median of [1,2,3,4] is
// tested as 2.5, the average of the two middle sorted values, not either
// one alone) and against a real Go build on random test images.

function median64(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return (sorted[31] + sorted[32]) / 2;
}

function packHash(flattens) {
  const median = median64(flattens);
  let hash = 0n;
  for (let idx = 0; idx < 64; idx++) {
    if (flattens[idx] > median) {
      const bitPos = BigInt(64 - idx - 1);
      hash |= 1n << bitPos;
    }
  }
  return hash; // BigInt, 0..2^64-1
}

// ---------------------------------------------------------------------------
// Top-level: montage -> uint64 phash, with intermediate artifacts exposed
// for visualization.
// ---------------------------------------------------------------------------

function computePerceptionHash(montageImage) {
  const resized = resizeAA(montageImage, HASH_RESIZE, HASH_RESIZE);
  const gray = toGrayscale(resized);
  const dct = dct2dTopLeft8x8(gray);
  const median = median64(dct);
  const hash = packHash(dct);

  return {
    hash,
    hex: hash.toString(16).padStart(16, '0'),
    // int64 form, matching how Stash stores it (same bit pattern, signed interpretation)
    int64: BigInt.asIntN(64, hash).toString(),
    resizedGray64x64: gray, // Float64Array(4096), for visualization
    dctCoefficients8x8: dct, // Float64Array(64), for visualization
    median,
    bits: Array.from({ length: 64 }, (_, idx) => dct[idx] > median ? 1 : 0),
  };
}

function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0n;
  while (x) {
    count += x & 1n;
    x >>= 1n;
  }
  return Number(count);
}

// ---------------------------------------------------------------------------
// Visualization helper: spatial contribution heatmap for a set of flipped
// DCT coefficients. UI-only -- purely explanatory, doesn't feed back into
// the hash itself.
// ---------------------------------------------------------------------------
//
// IMPORTANT: a coefficient's basis-function magnitude on its own is a fixed
// cosine pattern that has nothing to do with what's actually in either
// image -- it looks the same regardless of whether the two collages agree
// or disagree at that spot. Weighting by that alone (an earlier version of
// this function did exactly that) lights up wherever the flipped
// coefficients' cosine patterns happen to peak, which is frequently a
// region where the two images are identical -- the opposite of useful.
//
// What actually explains "why did this coefficient's value differ" is
// linearity of the DCT: DCT(grayA)[k] - DCT(grayB)[k] == DCT(grayA - grayB)[k]
// exactly (the forward transform is a linear operator, so the difference
// of two transforms equals the transform of the difference). Expanding
// that for a single output coefficient (j row-freq, i col-freq):
//
//   diff_k = sum over (y,x) of basis_j(y) * basis_i(x) * (grayA(y,x) - grayB(y,x))
//
// So each pixel (y,x)'s actual contribution to that coefficient's
// difference is basis_j(y) * basis_i(x) * (grayA(y,x) - grayB(y,x)) -- the
// basis magnitude *times* the real local pixel difference. Summing
// |contribution| over every flipped coefficient (optionally weighted by
// how much each one's value differs) gives a heatmap that only lights up
// where the images actually disagree AND where the frequencies that flipped
// bits care about that disagreement -- both factors have to be present.

let dctBasisCache = null;
function getDctBasisTable() {
  if (dctBasisCache) return dctBasisCache;
  const N = 64;
  const table = [];
  for (let k = 0; k < 8; k++) {
    const row = new Float64Array(N);
    for (let n = 0; n < N; n++) row[n] = Math.cos(((n + 0.5) * k * Math.PI) / N);
    table.push(row);
  }
  dctBasisCache = table;
  return table;
}

/**
 * coeffIndices: iterable of flipped coefficient indices (0..63, idx = 8*j+i
 *   with j = row/vertical frequency, i = column/horizontal frequency --
 *   matching dct2dTopLeft8x8's packing).
 * weightByIndex: optional {idx: weight} (e.g. |dctA[idx] - dctB[idx]|) to
 *   weight each coefficient's contribution; omit for an unweighted sum.
 * pixelDiff: REQUIRED for a meaningful result -- a Float64Array(4096)
 *   (row-major 64x64) of grayA(y,x) - grayB(y,x), i.e. the actual
 *   difference between the two images at the same stage the DCT reads
 *   from. Without this, the result is just the basis-function magnitude,
 *   which (see above) is not a useful "what caused this" signal on its own.
 * Returns a Float64Array(4096), row-major 64x64, normalized to [0, 1].
 */
function computeDctContributionHeatmap(coeffIndices, weightByIndex, pixelDiff) {
  const N = 64;
  const basis = getDctBasisTable();
  const heat = new Float64Array(N * N);

  for (const idx of coeffIndices) {
    const j = Math.floor(idx / 8); // row/vertical frequency
    const i = idx % 8; // column/horizontal frequency
    const w = weightByIndex ? (weightByIndex[idx] ?? 1) : 1;
    if (!w) continue;
    const vBasis = basis[j];
    const hBasis = basis[i];
    for (let y = 0; y < N; y++) {
      const vy = Math.abs(vBasis[y]);
      if (vy === 0) continue;
      const rowOffset = y * N;
      for (let x = 0; x < N; x++) {
        heat[rowOffset + x] += w * vy * Math.abs(hBasis[x]);
      }
    }
  }

  if (pixelDiff) {
    for (let k = 0; k < heat.length; k++) heat[k] *= Math.abs(pixelDiff[k]);
  }

  let max = 0;
  for (let k = 0; k < heat.length; k++) if (heat[k] > max) max = heat[k];
  if (max > 0) {
    for (let k = 0; k < heat.length; k++) heat[k] /= max;
  }
  return heat;
}

const PhashCore = {
  COLUMNS,
  ROWS,
  SCREENSHOT_WIDTH,
  HASH_RESIZE,
  computeScreenshotTimestamps,
  buildMontage,
  resizeAA,
  toGrayscale,
  dct2dTopLeft8x8,
  computePerceptionHash,
  hammingDistance,
  computeDctContributionHeatmap,
};

// Need to be able to import from Electron as well as a regular ol' webpage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PhashCore;
} else {
  window.PhashCore = PhashCore;
}
