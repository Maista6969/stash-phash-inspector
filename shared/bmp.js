'use strict';

/**
 * Minimal decoder for the uncompressed 24-bit BMP files that ffmpeg's
 * `-c:v bmp` encoder produces (both the real ffmpeg binary in the
 * Electron build and ffmpeg.wasm in the browser build emit the same
 * format). This avoids pulling in an image library whose internals we
 * can't audit -- we want full control over every byte that feeds into
 * the hash.
 *
 * Accepts a Node Buffer OR a plain Uint8Array (ffmpeg.wasm's FS.readFile
 * returns the latter) -- uses DataView rather than Buffer-only methods so
 * the exact same code runs in both the Electron and browser builds.
 *
 * Returns { width, height, data } where data is a Uint8ClampedArray of
 * RGBA bytes in top-to-bottom, left-to-right row order (i.e. already
 * flipped from BMP's bottom-up storage order).
 */
function decodeBMP(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error('Not a BMP file (bad magic bytes)');
  }

  const dataOffset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (compression !== 0) {
    throw new Error(`Unsupported BMP compression: ${compression}`);
  }
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new Error(`Unsupported BMP bit depth: ${bitsPerPixel}`);
  }

  const height = Math.abs(heightRaw);
  const topDown = heightRaw < 0; // negative height = already top-down
  const bytesPerPixel = bitsPerPixel / 8;
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4; // rows are padded to 4 bytes

  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    // BMP stores rows bottom-to-top unless height is negative.
    const srcRow = topDown ? y : height - 1 - y;
    const rowStart = dataOffset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      const srcIdx = rowStart + x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      // BMP stores pixels as BGR(A).
      data[dstIdx + 0] = bytes[srcIdx + 2]; // R
      data[dstIdx + 1] = bytes[srcIdx + 1]; // G
      data[dstIdx + 2] = bytes[srcIdx + 0]; // B
      data[dstIdx + 3] = bytesPerPixel === 4 ? bytes[srcIdx + 3] : 255;
    }
  }

  return { width, height, data };
}

const BmpDecoder = { decodeBMP };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BmpDecoder;
} else {
  window.BmpDecoder = BmpDecoder;
}
