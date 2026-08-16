'use strict';

/**
 * Parsing/formatting of phash values as users and Stash present them.
 *
 * Stash stores a phash as a signed int64 (the `phash` column / GraphQL
 * fingerprint is shown as 16 hex digits in the UI, but exports and the
 * database expose the decimal int64, which is negative about half the
 * time). Both spellings need to be accepted everywhere a hash is typed in.
 *
 * Rule: an optional-sign string of only decimal digits is an int64; an
 * optional `0x` followed by 1-16 hex digits is hex. A 16-character hex hash
 * that happens to contain only digits 0-9 is therefore read as decimal --
 * prefix it with 0x to force hex.
 */

(function (root) {
  const UINT64_MAX = (1n << 64n) - 1n;
  const INT64_MIN = -(1n << 63n);

  function toHex(big) {
    return BigInt.asUintN(64, big).toString(16).padStart(16, '0');
  }

  /** Returns the 16-digit lowercase hex form, or null if unparseable. */
  function parseHashInput(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (/^-?\d+$/.test(s)) {
      const v = BigInt(s);
      if (v > UINT64_MAX || v < INT64_MIN) return null;
      return toHex(v);
    }
    const m = /^(?:0x)?([0-9a-f]{1,16})$/i.exec(s);
    if (m) return toHex(BigInt('0x' + m[1]));
    return null;
  }

  /** Hex -> the signed decimal string Stash stores. */
  function hexToInt64(hex) {
    return BigInt.asIntN(64, BigInt('0x' + hex)).toString();
  }

  const HashFormat = { parseHashInput, hexToInt64 };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HashFormat;
  } else {
    root.HashFormat = HashFormat;
  }
}(typeof window !== 'undefined' ? window : globalThis));
